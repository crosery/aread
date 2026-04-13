#!/usr/bin/env node

import { parseArgs } from "node:util";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { createHash } from "node:crypto";

// Windows encoding fix
if (platform() === "win32") {
  spawnSync("chcp", ["65001"], { shell: true, stdio: "ignore" });
  spawnSync("powershell", [
    "-NoProfile", "-Command",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8"
  ], { stdio: "ignore" });
  if (process.stdout._handle && process.stdout._handle.setBlocking) {
    process.stdout._handle.setBlocking(true);
  }
}

const VERSION = "1.4.1";
const JINA_READ = "https://r.jina.ai";
const SUPPORTED_ENGINES = ["duckduckgo", "bing", "google", "baidu", "auto"];
const DDG_PROBE_TIMEOUT = 3000;

// --- Known anti-crawl domains and HTTP error explanations ---

const ANTI_CRAWL_DOMAINS = new Set([
  "csdn.net", "blog.csdn.net", "wenku.csdn.net",
  "zhihu.com", "zhuanlan.zhihu.com",
  "jianshu.com",
  "segmentfault.com",
  "juejin.cn",
]);

function isAntiCrawlDomain(url) {
  try {
    const host = new URL(url).hostname;
    for (const domain of ANTI_CRAWL_DOMAINS) {
      if (host === domain || host.endsWith("." + domain)) return true;
    }
  } catch {}
  return false;
}

const HTTP_ERROR_HINTS = {
  403: "site returned 403 Forbidden — access denied, likely requires authentication or blocks automated requests",
  421: "site returned 421 — too many connections from this IP, try again later",
  429: "site returned 429 Too Many Requests — rate limited, try again later",
  451: "site returned 451 — content unavailable for legal reasons",
  521: "site returned 521 (Cloudflare anti-bot) — the site uses Web Application Firewall protection and cannot be accessed programmatically. Try accessing via a browser instead",
  522: "site returned 522 (Cloudflare connection timed out) — the origin server is unreachable",
  523: "site returned 523 (Cloudflare origin unreachable) — DNS or origin server issue",
  525: "site returned 525 (SSL handshake failed) — certificate or TLS issue between CDN and origin",
};

const ANTI_CRAWL_STATUS_CODES = new Set([403, 421, 429, 451, 521, 522, 523, 525]);

function isAntiCrawlError(status) {
  return ANTI_CRAWL_STATUS_CODES.has(status);
}

function describeHttpError(status, url) {
  const hint = HTTP_ERROR_HINTS[status];
  if (hint) return hint;
  if (status >= 500) return `site returned ${status} (server error) — the server encountered an internal error`;
  return `HTTP ${status}`;
}

// --- Colors (auto-detect TTY) ---

const isTTY = process.stderr.isTTY;
const c = isTTY
  ? {
      red: "\x1b[0;31m",
      green: "\x1b[0;32m",
      cyan: "\x1b[0;36m",
      dim: "\x1b[2m",
      bold: "\x1b[1m",
      reset: "\x1b[0m",
    }
  : { red: "", green: "", cyan: "", dim: "", bold: "", reset: "" };

// --- Helpers ---

function die(msg) {
  process.stderr.write(`${c.red}error${c.reset}: ${msg}\n`);
  process.exit(1);
}

function info(msg) {
  if (raw) return;
  process.stderr.write(`${msg}\n`);
}

function urlHash(url) {
  return createHash("sha256").update(url).digest("hex");
}

async function getCachedContent(url) {
  if (opts && opts["no-cache"]) return null;
  const cacheDir = getCacheDir();
  const cachePath = join(cacheDir, urlHash(url) + ".md");
  try {
    return await readFile(cachePath, "utf-8");
  } catch {
    return null;
  }
}

async function setCachedContent(url, content) {
  const cacheDir = getCacheDir();
  await mkdir(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, urlHash(url) + ".md");
  await writeFile(cachePath, content, "utf-8");
}

