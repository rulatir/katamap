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

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    output: { type: "string", short: "o" },
    failed: { type: "string", short: "f" },
    concurrency: { type: "string", short: "c", default: "20" },
    retries: { type: "string", short: "r", default: "3" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help || positionals.length < 1) {
  console.error(`Usage: crawler.js <start_url> [-o output.txt] [-f failed.txt] [-c concurrency] [-r retries]`);
  process.exit(values.help ? 0 : 1);
}

const startUrl = positionals[0];
const outputFile = values.output;
const failedFile = values.failed;
const concurrency = parseInt(values.concurrency, 10);
const maxRetries = parseInt(values.retries, 10);

// If starting URL is https, prefer https for all discovered URLs
const preferHttps = startUrl.startsWith("https://");

// Document content types
const DOC_TYPES = [
  "text/html",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/rtf",
  "text/rtf",
  "application/msword",
  "application/vnd.ms-word",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.oasis.opendocument",
];

function isDocumentType(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase().split(";")[0].trim();
  return DOC_TYPES.some((t) => ct === t || ct.startsWith(t));
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Prefer https: upgrade http to https if in preferHttps mode
    if (preferHttps && u.protocol === "http:") {
      u.protocol = "https:";
    }
    // Remove trailing slash except for root
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    // Remove fragment
    u.hash = "";
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

    // Standard link elements
    for (const el of root.querySelectorAll("a[href], link[href]")) {
      addLink(links, el.getAttribute("href"), baseUrl, base);
    }

    // Forms
    for (const el of root.querySelectorAll("form[action]")) {
      addLink(links, el.getAttribute("action"), baseUrl, base);
    }

    // Scripts, images, iframes, etc.
    for (const el of root.querySelectorAll("script[src], img[src], iframe[src], video[src], audio[src], source[src], embed[src]")) {
      addLink(links, el.getAttribute("src"), baseUrl, base);
    }

    // Data attributes that often contain URLs
    for (const el of root.querySelectorAll("[data-url], [data-href], [data-src], [data-link]")) {
      addLink(links, el.getAttribute("data-url"), baseUrl, base);
      addLink(links, el.getAttribute("data-href"), baseUrl, base);
      addLink(links, el.getAttribute("data-src"), baseUrl, base);
      addLink(links, el.getAttribute("data-link"), baseUrl, base);
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

    // Extract URLs from inline scripts and style blocks
    const text = html;
    extractUrlsFromText(links, text, baseUrl, base);

  } catch {}
  return links;
}

function addLink(links, href, baseUrl, base) {
  if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("data:")) return;
  try {
    const resolved = new URL(href, baseUrl);
    // Same origin only
    if (resolved.hostname === base.hostname) {
      const norm = normalizeUrl(resolved.href);
      if (norm) links.add(norm);
    }
  } catch {}
}

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
const failed = new Map();        // url -> { attempts, lastError }
const queue = [];                // URLs to fetch: { url, attempts, canFallbackToHttp }
let inFlight = 0;
let done = false;

// Add URL to queue if not seen
function enqueue(url) {
  // Track if originally discovered as http (before normalization upgrades to https)
  const wasHttp = url.startsWith("http://");
  const norm = normalizeUrl(url);
  if (norm && !seen.has(norm)) {
    seen.add(norm);
    // Can only fallback to http if it was originally discovered as http
    queue.push({ url: norm, attempts: 0, canFallbackToHttp: wasHttp });
  }
}

// Retry-aware fetch with https->http fallback (only if originally discovered as http)
async function fetchWithRetry(url, attempts, canFallbackToHttp, triedHttpFallback = false) {
  const TRANSIENT_CODES = [408, 429, 500, 502, 503, 504];

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
    const isDoc = isDocumentType(contentType);
    const ct = contentType.toLowerCase();

    let links = new Set();
    // Parse HTML for full link extraction
    if (ct.includes("text/html")) {
      const html = await resp.text();
      links = extractLinks(html, url);
    }
    // Also extract URLs from JS and CSS
    else if (ct.includes("javascript") || ct.includes("text/css")) {
      const text = await resp.text();
      const base = new URL(url);
      extractUrlsFromText(links, text, url, base);
    }

    return { ok: true, isDoc, links };
  } catch (e) {
    const msg = e.message || String(e);

    // If https failed and this URL was originally discovered as http, try http fallback
    if (canFallbackToHttp && !triedHttpFallback && url.startsWith("https://")) {
      const httpUrl = url.replace("https://", "http://");
      console.error(`[https-failed] ${url} (${msg}), trying http...`);
      return fetchWithRetry(httpUrl, attempts, canFallbackToHttp, true);
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
    const { url, attempts, canFallbackToHttp } = item;

    const result = await fetchWithRetry(url, attempts, canFallbackToHttp);

    if (result.retry) {
      console.error(`[retry ${attempts + 1}/${maxRetries}] ${url} (${result.error})`);
      queue.push({ url, attempts: attempts + 1, canFallbackToHttp });
    } else if (result.error) {
      console.error(`[failed] ${url} (${result.error})`);
      failed.set(url, { attempts, lastError: result.error });
    } else {
      if (result.isDoc && !discovered.has(url)) {
        discovered.add(url);
        console.log(url);
      }
      // Enqueue discovered links
      for (const link of result.links) {
        enqueue(link);
      }
    }

    inFlight--;
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
  console.error(`[start] ${startUrl} (concurrency=${concurrency}, retries=${maxRetries})`);

  enqueue(startUrl);

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
    const lines = [...failed.entries()]
      .map(([url, info]) => `${url}\t${info.lastError}`)
      .sort();
    writeFileSync(failedFile, lines.join("\n") + "\n");
    console.error(`[saved] ${failedFile}`);
  }
}

main();
