#!/usr/bin/env bun
/**
 * Site crawler with:
 * - True concurrent fetching (worker pool)
 * - 408 and transient error retries
 * - Document URL discovery
 */

import { parseArgs } from "util";
import { writeFileSync } from "fs";
import { parse as parseHtml } from "node-html-parser";
import { decode as decodeHtmlEntities } from "he";
import { HttpCache } from "./http-cache.js";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    output: { type: "string", short: "o" },
    failed: { type: "string", short: "f" },
    concurrency: { type: "string", short: "j", default: "20" },
    retries: { type: "string", short: "r", default: "3" },
    followAll: { type: "boolean", short: "a", default: false },
    domain: { type: "string", short: "d", multiple: true },
    contentOnly: { type: "boolean", short: "c", default: false },
    store: { type: "string", short: "s" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help || positionals.length < 1) {
  console.error(`Usage: crawler.js [options] <start_url> [<start_url2> ...]

Options:
  -o, --output <file>     Output file for discovered document URLs
  -f, --failed <file>     Output file for failed URLs (YAML, grouped by error)
  -j, --concurrency <n>   Number of concurrent fetchers (default: 20)
  -r, --retries <n>       Number of retries for transient errors (default: 3)
  -a, --follow-all-links  Follow all links, including rel="nofollow"
  -c, --content-only      Skip scanning JavaScript and CSS for URLs
  -s, --store <dir>       Cache directory for HTTP responses (created if needed)
  -d, --domain <host>     Additional host to substitute with main host (can be repeated)
  -h, --help              Show this help

Arguments:
  <start_url>             One or more URLs to start crawling from
`);
  process.exit(values.help ? 0 : 1);
}

const startUrls = positionals;
const outputFile = values.output;
const failedFile = values.failed;
const concurrency = parseInt(values.concurrency, 10);
const maxRetries = parseInt(values.retries, 10);
const followAll = values.followAll;
const contentOnly = values.contentOnly;
const storeDir = values.store;

// Use first starting URL as reference for preferences
const firstStartUrl = startUrls[0];
const firstStartUrlParsed = new URL(firstStartUrl);

// If first starting URL is https, prefer https for all discovered URLs
const preferHttps = firstStartUrl.startsWith("https://");

// If first starting URL has a non-standard port, prefer that port for discovered URLs
const preferPort = firstStartUrlParsed.port || null; // null means no port preference

// Main host for substitution (from first starting URL)
const mainHost = firstStartUrlParsed.hostname;

// Additional hosts that should be substituted with main host
const additionalHosts = new Set(values.domain || []);

// HTML content types - only these are "documents" we track
function isHtmlType(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase().split(";")[0].trim();
  return ct === "text/html";
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Prefer https: upgrade http to https if in preferHttps mode
    if (preferHttps && u.protocol === "http:") {
      u.protocol = "https:";
    }
    // Prefer port: add port if URL has no port and we have a preferred port
    if (preferPort && !u.port) {
      u.port = preferPort;
    }
    // Remove trailing slash except for root
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    // Remove fragment
    u.hash = "";
    // Debug: warn if result still has no port when preferPort is set
    if (preferPort && !u.port) {
      console.error(`[BUG] normalizeUrl produced portless URL: ${u.href} (preferPort=${preferPort})`);
    }
    return u.href;
  } catch {
    return null;
  }
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  try {
    const root = parseHtml(html);
    const base = new URL(baseUrl);

    // Standard link elements - respect rel="nofollow" unless followAll is set
    for (const el of root.querySelectorAll("a[href], link[href]")) {
      const rel = (el.getAttribute("rel") || "").toLowerCase();
      if (!followAll && rel.includes("nofollow")) continue;
      addLink(links, el.getAttribute("href"), baseUrl, base);
    }

    // Forms - skip form actions (don't crawl form submissions)
    // (removed form[action] handling)

    // Scripts, images, iframes, etc.
    for (const el of root.querySelectorAll("script[src], img[src], iframe[src], video[src], audio[src], source[src], embed[src]")) {
      addLink(links, el.getAttribute("src"), baseUrl, base);
    }

    // Data attributes that often contain URLs
    const dataAttrs = ["data-url", "data-href", "data-src", "data-link"];
    const dataSelector = dataAttrs.map(attr => `[${attr}]`).join(", ");
    for (const el of root.querySelectorAll(dataSelector)) {
      for (const attr of dataAttrs) {
        addLink(links, el.getAttribute(attr), baseUrl, base);
      }
    }

    // Meta refresh redirects
    for (const el of root.querySelectorAll("meta[http-equiv='refresh']")) {
      const content = el.getAttribute("content") || "";
      const match = content.match(/url=(.+)/i);
      if (match) addLink(links, match[1].trim(), baseUrl, base);
    }

    // srcset (responsive images)
    for (const el of root.querySelectorAll("[srcset]")) {
      const srcset = el.getAttribute("srcset") || "";
      for (const part of srcset.split(",")) {
        const url = part.trim().split(/\s+/)[0];
        addLink(links, url, baseUrl, base);
      }
    }

    // Extract URLs from inline scripts and style blocks (unless content-only mode)
    if (!contentOnly) {
      const text = html;
      extractUrlsFromText(links, text, baseUrl, base);
    }

  } catch {}
  return links;
}

