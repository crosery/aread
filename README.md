# aread

**AI-first web reader & search.** The `a` stands for AI — built for agents that need structured web content in one call.

```bash
aread https://example.com              # read any page as Markdown
aread -s "rust async tutorial"         # search the web
aread -s "react hooks" --read          # search + read all results
aread -s "LLM evaluation" --multi      # query all engines, merge & deduplicate
```

- Zero runtime dependencies (optional `turndown` for local fallback)
- No API keys needed
- No Python needed
- Works on Linux, macOS, Windows
- Single file, structured output designed for LLM consumption

## Why aread?

AI agents need web content as clean, structured text — not HTML soup. `aread` gives agents:

- **One-call web reading** — any URL to Markdown, handling JS rendering and anti-scraping
- **Multi-source search** — query 4 engines in parallel, get deduplicated results
- **Structured output** — `--json` for machine parsing, `--raw` for pipe-friendly text
- **Graceful degradation** — engine failures are silently skipped, partial results still returned
- **No interactive prompts** — every option is a flag, designed for programmatic use

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

Results are cached locally (`~/.cache/aread/`). Use `--no-cache` to bypass.

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

## Search

Search the web with multiple engine support. No API keys, no tracking.

```bash
aread -s "rust async tutorial"                # search (default: auto engine)
aread -s "node.js streams" -n 5              # top 5 results
aread -s "react hooks" -e bing               # use specific engine
aread -s "kubernetes" --json                  # JSON output for agents
```

### Engines

| Engine | Flag | Notes |
|--------|------|-------|
| DuckDuckGo | `-e duckduckgo` | Private, no tracking |
| Bing | `-e bing` | Reliable, good international coverage |
| Google | `-e google` | Broad results |
| Baidu | `-e baidu` | Best for Chinese content |
| Auto | `-e auto` (default) | Probes DuckDuckGo, falls back to Bing |

If the chosen engine fails, aread automatically tries fallback engines before giving up.

### Multi-Engine Search (`--multi`)

Query all engines concurrently and get merged, deduplicated results — ideal for agents that want maximum coverage in one call.

```bash
aread -s "WebAssembly" --multi               # query all 4 engines at once
aread -s "transformer architecture" -m       # -m shorthand
aread -s "bilibili" --multi --json           # JSON output
aread -s "react server components" -m -n 5   # 5 results per engine, merged
```

How it works:
- Sends queries to bing, google, baidu, and duckduckgo in parallel via `Promise.allSettled`
- Merges all results, deduplicating by normalized URL (first occurrence wins)
- Any engine that fails is silently skipped — you still get results from the rest
- Output format is identical to single-engine search

### Search + Read

Search the web, then read every result page as Markdown — all in one command.

```bash
aread -s "CSS grid tutorial" --read                    # search + read all
aread -s "kubernetes networking" --read -o research.md  # save everything
aread -s "SQLite vs PostgreSQL" --read -n 3             # top 3, read all
aread -s "LLM agents" --multi --read                    # multi-engine + read
```

Concurrent page reading is controlled with `-c` (default: 5 concurrent reads).

## Agent Integration

`aread` outputs clean, structured content designed for LLM consumption:

```bash
# Feed a page to an AI agent
aread -r https://docs.python.org/3/tutorial | claude "summarize this"

# Multi-source research in one command
aread -r -s "WebAssembly 2024" --multi --read | claude "explain the key trends"

# Structured JSON for programmatic use
aread -s "react hooks" --multi --json | jq '.[].url'

# Compare technologies
aread -r -s "Bun vs Node.js benchmark" --read | claude "make a comparison table"
```

### JSON Output

Use `--json` for machine-readable output — perfect for agent tool integration:

```bash
# Search results as JSON array
aread -s "example" --json
# [{ "title": "...", "url": "...", "abstract": "..." }, ...]

# Read a page as JSON
aread --json https://example.com
# { "url": "...", "title": null, "markdown": "...", "cached": false, "error": null }

# Search + read as JSON (includes markdown content)
aread -s "example" --read --json
# [{ "url": "...", "title": "...", "markdown": "...", "cached": false, "error": null }, ...]
```

## All Options

```
aread <URL>                Read a page as Markdown
aread -s <QUERY>           Search the web
aread -s <QUERY> --read    Search + read top results
```

| Flag | Description |
|------|-------------|
| `-o, --output <FILE>` | Save to file |
| `-r, --raw` | No status messages, pipe-friendly |
| `-t, --timeout <SEC>` | Timeout in seconds (default: 30) |
| `-H, --header <K:V>` | Extra Jina header (repeatable) |
| `-s, --search <QUERY>` | Search the web |
| `-n, --num <N>` | Number of results (default: 10) |
| `-e, --engine <ENGINE>` | Search engine: `duckduckgo\|bing\|google\|baidu\|auto` (default: auto) |
| `-m, --multi` | Query all engines concurrently, merge & deduplicate |
| `--read` | Fetch each search result as Markdown |
| `-c, --concurrency <N>` | Concurrent reads with `--read` (default: 5) |
| `--no-cache` | Skip URL cache |
| `--json` | Structured JSON output |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## How It Works

| Feature | Implementation | Cost |
|---------|---------------|------|
| **Read** | [Jina Reader](https://jina.ai/reader/) with local turndown fallback | Free |
| **Search** | Native HTTP scraping of DuckDuckGo, Bing, Google, Baidu | Free |
| **Multi** | `Promise.allSettled` concurrent queries + URL deduplication | Free |
| **Cache** | SHA-256 URL hashing to `~/.cache/aread/` | Local |

No Python. No external binaries. No API keys. Just Node.js 18+.

## License

MIT
