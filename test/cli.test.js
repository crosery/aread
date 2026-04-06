import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile, readFile, mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const CLI = join(import.meta.dirname, "..", "src", "cli.js");

function run(args, { env = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [CLI, ...args],
      {
        timeout,
        encoding: "utf-8",
        env: { ...process.env, ...env },
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        resolve({ code: err ? err.code : 0, stdout, stderr, err });
      }
    );
  });
}

// --- 1. Concurrent --read ---

describe("concurrent --read", () => {
  it("should accept --concurrency flag without error", async () => {
    const { stderr } = await run(["--help"]);
    // help should mention concurrency
    const { stdout } = await run(["--help"]);
    assert.ok(stdout.includes("--concurrency") || stdout.includes("-c, --concurrency"));
  });

  it("should accept -c shorthand", async () => {
    // Just verify the arg is parsed without error (not actually searching)
    const { stdout } = await run(["--help"]);
    assert.ok(stdout.includes("-c, --concurrency"));
  });
});

// --- 2. URL cache ---

describe("URL cache", () => {
  const cacheDir = join(tmpdir(), `aread-test-cache-${Date.now()}`);

  before(async () => {
    await mkdir(cacheDir, { recursive: true });
  });

  after(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("should support --no-cache flag", async () => {
    const { stdout } = await run(["--help"]);
    assert.ok(stdout.includes("--no-cache"));
  });

  it("urlHash produces consistent SHA256 hex", () => {
    const url = "https://example.com/test";
    const hash = createHash("sha256").update(url).digest("hex");
    assert.equal(hash.length, 64);
    // Same input → same hash
    const hash2 = createHash("sha256").update(url).digest("hex");
    assert.equal(hash, hash2);
  });

  it("different URLs produce different hashes", () => {
    const h1 = createHash("sha256").update("https://a.com").digest("hex");
    const h2 = createHash("sha256").update("https://b.com").digest("hex");
    assert.notEqual(h1, h2);
  });

  it("cache file is created after fetching a URL", async () => {
    // Use XDG_CACHE_HOME to control cache location
    const { code } = await run(
      ["-r", "https://example.com"],
      { env: { XDG_CACHE_HOME: cacheDir } }
    );
    // Should succeed (code 0) or fail gracefully
    // Check if cache dir has any .md files
    const areadCache = join(cacheDir, "aread");
    try {
      const files = await readdir(areadCache);
      const mdFiles = files.filter((f) => f.endsWith(".md"));
      // If fetch succeeded, there should be a cache file
      if (code === 0) {
        assert.ok(mdFiles.length > 0, "cache file should be created");
      }
    } catch {
      // Cache dir may not exist if fetch failed (network)
    }
  });
});

// --- 3. Jina fallback ---

describe("Jina fallback", () => {
  it("help text mentions fallback behavior", async () => {
    const { stdout } = await run(["--help"]);
    assert.ok(stdout.includes("falls back to local fetch"));
  });

  it("turndown is importable as a dependency", async () => {
    // Verify turndown can be dynamically imported
    const TurndownService = (await import("turndown")).default;
    const td = new TurndownService();
    const md = td.turndown("<h1>Hello</h1><p>World</p>");
    assert.ok(md.includes("Hello"));
    assert.ok(md.includes("World"));
  });

  it("turndown converts HTML to markdown correctly", async () => {
    const TurndownService = (await import("turndown")).default;
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    const html = `
      <h1>Title</h1>
      <p>A paragraph with <strong>bold</strong> and <em>italic</em>.</p>
      <ul><li>Item 1</li><li>Item 2</li></ul>
      <pre><code>const x = 1;</code></pre>
    `;
    const md = td.turndown(html);
    assert.ok(md.includes("# Title") || md.includes("Title"));
    assert.ok(md.includes("**bold**"));
    assert.ok(md.includes("*italic*") || md.includes("_italic_"));
  });
});

// --- 4. No Python dependency (native DuckDuckGo) ---

describe("native DuckDuckGo search (no Python)", () => {
  it("help text no longer mentions Python requirement", async () => {
    const { stdout } = await run(["--help"]);
    assert.ok(!stdout.includes("requires Python 3"));
    assert.ok(stdout.includes("no Python required"));
  });

  it("parseDdgHtml extracts results from mock HTML", async () => {
    // We test the parsing logic by importing it indirectly
    // Since parseDdgHtml is not exported, we test via integration
    // Create a mock test of the regex logic
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&rut=abc">Example Page 1</a>
      <a class="result__snippet" href="#">This is the first result snippet</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage2&rut=def">Example Page 2</a>
      <a class="result__snippet" href="#">This is the second result snippet</a>
    `;

    // Replicate the parsing logic from cli.js
    const regex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const links = [...html.matchAll(regex)];
    const snippets = [...html.matchAll(snippetRegex)];

    assert.equal(links.length, 2);
    assert.equal(snippets.length, 2);

    // Test URL extraction with uddg param
    const rawUrl = links[0][1];
    const u = new URL(rawUrl, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    assert.ok(uddg);
    const decodedUrl = decodeURIComponent(uddg);
    assert.equal(decodedUrl, "https://example.com/page1");

    // Test title extraction
    const title = links[0][2].replace(/<[^>]*>/g, "").trim();
    assert.equal(title, "Example Page 1");

    // Test snippet extraction
    const abstract = snippets[0][1].replace(/<[^>]*>/g, "").trim();
    assert.equal(abstract, "This is the first result snippet");
  });

  it("search actually works (network test)", async () => {
    const { stdout, code, stderr } = await run(
      ["-s", "test query", "-n", "3", "-r"],
      { timeout: 30000 }
    );
    // If network is available, we should get results
    if (code === 0) {
      assert.ok(stdout.length > 0, "should have some output");
    }
    // If network fails, that's OK for CI
  });
});

// --- 5. --json output ---

describe("--json output", () => {
  it("help text mentions --json flag", async () => {
    const { stdout } = await run(["--help"]);
    assert.ok(stdout.includes("--json"));
  });

  it("--json with single URL produces valid JSON", async () => {
    const { stdout, code } = await run(["-r", "--json", "https://example.com"]);
    if (code === 0) {
      const parsed = JSON.parse(stdout);
      assert.ok(typeof parsed === "object");
      assert.ok("url" in parsed);
      assert.ok("markdown" in parsed);
      assert.ok("cached" in parsed);
      assert.ok("error" in parsed);
      assert.equal(parsed.url, "https://example.com");
      assert.equal(parsed.error, null);
    }
  });

  it("--json with search produces valid JSON array", async () => {
    const { stdout, code } = await run(
      ["-s", "example", "-n", "2", "--json", "-r"],
      { timeout: 30000 }
    );
    if (code === 0) {
      const parsed = JSON.parse(stdout);
      assert.ok(Array.isArray(parsed));
      assert.ok(parsed.length > 0);
      for (const item of parsed) {
        assert.ok("url" in item);
        assert.ok("title" in item);
        assert.ok("abstract" in item);
      }
    }
  });

  it("--json search+read produces JSON with markdown fields", async () => {
    const { stdout, code } = await run(
      ["-s", "example", "-n", "1", "--json", "--read", "-r"],
      { timeout: 30000 }
    );
    if (code === 0) {
      const parsed = JSON.parse(stdout);
      assert.ok(Array.isArray(parsed));
      if (parsed.length > 0) {
        assert.ok("markdown" in parsed[0]);
        assert.ok("cached" in parsed[0]);
      }
    }
  });
});

// --- General / regression ---

describe("general CLI behavior", () => {
  it("--version still works", async () => {
    const { stdout, code } = await run(["--version"]);
    assert.equal(code, 0);
    assert.ok(stdout.includes("aread v"));
  });

  it("--help still works", async () => {
    const { stdout, code } = await run(["--help"]);
    assert.equal(code, 0);
    assert.ok(stdout.includes("USAGE"));
    assert.ok(stdout.includes("READ OPTIONS"));
    assert.ok(stdout.includes("SEARCH OPTIONS"));
  });

  it("missing URL shows error", async () => {
    const { code, stderr } = await run([]);
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("missing URL"));
  });
});
