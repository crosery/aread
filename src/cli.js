#!/usr/bin/env node

import { parseArgs } from "node:util";
import { writeFile, mkdir, access, chmod } from "node:fs/promises";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir, platform } from "node:os";

// Windows encoding fix
if (platform() === "win32") {
  // Method 1: chcp 65001 (works on most Windows 10+)
  spawnSync("chcp", ["65001"], { shell: true, stdio: "ignore" });

  // Method 2: PowerShell - set .NET console encoding (more reliable)
  spawnSync("powershell", [
    "-NoProfile", "-Command",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8"
  ], { stdio: "ignore" });

  // Method 3: ensure Node writes UTF-8 BOM-less output
  if (process.stdout._handle && process.stdout._handle.setBlocking) {
    process.stdout._handle.setBlocking(true);
  }

  // Ensure ddgr subprocess also outputs UTF-8
  process.env.PYTHONIOENCODING = "utf-8";
}

const VERSION = "1.2.3";
const JINA_READ = "https://r.jina.ai";
const DDGR_VERSION = "2.2";
const DDGR_URLS = [
  `https://raw.githubusercontent.com/jarun/ddgr/v${DDGR_VERSION}/ddgr`,
  `https://cdn.jsdelivr.net/gh/jarun/ddgr@v${DDGR_VERSION}/ddgr`,
  `https://gitee.com/mirrors/ddgr/raw/v${DDGR_VERSION}/ddgr`,
];

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

function exec(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONIOENCODING: "utf-8", LANG: "en_US.UTF-8" };
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, timeout, encoding: "utf-8", env }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve(stdout);
    });
  });
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function cmdExists(cmd) {
  try {
    execFileSync(platform() === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function findPython() {
  for (const cmd of platform() === "win32" ? ["python", "python3", "py"] : ["python3", "python"]) {
    if (cmdExists(cmd)) return cmd;
  }
  return null;
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
    npx aread-cli <URL>

${c.bold}NOTE${c.reset}
    Search requires Python 3. First search auto-downloads ddgr to cache.
    Reading works without Python.`);
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

// --- ddgr management ---

function getCacheDir() {
  const home = homedir();
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "aread");
  }
  return join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "aread");
}

async function downloadWithFallback(urls, dest) {
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      clearTimeout(timer);
      if (res.ok) {
        const text = await res.text();
        if (text.startsWith("#!/")) {
          await writeFile(dest, text, "utf-8");
          return true;
        }
      }
    } catch {}
  }
  return false;
}

async function ensureDdgr() {
  // 1. Check system ddgr
  if (cmdExists("ddgr")) return { cmd: "ddgr", args: [] };

  // 2. Check cached ddgr
  const cacheDir = getCacheDir();
  const ddgrPath = join(cacheDir, "ddgr");
  const python = findPython();

  if (await fileExists(ddgrPath)) {
    if (!python) die("Python 3 is required for search. Install from https://python.org");
    return { cmd: python, args: [ddgrPath] };
  }

  // 3. Download ddgr
  if (!python) die("Python 3 is required for search. Install from https://python.org");

  info(`${c.dim}first run: downloading ddgr search engine (~60KB)...${c.reset}`);
  await mkdir(cacheDir, { recursive: true });

  const ok = await downloadWithFallback(DDGR_URLS, ddgrPath);
  if (!ok) {
    die(
      `failed to download ddgr. Install it manually:\n` +
        `       ${c.dim}arch:${c.reset}   pacman -S ddgr\n` +
        `       ${c.dim}mac:${c.reset}    brew install ddgr\n` +
        `       ${c.dim}pip:${c.reset}    pip install ddgr\n` +
        `       ${c.dim}win:${c.reset}    pip install ddgr`
    );
  }

  if (platform() !== "win32") await chmod(ddgrPath, 0o755);

  info(`${c.green}done${c.reset} ${c.dim}(cached at ${ddgrPath})${c.reset}\n`);
  return { cmd: python, args: [ddgrPath] };
}

// --- DuckDuckGo search ---

async function ddgSearch(query, num) {
  const { cmd, args: baseArgs } = await ensureDdgr();
  const timeout = parseInt(opts.timeout, 10) * 1000;
  const args = [...baseArgs, "--json", "-n", String(num), query];

  try {
    const stdout = await exec(cmd, args, timeout);
    return JSON.parse(stdout);
  } catch (e) {
    if (e.killed) die(`search timed out after ${opts.timeout}s`);
    die(`search failed: ${e.message}${e.stderr ? "\n       " + e.stderr.trim() : ""}`);
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
  info(`${c.dim}searching${c.reset} ${c.cyan}${opts.search}${c.reset}`);

  let results;
  try {
    results = await ddgSearch(opts.search, num);
  } catch (e) {
    die(e.message);
  }

  if (!results || results.length === 0) {
    die("no results found");
  }

  info(`${c.dim}found ${results.length} results${c.reset}\n`);

  if (opts.read) {
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
      info(
        `\n${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset} ${c.dim}(${Buffer.byteLength(output)} bytes)${c.reset}`
      );
    } else {
      process.stdout.write(output);
      if (!output.endsWith("\n")) process.stdout.write("\n");
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
    const body = await jinaFetch(url);

    if (opts.output) {
      await writeFile(opts.output, body, "utf-8");
      info(
        `${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset} ${c.dim}(${Buffer.byteLength(body)} bytes)${c.reset}`
      );
    } else {
      process.stdout.write(body);
      if (!body.endsWith("\n")) process.stdout.write("\n");
    }
  } catch (e) {
    if (e.name === "AbortError") die(`request timed out after ${opts.timeout}s`);
    die(e.message);
  }
}