function printHelp() {
  console.log(`${c.bold}aread${c.reset} ${c.dim}v${VERSION}${c.reset} - AI-friendly web reader & search

${c.bold}USAGE${c.reset}
    aread <URL>                Read a page as Markdown
    aread -s <QUERY>           Search the web (default: DuckDuckGo)
    aread -s <QUERY> --read    Search + read top results as Markdown

${c.bold}READ OPTIONS${c.reset}
    -o, --output <FILE>        Save output to file
    -r, --raw                  No status messages, pipe-friendly
    -t, --timeout <SEC>        Request timeout (default: 30)
    -H, --header <K:V>         Extra Jina header (repeatable)

${c.bold}SEARCH OPTIONS${c.reset}
    -s, --search <QUERY>       Search the web
    -n, --num <N>              Number of search results (default: 10)
    -e, --engine <ENGINE>      Search engine: duckduckgo|bing|google|baidu|auto
                               (default: duckduckgo, auto probes DDG then falls back to Bing)
    -m, --multi                Query all engines concurrently, merge & deduplicate results
    --read                     Also fetch each result as Markdown
    -c, --concurrency <N>      Concurrent reads (default: 5, with --read)

${c.bold}GENERAL${c.reset}
    --no-cache                 Skip URL cache
    --json                     Output structured JSON
    -h, --help                 Show this help
    -v, --version              Show version

${c.bold}EXAMPLES${c.reset}
    aread https://example.com
    aread example.com
    aread -o page.md https://example.com
    aread -r https://example.com | head -50
    aread -s "rust async tutorial"
    aread -s "react hooks" -n 3
    aread -s "node.js streams" --read
    aread -s "rust async tutorial" --multi
    aread -H "X-With-Links:true" https://example.com

${c.bold}JINA HEADERS${c.reset}
    X-Return-Format     html | text | screenshot | pageshot
    X-With-Links        true - include links
    X-With-Images       true - include images
    X-No-Cache          true - bypass Jina cache
    X-Target-Selector   <css> - extract specific element

${c.bold}INSTALL${c.reset}
    npm i -g aread-cli
    bun i -g aread-cli
    npx aread-cli <URL>

${c.bold}NOTE${c.reset}
    Search supports multiple engines (DuckDuckGo, Bing, Google, Baidu).
    Use --engine auto to probe DDG and fallback to Bing if unavailable.
    Use --multi to query all engines concurrently and merge results.
    Jina API is used for reading; falls back to local fetch + turndown.`);
}

// --- Parse args ---

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      raw: { type: "boolean", short: "r", default: false },
      timeout: { type: "string", short: "t", default: "30" },
      header: { type: "string", short: "H", multiple: true, default: [] },
      search: { type: "string", short: "s" },
      num: { type: "string", short: "n", default: "10" },
      engine: { type: "string", short: "e", default: "auto" },
      read: { type: "boolean", default: false },
      "no-cache": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      concurrency: { type: "string", short: "c", default: "5" },
      multi: { type: "boolean", short: "m", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
} catch (e) {
  die(`${e.message} (try aread --help)`);
}

const { values: opts, positionals } = parsed;
const raw = opts.raw;

if (opts.version) {
  console.log(`aread v${VERSION}`);
  process.exit(0);
}

if (opts.help) {
  printHelp();
  process.exit(0);
}

// --- Jina fetch ---

