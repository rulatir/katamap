/**
 * Sitemap parser using battle-tested SAX streaming XML parser
 * Parses both regular sitemaps (<urlset>) and hierarchical sitemap indexes (<sitemapindex>)
 */

import { Readable } from "stream";
import sax from "sax";

/**
 * Parse sitemap XML and extract URLs
 *
 * @param {string} xml - The XML content to parse
 * @param {string} baseUrl - Base URL for resolving relative URLs (not used currently, all sitemap URLs should be absolute)
 * @returns {Promise<{urls: string[], sitemaps: string[]}>} URLs from <urlset> and sub-sitemap URLs from <sitemapindex>
 */
export function parseSitemap(xml, baseUrl) {
  return new Promise((resolve) => {
    const urls = [];
    const sitemaps = [];

    let inLoc = false;
    let inSitemap = false; // Track if we're in a <sitemap> element (for sitemapindex)
    let inUrl = false; // Track if we're in a <url> element (for urlset)
    let currentLoc = '';

    const parserStream = sax.createStream(false, {
      trim: true,
      normalize: true,
      lowercase: true
    });

    parserStream.on('opentag', (node) => {
      if (node.name === 'loc') {
        inLoc = true;
        currentLoc = '';
      } else if (node.name === 'sitemap') {
        inSitemap = true;
      } else if (node.name === 'url') {
        inUrl = true;
      }
    });

    parserStream.on('text', (text) => {
      if (inLoc) {
        currentLoc += text;
      }
    });

    parserStream.on('closetag', (tagName) => {
      if (tagName === 'loc' && currentLoc) {
        // In sitemapindex, <loc> inside <sitemap> is a sub-sitemap
        if (inSitemap) {
          sitemaps.push(currentLoc);
        }
        // In urlset, <loc> inside <url> is a page URL
        else if (inUrl) {
          urls.push(currentLoc);
        }
        inLoc = false;
        currentLoc = '';
      } else if (tagName === 'sitemap') {
        inSitemap = false;
      } else if (tagName === 'url') {
        inUrl = false;
      }
    });

    parserStream.on('end', () => {
      resolve({ urls, sitemaps });
    });

    parserStream.on('error', (err) => {
      // On parse error, return what we've collected so far
      console.error(`[sitemap-parse-error] ${baseUrl}: ${err.message}`);
      resolve({ urls, sitemaps });
    });

    // Pipe XML string through parser
    const stream = Readable.from([xml]);
    stream.pipe(parserStream);
  });
}
