# aread

**AI-first web reader & search with AI summarization.** The `a` stands for AI — built for agents that need structured web content in one call.

```bash
aread https://example.com              # read any page as Markdown
aread example.com --summarize          # read + AI summary
aread -s "rust async tutorial"         # search the web
aread -s "react hooks" --read          # search + read all results
aread -s "LLM evaluation" --multi      # query all engines, merge & deduplicate
aread config init                      # setup AI summarization
```

- Zero runtime dependencies (optional `turndown` for local fallback)
- AI summarization via OpenAI-compatible APIs (OpenAI, Groq, OpenRouter, xAI, SiliconFlow, LongCat)
- Zhihu article support with auto browser cookie extraction (macOS)
- Works on Linux, macOS, Windows
- Single file, structured output designed for LLM consumption

## Why aread?

AI agents need web content as clean, structured text — not HTML soup. `aread` gives agents:

- **One-call web reading** — any URL to Markdown, handling JS rendering and anti-scraping
- **AI summarization** — distill pages to key facts via any OpenAI-compatible API
- **Multi-source search** — query multiple engines in parallel, get deduplicated results
- **Zhihu support** — auto-extract browser cookies to read zhihu.com articles and answers
- **Structured output** — `--json` for machine parsing, `--raw` for pipe-friendly text
- **Graceful degradation** — engine failures are silently skipped, partial results still returned

## Install

```bash
npm i -g aread-cli       # or: bun i -g aread-cli
```

Or run directly:

```bash
npx aread-cli https://example.com
```

## Read