async function jinaFetch(url) {
  const headers = { Accept: "text/markdown" };
  for (const h of opts.header) {
    const idx = h.indexOf(":");
    if (idx === -1) die(`invalid header format: ${h} (expected Key:Value)`);
    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }

  const timeout = parseInt(opts.timeout, 10) * 1000;
  const target = `${JINA_READ}/${url}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const res = await fetch(target, {
    headers,
    signal: controller.signal,
    redirect: "follow",
  });
  clearTimeout(timer);

  if (!res.ok) {
    const errMsg = describeHttpError(res.status, url);
    if (isAntiCrawlDomain(url) && isAntiCrawlError(res.status)) {
      throw new Error(`${errMsg}. This is a known anti-crawl site — try accessing via a browser or use an alternative source`);
    }
    throw new Error(`${errMsg} for ${url}`);
  }

  const body = await res.text();
  if (!body.trim()) throw new Error(`empty response for ${url} - try: aread -H "X-No-Cache:true" ${url}`);

  return body;
}

// --- Fallback: local HTML fetch + turndown ---

async function localFetch(url) {
  const timeout = parseInt(opts.timeout, 10) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const res = await fetch(url, {
    signal: controller.signal,
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; aread/1.0)" },
  });
  clearTimeout(timer);

  if (!res.ok) {
    const errMsg = describeHttpError(res.status, url);
    throw new Error(errMsg);
  }
  const html = await res.text();

  let TurndownService;
  try {
    TurndownService = (await import("turndown")).default;
  } catch {
    throw new Error("turndown not installed. Run: npm i turndown");
  }

  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  return td.turndown(html);
}

async function fetchWithFallback(url) {
  // Check cache first
  const cached = await getCachedContent(url);
  if (cached) return { markdown: cached, cached: true };

  // Warn early about known anti-crawl sites
  const antiCrawl = isAntiCrawlDomain(url);
  if (antiCrawl) {
    info(`${c.red}Warning${c.reset}: ${new URL(url).hostname} is a known anti-crawl site — fetch may fail or return incomplete content`);
  }

  try {
    const md = await jinaFetch(url);
    await setCachedContent(url, md);
    return { markdown: md, cached: false };
  } catch (jinaErr) {
    info(`${c.dim}jina failed, trying local fallback...${c.reset}`);
    try {
      const md = await localFetch(url);
      await setCachedContent(url, md);
      return { markdown: md, cached: false };
    } catch (localErr) {
      const baseMsg = `jina: ${jinaErr.message}; local: ${localErr.message}`;
      // Only attach anti-crawl hint if the errors look like anti-crawl blocks (not 404, etc.)
      if (antiCrawl && /\b(403|421|429|451|52[1-5]|empty|blocked|forbidden)\b/i.test(baseMsg)) {
        throw new Error(`${baseMsg}. This site has anti-crawl protection — try accessing via a browser or use an alternative source`);
      }
      throw new Error(baseMsg);
    }
  }
}

// --- Concurrency helper ---

async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i).then(
        (v) => ({ status: "fulfilled", value: v }),
        (e) => ({ status: "rejected", reason: e })
      );
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// --- Cache directory ---

function getCacheDir() {
  const home = homedir();
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "aread");
  }
  return join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "aread");
}

// --- DuckDuckGo search (native, no Python) ---

function parseDdgHtml(html, num) {
  const results = [];
  const regex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links = [...html.matchAll(regex)];
  const snippets = [...html.matchAll(snippetRegex)];

  for (let i = 0; i < Math.min(links.length, num); i++) {
    const rawUrl = links[i][1];
    const title = links[i][2].replace(/<[^>]*>/g, "").trim();
    const abstract = snippets[i] ? snippets[i][1].replace(/<[^>]*>/g, "").trim() : "";

    // DuckDuckGo redirects through uddg param
    let url = rawUrl;
    try {
      const u = new URL(rawUrl, "https://duckduckgo.com");
      const uddg = u.searchParams.get("uddg");
      if (uddg) url = decodeURIComponent(uddg);
    } catch {}

    if (url && title) results.push({ title, url, abstract });
  }

  return results;
}

async function ddgSearch(query, num) {
  const timeout = parseInt(opts.timeout, 10) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const params = new URLSearchParams({ q: query });
    const res = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return parseDdgHtml(html, num);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`duckduckgo search timed out after ${opts.timeout}s`);
    throw new Error(`duckduckgo search failed: ${e.message}`);
  }
}

// --- Bing search ---

function parseBingHtml(html, num) {
  const results = [];
  // Bing results: <li class="b_algo"><h2><a href="URL">Title</a></h2><p class="b_lineclamp...">Snippet</p></li>
  const blockRegex = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  const blocks = [...html.matchAll(blockRegex)];

  for (let i = 0; i < Math.min(blocks.length, num); i++) {
    const block = blocks[i][1];
    // Match <h2><a href="...">Title</a></h2> — h2 may or may not have class attr
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    let url = linkMatch[1].replace(/&amp;/g, "&");
    // Decode Bing redirect URL (bing.com/ck/a?...u=base64...)
    try {
      const u = new URL(url);
      const encoded = u.searchParams.get("u");
      if (encoded) url = Buffer.from(encoded.startsWith("a1") ? encoded.slice(2) : encoded, "base64").toString();
    } catch {}
    const title = linkMatch[2].replace(/<[^>]*>/g, "").trim();

    // Extract snippet from various Bing snippet containers
    let abstract = "";
    const snippetMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    if (snippetMatch) {
      abstract = (snippetMatch[1] || snippetMatch[2] || "").replace(/<[^>]*>/g, "").trim();
    }

    if (url && title) results.push({ title, url, abstract });
  }

  return results;
}

async function bingSearch(query, num) {
  const timeout = parseInt(opts.timeout, 10) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    // Use mkt=en-US to avoid cn.bing.com redirect returning only Zhihu results
    const params = new URLSearchParams({ q: query, count: String(num), mkt: "en-US" });
    const res = await fetch(`https://www.bing.com/search?${params}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return parseBingHtml(html, num);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`bing search timed out after ${opts.timeout}s`);
    throw new Error(`bing search failed: ${e.message}`);
  }
}

