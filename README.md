# aread

> Read any URL as Markdown. Search the web from your terminal. Feed it all to AI.

Zero dependencies. Single file. No API keys. Works everywhere Node.js 18+ or Bun runs.

## Why

- `curl` gives raw HTML — useless for AI or reading
- Browser extensions can't be scripted or piped
- Jina Reader is great but has no CLI
- DuckDuckGo is private but has no good terminal client

`aread` combines both: **read** any page as clean Markdown, **search** the web via DuckDuckGo — all from one command. Completely free, zero dependencies, no API keys.

## Install

```bash
# bun
bun i -g aread-cli

# npm
npm i -g aread-cli

# run without installing
npx aread-cli https://example.com
```

## Quick Start

```bash
# Read a page as Markdown
aread https://example.com

# Just type the domain
aread example.com

# Search the web
aread -s "rust async tutorial"

# Search + read all results as Markdown
aread -s "react hooks guide" --read

# Pipe to AI
aread -r https://docs.python.org/3/tutorial | claude "summarize this"
aread -r -s "kubernetes networking" --read | claude "explain like I'm 5"
```

## Usage

```
aread <URL>                Read a page as Markdown
aread -s <QUERY>           Search the web via DuckDuckGo
aread -s <QUERY> --read    Search + read top results as Markdown
```

### Read Options

| Flag | Description |
|------|-------------|
| `-o, --output <FILE>` | Save to file |
| `-r, --raw` | No status messages, pipe-friendly |
| `-t, --timeout <SEC>` | Timeout in seconds (default: 30) |
| `-H, --header <K:V>` | Extra Jina header (repeatable) |

### Search Options

| Flag | Description |
|------|-------------|
| `-s, --search <QUERY>` | Search via DuckDuckGo |
| `-n, --num <N>` | Number of results (default: 10) |
| `--read` | Also fetch each result as Markdown |

### General

| Flag | Description |
|------|-------------|
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## Examples

```bash
# Save a page to file
aread -o page.md https://example.com

# Top 3 search results
aread -s "node.js streams" -n 3

# Search + save all results as one Markdown file
aread -s "CSS grid tutorial" --read -o research.md

# Extract only article content
aread -H "X-Target-Selector:article" https://blog.example.com/post

# Include links in output
aread -H "X-With-Links:true" https://example.com

# Bypass cache
aread -H "X-No-Cache:true" https://example.com

# Build a research pipeline
for url in $(cat urls.txt); do
  aread -r "$url" >> research.md
done
```

## Jina Headers

| Header | Description |
|--------|-------------|
| `X-Return-Format` | `html`, `text`, `screenshot`, `pageshot` |
| `X-With-Links` | `true` - include links |
| `X-With-Images` | `true` - include images |
| `X-No-Cache` | `true` - bypass cache |
| `X-Target-Selector` | CSS selector to extract |

## How It Works

- **Read**: sends URL to [Jina Reader](https://jina.ai/reader/) which renders the page (JS included) and returns clean Markdown. Free, no key needed.
- **Search**: directly queries DuckDuckGo HTML endpoint and parses results. No external tools, no API keys, no tracking.
- **Search + Read**: combines both — searches first, then reads each result page via Jina.

## Requirements

- Node.js >= 18 or Bun
- That's it. Zero npm dependencies. Zero external tools.

## License

MIT
