#!/usr/bin/env node

import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";

const VERSION = "1.1.0";
const JINA_READ = "https://r.jina.ai";
const DDG_URL = "https://html.duckduckgo.com/html/";

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

function htmlDecode(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
}

function stripTags(str) {
  return str.replace(/<[^>]*>/g, "").trim();
}

function printHelp() {
  console.log(`${c.bold}aread${c.reset} ${c.dim}v${VERSION}${c.reset} - AI-friendly web reader & search

${c.bold}USAGE${c.reset}
    aread <URL>                Read a page as Markdown
    aread -s <QUERY>           Search the web (DuckDuckGo)
    aread -s <QUERY> --read    Search + read top results as Markdown

${c.bold}READ OPTIONS${c.reset}
    -o, --output <FILE>        Save output to file
    -r, --raw                  No status messages, pipe-friendly
    -t, --timeout <SEC>        Request timeout (default: 30)
    -H, --header <K:V>         Extra Jina header (repeatable)

${c.bold}SEARCH OPTIONS${c.reset}
    -s, --search <QUERY>       Search via DuckDuckGo
    -n, --num <N>              Number of search results (default: 10)
    --read                     Also fetch each result as Markdown

${c.bold}GENERAL${c.reset}
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
    npx aread-cli <URL>`);
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
      read: { type: "boolean", default: false },
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

// --- DuckDuckGo search (built-in, zero deps) ---

async function ddgSearch(query, num) {
  const timeout = parseInt(opts.timeout, 10) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const res = await fetch(DDG_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; aread-cli/1.1.0)",
    },
    body: `q=${encodeURIComponent(query)}`,
    signal: controller.signal,
    redirect: "follow",
  });
  clearTimeout(timer);

  if (!res.ok) die(`DuckDuckGo returned HTTP ${res.status}`);

  const html = await res.text();
  return parseDDGResults(html, num);
}

function parseDDGResults(html, max) {
  const results = [];
  // Match each result block: <a class="result__a" href="...">title</a> + snippet
  const resultBlocks = html.split(/class="result__body/g).slice(1);

  for (const block of resultBlocks) {
    if (results.length >= max) break;

    // Extract URL
    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
    if (!urlMatch) continue;

    let url = urlMatch[1];
    // DDG wraps URLs in redirect, extract actual URL
    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);

    // Skip DDG internal links
    if (url.startsWith("/") || url.includes("duckduckgo.com")) continue;

    // Extract title
    const titleMatch = block.match(/class="result__a"[^>]*>(.+?)<\/a>/s);
    const title = titleMatch ? htmlDecode(stripTags(titleMatch[1])) : url;

    // Extract snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>(.*?)<\/(?:a|td|div|span)/s);
    const snippet = snippetMatch ? htmlDecode(stripTags(snippetMatch[1])) : "";

    results.push({ title, url, snippet });
  }

  return results;
}

function formatSearchResults(results) {
  return results
    .map(
      (r, i) =>
        `${c.bold}${i + 1}.${c.reset} ${c.cyan}${r.title}${c.reset}\n` +
        `   ${c.dim}${r.url}${c.reset}\n` +
        `   ${r.snippet}`
    )
    .join("\n\n");
}

function formatSearchResultsRaw(results) {
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n");
}

// --- Main ---

if (opts.search) {
  // Search mode
  const num = parseInt(opts.num, 10);
  info(`${c.dim}searching${c.reset} ${c.cyan}${opts.search}${c.reset}`);

  let results;
  try {
    results = await ddgSearch(opts.search, num);
  } catch (e) {
    if (e.name === "AbortError") die(`search timed out after ${opts.timeout}s`);
    die(`search failed: ${e.message}`);
  }

  if (!results || results.length === 0) {
    die("no results found");
  }

  info(`${c.dim}found ${results.length} results${c.reset}\n`);

  if (opts.read) {
    // Search + read each result
    info(`${c.dim}reading ${results.length} pages...${c.reset}\n`);

    const parts = [];
    for (const [i, r] of results.entries()) {
      info(`${c.dim}[${i + 1}/${results.length}]${c.reset} ${c.cyan}${r.url}${c.reset}`);
      try {
        const md = await jinaFetch(r.url);
        parts.push(`---\n\n## ${i + 1}. ${r.title}\n\n> Source: ${r.url}\n\n${md}`);
      } catch {
        parts.push(`---\n\n## ${i + 1}. ${r.title}\n\n> Source: ${r.url}\n\n*Failed to fetch*`);
      }
    }

    const output = parts.join("\n\n");
    if (opts.output) {
      await writeFile(opts.output, output, "utf-8");
      info(`\n${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset} ${c.dim}(${Buffer.byteLength(output)} bytes)${c.reset}`);
    } else {
      process.stdout.write(output);
      if (!output.endsWith("\n")) process.stdout.write("\n");
    }
  } else {
    // Search only
    const output = raw ? formatSearchResultsRaw(results) : formatSearchResults(results);
    if (opts.output) {
      await writeFile(opts.output, output, "utf-8");
      info(`${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset}`);
    } else {
      console.log(output);
    }
  }
} else {
  // Read mode
  let url = positionals[0];
  if (!url) die("missing URL (try aread --help)");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  info(`${c.dim}fetching${c.reset} ${c.cyan}${url}${c.reset}`);

  try {
    const body = await jinaFetch(url);

    if (opts.output) {
      await writeFile(opts.output, body, "utf-8");
      info(`${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset} ${c.dim}(${Buffer.byteLength(body)} bytes)${c.reset}`);
    } else {
      process.stdout.write(body);
      if (!body.endsWith("\n")) process.stdout.write("\n");
    }
  } catch (e) {
    if (e.name === "AbortError") die(`request timed out after ${opts.timeout}s`);
    die(e.message);
  }
}