// --- Google search ---

function parseGoogleHtml(html, num) {
  const results = [];

  // Strategy 1: Match <div class="g"> blocks (standard Google layout)
  const blockRegex = /<div\s+class="[^"]*\bg\b[^"]*"[^>]*>([\s\S]*?)(?=<div\s+class="[^"]*\bg\b[^"]*"|<div\s+id="botstuff")/gi;
  const blocks = [...html.matchAll(blockRegex)];

  for (const block of blocks) {
    if (results.length >= num) break;
    const content = block[1];

    // Title is in <h3> inside an <a> with href
    const titleLinkMatch = content.match(/<a[^>]+href="(https?:\/\/(?!www\.google\.com)[^"]*)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i)
      || content.match(/<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<a[^>]+href="(https?:\/\/(?!www\.google\.com)[^"]*)"[^>]*>/i);
    if (!titleLinkMatch) continue;

    // Handle both match orderings (url first or title first)
    let url, title;
    if (titleLinkMatch[1].startsWith("http")) {
      url = titleLinkMatch[1];
      title = titleLinkMatch[2].replace(/<[^>]*>/g, "").trim();
    } else {
      title = titleLinkMatch[1].replace(/<[^>]*>/g, "").trim();
      url = titleLinkMatch[2];
    }

    // Extract snippet from data-sncf, VwiC3b class, or long <span>
    let abstract = "";
    const snippetMatch = content.match(/<div[^>]*(?:data-sncf|class="[^"]*VwiC3b[^"]*")[^>]*>([\s\S]*?)<\/div>/i)
      || content.match(/<span[^>]*class="[^"]*(?:st|VwiC3b|hgKElc)[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
      || content.match(/<div[^>]*class="[^"]*IsZvec[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (snippetMatch) {
      abstract = (snippetMatch[1] || "").replace(/<[^>]*>/g, "").trim();
    }

    if (url && title) results.push({ title, url, abstract });
  }

  // Strategy 2: Fallback — scan for <a href> + <h3> pairs anywhere in the HTML
  if (results.length === 0) {
    const linkRegex = /<a[^>]+href="(https?:\/\/(?!www\.google\.com|maps\.google|accounts\.google|support\.google|policies\.google)[^"]*)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
    const links = [...html.matchAll(linkRegex)];
    for (const m of links) {
      if (results.length >= num) break;
      const url = m[1];
      const title = m[2].replace(/<[^>]*>/g, "").trim();
      if (url && title) results.push({ title, url, abstract: "" });
    }
  }

  return results;
}