function looksLikeEmail(str) {
  // Match common email patterns
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

function looksLikePhoneNumber(str) {
  // Match common phone number patterns (with or without country code, various separators)
  // Examples: +1-234-567-8900, (123) 456-7890, 123.456.7890, 1234567890
  const cleaned = str.replace(/[\s\-\.\(\)]/g, '');
  // Check if it's mostly digits, possibly starting with +
  return /^\+?\d{7,15}$/.test(cleaned);
}

function addLink(links, href, baseUrl, base) {
  if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("data:")) return;
  // Decode HTML entities (e.g., &amp; -> &)
  const decoded = decodeHtmlEntities(href);

  // Skip if it looks like an email address or phone number (even without mailto:/tel: prefix)
  if (looksLikeEmail(decoded) || looksLikePhoneNumber(decoded)) return;

  try {
    const resolved = new URL(decoded, baseUrl);
    // Check if host is main host or an additional host
    const isMainHost = resolved.hostname === base.hostname;
    const isAdditionalHost = additionalHosts.has(resolved.hostname);

    if (isMainHost || isAdditionalHost) {
      // Mark if this came from an additional host (for fallback logic)
      const cameFromAdditionalHost = isAdditionalHost;
      if (isAdditionalHost) {
        // Substitute main host, protocol, and clear port (normalizeUrl will apply preferred port)
        resolved.hostname = mainHost;
        resolved.protocol = firstStartUrlParsed.protocol;
        resolved.port = "";  // Let normalizeUrl handle port based on preferPort
      }
      const norm = normalizeUrl(resolved.href);
      if (norm) links.add({ url: norm, cameFromAdditionalHost, sourceUrl: baseUrl });
    }
  } catch {}
}

/**
 * Extract URLs from plain text using regex patterns.
 *
 * This function complements DOM-based link extraction by finding URLs embedded in:
 * - Inline JavaScript code (e.g., fetch("/api/users"), window.location = "/home")
 * - CSS content (e.g., url('/images/bg.png'), @import "/styles.css")
 * - String literals and other text content that wouldn't be captured by DOM attribute queries
 *
 * While DOM crawling handles structured HTML attributes (href, src, etc.), this function
 * captures dynamically referenced URLs that only exist as string literals in script/style
 * content. Both approaches are necessary for comprehensive URL discovery.
 */
function extractUrlsFromText(links, text, baseUrl, base) {
  // Common URL patterns in JS/CSS
  const patterns = [
    // Quoted strings that look like paths
    /["'](\/[a-zA-Z0-9_\-\/\.]+?)["']/g,
    // Full URLs
    /["'](https?:\/\/[^"'\s<>]+?)["']/g,
    // url() in CSS
    /url\s*\(\s*["']?([^"'\)\s]+)["']?\s*\)/gi,
    // Common API/endpoint patterns
    /["'](\/?api\/[^"'\s]+?)["']/g,
    /["'](\/?v[0-9]+\/[^"'\s]+?)["']/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const url = match[1];
      // Skip obvious non-URLs
      if (url.includes("${") || url.includes("{{") || url.length < 2) continue;
      // Skip common false positives
      if (/^\/?[a-z]+$/.test(url)) continue; // single word
      if (url.startsWith("//") && !url.startsWith("///")) {
        // Protocol-relative URL
        addLink(links, "https:" + url, baseUrl, base);
      } else {
        addLink(links, url, baseUrl, base);
      }
    }
  }
}

// State
const discovered = new Set();    // URLs confirmed as documents
const seen = new Set();          // URLs we've queued/fetched (normalized)
const failed = new Map();        // url -> { lastError, referrers: Set }
const referrers = new Map();     // url -> Set of source URLs (tracks all pages linking to each URL)
const queue = [];                // URLs to fetch: { url, attempts, canFallbackToHttp }
let inFlight = 0;
let done = false;
let cache = null;                // HTTP response cache (initialized in main if --store is specified)

