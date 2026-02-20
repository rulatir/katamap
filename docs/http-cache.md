# HTTP Cache

Persistent disk-based cache for HTTP responses. Stores responses as JSON files keyed by URL hash.

## API

### `new HttpCache(cacheDir)`

Creates cache instance. Creates directory if it doesn't exist (recursive).

**Parameters:**
- `cacheDir` (string): Cache directory path

**Example:**
```javascript
import { HttpCache } from "./http-cache.js";

const cache = new HttpCache("./cache");
```

### `cache.get(url)`

Retrieve cached response for a URL.

**Parameters:**
- `url` (string): URL to look up

**Returns:** `Object|null`
- Cached response object if found
- `null` if not found or file is corrupted

**Example:**
```javascript
const cached = cache.get("https://example.com/page");
if (cached) {
  console.log(cached.status);       // 200
  console.log(cached.contentType);  // "text/html"
  console.log(cached.body);         // "<html>..."
  console.log(cached.timestamp);    // "2026-02-19T17:59:50.987Z"
}
```

### `cache.set(url, response)`

Store response in cache.

**Parameters:**
- `url` (string): URL being cached
- `response` (Object): Response data
  - `status` (number): HTTP status code
  - `contentType` (string): Content-Type header
  - `body` (string): Response body

**Example:**
```javascript
cache.set("https://example.com/page", {
  status: 200,
  contentType: "text/html",
  body: "<html>...</html>"
});
```

Silently fails on write errors (logs to stderr).

## Cache Format

### File Structure

```
cache-dir/
├── 5f4dcc3b5aa765d61d8327deb882cf99...  (SHA-256 hash of URL 1)
├── 098f6bcd4621d373cade4e832627b4f6...  (SHA-256 hash of URL 2)
└── ...
```

### File Naming

Filename = SHA-256 hash of URL (hex encoded, 64 characters)

Example:
```javascript
import { createHash } from "crypto";
const url = "https://example.com/page";
const hash = createHash("sha256").update(url).digest("hex");
// hash = "5f4dcc3b5aa765d61d8327deb882cf99..."
```

### File Content (JSON)

```json
{
  "url": "https://example.com/page",
  "timestamp": "2026-02-19T17:59:50.987Z",
  "status": 200,
  "contentType": "text/html; charset=utf-8",
  "body": "<!DOCTYPE html>..."
}
```

**Fields:**
- `url` (string): Original URL (for debugging/verification)
- `timestamp` (string): ISO 8601 timestamp when cached
- `status` (number): HTTP status code
- `contentType` (string): Content-Type header value
- `body` (string): Response body (text)

## Error Handling

**Read errors (corrupted files):**
- Returns `null`
- Treats as cache miss

**Write errors (disk full, permissions):**
- Logs to stderr: `[cache-error] Failed to write cache for {url}: {error}`
- Continues execution (non-fatal)

## Cache Invalidation

No automatic invalidation. Cache persists until:
- Directory is deleted manually
- Individual files are deleted manually

## Use Cases

**Development:** Avoid re-fetching during testing
```bash
./crawler.js -s ./cache https://example.com
./crawler.js -s ./cache https://example.com  # Much faster
```

**Production:** Cache expensive fetches across runs
```bash
./crawler.js -s /var/cache/crawler https://example.com
```

## Dependencies

- `crypto`: SHA-256 hashing
- `fs`: File I/O
- `path`: Path manipulation