async function googleSearch(query, num) {
  const timeout = parseInt(opts.timeout, 10) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const params = new URLSearchParams({ q: query, num: String(num), hl: "en" });
    const res = await fetch(`https://www.google.com/search?${params}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return parseGoogleHtml(html, num);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`google search timed out after ${opts.timeout}s`);
    throw new Error(`google search failed: ${e.message}`);
  }
}

// --- Baidu search ---

function extractBaiduAbstract(block) {
  // Strategy 1: Extract from <!--s-data:{"summaryData":...}--> JSON comments (modern Baidu SSR)
  const sdataMatch = block.match(/<!--s-data:(\{"summaryData"[\s\S]*?)-->/);
  if (sdataMatch) {
    try {
      const data = JSON.parse(sdataMatch[1]);
      const lines = data.summaryData?.generalLines || [];
      const texts = lines.flatMap((l) => (l.data || []).map((d) => d.text)).filter(Boolean);
      if (texts.length > 0) {
        return texts
          .join(" ")
          .replace(/<[^>]*>/g, "")
          .replace(/\s+/g, " ")
          .trim();
      }
    } catch {}
  }

  // Strategy 2: Rendered summary-text span (data-module="abstract" section)
  const summaryMatch = block.match(/<span[^>]+class="[^"]*summary-text[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  if (summaryMatch) {
    const text = summaryMatch[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (text.length > 5) return text;
  }

  // Strategy 3: data-module="abstract" div content
  const moduleMatch = block.match(/data-module="abstract"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  if (moduleMatch) {
    const text = moduleMatch[1].replace(/<[^>]*>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
    if (text.length > 5) return text;
  }

  // Strategy 4: Classic c-abstract class
  const classicMatch = block.match(/<(?:div|span)[^>]+class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i);
  if (classicMatch) {
    const text = classicMatch[1].replace(/<[^>]*>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
    if (text.length > 5) return text;
  }

  // Strategy 5: content-right class
  const crMatch = block.match(/<(?:span|div|p)[^>]+class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|p)>/i);
  if (crMatch) {
    const text = crMatch[1].replace(/<[^>]*>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
    if (text.length > 5) return text;
  }

  return "";
}

function parseBaiduHtml(html, num) {
  const results = [];

  // Split into result blocks: Baidu wraps each result in <div class="result c-container ...">
  const resultBlockRegex = /<div[^>]+class="[^"]*result\s+c-container[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*result\s+c-container[^"]*"|<div\s+id="(?:page|rs|content_right|con-ar)")/gi;
  const resultBlocks = [...html.matchAll(resultBlockRegex)];

  for (const blockMatch of resultBlocks) {
    if (results.length >= num) break;
    const block = blockMatch[1];

    // Extract title + URL: try h3.t > a, then h3 > a with cosc-title, then a.c-title
    const titleMatch = block.match(/<h3[^>]*class="[^"]*\bt\b[^"]*"[^>]*>\s*<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<h3[^>]*>\s*<a[^>]+class="[^"]*cosc-title[^"]*"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+class="[^"]*c-title[^"]*"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;

    const url = titleMatch[1].replace(/&amp;/g, "&");
    const title = titleMatch[2]
      .replace(/<[^>]*>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/&[^;]+;/g, "")
      .trim();

    if (!url || !title || url.startsWith("javascript:")) continue;

    const abstract = extractBaiduAbstract(block);
    results.push({ title, url, abstract });
  }

  // Fallback: old h3-based parsing if block-based approach yielded nothing
  if (results.length === 0) {
    const h3Regex = /<h3[^>]*class="[^"]*\bt\b[^"]*"[^>]*>\s*<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const h3Blocks = [...html.matchAll(h3Regex)];
    for (const block of h3Blocks) {
      if (results.length >= num) break;
      const url = block[1];
      const title = block[2].replace(/<[^>]*>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/&[^;]+;/g, "").trim();
      if (!url || !title || url.startsWith("javascript:")) continue;
      results.push({ title, url, abstract: "" });
    }
  }

  // Fallback: try c-title links (newer Baidu layout)
  if (results.length === 0) {
    const altRegex = /<a[^>]+class="[^"]*c-title[^"]*"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const altBlocks = [...html.matchAll(altRegex)];
    for (const block of altBlocks) {
      if (results.length >= num) break;
      const url = block[1];
      const title = block[2].replace(/<[^>]*>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();
      if (!url || !title || url.startsWith("javascript:")) continue;
      results.push({ title, url, abstract: "" });
    }
  }

  return results;
}

// Resolve Baidu redirect URLs (baidu.com/link?url=...) to real target URLs
async function resolveBaiduUrls(results) {
  const resolved = await Promise.all(
    results.map(async (r) => {
      if (!r.url.includes("baidu.com/link?")) return r;
      try {
        const res = await fetch(r.url, {
          method: "HEAD",
          redirect: "follow",
          headers: { "User-Agent": "Mozilla/5.0 (compatible; aread/1.0)" },
          signal: AbortSignal.timeout(5000),
        });
        const realUrl = res.url;
        if (realUrl && !realUrl.includes("baidu.com/link?")) {
          return { ...r, url: realUrl };
        }
      } catch {
        // Keep original URL on failure
      }
      return r;
    })
  );
  return resolved;
}

async function baiduSearch(query, num) {
  const timeout = parseInt(opts.timeout, 10) * 1000;
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // Baidu requires cookies to avoid security verification page.
  // First visit baidu.com homepage to obtain session cookies.
  let cookieStr = "";
  try {
    const homeRes = await fetch("https://www.baidu.com/", {
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      redirect: "follow",
    });
    const setCookies = homeRes.headers.getSetCookie?.() || [];
    cookieStr = setCookies.map((c) => c.split(";")[0]).join("; ");
  } catch {
    // Continue without cookies — may still work in some regions
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const params = new URLSearchParams({ wd: query, rn: String(num) });
    const headers = {
      "User-Agent": UA,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer": "https://www.baidu.com/",
    };
    if (cookieStr) headers["Cookie"] = cookieStr;

    const res = await fetch(`https://www.baidu.com/s?${params}`, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // Detect security verification page
    if (html.includes("百度安全验证") && html.length < 5000) {
      throw new Error("baidu returned security verification page (try again later)");
    }

    const results = parseBaiduHtml(html, num);
    return resolveBaiduUrls(results);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`baidu search timed out after ${opts.timeout}s`);
    throw new Error(`baidu search failed: ${e.message}`);
  }
}

