#!/usr/bin/env bun
/**
 * Site crawler with:
 * - True concurrent fetching (worker pool)
 * - 408 and transient error retries
 * - Document URL discovery
 */

import { parseArgs } from "util";
import { writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseHtml } from "node-html-parser";
import { decode as decodeHtmlEntities } from "he";
import { HttpCache, hashUrl } from "./http-cache.js";
import { parseSitemap } from "./sitemap-parser.js";
import { fetchWithRetry } from "./fetcher.js";
import { extractWithTrafilatura } from "./trafilatura-extractor.js";

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
    bodies: { type: "string", short: "b" },
    trafilatura: { type: "string", short: "t" },
    expect: { type: "string", short: "x" },
    wtf: { type: "string", short: "w" },
    preserveQueryOrder: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help || positionals.length < 1) {
  console.error(`Usage: crawler.js [options] <start_url> [<start_url2> ...]

Options:
  -o, --output <file>         Output file for discovered document URLs
  -f, --failed <file>         Output file for failed URLs (YAML, grouped by error)
  -j, --concurrency <n>       Number of concurrent fetchers (default: 20)
  -r, --retries <n>           Number of retries for transient errors (default: 3)
  -a, --follow-all-links      Follow all links, including rel="nofollow"
  -c, --content-only          Skip scanning JavaScript and CSS for URLs
  -s, --store <dir>           Cache directory for HTTP responses (created if needed)
  -b, --bodies <dir>          Save response bodies by URL hash (created if needed)
  -t, --trafilatura <dir>     Extract main content with trafilatura (requires -s, forces -b)
  -d, --domain <host>         Additional host to substitute with main host (can be repeated)
  -x, --expect <url>          Expect URL to be discovered; show detailed reason if not
  -w, --wtf <url>             Show why URL is being discovered (referrers, status)
  --preserve-query-order      Don't sort query parameters (for order-sensitive sites)
  -h, --help                  Show this help

Arguments:
  <start_url>                 One or more URLs to start crawling from
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
const trafilaturaDir = values.trafilatura;
const expectUrl = values.expect;
const wtfUrl = values.wtf;
const preserveQueryOrder = values.preserveQueryOrder;

// If -t is specified but -b is not, create temp dir for bodies
let bodiesDir = values.bodies;
let tempBodiesDir = null;
if (trafilaturaDir && !bodiesDir) {
  tempBodiesDir = mkdtempSync(join(tmpdir(), "crawler-bodies-"));
  bodiesDir = tempBodiesDir;
  console.error(`[trafilatura] created temp bodies dir: ${tempBodiesDir}`);
}

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
    // Sort query parameters alphabetically by key (unless preserveQueryOrder is set)
    if (!preserveQueryOrder && u.search) {
      const params = new URLSearchParams(u.search);
      const sortedParams = new URLSearchParams([...params.entries()].sort((a, b) => a[0].localeCompare(b[0])));
      u.search = sortedParams.toString();
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
  const sitemaps = new Set();
  try {
    const root = parseHtml(html);
    const base = new URL(baseUrl);

    // Standard link elements - respect rel="nofollow" unless followAll is set
    // Also detect rel="sitemap" for sitemap discovery
    for (const el of root.querySelectorAll("a[href], link[href]")) {
      const rel = (el.getAttribute("rel") || "").toLowerCase();
      if (rel.includes("sitemap")) {
        // Mark as sitemap for special handling
        addSitemapLink(sitemaps, el.getAttribute("href"), baseUrl, base);
        continue;
      }
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
  return { links, sitemaps };
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
  const trackExpected = (reason) => {
    if (expectTracking.normalized && href && href.includes(expectTracking.normalized.split('://')[1]?.split('/')[0])) {
      expectTracking.filtered = reason;
    }
  };

  if (!href) {
    trackExpected("empty href");
    return;
  }
  if (href.startsWith("#")) {
    trackExpected("fragment-only href");
    return;
  }
  if (href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("data:")) {
    trackExpected("special protocol");
    return;
  }

  // Decode HTML entities (e.g., &amp; -> &)
  const decoded = decodeHtmlEntities(href);

  // Skip if it looks like an email address or phone number (even without mailto:/tel: prefix)
  if (looksLikeEmail(decoded)) {
    trackExpected("looks like email");
    return;
  }
  if (looksLikePhoneNumber(decoded)) {
    trackExpected("looks like phone number");
    return;
  }

  try {
    const resolved = new URL(decoded, baseUrl);

    // Check for fixer-upper case: resolved URL has base path embedded, then a domain
    // Get the base directory path (drop last segment from baseUrl path)
    const basePathSegments = base.pathname.split('/').filter(s => s.length > 0);
    basePathSegments.pop(); // Remove filename/last segment to get directory
    const baseDir = '/' + basePathSegments.join('/') + (basePathSegments.length > 0 ? '/' : '');

    // Strip base directory from resolved pathname
    if (resolved.pathname.startsWith(baseDir)) {
      const remaining = resolved.pathname.slice(baseDir.length);
      const remainingSegments = remaining.split('/').filter(s => s.length > 0);

      if (remainingSegments.length > 0) {
        const firstSegment = remainingSegments[0];
        const isFirstSegmentMainDomain = firstSegment === mainHost;
        const isFirstSegmentAdditionalDomain = additionalHosts.has(firstSegment);

        if (isFirstSegmentMainDomain || isFirstSegmentAdditionalDomain) {
          // This looks like a malformed URL - domain appears after base path
          // Create fixed version by treating remaining as absolute with protocol
          const fixedHref = `${firstStartUrlParsed.protocol}//${remaining}`;
          try {
            const fixedResolved = new URL(fixedHref);
            const fixedNorm = normalizeUrl(fixedResolved.href);
            const unfixedNorm = normalizeUrl(resolved.href);

            if (fixedNorm && unfixedNorm) {
              // Track the mapping
              fixerUppers.set(unfixedNorm, fixedNorm);
              console.error(`[fixer-upper] detected: ${remaining}`);
              console.error(`[fixer-upper]   unfixed: ${unfixedNorm}`);
              console.error(`[fixer-upper]   fixed:   ${fixedNorm}`);

              // Add both versions
              links.add({ url: unfixedNorm, cameFromAdditionalHost: false, sourceUrl: baseUrl });
              links.add({ url: fixedNorm, cameFromAdditionalHost: isFirstSegmentAdditionalDomain, sourceUrl: baseUrl });
            }
            return; // Done processing this link
          } catch (fixError) {
            // If fixing fails, fall through to normal processing
            console.error(`[fixer-upper] Failed to fix ${remaining}: ${fixError.message}`);
          }
        }
      }
    }

    // Normal processing
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
    } else {
      trackExpected(`wrong domain (${resolved.hostname}, expected ${mainHost})`);
    }
  } catch (e) {
    trackExpected(`URL parse error: ${e.message}`);
  }
}

