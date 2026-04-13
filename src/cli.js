#!/usr/bin/env node

import { parseArgs } from "node:util";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

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

const VERSION = "1.6.0";
const JINA_READ = "https://r.jina.ai";
const SUPPORTED_ENGINES = ["duckduckgo", "bing", "auto"];
const DDG_PROBE_TIMEOUT = 3000;

// --- AI Provider presets (all OpenAI-compatible) ---

const AI_PROVIDERS = {
  openai:      { name: "OpenAI",      baseUrl: "https://api.openai.com/v1" },
  groq:        { name: "Groq",        baseUrl: "https://api.groq.com/openai/v1" },
  openrouter:  { name: "OpenRouter",  baseUrl: "https://openrouter.ai/api/v1" },
  xai:         { name: "xAI",         baseUrl: "https://api.x.ai/v1" },
  siliconflow: { name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1" },
  longcat:     { name: "LongCat",     baseUrl: "https://api.longcat.chat/openai/v1" },
};

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

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

async function getCachedContent(url) {
  if (opts && opts["no-cache"]) return null;
  const cacheDir = getCacheDir();
  const cachePath = join(cacheDir, urlHash(url) + ".md");
  try {
    const { stat } = await import("node:fs/promises");
    const st = await stat(cachePath);
    if (Date.now() - st.mtimeMs > CACHE_MAX_AGE_MS) return null; // expired
    return await readFile(cachePath, "utf-8");
  } catch {
    return null;
  }
}

async function setCachedContent(url, content) {
  // Don't cache garbage (too short or looks like JS/CSS noise)
  if (!content || content.length < 50) return;
  const cacheDir = getCacheDir();
  await mkdir(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, urlHash(url) + ".md");
  await writeFile(cachePath, content, "utf-8");
}

// --- AI Config ---

function getConfigDir() {
  const home = homedir();
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "aread");
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "aread");
}

function getConfigPath() {
  return join(getConfigDir(), "config.json");
}

