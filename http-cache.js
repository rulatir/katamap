/**
 * Persistent HTTP response cache service
 * Caches responses by URL hash to disk
 */

import { createHash } from "crypto";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

/**
 * Generate a hash key for a URL
 */
export function hashUrl(url) {
  return createHash("sha256").update(url).digest("hex");
}

export class HttpCache {
  constructor(cacheDir, bodiesDir = null) {
    this.cacheDir = cacheDir;
    this.bodiesDir = bodiesDir;
    // Create cache directory if it doesn't exist (cacheDir can be null for bodies-only mode)
    if (cacheDir && !existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    // Create bodies directory if specified
    if (bodiesDir && !existsSync(bodiesDir)) {
      mkdirSync(bodiesDir, { recursive: true });
    }
  }

  /**
   * Generate a hash key for a URL
   */
  _hashUrl(url) {
    return hashUrl(url);
  }

  /**
   * Get cached response for a URL
   * @returns {Object|null} Cached response object or null if not found
   */
  get(url) {
    // No caching if cacheDir is null
    if (!this.cacheDir) {
      return null;
    }

    const hash = this._hashUrl(url);
    const cachePath = join(this.cacheDir, hash);

    if (!existsSync(cachePath)) {
      return null;
    }

    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
      // Write body file if bodiesDir is configured
      if (this.bodiesDir && cached.body !== undefined) {
        const bodyPath = join(this.bodiesDir, hash);
        try {
          writeFileSync(bodyPath, cached.body, "utf-8");
        } catch (e) {
          console.error(`[bodies-error] Failed to write body for ${url}: ${e.message}`);
        }
      }
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

    // Write cache file if cacheDir is configured
    if (this.cacheDir) {
      const cachePath = join(this.cacheDir, hash);
      try {
        const cacheData = {
          url,
          timestamp: new Date().toISOString(),
          ...response
        };
        writeFileSync(cachePath, JSON.stringify(cacheData), "utf-8");
      } catch (e) {
        console.error(`[cache-error] Failed to write cache for ${url}: ${e.message}`);
      }
    }

    // Write body file if bodiesDir is configured
    if (this.bodiesDir && response.body !== undefined) {
      const bodyPath = join(this.bodiesDir, hash);
      try {
        writeFileSync(bodyPath, response.body, "utf-8");
      } catch (e) {
        console.error(`[bodies-error] Failed to write body for ${url}: ${e.message}`);
      }
    }
  }
}
