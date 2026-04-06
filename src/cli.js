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

const VERSION = "1.3.1";
const JINA_READ = "https://r.jina.ai";
const SUPPORTED_ENGINES = ["duckduckgo", "bing", "google", "baidu", "auto"];
const DDG_PROBE_TIMEOUT = 3000;

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

  if (!res.ok) die(`HTTP ${res.status} ${res.statusText} for ${url}`);

  const body = await res.text();
  if (!body.trim()) die(`empty response for ${url} - try: aread -H "X-No-Cache:true" ${url}`);

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

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
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
      throw new Error(`jina: ${jinaErr.message}; local: ${localErr.message}`);
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

    if (!res.ok) die(`search failed: HTTP ${res.status}`);
    const html = await res.text();
    return parseDdgHtml(html, num);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") die(`search timed out after ${opts.timeout}s`);
    die(`search failed: ${e.message}`);
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
    const linkMatch = block.match(/<h2[^>]*><a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a><\/h2>/i);
    if (!linkMatch) continue;

    let url = linkMatch[1].replace(/&amp;/g, "&");
    // Decode Bing redirect URL (u param is base64 with 'a1' prefix)
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
    const params = new URLSearchParams({ q: query, count: String(num) });
    const res = await fetch(`https://www.bing.com/search?${params}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
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
  // Google wraps each result in <div class="g">
  const blockRegex = /<div\s+class="[^"]*\bg\b[^"]*">([\s\S]*?)<\/div>\s*(?=<div\s+class="[^"]*\bg\b|$)/gi;
  const blocks = [...html.matchAll(blockRegex)];

  for (let i = 0; i < Math.min(blocks.length, num); i++) {
    const block = blocks[i][1];
    // Extract first <a href="http..."> link
    const linkMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const url = linkMatch[1];
    // Title is usually in <h3>
    const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]*>/g, "").trim()
      : linkMatch[2].replace(/<[^>]*>/g, "").trim();

    // Snippet in <span> or <div> after the link area
    let abstract = "";
    const snippetMatch = block.match(/<span[^>]*class="[^"]*"[^>]*>([\s\S]{20,}?)<\/span>/i)
      || block.match(/<div[^>]*data-sncf[^>]*>([\s\S]*?)<\/div>/i);
    if (snippetMatch) {
      abstract = snippetMatch[1].replace(/<[^>]*>/g, "").trim();
    }

    if (url && title && !url.includes("google.com/search")) {
      results.push({ title, url, abstract });
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

function parseBaiduHtml(html, num) {
  const results = [];
  // Baidu results: <div class="result c-container ..."> with <h3 class="t"><a href="...">Title</a></h3>
  const blockRegex = /<div[^>]+class="[^"]*result[^"]*c-container[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<!--/gi;
  // Fallback: simpler pattern
  const blockRegex2 = /<h3[^>]*class="[^"]*t[^"]*"[^>]*>\s*<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

  const blocks = [...html.matchAll(blockRegex2)];
  for (let i = 0; i < Math.min(blocks.length, num); i++) {
    const url = blocks[i][1];
    const title = blocks[i][2].replace(/<[^>]*>/g, "").replace(/&[^;]+;/g, "").trim();

    // Baidu uses redirect URLs, the real URL is resolved on click
    // We keep the baidu redirect URL as-is since resolving requires following redirects
    if (url && title) {
      results.push({ title, url, abstract: "" });
    }
  }

  return results;
}

async function baiduSearch(query, num) {
  const timeout = parseInt(opts.timeout, 10) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const params = new URLSearchParams({ wd: query, rn: String(num) });
    const res = await fetch(`https://www.baidu.com/s?${params}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return parseBaiduHtml(html, num);
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
        `   ${r.abstract || ""}`
    )
    .join("\n\n");
}

function formatSearchResultsRaw(results) {
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.abstract || ""}`).join("\n\n");
}

// --- Main ---

if (opts.search) {
  const num = parseInt(opts.num, 10);
  const engineArg = opts.engine.toLowerCase();
  if (!SUPPORTED_ENGINES.includes(engineArg)) {
    die(`unknown engine: ${engineArg} (supported: ${SUPPORTED_ENGINES.join(", ")})`);
  }

  const engine = await resolveEngine(engineArg);
  info(`${c.dim}searching${c.reset} ${c.cyan}${opts.search}${c.reset} ${c.dim}(${engine})${c.reset}`);

  let results;
  try {
    results = await searchWith(engine, opts.search, num);
  } catch (e) {
    die(e.message);
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
        return `---\n\n## ${i + 1}. ${results[i].title}\n\n> Source: ${results[i].url}\n\n*Failed to fetch*`;
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