// --- Auto engine detection ---

async function probeDdg() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DDG_PROBE_TIMEOUT);

  try {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    return res.status < 500; // reachable if not server error
  } catch {
    clearTimeout(timer);
    return false;
  }
}

async function resolveEngine(engine) {
  if (engine !== "auto") return engine;

  info(`${c.dim}probing DuckDuckGo availability...${c.reset}`);
  const ddgOk = await probeDdg();
  if (ddgOk) {
    info(`${c.dim}DuckDuckGo reachable, using duckduckgo engine${c.reset}`);
    return "duckduckgo";
  }
  info(`${c.dim}DuckDuckGo unreachable, falling back to bing${c.reset}`);
  return "bing";
}

// Search with automatic fallback: if the chosen engine fails, try alternatives
async function searchWithFallback(engine, query, num) {
  const fallbackOrder = {
    duckduckgo: ["bing", "baidu"],
    bing: ["baidu"],
    google: ["bing", "baidu"],
    baidu: ["bing"],
  };

  try {
    const results = await searchWith(engine, query, num);
    if (results && results.length > 0) return results;
    throw new Error("no results returned");
  } catch (primaryErr) {
    const fallbacks = fallbackOrder[engine] || [];
    for (const fb of fallbacks) {
      info(`${c.dim}${engine} failed (${primaryErr.message}), trying ${fb}...${c.reset}`);
      try {
        const results = await searchWith(fb, query, num);
        if (results && results.length > 0) return results;
      } catch {
        // continue to next fallback
      }
    }
    throw primaryErr;
  }
}

