# aread

**AI-friendly web reader & search.** One command to read any URL as Markdown or search the web via DuckDuckGo.

```bash
npx aread-cli https://example.com          # read any page
npx aread-cli -s "rust async tutorial"      # search the web
npx aread-cli -s "react hooks" --read       # search + read all results
```

- Zero npm dependencies
- No API keys needed
- Works on Linux, macOS, Windows
- Single file, ~11KB

## Install

```bash
bun i -g aread-cli      # or: npm i -g aread-cli
```

## Read

Turn any web page into clean, structured Markdown. Powered by [Jina Reader](https://jina.ai/reader/) — handles JavaScript rendering, anti-scraping, and messy HTML for you.

```bash
aread https://example.com           # full page as markdown
aread example.com                   # auto-adds https://
aread -o page.md example.com        # save to file
aread -r example.com | head -50     # raw mode, no status messages
```

### Jina Headers

Fine-tune what you get back:

```bash
aread -H "X-Target-Selector:article" https://blog.example.com    # extract <article> only
aread -H "X-With-Links:true" https://example.com                 # include hyperlinks
aread -H "X-No-Cache:true" https://example.com                   # bypass cache
```

| Header | Description |
|--------|-------------|
| `X-Return-Format` | `html`, `text`, `screenshot`, `pageshot` |
| `X-With-Links` | include hyperlinks |
| `X-With-Images` | include images |
| `X-No-Cache` | bypass Jina cache |
| `X-Target-Selector` | extract specific CSS selector |

## Search

Search the web via DuckDuckGo. Private, no tracking, no API key.

```bash
aread -s "rust async tutorial"            # 10 results (default)
aread -s "node.js streams" -n 5           # top 5
aread -s "react hooks" -o results.md      # save to file
```

### Search + Read

The killer feature. Search the web, then read every result page as Markdown — all in one command.

```bash
aread -s "CSS grid tutorial" --read                    # search + read all
aread -s "kubernetes networking" --read -o research.md  # save everything
aread -s "SQLite vs PostgreSQL" --read -n 3             # top 3, read all
```

## Pipe to AI

`aread` outputs clean Markdown, perfect for feeding into LLMs:

```bash
# Summarize a page
aread -r https://docs.python.org/3/tutorial | claude "summarize this"

# Research a topic and explain it
aread -r -s "WebAssembly 2024" --read | claude "explain like I'm 5"

# Compare technologies
aread -r -s "Bun vs Node.js benchmark" --read | claude "make a comparison table"
```

## All Options

```
aread <URL>                Read a page as Markdown
aread -s <QUERY>           Search via DuckDuckGo
aread -s <QUERY> --read    Search + read top results
```

| Flag | Description |
|------|-------------|
| `-o, --output <FILE>` | Save to file |
| `-r, --raw` | No status messages, pipe-friendly |
| `-t, --timeout <SEC>` | Timeout in seconds (default: 30) |
| `-H, --header <K:V>` | Extra Jina header (repeatable) |
| `-s, --search <QUERY>` | Search via DuckDuckGo |
| `-n, --num <N>` | Number of results (default: 10) |
| `--read` | Fetch each search result as Markdown |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## How It Works

| Feature | Powered by | Cost |
|---------|------------|------|
| **Read** | [Jina Reader](https://jina.ai/reader/) — renders JS, extracts content, returns Markdown | Free |
| **Search** | [ddgr](https://github.com/jarun/ddgr) — DuckDuckGo from the terminal | Free |

Search auto-downloads `ddgr` (~60KB Python script) to cache on first use. Requires Python 3 for search. Reading works without Python.

## License

MIT
