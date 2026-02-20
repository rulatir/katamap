# Sitemap Parser

Parses sitemap XML files (sitemaps.org protocol) and extracts URLs.

## API

### `parseSitemap(xml, baseUrl)`

**Parameters:**
- `xml` (string): XML content to parse
- `baseUrl` (string): URL for error logging

**Returns:** `Promise<{urls: string[], sitemaps: string[]}>`
- `urls`: Page URLs from `<urlset>/<url>/<loc>`
- `sitemaps`: Sub-sitemap URLs from `<sitemapindex>/<sitemap>/<loc>`

**Example:**
```javascript
import { parseSitemap } from "./sitemap-parser.js";

const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;

const { urls, sitemaps } = await parseSitemap(xml, "https://example.com/sitemap.xml");
// urls: ["https://example.com/page1", "https://example.com/page2"]
// sitemaps: []
```

**Hierarchical sitemaps (sitemapindex):**
```javascript
const indexXml = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
</sitemapindex>`;

const { urls, sitemaps } = await parseSitemap(indexXml, "https://example.com/sitemap.xml");
// urls: []
// sitemaps: ["https://example.com/sitemap-posts.xml", "https://example.com/sitemap-pages.xml"]
```

## Implementation

Uses SAX streaming XML parser. Tracks state with boolean flags (`inSitemap`, `inUrl`, `inLoc`) to determine context when closing `</loc>` tags.

On parse error: returns partial results and logs to stderr.

## Dependencies

- `sax`: Streaming XML parser
- `stream`: Node.js streams
