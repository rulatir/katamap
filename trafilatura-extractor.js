import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { cpus } from "os";

/**
 * Extract main content from HTML documents using trafilatura
 * @param {string} trafilaturaDir - Output directory for extracted content
 * @param {string} bodiesDir - Directory containing HTML body files
 * @param {Set<string>} htmlHashes - Set of URL hashes for HTML documents
 */
export async function extractWithTrafilatura(trafilaturaDir, bodiesDir, htmlHashes) {
  if (htmlHashes.size === 0) {
    console.error(`[trafilatura] no HTML documents to extract`);
    return;
  }

  console.error(`\n[trafilatura] extracting ${htmlHashes.size} HTML documents`);

  // Start HTTP server to serve bodies directory
  const server = Bun.serve({
    port: 0, // Let OS assign available port
    async fetch(req) {
      const url = new URL(req.url);
      const hash = url.pathname.slice(1); // Remove leading /
      if (!hash) {
        return new Response("Not found", { status: 404 });
      }
      const bodyPath = join(bodiesDir, hash);
      if (!existsSync(bodyPath)) {
        return new Response("Not found", { status: 404 });
      }
      try {
        const file = Bun.file(bodyPath);
        return new Response(file);
      } catch (e) {
        return new Response("Error reading file", { status: 500 });
      }
    }
  });

  const port = server.port;
  console.error(`[trafilatura] HTTP server started on port ${port}`);

  try {
    // Create trafilatura output directory
    if (!existsSync(trafilaturaDir)) {
      mkdirSync(trafilaturaDir, { recursive: true });
    }

    // Determine concurrency: max(1, cores - 1)
    const concurrency = Math.max(1, cpus().length - 1);
    console.error(`[trafilatura] using ${concurrency} parallel workers`);

    // Extract main content for each HTML document using worker pool
    let processed = 0;
    const hashArray = Array.from(htmlHashes);
    let nextIndex = 0;

    // Worker function to process a single hash
    const processHash = async (hash) => {
      const url = `http://127.0.0.1:${port}/${hash}`;
      const outputPath = join(trafilaturaDir, hash);

      try {
        const result = Bun.spawn(["trafilatura", "-u", url, "--recall"], {
          stdout: "pipe",
          stderr: "pipe"
        });

        const [output, stderr] = await Promise.all([
          new Response(result.stdout).text(),
          new Response(result.stderr).text()
        ]);
        const exitCode = await result.exited;

        if (exitCode === 0) {
          writeFileSync(outputPath, output, "utf-8");
          processed++;
          if (processed % 10 === 0) {
            console.error(`[trafilatura] processed ${processed}/${htmlHashes.size}`);
          }
        } else {
          console.error(`[trafilatura] failed to extract ${hash}: exit code ${exitCode}, ${stderr}`);
        }
      } catch (e) {
        console.error(`[trafilatura] failed to extract ${hash}: ${e.message}`);
      }
    };

    // Worker pool: maintain concurrency workers running
    const activePromises = new Set();

    while (nextIndex < hashArray.length || activePromises.size > 0) {
      // Fill up to concurrency limit
      while (nextIndex < hashArray.length && activePromises.size < concurrency) {
        const hash = hashArray[nextIndex++];
        const promise = processHash(hash);
        activePromises.add(promise);
        promise.then(() => activePromises.delete(promise));
      }

      // Wait for at least one to complete
      if (activePromises.size > 0) {
        await Promise.race(activePromises);
      }
    }

    console.error(`[trafilatura] extracted ${processed}/${htmlHashes.size} documents`);
    console.error(`[saved] ${trafilaturaDir}`);
  } finally {
    // Stop HTTP server
    server.stop();
  }
}
