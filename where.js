#!/usr/bin/env bun
/**
 * Find where bad URLs are referenced.
 * Crawls from starting URL and reports which pages contain links to the bad URLs.
 */

import { parseArgs } from "util";
import { readFileSync, writeFileSync } from "fs";
import { parse as parseHtml } from "node-html-parser";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    bad: { type: "string", short: "b" },
    output: { type: "string", short: "o" },
    concurrency: { type: "string", short: "c", default: "20" },
    groupBy: { type: "string", short: "g" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help || positionals.length < 1 || !values.bad) {
  console.error(`Usage: where.js <start_url> -b <bad_urls_file> [-o output.txt] [-c concurrency] [-g param1,param2,...]

Find pages that contain references to "bad" URLs.

Required:
  <start_url>         URL to start crawling from
  -b, --bad <file>    File containing bad URLs (one per line)

Optional:
  -o, --output <file> Output file (default: stdout)
  -c, --concurrency   Number of concurrent fetchers (default: 20)
  -g, --groupBy       Comma-separated query params to group bad URLs by
  -h, --help          Show this help
`);
  process.exit(values.help ? 0 : 1);
}

const startUrl = positionals[0];
const badUrlsFile = values.bad;
const outputFile = values.output;
const concurrency = parseInt(values.concurrency, 10);
const groupByParams = values.groupBy ? values.groupBy.split(",").map(p => p.trim()) : [];

// Extract group key from URL based on groupByParams
function getGroupKey(url) {
  if (groupByParams.length === 0) return null;
  try {
    const u = new URL(url);
    const parts = [];
    for (const param of groupByParams) {
      const val = u.searchParams.get(param);
      if (val !== null) {
        parts.push(`${param}=${val}`);
      }
    }
    return parts.length > 0 ? parts.join("&") : "(no matching params)";
  } catch {
    return "(invalid url)";
  }
}

// Load bad URLs
const badUrlsList = readFileSync(badUrlsFile, "utf-8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

const badUrls = new Set(
  badUrlsList
    .map((url) => normalizeUrl(url))
    .filter(Boolean)
);

// Map from group key -> Set of bad URLs in that group
const badUrlGroups = new Map();
for (const url of badUrlsList) {
  const norm = normalizeUrl(url);
  if (!norm) continue;
  const key = getGroupKey(norm) || "(ungrouped)";
  if (!badUrlGroups.has(key)) {
    badUrlGroups.set(key, new Set());
  }
  badUrlGroups.get(key).add(norm);
}

console.error(`[info] Loaded ${badUrls.size} bad URLs from ${badUrlsFile}`);
if (groupByParams.length > 0) {
  console.error(`[info] Grouping by: ${groupByParams.join(", ")}`);
  console.error(`[info] Found ${badUrlGroups.size} group(s)`);
}

// Also create patterns for matching (without protocol/port variations)
const badPatterns = new Set();
for (const url of badUrls) {
  try {
    const u = new URL(url);
    // Add pathname + search as pattern (for matching regardless of protocol/port)
    badPatterns.add(u.pathname + u.search);
  } catch {}
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

// Decode common HTML entities in URLs
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function extractAllRefs(html, baseUrl) {
  const refs = new Set();
  try {
    const root = parseHtml(html);

    // All href and src attributes
    for (const el of root.querySelectorAll("[href], [src], [action], [data-url], [data-href], [data-src]")) {
      for (const attr of ["href", "src", "action", "data-url", "data-href", "data-src"]) {
        const val = el.getAttribute(attr);
        if (val) refs.add(decodeHtmlEntities(val));
      }
    }

    // srcset
    for (const el of root.querySelectorAll("[srcset]")) {
      const srcset = el.getAttribute("srcset") || "";
      for (const part of srcset.split(",")) {
        const url = part.trim().split(/\s+/)[0];
        if (url) refs.add(decodeHtmlEntities(url));
      }
    }

    // Extract from inline text (JS/CSS)
    extractRefsFromText(html, refs);
  } catch {}
  return refs;
}

function extractRefsFromText(text, refs) {
  const patterns = [
    /["'](\/[a-zA-Z0-9_\-\/\.]+?)["']/g,
    /["'](https?:\/\/[^"'\s<>]+?)["']/g,
    /url\s*\(\s*["']?([^"'\)\s]+)["']?\s*\)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const url = match[1];
      if (url && url.length >= 2 && !url.includes("${") && !url.includes("{{")) {
        refs.add(url);
      }
    }
  }
}

function resolveRef(ref, baseUrl) {
  try {
    if (ref.startsWith("//")) {
      return new URL("https:" + ref).href;
    }
    return new URL(ref, baseUrl).href;
  } catch {
    return null;
  }
}

function findMatchingBadUrl(ref, baseUrl) {
  // Check if ref matches any bad URL, return the matched bad URL or null
  const resolved = resolveRef(ref, baseUrl);
  if (resolved) {
    const norm = normalizeUrl(resolved);
    if (norm && badUrls.has(norm)) return norm;

    // Also check by pathname pattern
    try {
      const u = new URL(resolved);
      const pattern = u.pathname + u.search;
      if (badPatterns.has(pattern)) {
        // Find the actual bad URL that matches this pattern
        for (const badUrl of badUrls) {
          try {
            const bu = new URL(badUrl);
            if (bu.pathname + bu.search === pattern) return badUrl;
          } catch {}
        }
      }
    } catch {}
  }

  // Check raw ref against patterns (for relative URLs)
  if (ref.startsWith("/")) {
    const pattern = ref.split("#")[0]; // remove fragment
    if (badPatterns.has(pattern)) {
      // Find the actual bad URL that matches this pattern
      for (const badUrl of badUrls) {
        try {
          const bu = new URL(badUrl);
          if (bu.pathname + bu.search === pattern) return badUrl;
        } catch {}
      }
    }
  }

  return null;
}

// State
const seen = new Set();
const queue = [];
// results: pageUrl -> Map of (groupKey -> Set of bad refs found)
const results = new Map();

let inFlight = 0;
let done = false;

function enqueue(url) {
  const norm = normalizeUrl(url);
  if (norm && !seen.has(norm)) {
    seen.add(norm);
    queue.push(norm);
  }
}

async function fetchPage(url) {
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Crawler/1.0)",
      },
    });

    if (!resp.ok) return null;

    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;

    return await resp.text();
  } catch {
    return null;
  }
}