async function loadConfig() {
  try {
    const raw = await readFile(getConfigPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveConfig(config) {
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true });
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function getNestedValue(obj, keyPath) {
  const keys = keyPath.split(".");
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

function setNestedValue(obj, keyPath, value) {
  const keys = keyPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function deleteNestedValue(obj, keyPath) {
  const keys = keyPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") return;
    cur = cur[keys[i]];
  }
  delete cur[keys[keys.length - 1]];
}

function resolveAIConfig(config) {
  const ai = config.ai || {};
  let baseUrl = ai.baseUrl;
  const apiKey = ai.apiKey;
  const model = ai.model;
  const provider = ai.provider;

  // If provider is set and no custom baseUrl, use preset
  if (provider && !baseUrl) {
    const preset = AI_PROVIDERS[provider.toLowerCase()];
    if (preset) baseUrl = preset.baseUrl;
  }

  return { baseUrl, apiKey, model, provider };
}

async function aiSummarize(markdown, url) {
  const config = await loadConfig();
  const { baseUrl, apiKey, model } = resolveAIConfig(config);

  if (!baseUrl || !apiKey || !model) {
    const missing = [];
    if (!baseUrl) missing.push("ai.baseUrl or ai.provider");
    if (!apiKey) missing.push("ai.apiKey");
    if (!model) missing.push("ai.model");
    throw new Error(`AI not configured. Missing: ${missing.join(", ")}. Run: aread config set <key> <value>`);
  }

  const endpoint = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const timeout = parseInt(opts.timeout, 10) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 2); // give AI more time

  try {
    // Truncate very long content to avoid token limits
    const maxChars = 30000;
    const content = markdown.length > maxChars
      ? markdown.slice(0, maxChars) + "\n\n[... content truncated ...]"
      : markdown;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `Extract key information from the web page. Respond in markdown, same language as source. Keep it under 500 words.

Format:
# (subject-specific title, not "summary")

(1-2 sentence core conclusion)

- key fact or data point
- key fact or data point
- ...

(Only add short paragraphs if there are technical details or nuanced arguments that bullet points can't capture. Otherwise stop after the bullets.)

Rules: only verifiable facts from the source. No filler, no "this article discusses", no meta-commentary. Prioritize facts and data over opinions. Ignore nav, ads, boilerplate.`,
          },
          {
            role: "user",
            content: `${url}\n\n${content}`,
          },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`AI API returned ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const choice = data.choices && data.choices[0];
    if (!choice || !choice.message || !choice.message.content) {
      throw new Error("AI API returned empty response");
    }

    return choice.message.content.trim();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`AI summarization timed out`);
    throw e;
  }
}

async function promptLine(rl, question, defaultValue) {
  const suffix = defaultValue ? ` ${c.dim}(${defaultValue})${c.reset}` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

async function promptSelect(rl, question, choices) {
  console.log(`\n${c.bold}${question}${c.reset}\n`);
  for (let i = 0; i < choices.length; i++) {
    const ch = choices[i];
    console.log(`  ${c.cyan}${String(i + 1).padStart(2)}${c.reset}  ${ch.label}${ch.hint ? `  ${c.dim}${ch.hint}${c.reset}` : ""}`);
  }
  console.log();

  while (true) {
    const answer = await promptLine(rl, `Select [1-${choices.length}]`);
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < choices.length) return choices[idx].value;
    process.stderr.write(`${c.red}Invalid choice, try again${c.reset}\n`);
  }
}

async function configInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  try {
    console.log(`\n${c.bold}aread AI Configuration${c.reset}\n`);
    console.log(`${c.dim}Configure AI summarization for aread. Values can be pasted from clipboard.${c.reset}`);

    const config = await loadConfig();
    const existing = config.ai || {};

    // Step 1: Choose provider
    const providerEntries = Object.entries(AI_PROVIDERS);
    const providerChoices = [
      ...providerEntries.map(([id, p]) => ({
        value: id,
        label: `${p.name}`,
        hint: p.baseUrl,
      })),
      { value: "custom", label: "Custom (OpenAI-compatible)", hint: "enter your own base URL" },
    ];

    // Find current provider index for display
    const currentProvider = existing.provider || null;

    const provider = await promptSelect(rl, "Choose AI Provider", providerChoices);

    let baseUrl = "";
    if (provider === "custom") {
      baseUrl = await promptLine(rl, `\n  Base URL`, existing.baseUrl);
      if (!baseUrl) {
        process.stderr.write(`${c.red}Base URL is required for custom provider${c.reset}\n`);
        return;
      }
    }

    // Step 2: API Key
    console.log();
    const currentKeyHint = existing.apiKey ? existing.apiKey.slice(0, 6) + "...***" : "";
    const apiKey = await promptLine(rl, `  API Key`, currentKeyHint ? "keep current" : "");

    let finalApiKey = existing.apiKey;
    if (apiKey && apiKey !== "keep current") {
      finalApiKey = apiKey;
    }
    if (!finalApiKey) {
      process.stderr.write(`${c.red}API Key is required${c.reset}\n`);
      return;
    }

    // Step 3: Model name
    const modelHints = {
      openai: "e.g. gpt-4o-mini, gpt-4o, gpt-4.1-nano",
      groq: "e.g. llama-3.3-70b-versatile, gemma2-9b-it",
      openrouter: "e.g. google/gemini-2.0-flash-001, deepseek/deepseek-chat",
      xai: "e.g. grok-2-latest",
      siliconflow: "e.g. deepseek-ai/DeepSeek-V3, Qwen/Qwen2.5-7B-Instruct",
      longcat: "e.g. LongCat-Flash-Chat, LongCat-Flash-Lite",
      custom: "enter model name",
    };
    const hint = modelHints[provider] || "";
    console.log(`\n  ${c.dim}${hint}${c.reset}`);
    const model = await promptLine(rl, `  Model`, existing.model);
    if (!model) {
      process.stderr.write(`${c.red}Model name is required${c.reset}\n`);
      return;
    }

    // Save config
    config.ai = config.ai || {};
    if (provider !== "custom") {
      config.ai.provider = provider;
      delete config.ai.baseUrl;
    } else {
      config.ai.baseUrl = baseUrl;
      delete config.ai.provider;
    }
    config.ai.apiKey = finalApiKey;
    config.ai.model = model;

    // Step 4: Auto-summarize
    const currentAuto = existing.autoSummarize === "true" ? "yes" : "no";
    console.log();
    const autoAnswer = await promptLine(rl, `  Auto-summarize every fetch? (yes/no)`, currentAuto);
    config.ai.autoSummarize = (autoAnswer.toLowerCase() === "yes" || autoAnswer.toLowerCase() === "y") ? "true" : "false";

    await saveConfig(config);

    // Confirm
    const displayProvider = provider === "custom" ? `custom (${baseUrl})` : `${AI_PROVIDERS[provider].name}`;
    const displayKey = finalApiKey.slice(0, 6) + "..." + finalApiKey.slice(-4);
    const autoLabel = config.ai.autoSummarize === "true" ? `${c.green}on${c.reset}` : `${c.dim}off${c.reset}`;

    console.log(`\n${c.green}✓ Configuration saved${c.reset}\n`);
    console.log(`  Provider:       ${c.cyan}${displayProvider}${c.reset}`);
    console.log(`  API Key:        ${c.dim}${displayKey}${c.reset}`);
    console.log(`  Model:          ${c.cyan}${model}${c.reset}`);
    console.log(`  Auto-summarize: ${autoLabel}`);
    console.log(`\n  ${c.dim}Config: ${getConfigPath()}${c.reset}`);
    if (config.ai.autoSummarize === "true") {
      console.log(`  ${c.dim}AI summary is ON by default. Use --no-summarize to skip.${c.reset}`);
    } else {
      console.log(`  ${c.dim}Use -S or --summarize to enable AI summary.${c.reset}`);
    }
    console.log();
  } finally {
    rl.close();
  }
}

async function handleConfigCommand(args) {
  const sub = args[0];

  if (sub === "init") {
    await configInit();
    return;
  }

  if (sub === "set" && args.length >= 3) {
    const key = args[1];
    const value = args.slice(2).join(" ");
    const config = await loadConfig();
    setNestedValue(config, key, value);
    await saveConfig(config);
    // Mask sensitive values in output
    const keyLower = key.toLowerCase();
    const isSensitive = keyLower.includes("apikey") || keyLower.includes("key") || keyLower.includes("cookie");
    const display = isSensitive
      ? value.slice(0, 10) + "..." + ` (${value.length} chars)`
      : value;
    process.stderr.write(`${c.green}✓${c.reset} ${key} = ${display}\n`);
    return;
  }

  if (sub === "get" && args[1]) {
    const config = await loadConfig();
    const val = getNestedValue(config, args[1]);
    if (val === undefined) {
      process.stderr.write(`${c.dim}(not set)${c.reset}\n`);
    } else {
      console.log(typeof val === "object" ? JSON.stringify(val, null, 2) : val);
    }
    return;
  }

  if (sub === "delete" && args[1]) {
    const config = await loadConfig();
    deleteNestedValue(config, args[1]);
    await saveConfig(config);
    process.stderr.write(`${c.green}✓${c.reset} deleted ${args[1]}\n`);
    return;
  }

  if (sub === "show" || sub === undefined) {
    const config = await loadConfig();
    if (Object.keys(config).length === 0) {
      process.stderr.write(`${c.dim}(no config)${c.reset}\n\n`);
    } else {
      // Mask sensitive values
      const display = JSON.parse(JSON.stringify(config));
      if (display.ai && display.ai.apiKey) {
        const k = display.ai.apiKey;
        display.ai.apiKey = k.slice(0, 6) + "..." + k.slice(-4);
      }
      if (display.zhihu && display.zhihu.cookie) {
        const ck = display.zhihu.cookie;
        display.zhihu.cookie = ck.slice(0, 20) + "..." + ` (${ck.length} chars)`;
      }
      console.log(JSON.stringify(display, null, 2));
    }
    process.stderr.write(`\n${c.dim}config: ${getConfigPath()}${c.reset}\n`);
    return;
  }

  if (sub === "providers") {
    console.log(`${c.bold}Built-in AI providers:${c.reset}\n`);
    for (const [id, p] of Object.entries(AI_PROVIDERS)) {
      console.log(`  ${c.cyan}${id.padEnd(12)}${c.reset} ${p.baseUrl}`);
    }
    console.log(`\n${c.dim}Usage: aread config set ai.provider <name>${c.reset}`);
    console.log(`${c.dim}Or set a custom baseUrl: aread config set ai.baseUrl <url>${c.reset}`);
    return;
  }

  // Unknown subcommand — show usage
  console.log(`${c.bold}aread config${c.reset} - Manage configuration

${c.bold}USAGE${c.reset}
    aread config init               Interactive setup (recommended)
    aread config show               Show current config
    aread config set <key> <value>  Set a config value
    aread config get <key>          Get a config value
    aread config delete <key>       Delete a config value
    aread config providers          List built-in AI providers

${c.bold}AI CONFIG KEYS${c.reset}
    ai.provider        Provider preset (${Object.keys(AI_PROVIDERS).join(", ")})
    ai.baseUrl         Custom API base URL (overrides provider preset)
    ai.apiKey          API key
    ai.model           Model name (e.g. gpt-4o-mini, deepseek-chat, etc.)
    ai.autoSummarize   Auto-summarize on every fetch (true/false)
    zhihu.cookie       Zhihu browser cookie (for fetching zhihu.com articles)

${c.bold}EXAMPLES${c.reset}
    aread config set ai.provider openrouter
    aread config set ai.apiKey sk-or-xxx
    aread config set ai.model google/gemini-2.0-flash-001
    aread config set ai.provider siliconflow
    aread config set ai.model deepseek-ai/DeepSeek-V3`);
}

function printHelp() {
  console.log(`${c.bold}aread${c.reset} ${c.dim}v${VERSION}${c.reset} - AI-friendly web reader & search

${c.bold}USAGE${c.reset}
    aread <URL>                Read a page as Markdown
    aread <URL> --summarize    Read + AI summary
    aread -s <QUERY>           Search the web (default: DuckDuckGo)
    aread -s <QUERY> --read    Search + read top results as Markdown
    aread config               Manage AI config

${c.bold}READ OPTIONS${c.reset}
    -o, --output <FILE>        Save output to file
    -r, --raw                  No status messages, pipe-friendly
    -t, --timeout <SEC>        Request timeout (default: 30)
    -H, --header <K:V>         Extra Jina header (repeatable)
    -S, --summarize            Summarize content with AI (requires config)
    --no-summarize             Disable AI summary (override autoSummarize)

${c.bold}SEARCH OPTIONS${c.reset}
    -s, --search <QUERY>       Search the web
    -n, --num <N>              Number of search results (default: 10)
    -e, --engine <ENGINE>      Search engine: duckduckgo|bing|auto
                               (default: duckduckgo, auto probes DDG then falls back to Bing)
    -m, --multi                Query all engines concurrently, merge & deduplicate results
    --read                     Also fetch each result as Markdown
    -c, --concurrency <N>      Concurrent reads (default: 5, with --read)

${c.bold}AI SUMMARIZE${c.reset}
    Setup:  aread config init                   Interactive setup (recommended)
    Or manually:
      aread config set ai.provider <provider>   Set provider (openai, groq, openrouter, xai, siliconflow, longcat)
      aread config set ai.apiKey <key>          Set API key
      aread config set ai.model <model>         Set model name
    Auto mode (summarize every fetch without -S flag):
      aread config set ai.autoSummarize true    Enable auto-summarize
      aread config set ai.autoSummarize false   Disable auto-summarize
    See all providers: aread config providers

${c.bold}GENERAL${c.reset}
    --no-cache                 Skip URL cache
    --json                     Output structured JSON
    -h, --help                 Show this help
    -v, --version              Show version

${c.bold}EXAMPLES${c.reset}
    aread https://example.com
    aread example.com
    aread example.com --summarize
    aread -o page.md https://example.com
    aread -r https://example.com | head -50
    aread -s "rust async tutorial"
    aread -s "react hooks" -n 3
    aread -s "node.js streams" --read
    aread -s "node.js streams" --read --summarize
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
    Search supports multiple engines (DuckDuckGo, Bing).
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
      summarize: { type: "boolean", short: "S" },
      "no-summarize": { type: "boolean", default: false },
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

// --- Browser cookie extraction (Chrome/Chromium on macOS) ---

const CHROME_BROWSERS = [
  { name: "Chrome",   dir: "Google/Chrome/",                  keychain: "Chrome Safe Storage" },
  { name: "Arc",      dir: "Arc/User Data/",                  keychain: "Arc Safe Storage" },
  { name: "Edge",     dir: "Microsoft Edge/",                 keychain: "Microsoft Edge Safe Storage" },
  { name: "Brave",    dir: "BraveSoftware/Brave-Browser/",    keychain: "Brave Safe Storage" },
  { name: "Chromium", dir: "chromium/",                       keychain: "Chromium Safe Storage" },
];

function findChromeDbPath() {
  if (platform() !== "darwin") return null; // macOS only for now
  const base = join(homedir(), "Library", "Application Support");
  for (const b of CHROME_BROWSERS) {
    const dbPath = join(base, b.dir, "Default", "Cookies");
    if (existsSync(dbPath)) return { dbPath, browser: b };
  }
  return null;
}

async function getKeychainPassword(service) {
  return new Promise((resolve, reject) => {
    const proc = spawnSync("security", ["find-generic-password", "-s", service, "-w"], {
      timeout: 10000,
      encoding: "utf-8",
    });
    if (proc.status !== 0) {
      const err = (proc.stderr || "").trim();
      if (err.includes("not be found")) reject(new Error(`No Keychain entry for "${service}"`));
      else reject(new Error(`Keychain error: ${err}`));
      return;
    }
    resolve(proc.stdout.trim());
  });
}

function deriveKey(password, iterations) {
  return createHash("sha1"); // placeholder — use proper pbkdf2
}

// Cache extracted cookies to avoid repeated Keychain/DB access
const _cookieCache = new Map();

async function extractBrowserCookies(domain) {
  if (_cookieCache.has(domain)) return _cookieCache.get(domain);

  const found = findChromeDbPath();
  if (!found) { _cookieCache.set(domain, null); return null; }

  const { dbPath, browser } = found;
  info(`${c.dim}reading cookies from ${browser.name}...${c.reset}`);

  // Get Keychain password and derive AES key
  let keychainPassword;
  try {
    keychainPassword = await getKeychainPassword(browser.keychain);
  } catch (e) {
    info(`${c.dim}keychain access failed: ${e.message}${c.reset}`);
    return null;
  }

  const { pbkdf2Sync, createDecipheriv } = await import("node:crypto");
  const aesKey = pbkdf2Sync(keychainPassword, "saltysalt", 1003, 16, "sha1");

  // Copy DB to avoid locking issues (Chrome may have it open)
  const tmpDb = join("/tmp", `aread-cookies-${Date.now()}.db`);
  const { copyFileSync, unlinkSync } = await import("node:fs");
  try {
    copyFileSync(dbPath, tmpDb);
    if (existsSync(dbPath + "-wal")) copyFileSync(dbPath + "-wal", tmpDb + "-wal");
    if (existsSync(dbPath + "-shm")) copyFileSync(dbPath + "-shm", tmpDb + "-shm");
  } catch {
    return null;
  }

  try {
    // Query with sqlite3 CLI (zero dependency)
    const domains = [domain, "." + domain];
    // Include subdomains
    const domainClauses = domains.map(d => `host_key = '${d.replace(/'/g, "''")}'`).join(" OR ");
    const sql = `SELECT host_key, name, value, hex(encrypted_value) as ev_hex, path, expires_utc, is_secure, is_httponly FROM cookies WHERE (${domainClauses} OR host_key LIKE '%.${domain.replace(/'/g, "''")}') AND (has_expires = 0 OR expires_utc > ${Date.now() * 1000 + 11644473600000000});`;

    const result = spawnSync("sqlite3", ["-json", tmpDb, sql], {
      timeout: 5000,
      encoding: "utf-8",
    });

    if (result.status !== 0) return null;
    const rows = JSON.parse(result.stdout || "[]");
    if (rows.length === 0) return null;

    // Decrypt cookies and build cookie string
    const cookieParts = [];
    for (const row of rows) {
      let value = row.value || "";

      if (!value && row.ev_hex) {
        try {
          const ev = Buffer.from(row.ev_hex, "hex");
          if (ev.length > 3) {
            const prefix = ev.slice(0, 3).toString("utf-8");
            if (prefix === "v10") {
              const ciphertext = ev.slice(3);
              const iv = Buffer.alloc(16, 0x20);
              const decipher = createDecipheriv("aes-128-cbc", aesKey, iv);
              const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
              if (plaintext.length > 32) {
                value = plaintext.slice(32).toString("utf-8");
              }
            }
          }
        } catch {
          continue; // skip failed decryption
        }
      }

      if (value) {
        cookieParts.push(`${row.name}=${value}`);
      }
    }

    if (cookieParts.length === 0) { _cookieCache.set(domain, null); return null; }
    const cookieStr = cookieParts.join("; ");
    info(`${c.green}✓${c.reset} ${c.dim}extracted ${cookieParts.length} cookies from ${browser.name}${c.reset}`);
    _cookieCache.set(domain, cookieStr);
    return cookieStr;
  } finally {
    try { unlinkSync(tmpDb); } catch {}
    try { unlinkSync(tmpDb + "-wal"); } catch {}
    try { unlinkSync(tmpDb + "-shm"); } catch {}
  }
}

// --- Zhihu-specific fetch ---

function isZhihuUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "zhihu.com" || host.endsWith(".zhihu.com");
  } catch {
    return false;
  }
}

function parseZhihuArticleId(url) {
  // zhuanlan.zhihu.com/p/123456 or zhihu.com/p/123456
  const match = url.match(/\/p\/(\d+)/);
  return match ? match[1] : null;
}

function parseZhihuQuestionId(url) {
  // zhihu.com/question/xxx (with or without /answer/yyy)
  const match = url.match(/\/question\/(\d+)/);
  return match ? match[1] : null;
}

function parseZhihuAnswerId(url) {
  // zhihu.com/question/xxx/answer/yyy
  const match = url.match(/\/question\/\d+\/answer\/(\d+)/);
  return match ? match[1] : null;
}

function extractZhihuInitialData(html) {
  // Zhihu SSR pages embed data in <script id="js-initialData">
  const match = html.match(/<script\s+id="js-initialData"\s*[^>]*>([\s\S]*?)<\/script>/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {}
  }
  return null;
}

function extractZhihuContent(initialData, articleId, questionId, answerId) {
  try {
    const entities = initialData.initialState?.entities;
    if (!entities) return null;

    // Case 1: Article (zhuanlan.zhihu.com/p/xxx)
    if (articleId) {
      const article = entities.articles?.[articleId];
      if (article && article.content) {
        return {
          title: article.title || "",
          content: article.content,
          author: article.author?.name || "",
          created: article.created ? new Date(article.created * 1000).toISOString() : "",
          voteupCount: article.voteupCount || 0,
        };
      }
    }

    // Case 2: Specific answer (/question/xxx/answer/yyy)
    if (answerId) {
      const answer = entities.answers?.[answerId];
      if (answer && answer.content) {
        const questionTitle = entities.questions?.[questionId]?.title || answer.question?.title || "";
        return {
          title: questionTitle,
          content: answer.content,
          author: answer.author?.name || "",
          created: answer.createdTime ? new Date(answer.createdTime * 1000).toISOString() : "",
          voteupCount: answer.voteupCount || 0,
        };
      }
    }

    // Case 3: Question page (/question/xxx) — extract question + all answers
    if (questionId) {
      const question = entities.questions?.[questionId];
      const answers = entities.answers || {};
      const answerList = Object.values(answers).filter(a => a.content && a.content.length > 0);

      if (question && answerList.length > 0) {
        // Sort by votes descending
        answerList.sort((a, b) => (b.voteupCount || 0) - (a.voteupCount || 0));

        // Build combined HTML: question detail + all answers
        const parts = [];
        if (question.detail) parts.push(question.detail);
        for (const a of answerList) {
          parts.push(
            `<h2>${a.author?.name || "Anonymous"} (${a.voteupCount || 0} votes)</h2>` +
            a.content
          );
        }

        return {
          title: question.title || "",
          content: parts.join("<hr>"),
          author: "",
          created: "",
          voteupCount: 0,
          answerCount: answerList.length,
        };
      }
    }
  } catch {}
  return null;
}

async function zhihuFetch(url) {
  // Try: 1) manual config cookie  2) auto-extract from browser
  const config = await loadConfig();
  let cookie = config.zhihu?.cookie;

  if (!cookie) {
    info(`${c.dim}no manual cookie configured, trying browser extraction...${c.reset}`);
    cookie = await extractBrowserCookies("zhihu.com");
  }

  if (!cookie) {
    throw new Error(
      "Zhihu requires cookies from your browser. On macOS, aread can auto-extract from Chrome — make sure you're logged in to zhihu.com.\n" +
      "Or manually configure: aread config set zhihu.cookie \"<cookie from DevTools>\""
    );
  }

  const timeout = parseInt(opts.timeout, 10) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Cookie": cookie,
        "Referer": "https://www.zhihu.com/",
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      if (res.status === 403) {
        throw new Error("cookie expired or invalid. Please update: aread config set zhihu.cookie \"<new cookie>\"");
      }
      throw new Error(`HTTP ${res.status}`);
    }

    const html = await res.text();

    // Check if we got the JS challenge page instead of real content
    if (html.includes('id="zh-zse-ck"') && html.length < 1000) {
      throw new Error(
        "cookie expired — Zhihu returned challenge page. Please update:\n" +
        "  aread config set zhihu.cookie \"<new cookie from browser>\""
      );
    }

    // Try to extract from initialData (best quality)
    const articleId = parseZhihuArticleId(url);
    const questionId = parseZhihuQuestionId(url);
    const answerId = parseZhihuAnswerId(url);
    const initialData = extractZhihuInitialData(html);

    if (initialData) {
      const extracted = extractZhihuContent(initialData, articleId, questionId, answerId);
      if (extracted && extracted.content) {
        const label = extracted.answerCount
          ? `${extracted.answerCount} answers`
          : "content";
        info(`${c.green}✓${c.reset} ${c.dim}extracted ${label} from zhihu initialData${c.reset}`);

        // Convert HTML content to markdown via turndown
        let TurndownService;
        try {
          TurndownService = (await import("turndown")).default;
        } catch {
          throw new Error("turndown not installed. Run: npm i turndown");
        }
        const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
        const mdContent = td.turndown(extracted.content);

        // Build final markdown with metadata
        const meta = [];
        if (extracted.title) meta.push(`# ${extracted.title}`);
        if (extracted.author) meta.push(`> Author: ${extracted.author}`);
        if (extracted.created) meta.push(`> Date: ${extracted.created.split("T")[0]}`);
        if (extracted.voteupCount) meta.push(`> Votes: ${extracted.voteupCount}`);

        return meta.length > 0
          ? meta.join("\n") + "\n\n" + mdContent
          : mdContent;
      }
    }

    // No extractable content
    throw new Error(
      "could not extract content from this zhihu page. The page may have no answers yet or require JavaScript rendering."
    );
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`zhihu fetch timed out after ${opts.timeout}s`);
    throw e;
  }
}

