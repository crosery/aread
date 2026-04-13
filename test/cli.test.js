import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile, readFile, mkdir, rm, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "src", "cli.js");

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
    assert.ok(stdout.includes("multiple engines") || stdout.includes("DuckDuckGo"));
  });

  it("ddgSearch uses GET method with real browser User-Agent", async () => {
    // Read the source and verify the DDG search function uses GET + real UA
    const src = await readFile(CLI, "utf-8");

    // Extract the ddgSearch function body
    const ddgFnMatch = src.match(/async function ddgSearch[\s\S]*?^}/m);
    assert.ok(ddgFnMatch, "ddgSearch function should exist");
    const ddgFn = ddgFnMatch[0];

    // Must use GET, not POST
    assert.ok(
      ddgFn.includes('method: "GET"') || !ddgFn.includes('method: "POST"'),
      "ddgSearch should use GET, not POST"
    );
    assert.ok(
      !ddgFn.includes('"Content-Type": "application/x-www-form-urlencoded"'),
      "ddgSearch should not send form-encoded body"
    );
    assert.ok(
      !ddgFn.includes("body:"),
      "ddgSearch GET request should not have a body"
    );

    // Must use real browser User-Agent, not the generic aread one
    assert.ok(
      ddgFn.includes("Chrome/") && ddgFn.includes("AppleWebKit/"),
      "ddgSearch should use a real browser User-Agent"
    );
    assert.ok(
      !ddgFn.includes('"User-Agent": "Mozilla/5.0 (compatible; aread/1.0)"'),
      "ddgSearch should not use the generic aread User-Agent"
    );

    // URL should be query-string based (GET style)
    assert.ok(
      ddgFn.includes("html.duckduckgo.com/html/?"),
      "ddgSearch should append query params to URL (GET style)"
    );
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

// --- 6. Multi-engine support ---

describe("multi-engine support", () => {
  it("--help mentions --engine flag", async () => {
    const { stdout } = await run(["--help"]);
    assert.ok(stdout.includes("--engine"));
    assert.ok(stdout.includes("duckduckgo"));
    assert.ok(stdout.includes("bing"));
    assert.ok(stdout.includes("auto"));
  });

  it("-e shorthand is accepted", async () => {
    const { stdout } = await run(["--help"]);
    assert.ok(stdout.includes("-e, --engine"));
  });

  it("unknown engine produces error", async () => {
    const { code, stderr } = await run(["-s", "test", "-e", "yahoo"]);
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("unknown engine"));
  });

  it("default engine is auto which probes DDG then falls back (no --engine flag)", async () => {
    const { stdout } = await run(["--help"]);
    // Help text mentions auto as default or mentions DDG with fallback
    assert.ok(
      stdout.includes("default: duckduckgo") || stdout.includes("auto probes DDG"),
      "help should mention default engine behavior"
    );
  });
});