async function worker() {
  const startHost = new URL(startUrl).hostname;

  while (!done) {
    const url = queue.shift();
    if (!url) {
      await Bun.sleep(50);
      continue;
    }

    inFlight++;

    const html = await fetchPage(url);
    if (html) {
      const refs = extractAllRefs(html, url);
      // Map: groupKey -> Set of bad refs
      const badRefsByGroup = new Map();

      for (const ref of refs) {
        const matchedBadUrl = findMatchingBadUrl(ref, url);
        if (matchedBadUrl) {
          const groupKey = getGroupKey(matchedBadUrl) || "(ungrouped)";
          if (!badRefsByGroup.has(groupKey)) {
            badRefsByGroup.set(groupKey, new Set());
          }
          badRefsByGroup.get(groupKey).add(ref);
        }

        // Also enqueue internal links for crawling
        const resolved = resolveRef(ref, url);
        if (resolved) {
          try {
            const u = new URL(resolved);
            if (u.hostname === startHost) {
              enqueue(resolved);
            }
          } catch {}
        }
      }

      if (badRefsByGroup.size > 0) {
        results.set(url, badRefsByGroup);
        const totalBadRefs = [...badRefsByGroup.values()].reduce((sum, set) => sum + set.size, 0);
        console.error(`[found] ${url} -> ${totalBadRefs} bad ref(s) in ${badRefsByGroup.size} group(s)`);
      }
    }

    inFlight--;
  }
}

async function progressReporter() {
  while (!done) {
    await Bun.sleep(2000);
    console.error(`[progress] queue=${queue.length} inFlight=${inFlight} scanned=${seen.size} pagesWithBadRefs=${results.size}`);
  }
}

async function main() {
  console.error(`[start] ${startUrl} (concurrency=${concurrency})`);

  enqueue(startUrl);

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }

  progressReporter();

  while (queue.length > 0 || inFlight > 0) {
    await Bun.sleep(100);
  }

  done = true;
  await Promise.all(workers);

  console.error(`\n[done] scanned=${seen.size} pagesWithBadRefs=${results.size}`);

  // Build output grouped by bad URL group
  let output = "";

  if (groupByParams.length > 0) {
    // Group output: group -> pages -> refs
    const groupedOutput = new Map(); // groupKey -> Map of (pageUrl -> Set of refs)

    for (const [pageUrl, badRefsByGroup] of results) {
      for (const [groupKey, refs] of badRefsByGroup) {
        if (!groupedOutput.has(groupKey)) {
          groupedOutput.set(groupKey, new Map());
        }
        const pagesMap = groupedOutput.get(groupKey);
        if (!pagesMap.has(pageUrl)) {
          pagesMap.set(pageUrl, new Set());
        }
        for (const ref of refs) {
          pagesMap.get(pageUrl).add(ref);
        }
      }
    }

    const lines = [];
    for (const groupKey of [...groupedOutput.keys()].sort()) {
      lines.push(`\n=== GROUP: ${groupKey} ===`);
      const pagesMap = groupedOutput.get(groupKey);
      for (const pageUrl of [...pagesMap.keys()].sort()) {
        const refs = pagesMap.get(pageUrl);
        for (const ref of [...refs].sort()) {
          lines.push(`${pageUrl}\t${ref}`);
        }
      }
    }
    output = lines.join("\n") + "\n";
  } else {
    // Flat output (no grouping)
    const lines = [];
    for (const [pageUrl, badRefsByGroup] of [...results.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const [_, refs] of badRefsByGroup) {
        for (const ref of [...refs].sort()) {
          lines.push(`${pageUrl}\t${ref}`);
        }
      }
    }
    output = lines.join("\n") + (lines.length ? "\n" : "");
  }

  if (outputFile) {
    writeFileSync(outputFile, output);
    console.error(`[saved] ${outputFile}`);
  } else {
    process.stdout.write(output);
  }
}

main();