// --- Multi-engine aggregate search ---

const MULTI_ENGINES = ["bing", "google", "baidu", "duckduckgo"];

async function multiEngineSearch(query, num) {
  info(`${c.dim}multi-engine search: querying ${MULTI_ENGINES.join(", ")}...${c.reset}`);

  const settled = await Promise.allSettled(
    MULTI_ENGINES.map((engine) => searchWith(engine, query, num))
  );

  const seenUrls = new Set();
  const merged = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "fulfilled" && Array.isArray(result.value)) {
      info(`${c.dim}  ${MULTI_ENGINES[i]}: ${result.value.length} results${c.reset}`);
      for (const item of result.value) {
        const normalizedUrl = normalizeUrl(item.url);
        if (!seenUrls.has(normalizedUrl)) {
          seenUrls.add(normalizedUrl);
          merged.push(item);
        }
      }
    } else {
      const reason = result.status === "rejected" ? result.reason.message : "no results";
      info(`${c.dim}  ${MULTI_ENGINES[i]}: failed (${reason})${c.reset}`);
    }
  }

  return merged;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Remove trailing slash, lowercase host
    let normalized = u.origin.toLowerCase() + u.pathname.replace(/\/+$/, "") + u.search;
    return normalized;
  } catch {
    return url;
  }
}

async function searchWith(engine, query, num) {
  switch (engine) {
    case "duckduckgo": return ddgSearch(query, num);
    case "bing": return bingSearch(query, num);
    case "google": return googleSearch(query, num);
    case "baidu": return baiduSearch(query, num);
    default: die(`unknown engine: ${engine} (supported: ${SUPPORTED_ENGINES.join(", ")})`);
  }
}

function formatSearchResults(results) {
  return results
    .map(
      (r, i) =>
        `${c.bold}${i + 1}.${c.reset} ${c.cyan}${r.title}${c.reset}\n` +
        `   ${c.dim}${r.url}${c.reset}\n` +
        `   ${r.abstract || `${c.dim}(no abstract available)${c.reset}`}`
    )
    .join("\n\n");
}

