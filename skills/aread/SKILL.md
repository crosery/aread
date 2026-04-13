---
name: aread
description: >
  当用户或 agent 需要联网获取信息时使用此 skill。触发场景包括：读取网页内容、将 URL 转为 Markdown、
  联网搜索、查资料、查看在线文档、搜索技术问题。关键词：搜索、search、联网、网页、URL、read url、
  在线、查一下、搜一下、读一下这个链接、这个网页说了什么、帮我查、网上找找、搜搜看。
  也适用于 agent 自身在解决问题过程中需要查阅在线文档、API 文档、技术博客、GitHub README 等外部资源的场景。
  aread 是一个零依赖、无需 API Key 的 CLI 工具，支持网页读取（基于 Jina Reader）和多引擎搜索
  （DuckDuckGo/Bing/Google/Baidu），专为 AI agent 设计，输出结构化的 Markdown 或 JSON。
---

# aread — 联网搜索与网页读取

`aread` 是一个全局安装的 CLI 工具（`bun i -g aread-cli`），无需 API Key，无需 Python，
专为 AI agent 设计——一条命令完成网页读取或联网搜索。

开源地址：https://github.com/Crosery/aread

## 快速决策

根据用户需求选择命令模式：

```
用户给了 URL / 链接         → 读取模式
用户要搜索 / 查东西          → 搜索模式
用户要搜索并深入了解          → 搜索+阅读模式
用户要全面搜索               → 多引擎搜索模式
```

## 核心命令

### 1. 读取网页

将任意 URL 转为干净 Markdown，适合 agent 直接消费。

```bash
aread <URL> -r
```

- **`-r` 必须加**：去除状态消息，输出纯净 Markdown，agent 解析必备
- URL 可省略 `https://`，工具会自动补全
- Bash tool timeout 建议 `60000`（部分页面加载较慢）

示例：
```bash
aread https://docs.python.org/3/tutorial -r
aread github.com/vercel/next.js -r
```

### 2. 搜索

联网搜索，返回结构化结果。

```bash
aread -s "搜索关键词" -n 5 --json
```

- `--json` 输出结构化 JSON：`[{ title, url, abstract }, ...]`
- `-n` 控制结果数量，agent 场景建议 3-5 条以节省 token
- Bash tool timeout 建议 `30000`

**引擎选择指南：**

| 场景           | 参数                            | 说明                      |
| -------------- | ------------------------------- | ------------------------- |
| 通用 / 默认    | 不加 `-e`                       | 默认 DuckDuckGo           |
| 中文内容       | `-e baidu`                      | 百度对中文内容覆盖最好    |
| 英文技术文档   | `-e google`                     | Google 技术搜索强         |
| 需要全面覆盖   | `--multi`（或 `-m`）            | 四引擎并发，去重合并      |

### 3. 搜索 + 读取结果页面

搜索后自动读取所有结果页面的正文内容，一步完成。

```bash
aread -s "搜索关键词" --read -c 5 -n 10
```

- `--read` 搜索后读取每个结果的页面内容
- `-c` 并发读取数，默认 5；网络不稳定时降到 2-3
- Bash tool timeout 建议 `120000`（需读取多个页面）

### 4. 多引擎全面搜索

同时查询所有引擎（Bing、Google、Baidu、DuckDuckGo），合并去重。

```bash
aread -s "关键词" --multi --json
aread -s "关键词" -m --read -n 5
```

## 高级用法

### 提取页面特定部分

```bash
aread <URL> -r -H "X-Target-Selector:article"
```

### 保留链接或图片

```bash
aread <URL> -r -H "X-With-Links:true"
aread <URL> -r -H "X-With-Images:true"
```

### 保存到文件

```bash
aread <URL> -r -o output.md
aread -s "关键词" --read -o research.md
```

## 使用原则

1. **agent 调用时始终加 `-r`**：确保输出干净，没有状态消息干扰解析
2. **搜索用 `--json`**：结构化输出更可靠，方便提取 title/url/abstract
3. **中文搜索加 `-e baidu`**：百度对中文内容覆盖远优于其他引擎
4. **合理设 timeout**：读取 60s，搜索 30s，搜索+读取 120s
5. **结果数适当**：agent 场景 `-n 3-5` 即可，太多浪费 token
6. **善用 `--multi`**：当搜索结果质量要求高时，多引擎去重效果更好
7. **缓存自动管理**：结果自动缓存到 `~/.cache/aread/`，重复 URL 秒出；需要最新内容时加 `--no-cache`

## 典型场景示例

**场景 1：用户给了一个链接，想知道内容**
```bash
aread https://example.com/article -r
```
然后基于输出内容回答用户问题。

**场景 2：用户想搜索某个技术问题**
```bash
aread -s "Next.js App Router vs Pages Router" -n 5 --json
```
解析 JSON 结果，提取相关摘要回答用户。

**场景 3：用户需要深入研究某个主题**
```bash
aread -s "Rust 异步编程" --read -n 3 -c 3
```
一次搜索并读取所有结果页面的完整内容，综合分析后给出答案。

**场景 4：agent 自身需要查阅在线文档**
在解决问题过程中，agent 需要查 API 文档、GitHub issue 等：
```bash
aread -s "React useEffect cleanup" -n 3 --json
aread https://react.dev/reference/react/useEffect -r
```