function addSitemapLink(sitemaps, href, baseUrl, base) {
  if (!href) return;
  const decoded = decodeHtmlEntities(href);

  try {
    const resolved = new URL(decoded, baseUrl);
    // Check if host is main host or an additional host
    const isMainHost = resolved.hostname === base.hostname;
    const isAdditionalHost = additionalHosts.has(resolved.hostname);

    if (isMainHost || isAdditionalHost) {
      const cameFromAdditionalHost = isAdditionalHost;
      if (isAdditionalHost) {
        resolved.hostname = mainHost;
        resolved.protocol = firstStartUrlParsed.protocol;
        resolved.port = "";
      }
      const norm = normalizeUrl(resolved.href);
      if (norm) sitemaps.add({ url: norm, cameFromAdditionalHost, sourceUrl: baseUrl, isSitemap: true });
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
const htmlHashes = new Set();    // Hashes of URLs that returned text/html (for trafilatura)
const fixerUppers = new Map();   // unfixedUrl -> fixedUrl (for malformed protocol-less URLs)
let inFlight = 0;
let done = false;
let cache = null;                // HTTP response cache (initialized in main if --store is specified)

// Tracking for -x / --expect option
const expectTracking = {
  normalized: null,              // Normalized version of expected URL
  seen: false,                   // Was it added to seen set?
  filtered: null,                // Why was it filtered (if applicable)?
  fetched: false,                // Was it fetched?
  fetchResult: null,             // Result of fetch (ok, error, retry)
  contentType: null,             // Content-Type of response
  isHtml: false,                 // Was it detected as HTML?
  isSitemap: false,              // Was it detected as sitemap?
  addedToDiscovered: false       // Was it added to discovered set?
};

// Tracking for -w / --wtf option
const wtfTracking = {
  normalized: null,              // Normalized version of WTF URL
  seen: false,                   // Was it added to seen set?
  fetched: false,                // Was it fetched?
  fetchResult: null,             // Result of fetch
  addedToDiscovered: false       // Was it added to discovered set?
};

// Add URL to queue if not seen
function enqueue(linkOrUrl) {
  // Accept either a string or an object { url, cameFromAdditionalHost, sourceUrl, isSitemap }
  const url = typeof linkOrUrl === "string" ? linkOrUrl : linkOrUrl.url;
  const cameFromAdditionalHost = typeof linkOrUrl === "object" ? linkOrUrl.cameFromAdditionalHost : false;
  const sourceUrl = typeof linkOrUrl === "object" ? linkOrUrl.sourceUrl : null;
  const isSitemap = typeof linkOrUrl === "object" ? linkOrUrl.isSitemap : false;

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

    // Track if this is the expected URL
    if (expectTracking.normalized === norm) {
      expectTracking.seen = true;
    }

    // Track if this is the WTF URL
    if (wtfTracking.normalized === norm) {
      wtfTracking.seen = true;
    }

    // Can fallback to http if originally discovered as http
    // Can fallback to no-port if originally discovered without port (but NOT if from additional host)
    queue.push({
      url: norm,
      attempts: 0,
      canFallbackToHttp: wasHttp,
      canFallbackToNoPort: wasPortless && !cameFromAdditionalHost,
      cameFromAdditionalHost,
      isSitemap
    });
  }
}

/**
 * Parse sitemap XML and filter URLs through domain logic
 * Wraps the pure sitemap parser with application-specific filtering
 */
async function parseSitemapWithFiltering(xml, baseUrl) {
  const links = new Set();
  const sitemaps = new Set();
  const base = new URL(baseUrl);

  // Parse sitemap to get raw URLs
  const { urls, sitemaps: sitemapUrls } = await parseSitemap(xml, baseUrl);

  // Filter page URLs through domain logic
  for (const url of urls) {
    addLink(links, url, baseUrl, base);
  }

  // Filter sitemap URLs through domain logic
  for (const sitemapUrl of sitemapUrls) {
    addSitemapLink(sitemaps, sitemapUrl, baseUrl, base);
  }

  // Log results
  if (sitemapUrls.length > 0) {
    console.error(`[sitemap] ${baseUrl}: found ${sitemapUrls.length} sub-sitemaps, ${sitemaps.size} after domain filtering`);
  }
  if (urls.length > 0) {
    console.error(`[sitemap] ${baseUrl}: found ${urls.length} URLs, ${links.size} after domain filtering`);
  }
  if (sitemapUrls.length === 0 && urls.length === 0) {
    console.error(`[sitemap] ${baseUrl}: no URLs or sitemaps found`);
  }

  return { links, sitemaps };
}

/**
 * Process response body and extract links
 * Auto-detects sitemaps from XML responses
 */
async function processResponseBody(body, contentType, url, isSitemap = false) {
  const ct = contentType.toLowerCase();
  let links = new Set();
  let sitemaps = new Set();
  let isHtml = false;
  let isSitemapDetected = false;

  // Auto-detect and parse sitemap XML
  // This handles both explicit sitemap requests and starting URLs that are sitemaps
  // Only parse XML content types that could be sitemaps (not SVG, RSS, Atom, etc.)
  const isSitemapContentType = ct.includes("application/xml") ||
                                ct.includes("text/xml") ||
                                (ct.includes("text/plain") && isSitemap);

  if (isSitemapContentType) {
    console.error(`[sitemap] attempting to parse ${url} (content-type: ${contentType})`);
    const result = await parseSitemapWithFiltering(body, url);
    links = result.links;
    sitemaps = result.sitemaps;
    console.error(`[sitemap] parsed ${url}: found ${links.size} URLs, ${sitemaps.size} sub-sitemaps`);
    // If we found sitemap content, mark as detected
    if (links.size > 0 || sitemaps.size > 0) {
      isSitemapDetected = true;
    }
  }
  // Parse HTML for full link extraction (only if not a sitemap)
  else if (ct.includes("text/html")) {
    const result = extractLinks(body, url);
    links = result.links;
    sitemaps = result.sitemaps;
    isHtml = isHtmlType(contentType);
  }
  // Also extract URLs from JS and CSS (but these are not "documents" we track)
  else if (!contentOnly && (ct.includes("javascript") || ct.includes("text/css"))) {
    const base = new URL(url);
    extractUrlsFromText(links, body, url, base);
  }

  return { isHtml, links, sitemaps, isSitemapDetected };
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
    const { url, attempts, canFallbackToHttp, canFallbackToNoPort, cameFromAdditionalHost, isSitemap } = item;

    if (isSitemap) {
      console.error(`[sitemap] parsing: ${url}`);
    }

    // Track if this is the expected URL or WTF URL
    const isExpected = expectTracking.normalized === url;
    const isWtf = wtfTracking.normalized === url;

    // Fetch raw HTTP response
    const fetchResult = await fetchWithRetry(url, attempts, canFallbackToHttp, canFallbackToNoPort, cache, {
      maxRetries,
      preferPort
    });

    if (isExpected) {
      expectTracking.fetched = true;
      expectTracking.fetchResult = fetchResult.retry ? 'retry' : (fetchResult.error ? 'error' : 'ok');
    }

    if (isWtf) {
      wtfTracking.fetched = true;
      wtfTracking.fetchResult = fetchResult.retry ? 'retry' : (fetchResult.error ? 'error' : 'ok');
    }

    if (fetchResult.retry) {
      // Only log retries for HTML pages (we don't know yet, so always log)
      console.error(`[retry ${attempts + 1}/${maxRetries}] ${url} (${fetchResult.error})`);
      queue.push({ url, attempts: attempts + 1, canFallbackToHttp, canFallbackToNoPort, cameFromAdditionalHost, isSitemap });
    } else if (fetchResult.error) {
      if (isExpected) {
        expectTracking.fetchResult = `error: ${fetchResult.error}`;
      }
      // Only track failed HTML pages - but we don't know content type for failed requests
      // For now, assume potentially HTML if path looks like document (no extension or .html/.htm/.php etc)
      if (looksLikeHtmlUrl(url)) {
        const refs = referrers.get(url);
        const refInfo = refs && refs.size > 0 ? ` from ${refs.size} page(s)` : "";
        console.error(`[failed] ${url} (${fetchResult.error})${refInfo}`);
        failed.set(url, { lastError: fetchResult.error });
      }
    } else {
      // Success - process response based on content type and sitemap flag
      const { isHtml, links, sitemaps, isSitemapDetected } = await processResponseBody(
        fetchResult.body,
        fetchResult.contentType,
        url,
        isSitemap || false
      );

      if (isExpected) {
        expectTracking.contentType = fetchResult.contentType;
        expectTracking.isHtml = isHtml;
        expectTracking.isSitemap = isSitemapDetected;
      }

      // Only track HTML documents (not sitemaps)
      if (isHtml && !isSitemapDetected && !discovered.has(url)) {
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
        const cacheIndicator = fetchResult.fromCache ? " [cached]" : "";
        console.log(url + cacheIndicator);

        if (isExpected) {
          expectTracking.addedToDiscovered = true;
        }

        if (isWtf) {
          wtfTracking.addedToDiscovered = true;
        }

        // Track HTML hashes for trafilatura
        if (trafilaturaDir) {
          htmlHashes.add(hashUrl(url));
        }
      }
      // Enqueue discovered links regardless of content type
      // Links are already normalized by addLink -> normalizeUrl, so port is added
      for (const link of links) {
        enqueue(link);
      }
      // Enqueue discovered sitemaps for parsing
      for (const sitemap of sitemaps) {
        console.error(`[sitemap] discovered: ${sitemap.url}`);
        enqueue(sitemap);
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
  // Initialize expected URL tracking if -x is specified
  if (expectUrl) {
    const normalized = normalizeUrl(expectUrl);
    if (normalized) {
      expectTracking.normalized = normalized;
      console.error(`[expect] Tracking: ${expectUrl}`);
      console.error(`[expect] Normalized: ${normalized}`);
    } else {
      console.error(`[expect] Failed to normalize: ${expectUrl}`);
    }
  }

  // Initialize WTF URL tracking if -w is specified
  if (wtfUrl) {
    const normalized = normalizeUrl(wtfUrl);
    if (normalized) {
      wtfTracking.normalized = normalized;
      console.error(`[wtf] Tracking: ${wtfUrl}`);
      console.error(`[wtf] Normalized: ${normalized}`);
    } else {
      console.error(`[wtf] Failed to normalize: ${wtfUrl}`);
    }
  }

  // Initialize cache/bodies service if -s, -b, or -t is specified
  if (storeDir || bodiesDir || trafilaturaDir) {
    cache = new HttpCache(storeDir || null, bodiesDir);
    if (storeDir) {
      console.error(`[cache] enabled at ${storeDir}`);
    }
    if (bodiesDir) {
      console.error(`[bodies] enabled at ${bodiesDir}`);
    }
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
  progressReporter();

  // Wait until queue is empty and no requests in flight
  while (queue.length > 0 || inFlight > 0) {
    await Bun.sleep(100);
  }

  done = true;
  await Promise.all(workers);

  console.error(`\n[done] discovered=${discovered.size} failed=${failed.size}`);

  if (outputFile) {
    // Create directory for output file if needed
    const outputDir = join(outputFile, '..');
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    const sorted = [...discovered].sort();
    writeFileSync(outputFile, sorted.join("\n") + "\n");
    console.error(`[saved] ${outputFile}`);
  }

  // Save fixer-uppers mapping if any (relative to cache dir)
  if (storeDir && fixerUppers.size > 0) {
    const detailDir = join(storeDir, '..', '.katamap-detail');
    if (!existsSync(detailDir)) {
      mkdirSync(detailDir, { recursive: true });
    }
    const fixerUppersFile = join(detailDir, 'fixer-uppers.json');
    const fixerUppersObj = Object.fromEntries(fixerUppers);
    writeFileSync(fixerUppersFile, JSON.stringify(fixerUppersObj, null, 2) + "\n");
    console.error(`[saved] ${fixerUppersFile} (${fixerUppers.size} mappings)`);
  }

  if (failedFile && failed.size > 0) {
    // Create directory for failed file if needed
    const failedDir = join(failedFile, '..');
    if (!existsSync(failedDir)) {
      mkdirSync(failedDir, { recursive: true });
    }
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

  // Run trafilatura extraction if requested
  if (trafilaturaDir && htmlHashes.size > 0) {
    await extractWithTrafilatura(trafilaturaDir, bodiesDir, htmlHashes);
  }

  // Report on expected URL if specified
  if (expectUrl) {
    console.error(`\n[expect] Analysis for: ${expectUrl}`);

    if (!expectTracking.normalized) {
      console.error(`[expect] FAILED: Could not normalize URL`);
    } else if (expectTracking.addedToDiscovered) {
      console.error(`[expect] SUCCESS: URL was discovered and recorded`);
    } else {
      console.error(`[expect] FAILED: URL was not recorded in output`);
      console.error(`[expect] Normalized to: ${expectTracking.normalized}`);

      if (expectTracking.filtered) {
        console.error(`[expect] Reason: Filtered during link extraction - ${expectTracking.filtered}`);
      } else if (!expectTracking.seen) {
        console.error(`[expect] Reason: URL was never discovered/linked to`);
        const refs = referrers.get(expectTracking.normalized);
        if (refs && refs.size > 0) {
          console.error(`[expect] Note: URL had ${refs.size} referrer(s) but still not queued`);
          for (const ref of refs) {
            console.error(`[expect]   - ${ref}`);
          }
        } else {
          console.error(`[expect] Note: No pages linked to this URL`);
        }
      } else if (!expectTracking.fetched) {
        console.error(`[expect] Reason: URL was queued but never fetched (still in queue?)`);
      } else if (expectTracking.fetchResult !== 'ok') {
        console.error(`[expect] Reason: Fetch failed - ${expectTracking.fetchResult}`);
      } else if (expectTracking.isSitemap) {
        console.error(`[expect] Reason: URL returned sitemap XML, not HTML`);
      } else if (!expectTracking.isHtml) {
        console.error(`[expect] Reason: URL did not return HTML content`);
        console.error(`[expect] Content-Type: ${expectTracking.contentType || 'unknown'}`);
      } else {
        console.error(`[expect] Reason: Unknown (isHtml=${expectTracking.isHtml}, sitemap=${expectTracking.isSitemap})`);
      }
    }
  }

  // Report on WTF URL if specified
  if (wtfUrl) {
    console.error(`\n[wtf] Analysis for: ${wtfUrl}`);

    if (!wtfTracking.normalized) {
      console.error(`[wtf] Could not normalize URL`);
    } else {
      console.error(`[wtf] Normalized to: ${wtfTracking.normalized}`);

      // Show referrers (who's linking to this URL)
      const refs = referrers.get(wtfTracking.normalized);
      if (refs && refs.size > 0) {
        console.error(`[wtf] Referenced by ${refs.size} page(s):`);
        for (const ref of refs) {
          console.error(`[wtf]   - ${ref}`);
        }
      } else {
        console.error(`[wtf] No pages linked to this URL`);
      }

      // Show discovery status
      if (wtfTracking.seen) {
        console.error(`[wtf] Status: URL was queued for crawling`);
      } else {
        console.error(`[wtf] Status: URL was NOT queued (filtered or wrong domain)`);
      }

      if (wtfTracking.fetched) {
        console.error(`[wtf] Status: URL was fetched (${wtfTracking.fetchResult})`);
      } else if (wtfTracking.seen) {
        console.error(`[wtf] Status: URL was queued but not fetched`);
      }

      if (wtfTracking.addedToDiscovered) {
        console.error(`[wtf] Status: URL was added to discovered set (recorded in output)`);
      } else if (wtfTracking.fetched && wtfTracking.fetchResult === 'ok') {
        console.error(`[wtf] Status: URL was fetched successfully but NOT added to discovered (not HTML or was sitemap)`);
      }
    }
  }

  // Clean up temp bodies directory if it was created
  if (tempBodiesDir) {
    console.error(`[trafilatura] cleaning up temp dir: ${tempBodiesDir}`);
    rmSync(tempBodiesDir, { recursive: true, force: true });
  }
}

main();