function formatSearchResultsRaw(results) {
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.abstract || "(no abstract available)"}`).join("\n\n");
}

// --- Main ---

if (opts.search) {
  const num = parseInt(opts.num, 10);

  let results;

  if (opts.multi) {
    info(`${c.dim}searching${c.reset} ${c.cyan}${opts.search}${c.reset} ${c.dim}(multi-engine)${c.reset}`);
    try {
      results = await multiEngineSearch(opts.search, num);
    } catch (e) {
      die(e.message);
    }
  } else {
    const engineArg = opts.engine.toLowerCase();
    if (!SUPPORTED_ENGINES.includes(engineArg)) {
      die(`unknown engine: ${engineArg} (supported: ${SUPPORTED_ENGINES.join(", ")})`);
    }

    const engine = await resolveEngine(engineArg);
    info(`${c.dim}searching${c.reset} ${c.cyan}${opts.search}${c.reset} ${c.dim}(${engine})${c.reset}`);

    try {
      results = await searchWithFallback(engine, opts.search, num);
    } catch (e) {
      die(e.message);
    }
  }

  if (!results || results.length === 0) {
    die("no results found");
  }

  info(`${c.dim}found ${results.length} results${c.reset}\n`);

  if (opts.read) {
    const concurrency = parseInt(opts.concurrency, 10) || 5;
    info(`${c.dim}reading ${results.length} pages (concurrency: ${concurrency})...${c.reset}\n`);

    const settled = await mapConcurrent(results, concurrency, async (r, i) => {
      info(`${c.dim}[${i + 1}/${results.length}]${c.reset} ${c.cyan}${r.url}${c.reset}`);
      const { markdown, cached: wasCached } = await fetchWithFallback(r.url);
      return { index: i, title: r.title, url: r.url, markdown, cached: wasCached };
    });

    // Compute batch read statistics
    const successes = settled.filter((s) => s.status === "fulfilled");
    const failures = settled.filter((s) => s.status === "rejected");
    const failDetails = failures.map((s, fi) => {
      // Find the original index of this failure
      const origIdx = settled.indexOf(s);
      return { idx: origIdx + 1, url: results[origIdx].url, reason: s.reason.message };
    });

    // Print summary statistics
    info(`\n${c.bold}Read summary:${c.reset} ${c.green}${successes.length} succeeded${c.reset}, ${failures.length > 0 ? c.red : c.dim}${failures.length} failed${c.reset} out of ${settled.length} pages`);
    if (failDetails.length > 0) {
      for (const f of failDetails) {
        info(`  ${c.red}✗${c.reset} [${f.idx}] ${f.url} — ${f.reason}`);
      }
      if (successes.length === 0) {
        info(`\n${c.red}All pages failed to fetch.${c.reset} The search results may point to sites with anti-crawl protection. Try different search terms or a different engine.`);
      }
    }

    if (opts.json) {
      const jsonResults = settled.map((s, i) => {
        if (s.status === "fulfilled") {
          return { url: s.value.url, title: s.value.title, markdown: s.value.markdown, cached: s.value.cached, error: null };
        }
        return { url: results[i].url, title: results[i].title, markdown: null, cached: false, error: s.reason.message };
      });
      const jsonOutput = JSON.stringify(jsonResults, null, 2);
      if (opts.output) {
        await writeFile(opts.output, jsonOutput, "utf-8");
        info(`\n${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset}`);
      } else {
        process.stdout.write(jsonOutput + "\n");
      }
    } else {
      const parts = settled.map((s, i) => {
        if (s.status === "fulfilled") {
          const v = s.value;
          return `---\n\n## ${i + 1}. ${v.title}\n\n> Source: ${v.url}\n\n${v.markdown}`;
        }
        const errMsg = s.reason.message;
        return `---\n\n## ${i + 1}. ${results[i].title}\n\n> Source: ${results[i].url}\n\n*Failed to fetch: ${errMsg}*`;
      });

      const output = parts.join("\n\n");
      if (opts.output) {
        await writeFile(opts.output, output, "utf-8");
        info(`\n${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset} ${c.dim}(${Buffer.byteLength(output)} bytes)${c.reset}`);
      } else {
        process.stdout.write(output);
        if (!output.endsWith("\n")) process.stdout.write("\n");
      }
    }
  } else if (opts.json) {
    const jsonOutput = JSON.stringify(results, null, 2);
    if (opts.output) {
      await writeFile(opts.output, jsonOutput, "utf-8");
      info(`${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset}`);
    } else {
      process.stdout.write(jsonOutput + "\n");
    }
  } else {
    const output = raw ? formatSearchResultsRaw(results) : formatSearchResults(results);
    if (opts.output) {
      await writeFile(opts.output, output, "utf-8");
      info(`${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset}`);
    } else {
      console.log(output);
    }
  }
} else {
  let url = positionals[0];
  if (!url) die("missing URL (try aread --help)");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  info(`${c.dim}fetching${c.reset} ${c.cyan}${url}${c.reset}`);

  try {
    const { markdown: body, cached: wasCached } = await fetchWithFallback(url);
    if (wasCached) info(`${c.dim}(from cache)${c.reset}`);

    if (opts.json) {
      const jsonOutput = JSON.stringify({ url, title: null, markdown: body, cached: wasCached, error: null }, null, 2);
      if (opts.output) {
        await writeFile(opts.output, jsonOutput, "utf-8");
        info(`${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset}`);
      } else {
        process.stdout.write(jsonOutput + "\n");
      }
    } else {
      if (opts.output) {
        await writeFile(opts.output, body, "utf-8");
        info(
          `${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset} ${c.dim}(${Buffer.byteLength(body)} bytes)${c.reset}`
        );
      } else {
        process.stdout.write(body);
        if (!body.endsWith("\n")) process.stdout.write("\n");
      }
    }
  } catch (e) {
    if (e.name === "AbortError") die(`request timed out after ${opts.timeout}s`);
    die(e.message);
  }
}