// Add URL to queue if not seen
function enqueue(linkOrUrl) {
  // Accept either a string or an object { url, cameFromAdditionalHost, sourceUrl }
  const url = typeof linkOrUrl === "string" ? linkOrUrl : linkOrUrl.url;
  const cameFromAdditionalHost = typeof linkOrUrl === "object" ? linkOrUrl.cameFromAdditionalHost : false;
  const sourceUrl = typeof linkOrUrl === "object" ? linkOrUrl.sourceUrl : null;

  // Track original properties before normalization (for fallback logic)
  let wasHttp = false;
  let wasPortless = false;
  try {
    const parsed = new URL(url);
    wasHttp = parsed.protocol === "http:";
    wasPortless = !parsed.port;
  } catch {}

  const norm = normalizeUrl(url);
  if (!norm) return;

  // Always track referrers, even for already-seen URLs
  if (sourceUrl) {
    if (!referrers.has(norm)) {
      referrers.set(norm, new Set());
    }
    referrers.get(norm).add(sourceUrl);
  }

  if (!seen.has(norm)) {
    seen.add(norm);
    // Can fallback to http if originally discovered as http (but NOT if from additional host)
    // Can fallback to no-port if originally discovered without port (but NOT if from additional host)
    // URLs from additional hosts: no fallbacks, they just fail if main host doesn't work
    queue.push({
      url: norm,
      attempts: 0,
      canFallbackToHttp: wasHttp && !cameFromAdditionalHost,
      canFallbackToNoPort: wasPortless && !cameFromAdditionalHost,
      cameFromAdditionalHost
    });
  }
}

/**
 * Process response body and extract links
 */
function processResponseBody(body, contentType, url) {
  const isHtml = isHtmlType(contentType);
  const ct = contentType.toLowerCase();
  let links = new Set();

  // Parse HTML for full link extraction
  if (ct.includes("text/html")) {
    links = extractLinks(body, url);
  }
  // Also extract URLs from JS and CSS (but these are not "documents" we track)
  else if (!contentOnly && (ct.includes("javascript") || ct.includes("text/css"))) {
    const base = new URL(url);
    extractUrlsFromText(links, body, url, base);
  }

  return { isHtml, links };
}

// Retry-aware fetch with https->http and port->no-port fallback
async function fetchWithRetry(url, attempts, canFallbackToHttp, canFallbackToNoPort, cache = null, triedHttpFallback = false, triedNoPortFallback = false) {
  const TRANSIENT_CODES = [408, 429, 500, 502, 503, 504];

  // Check cache first
  if (cache) {
    const cached = cache.get(url);
    if (cached) {
      const { isHtml, links } = processResponseBody(cached.body, cached.contentType, url);
      return { ok: true, isHtml, links, fetchedUrl: url, fromCache: true };
    }
  }

  try {
    const resp = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Crawler/1.0)",
      },
    });

    if (TRANSIENT_CODES.includes(resp.status) && attempts < maxRetries) {
      return { retry: true, error: `HTTP ${resp.status}` };
    }

    if (!resp.ok) {
      return { error: `HTTP ${resp.status}` };
    }

    const contentType = resp.headers.get("content-type") || "";
    const body = await resp.text();

    // Store in cache if available
    if (cache) {
      cache.set(url, {
        status: resp.status,
        contentType,
        body
      });
    }

    const { isHtml, links } = processResponseBody(body, contentType, url);
    return { ok: true, isHtml, links, fetchedUrl: url };
  } catch (e) {
    const msg = e.message || String(e);

    // Try port fallback first (remove port if it was added by normalization)
    if (canFallbackToNoPort && !triedNoPortFallback && preferPort) {
      try {
        const u = new URL(url);
        if (u.port === preferPort) {
          u.port = "";
          const noPortUrl = u.href;
          console.error(`[port-failed] ${url} (${msg}), trying without port...`);
          return fetchWithRetry(noPortUrl, attempts, canFallbackToHttp, canFallbackToNoPort, cache, triedHttpFallback, true);
        }
      } catch {}
    }

    // Then try https->http fallback if URL was originally discovered as http
    if (canFallbackToHttp && !triedHttpFallback && url.startsWith("https://")) {
      const httpUrl = url.replace("https://", "http://");
      console.error(`[https-failed] ${url} (${msg}), trying http...`);
      return fetchWithRetry(httpUrl, attempts, canFallbackToHttp, canFallbackToNoPort, cache, true, triedNoPortFallback);
    }

    // Retry on network errors
    if (attempts < maxRetries) {
      return { retry: true, error: msg };
    }
    return { error: msg };
  }
}

