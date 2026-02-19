#!/usr/bin/env bun
/**
 * Smoketest for HTTP cache
 */

import { HttpCache } from "./http-cache.js";
import { mkdirSync, rmSync } from "fs";

const TEST_URL = "http://example.com/";
const TEMP_DIR = "/tmp/crawler-cache-test";

console.log("=== HTTP Cache Smoketest ===\n");

// Create temp directory
console.log(`Creating temp cache directory: ${TEMP_DIR}`);
mkdirSync(TEMP_DIR, { recursive: true });

// Initialize cache
const cache = new HttpCache(TEMP_DIR);

// Test 1: Cache miss (fetch from network)
console.log("\n--- Test 1: Cache MISS ---");
console.log(`Fetching ${TEST_URL} (should be cache miss)`);
const resp1 = await fetch(TEST_URL, {
  headers: { "User-Agent": "Mozilla/5.0 (compatible; Crawler/1.0)" }
});
const body1 = await resp1.text();
const contentType1 = resp1.headers.get("content-type") || "";

console.log(`Status: ${resp1.status}`);
console.log(`Content-Type: ${contentType1}`);
console.log(`Body length: ${body1.length} bytes`);
console.log(`Body preview: ${body1.substring(0, 100)}...`);

// Store in cache
cache.set(TEST_URL, {
  status: resp1.status,
  contentType: contentType1,
  body: body1
});
console.log("✓ Stored in cache");

// Test 2: Cache hit (fetch from cache)
console.log("\n--- Test 2: Cache HIT ---");
console.log(`Fetching ${TEST_URL} (should be cache hit)`);
const cached = cache.get(TEST_URL);

if (!cached) {
  console.error("✗ FAILED: Expected cache hit, got cache miss!");
  process.exit(1);
}

console.log(`Status: ${cached.status}`);
console.log(`Content-Type: ${cached.contentType}`);
console.log(`Body length: ${cached.body.length} bytes`);
console.log(`Body preview: ${cached.body.substring(0, 100)}...`);
console.log(`Cached at: ${cached.timestamp}`);
console.log("✓ Retrieved from cache");

// Test 3: Compare bodies
console.log("\n--- Test 3: Compare Bodies ---");
if (body1 === cached.body) {
  console.log("✓ Bodies match exactly!");
} else {
  console.error("✗ FAILED: Bodies don't match!");
  console.error(`Original length: ${body1.length}`);
  console.error(`Cached length: ${cached.body.length}`);
  process.exit(1);
}

if (contentType1 === cached.contentType) {
  console.log("✓ Content-Types match!");
} else {
  console.error("✗ FAILED: Content-Types don't match!");
  console.error(`Original: ${contentType1}`);
  console.error(`Cached: ${cached.contentType}`);
  process.exit(1);
}

// Cleanup
console.log("\n--- Cleanup ---");
console.log(`Removing temp directory: ${TEMP_DIR}`);
rmSync(TEMP_DIR, { recursive: true, force: true });
console.log("✓ Cleanup complete");

console.log("\n=== All tests passed! ===");