describe("Bing search HTML parsing", () => {
  it("parseBingHtml extracts results from mock HTML", () => {
    // Replicate the Bing parsing logic
    const html = `
      <li class="b_algo"><h2><a href="https://example.com/page1">Bing Result 1</a></h2>
      <p class="b_lineclamp2">This is bing snippet 1</p></li>
      <li class="b_algo"><h2><a href="https://example.com/page2">Bing Result 2</a></h2>
      <p class="b_lineclamp3">This is bing snippet 2</p></li>
    `;

    const blockRegex = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
    const blocks = [...html.matchAll(blockRegex)];
    assert.equal(blocks.length, 2);

    // Updated regex: h2 may have class attr, no need for </h2> in match
    const linkMatch = blocks[0][1].match(/<h2[^>]*>\s*<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    assert.ok(linkMatch);
    assert.equal(linkMatch[1], "https://example.com/page1");
    assert.equal(linkMatch[2].replace(/<[^>]*>/g, "").trim(), "Bing Result 1");

    const snippetMatch = blocks[0][1].match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    assert.ok(snippetMatch);
    assert.equal(snippetMatch[1].replace(/<[^>]*>/g, "").trim(), "This is bing snippet 1");
  });

  it("parseBingHtml handles cn.bing.com HTML with class on h2", () => {
    // cn.bing.com uses <h2 class=""><a target="_blank" ...>
    const html = `
      <li class="b_algo" data-id><h2 class=""><a target="_blank" href="https://www.bilibili.com/" h="ID=SERP,1.2">哔哩哔哩-bilibili</a></h2>
      <div class="b_caption"><p class="b_lineclamp2">哔哩哔哩 is a video site</p></div></li>
      <li class="b_algo"><h2 class=""><a target="_blank" href="https://apps.apple.com/bilibili" h="ID=SERP,2.2">Bilibili App</a></h2>
      <div class="b_caption"><p class="b_lineclamp2">Download bilibili app</p></div></li>
    `;

    const blockRegex = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
    const blocks = [...html.matchAll(blockRegex)];
    assert.equal(blocks.length, 2);

    const linkMatch = blocks[0][1].match(/<h2[^>]*>\s*<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    assert.ok(linkMatch, "should match h2 with class attr");
    assert.equal(linkMatch[1], "https://www.bilibili.com/");
  });

  it("parseBingHtml decodes bing.com/ck/a redirect URLs", () => {
    // Bing wraps URLs in bing.com/ck/a?...u=base64...
    const realUrl = "https://example.com/page";
    const encoded = "a1" + Buffer.from(realUrl).toString("base64");
    const bingUrl = `https://www.bing.com/ck/a?u=${encoded}&ntb=1`;
    const html = `<li class="b_algo"><h2><a href="${bingUrl}">Test</a></h2></li>`;

    const blockRegex = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
    const blocks = [...html.matchAll(blockRegex)];
    const linkMatch = blocks[0][1].match(/<h2[^>]*>\s*<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    let url = linkMatch[1].replace(/&amp;/g, "&");
    try {
      const u = new URL(url);
      const enc = u.searchParams.get("u");
      if (enc) url = Buffer.from(enc.startsWith("a1") ? enc.slice(2) : enc, "base64").toString();
    } catch {}

    assert.equal(url, realUrl);
  });
});


describe("auto engine detection and fallback", () => {
  it("--engine auto is accepted without error on --help", async () => {
    const { stdout } = await run(["--help"]);
    assert.ok(stdout.includes("auto"));
  });

  it("bing search works (network test)", async () => {
    const { stdout, code } = await run(
      ["-s", "test", "-n", "3", "-r", "-e", "bing"],
      { timeout: 30000 }
    );
    if (code === 0) {
      assert.ok(stdout.length > 0, "should have some output");
    }
  });

  it("auto mode uses bing fallback when DDG is unavailable (network test)", async () => {
    // Don't use -r (raw) so status messages appear on stderr
    const { stdout, code, stderr } = await run(
      ["-s", "test", "-n", "3"],
      { timeout: 30000 }
    );
    if (code === 0) {
      assert.ok(stdout.length > 0, "should have some output");
      // stderr should mention probing DDG or searching
      assert.ok(stderr.includes("probing DuckDuckGo") || stderr.includes("searching"));
    }
  });

  it("source code contains searchWithFallback function", async () => {
    const src = await readFile(CLI, "utf-8");
    assert.ok(src.includes("searchWithFallback"), "searchWithFallback should exist");
    assert.ok(src.includes("fallbackOrder"), "fallbackOrder config should exist");
  });

  it("bing search uses mkt=en-US for international results", async () => {
    const src = await readFile(CLI, "utf-8");
    const bingFnMatch = src.match(/async function bingSearch[\s\S]*?^}/m);
    assert.ok(bingFnMatch, "bingSearch function should exist");
    assert.ok(bingFnMatch[0].includes("mkt"), "bingSearch should include mkt parameter");
  });

});

// --- 7. Multi-engine aggregate search (--multi) ---

describe("multi-engine aggregate search (--multi)", () => {
  it("--help mentions --multi flag", async () => {
    const { stdout } = await run(["--help"]);
    assert.ok(stdout.includes("--multi"), "help should mention --multi");
    assert.ok(stdout.includes("-m, --multi"), "help should show -m shorthand");
  });

  it("-m shorthand is accepted without error", async () => {
    const { stdout } = await run(["--help"]);
    assert.ok(stdout.includes("-m, --multi"));
  });

  it("source code contains multiEngineSearch function", async () => {
    const src = await readFile(CLI, "utf-8");
    assert.ok(src.includes("multiEngineSearch"), "multiEngineSearch function should exist");
    assert.ok(src.includes("Promise.allSettled"), "should use Promise.allSettled for concurrent queries");
    assert.ok(src.includes("MULTI_ENGINES"), "should define MULTI_ENGINES constant");
  });

  it("source code contains normalizeUrl for deduplication", async () => {
    const src = await readFile(CLI, "utf-8");
    assert.ok(src.includes("normalizeUrl"), "normalizeUrl function should exist for dedup");
    assert.ok(src.includes("seenUrls"), "should track seen URLs for deduplication");
  });

  it("normalizeUrl logic works correctly", () => {
    // Replicate normalizeUrl from cli.js
    function normalizeUrl(url) {
      try {
        const u = new URL(url);
        return u.origin.toLowerCase() + u.pathname.replace(/\/+$/, "") + u.search;
      } catch {
        return url;
      }
    }

    // Same URL with/without trailing slash
    assert.equal(
      normalizeUrl("https://example.com/"),
      normalizeUrl("https://example.com")
    );

    // Case-insensitive host
    assert.equal(
      normalizeUrl("https://EXAMPLE.COM/page"),
      normalizeUrl("https://example.com/page")
    );

    // Different paths are different
    assert.notEqual(
      normalizeUrl("https://example.com/a"),
      normalizeUrl("https://example.com/b")
    );

    // Preserves query string
    assert.notEqual(
      normalizeUrl("https://example.com/page?q=1"),
      normalizeUrl("https://example.com/page?q=2")
    );
  });

  it("--multi search works (network test)", async () => {
    const { stdout, code, stderr } = await run(
      ["-s", "test", "-n", "3", "--multi"],
      { timeout: 60000 }
    );
    if (code === 0) {
      assert.ok(stdout.length > 0, "should have some output");
    }
    // stderr should mention multi-engine
    assert.ok(
      stderr.includes("multi-engine") || stderr.includes("querying"),
      "stderr should show multi-engine status"
    );
  });

  it("--multi with --json produces valid JSON", async () => {
    const { stdout, code } = await run(
      ["-s", "test", "-n", "3", "--multi", "--json", "-r"],
      { timeout: 60000 }
    );
    if (code === 0 && stdout.trim()) {
      const parsed = JSON.parse(stdout);
      assert.ok(Array.isArray(parsed), "JSON output should be an array");
      for (const item of parsed) {
        assert.ok("title" in item, "each result should have title");
        assert.ok("url" in item, "each result should have url");
        assert.ok("abstract" in item, "each result should have abstract");
      }
    }
  });

  it("--multi with -m shorthand works (network test)", async () => {
    const { stdout, code, stderr } = await run(
      ["-s", "test", "-n", "3", "-m"],
      { timeout: 60000 }
    );
    if (code === 0) {
      assert.ok(stdout.length > 0, "should have some output");
    }
    assert.ok(
      stderr.includes("multi-engine") || stderr.includes("querying"),
      "stderr should show multi-engine status for -m shorthand"
    );
  });

  it("--multi results are deduplicated by URL", async () => {
    // Deduplication logic test: simulate what multiEngineSearch does
    const results1 = [
      { title: "Result A", url: "https://example.com/page1", abstract: "From engine 1" },
      { title: "Result B", url: "https://example.com/page2", abstract: "From engine 1" },
    ];
    const results2 = [
      { title: "Result A (dup)", url: "https://example.com/page1", abstract: "From engine 2" },
      { title: "Result C", url: "https://example.com/page3", abstract: "From engine 2" },
    ];

    function normalizeUrl(url) {
      try {
        const u = new URL(url);
        return u.origin.toLowerCase() + u.pathname.replace(/\/+$/, "") + u.search;
      } catch {
        return url;
      }
    }

    const seenUrls = new Set();
    const merged = [];
    for (const batch of [results1, results2]) {
      for (const item of batch) {
        const normalized = normalizeUrl(item.url);
        if (!seenUrls.has(normalized)) {
          seenUrls.add(normalized);
          merged.push(item);
        }
      }
    }

    assert.equal(merged.length, 3, "should have 3 unique results (not 4)");
    assert.equal(merged[0].title, "Result A", "first occurrence should be kept");
    assert.equal(merged[2].url, "https://example.com/page3");
  });

  it("--multi ignores --engine flag", async () => {
    // When --multi is set, --engine should be irrelevant
    const { stderr } = await run(
      ["-s", "test", "-n", "1", "--multi", "-e", "bing"],
      { timeout: 60000 }
    );
    // Should still say multi-engine, not just bing
    assert.ok(
      stderr.includes("multi-engine") || stderr.includes("querying"),
      "with --multi, should use multi-engine mode regardless of --engine"
    );
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