Turn any web page into clean Markdown. Powered by [Jina Reader](https://jina.ai/reader/) with automatic local fallback.

```bash
aread https://example.com           # full page as Markdown
aread example.com                   # auto-adds https://
aread -o page.md example.com        # save to file
aread -r example.com | head -50     # raw mode, no status messages
aread --json example.com            # structured JSON output
```

If Jina is unreachable, aread falls back to local fetch + [turndown](https://github.com/mixmark-io/turndown) (install with `npm i turndown` for fallback support).

Results are cached locally (`~/.cache/aread/`) with 24h expiry. Use `--no-cache` to bypass.

### Jina Headers

Fine-tune what you get back:

```bash
aread -H "X-Target-Selector:article" https://blog.example.com    # extract <article> only
aread -H "X-With-Links:true" https://example.com                 # include hyperlinks
aread -H "X-No-Cache:true" https://example.com                   # bypass Jina cache
```

| Header | Description |
|--------|-------------|
| `X-Return-Format` | `html`, `text`, `screenshot`, `pageshot` |
| `X-With-Links` | include hyperlinks |
| `X-With-Images` | include images |
| `X-No-Cache` | bypass Jina cache |
| `X-Target-Selector` | extract specific CSS selector |

## AI Summarization

Summarize any fetched content using an OpenAI-compatible AI API. Preserves 90% of information — only strips filler, repetition, and noise.

### Setup

Interactive setup (recommended):

```bash
aread config init
```

Or manual configuration:

```bash
aread config set ai.provider openrouter      # choose provider
aread config set ai.apiKey sk-xxx            # set API key
aread config set ai.model google/gemini-2.0-flash-001  # set model
aread config set ai.autoSummarize true       # auto-summarize every fetch
```

### Built-in Providers

| Provider | Base URL |
|----------|----------|
| openai | `https://api.openai.com/v1` |
| groq | `https://api.groq.com/openai/v1` |
| openrouter | `https://openrouter.ai/api/v1` |
| xai | `https://api.x.ai/v1` |
| siliconflow | `https://api.siliconflow.cn/v1` |
| longcat | `https://api.longcat.chat/openai/v1` |

Or use any OpenAI-compatible endpoint:

```bash
aread config set ai.baseUrl https://your-api.com/v1
```

### Usage

```bash
aread example.com -S               # one-time summarize with -S flag
aread example.com --summarize      # same as -S
aread example.com --no-summarize   # disable auto-summarize for this call
```

With `ai.autoSummarize` set to `true`, every fetch automatically includes an AI summary.

### Config Management

```bash
aread config show                  # view current config (secrets masked)
aread config providers             # list all built-in providers
aread config get ai.model          # get a specific value
aread config delete ai.apiKey      # delete a value
```

## Zhihu Support

aread can fetch articles and answers from zhihu.com (知乎) — a site with aggressive anti-crawling protection.

On **macOS**, aread automatically extracts cookies from your Chrome/Arc/Edge/Brave browser. Just make sure you're logged in to zhihu.com in your browser.

```bash
aread https://zhuanlan.zhihu.com/p/696916846     # article — auto works
aread https://www.zhihu.com/question/123456       # question + all answers
```

Supported page types:

| Type | URL Pattern | What's extracted |
|------|-------------|------------------|
| Article | `zhuanlan.zhihu.com/p/xxx` | Title, author, date, full content |
| Question | `zhihu.com/question/xxx` | Question + all answers (sorted by votes) |
| Answer | `zhihu.com/question/xxx/answer/yyy` | Specific answer with question title |

Manual cookie configuration (if auto-extraction doesn't work):

```bash
aread config set zhihu.cookie "<cookie from browser DevTools>"
```

## Search

Search the web with multiple engine support. No API keys, no tracking.

```bash
aread -s "rust async tutorial"                # search (default: auto engine)
aread -s "node.js streams" -n 5              # top 5 results
aread -s "react hooks" -e bing               # use specific engine
aread -s "kubernetes" --json                  # JSON output for agents
```

**Note:** Use quotes for multi-word queries: `aread -s "query with spaces"`.

### Engines

| Engine | Flag | Notes |
|--------|------|-------|
| DuckDuckGo | `-e duckduckgo` | Private, no tracking |
| Bing | `-e bing` | Reliable, good international coverage |
| Auto | `-e auto` (default) | Probes DuckDuckGo, falls back to Bing |

If the chosen engine fails, aread automatically tries fallback engines before giving up.

### Multi-Engine Search (`--multi`)

Query all engines concurrently and get merged, deduplicated results.

```bash
aread -s "WebAssembly" --multi               # query all engines at once
aread -s "transformer architecture" -m       # -m shorthand
aread -s "bilibili" --multi --json           # JSON output
```

### Search + Read

Search the web, then read every result page as Markdown — all in one command.

```bash
aread -s "CSS grid tutorial" --read                    # search + read all
aread -s "kubernetes networking" --read -o research.md  # save everything
aread -s "SQLite vs PostgreSQL" --read -n 3             # top 3, read all
aread -s "LLM agents" --multi --read                    # multi-engine + read
```

With AI summarization enabled, search + read outputs only the AI summary for each result — saving tokens while preserving key information.

## Agent Integration

`aread` outputs clean, structured content designed for LLM consumption:

```bash
# Feed a page to an AI agent
aread -r https://docs.python.org/3/tutorial | claude "summarize this"

# Multi-source research in one command
aread -r -s "WebAssembly 2024" --multi --read | claude "explain the key trends"

# Structured JSON for programmatic use
aread -s "react hooks" --multi --json | jq '.[].url'
```

### JSON Output

Use `--json` for machine-readable output:

```bash
# Search results as JSON array
aread -s "example" --json

# Read a page as JSON (includes summary field when AI is configured)
aread --json https://example.com
# { "url": "...", "markdown": "...", "summary": "...", "cached": false, "error": null }
```

## All Options

```
aread <URL>                  Read a page as Markdown
aread <URL> --summarize      Read + AI summary
aread -s <QUERY>             Search the web
aread -s <QUERY> --read      Search + read top results
aread config                 Manage configuration
```

| Flag | Description |
|------|-------------|
| `-o, --output <FILE>` | Save to file |
| `-r, --raw` | No status messages, pipe-friendly |
| `-t, --timeout <SEC>` | Timeout in seconds (default: 30) |
| `-H, --header <K:V>` | Extra Jina header (repeatable) |
| `-s, --search <QUERY>` | Search the web (use quotes for multi-word) |
| `-n, --num <N>` | Number of results (default: 10) |
| `-e, --engine <ENGINE>` | Search engine: `duckduckgo\|bing\|auto` (default: auto) |
| `-m, --multi` | Query all engines concurrently |
| `--read` | Fetch each search result as Markdown |
| `-c, --concurrency <N>` | Concurrent reads with `--read` (default: 5) |
| `-S, --summarize` | AI summarize (requires config) |
| `--no-summarize` | Disable auto-summarize |
| `--no-cache` | Skip URL cache |
| `--json` | Structured JSON output |

## How It Works

| Feature | Implementation | Cost |
|---------|---------------|------|
| **Read** | [Jina Reader](https://jina.ai/reader/) with local turndown fallback | Free |
| **Search** | Native HTTP scraping of DuckDuckGo, Bing | Free |
| **Summarize** | OpenAI-compatible API (user-provided key) | Per-token |
| **Zhihu** | Browser cookie extraction + SSR data parsing | Free |
| **Cache** | SHA-256 URL hashing to `~/.cache/aread/`, 24h expiry | Local |

No Python. No external binaries. No API keys required (except optional AI summarization). Just Node.js 18+.

## License

MIT
