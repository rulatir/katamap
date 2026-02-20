/**
 * Application HTTP fetcher with authority normalization and retry logic
 *
 * Handles:
 * - Cache checking/storage
 * - Transient error retries (408, 429, 5xx)
 * - Authority fallbacks (port removal, https->http downgrade)
 * - Timeout handling
 */

/**
 * Fetch URL with retry logic and authority fallbacks
 *
 * @param {string} url - URL to fetch
 * @param {number} attempts - Current attempt number (0-indexed)
 * @param {boolean} canFallbackToHttp - Whether to try http if https fails
 * @param {boolean} canFallbackToNoPort - Whether to try without port if port fails
 * @param {Object|null} cache - Optional cache service with get/set methods
 * @param {Object} options - Configuration options
 * @param {number} options.maxRetries - Maximum retry attempts for transient errors
 * @param {string|null} options.preferPort - Preferred port (for fallback detection)
 * @param {number} options.timeout - Request timeout in milliseconds
 * @param {string} options.userAgent - User agent string
 * @param {boolean} triedHttpFallback - Internal: whether http fallback was attempted
 * @param {boolean} triedNoPortFallback - Internal: whether no-port fallback was attempted
 * @returns {Promise<Object>} Response object: { ok, status, contentType, body, fetchedUrl, fromCache } or { retry, error } or { error }
 */
export async function fetchWithRetry(
  url,
  attempts,
  canFallbackToHttp,
  canFallbackToNoPort,
  cache = null,
  options = {},
  triedHttpFallback = false,
  triedNoPortFallback = false
) {
  const {
    maxRetries = 3,
    preferPort = null,
    timeout = 30000,
    userAgent = "Mozilla/5.0 (compatible; Crawler/1.0)"
  } = options;

  const TRANSIENT_CODES = [408, 429, 500, 502, 503, 504];

  // Check cache first
  if (cache) {
    const cached = cache.get(url);
    if (cached) {
      return {
        ok: true,
        status: cached.status,
        contentType: cached.contentType,
        body: cached.body,
        fetchedUrl: url,
        fromCache: true
      };
    }
  }

  try {
    const resp = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
      headers: {
        "User-Agent": userAgent,
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

    return { ok: true, status: resp.status, contentType, body, fetchedUrl: url };
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
          return fetchWithRetry(noPortUrl, attempts, canFallbackToHttp, canFallbackToNoPort, cache, options, triedHttpFallback, true);
        }
      } catch {}
    }

    // Then try https->http fallback if URL was originally discovered as http
    if (canFallbackToHttp && !triedHttpFallback && url.startsWith("https://")) {
      const httpUrl = url.replace("https://", "http://");
      console.error(`[https-failed] ${url} (${msg}), trying http...`);
      return fetchWithRetry(httpUrl, attempts, canFallbackToHttp, canFallbackToNoPort, cache, options, true, triedNoPortFallback);
    }

    // Retry on network errors
    if (attempts < maxRetries) {
      return { retry: true, error: msg };
    }
    return { error: msg };
  }
}
