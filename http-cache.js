/**
 * Persistent HTTP response cache service
 * Caches responses by URL hash to disk
 */

import { createHash } from "crypto";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

export class HttpCache {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    // Create cache directory if it doesn't exist
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Generate a hash key for a URL
   */
  _hashUrl(url) {
    return createHash("sha256").update(url).digest("hex");
  }

  /**
   * Get cached response for a URL
   * @returns {Object|null} Cached response object or null if not found
   */
  get(url) {
    const hash = this._hashUrl(url);
    const cachePath = join(this.cacheDir, hash);

    if (!existsSync(cachePath)) {
      return null;
    }

    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
      return cached;
    } catch (e) {
      // If cache file is corrupted, treat as cache miss
      return null;
    }
  }

  /**
   * Store a response in the cache
   * @param {string} url - The URL being cached
   * @param {Object} response - Response object with status, contentType, body
   */
  set(url, response) {
    const hash = this._hashUrl(url);
    const cachePath = join(this.cacheDir, hash);

    try {
      const cacheData = {
        url,
        timestamp: new Date().toISOString(),
        ...response
      };
      writeFileSync(cachePath, JSON.stringify(cacheData), "utf-8");
    } catch (e) {
      // Silently fail on cache write errors
      console.error(`[cache-error] Failed to write cache for ${url}: ${e.message}`);
    }
  }
}
