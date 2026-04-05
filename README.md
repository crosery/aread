# jread

> Turn any URL into clean Markdown. Powered by [Jina Reader](https://jina.ai/reader/).

Zero dependencies. Single file. Works everywhere Node.js 18+ or Bun runs.

## Why

- `curl` gives you raw HTML — useless for reading or piping into LLMs
- `wget` is the same story
- Browser extensions can't be scripted

`jread` gives you clean, structured Markdown from any URL, in one command.

## Install

```bash
# bun (recommended)
bun i -g jread-cli

# npm
npm i -g jread-cli

# run without installing
npx jread-cli https://example.com
```

## Quick Start

```bash
# Read any page
jread https://example.com

# Auto-adds https:// — just type the domain
jread example.com

# Save to file
jread -o page.md https://example.com

# Pipe into other tools (no status messages)
jread -r https://example.com | head -50

# Feed to LLMs
jread -r https://docs.python.org/3/tutorial | llm "summarize this"
```

## Usage

```
jread [OPTIONS] <URL>
```

### Options

| Flag | Description |
|------|-------------|
| `-o, --output <FILE>` | Save output to file |
| `-r, --raw` | Raw mode — no status messages, ideal for piping |
| `-t, --timeout <SEC>` | Request timeout (default: 30) |
| `-H, --header <K:V>` | Extra Jina header (repeatable) |
| `-s, --search <QUERY>` | Search the web via Jina (requires API key) |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

### Examples

```bash
# Extract only the article content
jread -H "X-Target-Selector:article" https://blog.example.com/post

# Include links in output
jread -H "X-With-Links:true" https://example.com

# Bypass Jina cache for fresh content
jread -H "X-No-Cache:true" https://example.com

# Search the web (requires JINA_API_KEY)
export JINA_API_KEY="your-key"
jread -s "rust async tutorial"
```

### Jina Headers Reference

| Header | Values | Description |
|--------|--------|-------------|
| `X-Return-Format` | `html` `text` `screenshot` `pageshot` | Output format |
| `X-With-Links` | `true` | Include hyperlinks |
| `X-With-Images` | `true` | Include images |
| `X-With-Generated-Alt` | `true` | AI-generated alt text |
| `X-No-Cache` | `true` | Bypass Jina cache |
| `X-Target-Selector` | CSS selector | Extract specific elements |

## Use Cases

**Feed web pages to AI/LLMs**
```bash
jread -r https://docs.example.com | claude "explain this API"
```

**Save documentation offline**
```bash
jread -o react-hooks.md https://react.dev/reference/react/hooks
```

**Build a research pipeline**
```bash
for url in $(cat urls.txt); do
  jread -r "$url" >> research.md
done
```

**Quick reference from terminal**
```bash
jread -r -H "X-Target-Selector:table" https://caniuse.com/css-grid
```

## How It Works

jread is a thin CLI wrapper around [Jina Reader](https://jina.ai/reader/) (`r.jina.ai`). It sends your URL to Jina's API, which renders the page (including JavaScript), extracts the main content, and returns clean Markdown. No API key needed for reading.

## Requirements

- Node.js >= 18 or Bun (any version)
- That's it. Zero npm dependencies.

## License

MIT
