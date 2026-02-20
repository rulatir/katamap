# Fetcher

HTTP fetcher with cache, retry logic, and authority fallbacks for development scenarios.

## API

### `fetchWithRetry(url, attempts, canFallbackToHttp, canFallbackToNoPort, cache, options, triedHttpFallback, triedNoPortFallback)`

**Parameters:**
- `url` (string): URL to fetch
- `attempts` (number): Current attempt number (0-indexed)
- `canFallbackToHttp` (boolean): Try http if https fails
- `canFallbackToNoPort` (boolean): Try without port if port fails
- `cache` (Object|null): Cache service with `get(url)` and `set(url, {status, contentType, body})` methods
- `options` (Object): Configuration
  - `maxRetries` (number, default: 3): Max retry attempts for transient errors
  - `preferPort` (string|null, default: null): Preferred port for fallback detection
  - `timeout` (number, default: 30000): Request timeout in milliseconds
  - `userAgent` (string, default: "Mozilla/5.0 (compatible; Crawler/1.0)"): User agent
- `triedHttpFallback` (boolean, internal): Whether http fallback was attempted
- `triedNoPortFallback` (boolean, internal): Whether no-port fallback was attempted

**Returns:** `Promise<Object>`

Success: `{ ok: true, status, contentType, body, fetchedUrl, fromCache? }`
Retry: `{ retry: true, error }`
Error: `{ error }`

**Example:**
```javascript
import { fetchWithRetry } from "./fetcher.js";
import { HttpCache } from "./http-cache.js";

const cache = new HttpCache("./cache");
const result = await fetchWithRetry(
  "https://example.com",
  0, // first attempt
  true, // can fallback to http
  false, // cannot fallback to no-port
  cache,
  { maxRetries: 3, preferPort: "8080" }
);

if (result.ok) {
  console.log(result.body);
} else if (result.retry) {
  // Retry with attempts + 1
} else {
  console.error(result.error);
}
```

## Behavior

### Cache
1. Check cache first (if provided)
2. Return cached response if found
3. Store successful responses in cache

### Transient Errors
Retry on HTTP status codes: 408, 429, 500, 502, 503, 504

Returns `{ retry: true, error }` if attempts < maxRetries

### Authority Fallbacks

**Port fallback** (if `canFallbackToNoPort` && URL has `preferPort`):
```
https://example.com:8080/page (fails)
  → https://example.com/page
```

**Protocol fallback** (if `canFallbackToHttp` && URL is https):
```
https://example.com/page (fails)
  → http://example.com/page
```

Fallback order: port first, then protocol.

### Use Case

Development scenario:
- Site at `dev.example.com:8080` (cache bypass port)
- Sitemaps reference final domain `www.example.com`
- Internal links may incorrectly use `:80` instead of `:8080`
- `-d www.example.com` flag rewrites final domain to dev domain before fetching
- Authority fallbacks handle port mismatches

## Dependencies

- Native `fetch()`: HTTP client
- `AbortSignal`: Request timeout