// Worker function
async function worker() {
  while (!done) {
    const item = queue.shift();
    if (!item) {
      // Queue empty, wait a bit
      await Bun.sleep(50);
      continue;
    }

    inFlight++;
    const { url, attempts, canFallbackToHttp, canFallbackToNoPort, cameFromAdditionalHost } = item;

    const result = await fetchWithRetry(url, attempts, canFallbackToHttp, canFallbackToNoPort, cache);

    if (result.retry) {
      // Only log retries for HTML pages (we don't know yet, so always log)
      console.error(`[retry ${attempts + 1}/${maxRetries}] ${url} (${result.error})`);
      queue.push({ url, attempts: attempts + 1, canFallbackToHttp, canFallbackToNoPort, cameFromAdditionalHost });
    } else if (result.error) {
      // Only track failed HTML pages - but we don't know content type for failed requests
      // For now, assume potentially HTML if path looks like document (no extension or .html/.htm/.php etc)
      if (looksLikeHtmlUrl(url)) {
        const refs = referrers.get(url);
        const refInfo = refs && refs.size > 0 ? ` from ${refs.size} page(s)` : "";
        console.error(`[failed] ${url} (${result.error})${refInfo}`);
        failed.set(url, { lastError: result.error });
      }
    } else {
      // Success - only track HTML documents
      // Always use the normalized URL (with preferred port), not the fallback URL
      if (result.isHtml && !discovered.has(url)) {
        // Debug: warn if adding portless URL when preferPort is set
        if (preferPort) {
          try {
            const checkUrl = new URL(url);
            if (!checkUrl.port) {
              console.error(`[BUG] Adding portless URL to discovered: ${url} (preferPort=${preferPort})`);
            }
          } catch {}
        }
        discovered.add(url);
        const cacheIndicator = result.fromCache ? " [cached]" : "";
        console.log(url + cacheIndicator);
      }
      // Enqueue discovered links regardless of content type
      // Links are already normalized by addLink -> normalizeUrl, so port is added
      for (const link of result.links) {
        enqueue(link);
      }
    }

    inFlight--;
  }
}

// Heuristic: does URL look like it might be an HTML page?
function looksLikeHtmlUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname;
    // Root or directory-like paths
    if (path === "/" || path.endsWith("/")) return true;
    // Common HTML extensions
    if (/\.(html?|php|asp|aspx|jsp|cgi|pl)$/i.test(path)) return true;
    // No extension (friendly URLs like /about, /contact)
    const lastSegment = path.split("/").pop();
    if (lastSegment && !lastSegment.includes(".")) return true;
    return false;
  } catch {
    return true; // assume HTML if can't parse
  }
}

// Progress reporter
async function progressReporter() {
  while (!done) {
    await Bun.sleep(2000);
    console.error(`[progress] queue=${queue.length} inFlight=${inFlight} discovered=${discovered.size} failed=${failed.size}`);
  }
}

// Main
async function main() {
  // Initialize cache if store directory is specified
  if (storeDir) {
    cache = new HttpCache(storeDir);
    console.error(`[cache] enabled at ${storeDir}`);
  }

  console.error(`[start] ${startUrls.length} URL(s) (concurrency=${concurrency}, retries=${maxRetries})`);
  for (const url of startUrls) {
    console.error(`  - ${url}`);
  }

  // Enqueue all starting URLs
  for (const url of startUrls) {
    enqueue(url);
  }

  // Start workers
  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }

  // Start progress reporter
  const progress = progressReporter();

  // Wait until queue is empty and no requests in flight
  while (queue.length > 0 || inFlight > 0) {
    await Bun.sleep(100);
  }

  done = true;
  await Promise.all(workers);

  console.error(`\n[done] discovered=${discovered.size} failed=${failed.size}`);
  
  if (outputFile) {
    const sorted = [...discovered].sort();
    writeFileSync(outputFile, sorted.join("\n") + "\n");
    console.error(`[saved] ${outputFile}`);
  }
  
  if (failedFile && failed.size > 0) {
    // Group failures by error type
    const byError = new Map();
    for (const [url, info] of failed) {
      const error = info.lastError;
      if (!byError.has(error)) {
        byError.set(error, []);
      }
      const refs = referrers.get(url);
      byError.get(error).push({
        url,
        referrers: refs ? [...refs].sort() : []
      });
    }

    // Generate YAML
    const yamlLines = [];
    for (const [error, urls] of [...byError.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      yamlLines.push(`- error: "${error}"`);
      yamlLines.push(`  urls:`);
      for (const { url, referrers: refs } of urls.sort((a, b) => a.url.localeCompare(b.url))) {
        yamlLines.push(`    - url: "${url}"`);
        yamlLines.push(`      referrers:`);
        if (refs.length === 0) {
          yamlLines.push(`        []`);
        } else {
          for (const ref of refs) {
            yamlLines.push(`        - "${ref}"`);
          }
        }
      }
    }
    writeFileSync(failedFile, yamlLines.join("\n") + "\n");
    console.error(`[saved] ${failedFile}`);
  }
}

main();