async function fetchWithFallback(url) {
  // Check cache first
  const cached = await getCachedContent(url);
  if (cached) return { markdown: cached, cached: true };

  // Zhihu: use dedicated fetch with user cookie
  if (isZhihuUrl(url)) {
    try {
      const md = await zhihuFetch(url);
      await setCachedContent(url, md);
      return { markdown: md, cached: false };
    } catch (e) {
      throw new Error(`zhihu: ${e.message}`);
    }
  }

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
    duckduckgo: ["bing"],
    bing: ["duckduckgo"],
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

const MULTI_ENGINES = ["bing", "duckduckgo"];

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

// --- Config subcommand ---

if (positionals[0] === "config") {
  await handleConfigCommand(positionals.slice(1));
  process.exit(0);
}

// --- Resolve --summarize: explicit flag > config autoSummarize > off ---

let shouldSummarize = false;
if (opts["no-summarize"]) {
  shouldSummarize = false;
} else if (opts.summarize) {
  shouldSummarize = true;
} else {
  // Check config for autoSummarize
  const cfg = await loadConfig();
  if (cfg.ai && cfg.ai.autoSummarize === "true") {
    shouldSummarize = true;
  }
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

    // AI summarize each successful result if summarize enabled
    if (shouldSummarize) {
      const successIndices = settled.map((s, i) => s.status === "fulfilled" ? i : -1).filter(i => i >= 0);
      if (successIndices.length > 0) {
        info(`\n${c.dim}summarizing ${successIndices.length} pages with AI...${c.reset}`);
        const concurrencyAI = Math.min(3, successIndices.length); // limit AI concurrency
        const summaryResults = await mapConcurrent(successIndices, concurrencyAI, async (idx) => {
          const v = settled[idx].value;
          info(`${c.dim}  [${idx + 1}] summarizing ${v.url}...${c.reset}`);
          const summary = await aiSummarize(v.markdown, v.url);
          return { idx, summary };
        });
        for (const sr of summaryResults) {
          if (sr.status === "fulfilled") {
            settled[sr.value.idx].value.summary = sr.value.summary;
          }
        }
        const sumOk = summaryResults.filter(s => s.status === "fulfilled").length;
        info(`${c.green}✓${c.reset} ${c.dim}${sumOk}/${successIndices.length} summaries generated${c.reset}`);
      }
    }

    if (opts.json) {
      const jsonResults = settled.map((s, i) => {
        if (s.status === "fulfilled") {
          return { url: s.value.url, title: s.value.title, markdown: s.value.markdown, cached: s.value.cached, summary: s.value.summary || null, error: null };
        }
        return { url: results[i].url, title: results[i].title, markdown: null, cached: false, summary: null, error: s.reason.message };
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
          const summaryBlock = v.summary ? `\n\n${v.summary}\n\n---\n` : "";
          return `---\n\n## ${i + 1}. ${v.title}\n\n> Source: ${v.url}${summaryBlock}\n\n${v.markdown}`;
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

    let summary = null;
    if (shouldSummarize) {
      info(`${c.dim}summarizing with AI...${c.reset}`);
      try {
        summary = await aiSummarize(body, url);
        info(`${c.green}✓${c.reset} ${c.dim}summary generated${c.reset}`);
      } catch (e) {
        info(`${c.red}AI summary failed${c.reset}: ${e.message}`);
      }
    }

    if (opts.json) {
      const result = { url, title: null, markdown: body, cached: wasCached, summary, error: null };
      const jsonOutput = JSON.stringify(result, null, 2);
      if (opts.output) {
        await writeFile(opts.output, jsonOutput, "utf-8");
        info(`${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset}`);
      } else {
        process.stdout.write(jsonOutput + "\n");
      }
    } else {
      let output = body;
      if (summary) {
        output = `${summary}\n\n---\n\n${body}`;
      }
      if (opts.output) {
        await writeFile(opts.output, output, "utf-8");
        info(
          `${c.green}saved${c.reset} ${c.bold}${opts.output}${c.reset} ${c.dim}(${Buffer.byteLength(output)} bytes)${c.reset}`
        );
      } else {
        process.stdout.write(output);
        if (!output.endsWith("\n")) process.stdout.write("\n");
      }
    }
  } catch (e) {
    if (e.name === "AbortError") die(`request timed out after ${opts.timeout}s`);
    die(e.message);
  }
}
