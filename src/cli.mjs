#!/usr/bin/env node

import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";

const VERSION = "1.0.0";
const JINA_READ = "https://r.jina.ai";
const JINA_SEARCH = "https://s.jina.ai";

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

function printHelp() {
  console.log(`${c.bold}jread${c.reset} ${c.dim}v${VERSION}${c.reset} - Fetch any URL as clean Markdown via Jina Reader

${c.bold}USAGE${c.reset}
    jread [OPTIONS] <URL>

${c.bold}OPTIONS${c.reset}
    -o, --output <FILE>   Save output to file
    -r, --raw             Raw output, no status messages
    -t, --timeout <SEC>   Request timeout in seconds (default: 30)
    -H, --header <K:V>    Extra header for Jina (repeatable)
    -s, --search <QUERY>  Search the web via Jina (s.jina.ai)
    -h, --help            Show this help
    -v, --version         Show version

${c.bold}EXAMPLES${c.reset}
    jread https://example.com
    jread example.com
    jread -o page.md https://example.com
    jread -r https://example.com
    jread -s "rust async tutorial"
    jread -H "X-With-Links:true" https://example.com

${c.bold}JINA HEADERS${c.reset}
    X-Return-Format     html | text | screenshot | pageshot
    X-With-Links        true - include links
    X-With-Images       true - include images
    X-No-Cache          true - bypass Jina cache
    X-Target-Selector   <css> - extract specific element

${c.bold}INSTALL${c.reset}
    npm i -g jread-cli
    bun i -g jread-cli
    npx jread-cli <URL>`);
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
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
} catch (e) {
  die(`${e.message} (try jread --help)`);
}

const { values: opts, positionals } = parsed;
const raw = opts.raw;

if (opts.version) {
  console.log(`jread v${VERSION}`);
  process.exit(0);
}

if (opts.help) {
  printHelp();
  process.exit(0);
}

// --- Build request ---

const headers = { Accept: "text/markdown" };
if (process.env.JINA_API_KEY) {
  headers["Authorization"] = `Bearer ${process.env.JINA_API_KEY}`;
}
for (const h of opts.header) {
  const idx = h.indexOf(":");
  if (idx === -1) die(`invalid header format: ${h} (expected Key:Value)`);
  headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
}

const timeout = parseInt(opts.timeout, 10) * 1000;

let target;
if (opts.search) {
  target = `${JINA_SEARCH}/${encodeURIComponent(opts.search)}`;
  info(`${c.dim}searching${c.reset} ${c.cyan}${opts.search}${c.reset}`);
} else {
  let url = positionals[0];
  if (!url) die("missing URL (try jread --help)");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  target = `${JINA_READ}/${url}`;
  info(`${c.dim}fetching${c.reset} ${c.cyan}${url}${c.reset}`);
}

// --- Fetch ---

try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const res = await fetch(target, {
    headers,
    signal: controller.signal,
    redirect: "follow",
  });
  clearTimeout(timer);

  if (!res.ok) {
    if (res.status === 401 && opts.search) {
      die(
        `search requires a Jina API key.\n       Set JINA_API_KEY env var, or get one free at https://jina.ai/api-key`
      );
    }
    die(`HTTP ${res.status} ${res.statusText}`);
  }

  const body = await res.text();

  if (!body.trim()) {
    die(`empty response - try: jread -H "X-No-Cache:true" <url>`);
  }

  if (opts.output) {
    await writeFile(opts.output, body, "utf-8");
    const bytes = Buffer.byteLength(body, "utf-8");
    info(
      `${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset} ${c.dim}(${bytes} bytes)${c.reset}`
    );
  } else {
    process.stdout.write(body);
    // Ensure trailing newline
    if (!body.endsWith("\n")) process.stdout.write("\n");
  }
} catch (e) {
  if (e.name === "AbortError") {
    die(`request timed out after ${opts.timeout}s`);
  }
  die(e.message);
}
