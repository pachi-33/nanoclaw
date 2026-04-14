---
name: send-media
description: Teach agents how to embed image and file send markers in their responses so that NanoClaw extracts, uploads, and delivers them to the chat channel (Feishu, WhatsApp, Telegram, Slack, Discord). Covers supported syntax, path rules, and mixed-media examples.
---

# Send Media — Image & File Delivery Markers

NanoClaw channels scan agent output for special path markers. When found, the file or image is uploaded and sent to the chat separately from the text. The markers themselves are stripped from the final text before delivery.

## Supported Syntax

### Images (3 formats)

| Format | Syntax | Example |
|--------|--------|---------|
| Chinese tag | `[图片: path]` | `[图片: /workspace/group/chart.png]` |
| English tag | `[image: path]` | `[image: /workspace/group/result.jpg]` |
| Markdown | `![alt](path)` | `![趋势图](/workspace/group/trend.png)` |

### Files (2 formats)

| Format | Syntax | Example |
|--------|--------|---------|
| Chinese tag | `[文件: path]` | `[文件: /workspace/group/report.pdf]` |
| English tag | `[file: path]` | `[file: /workspace/group/data.xlsx]` |

## Path Rules

- Path **must** start with `/` (absolute).
- Use **container paths** (`/workspace/group/...`) — the host mounts the group folder at this location inside the container.
- Host absolute paths also work but are discouraged in container context.

## Image Format Handling

If the image extension is in the Feishu-supported set (`.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`, `.webp`, `.tiff`, `.tif`, `.ico`, `.heic`), NanoClaw uses the platform's native image API for optimal rendering. Unsupported image formats fall back to the generic file upload channel.

## Guidelines

1. **Always use absolute paths starting with `/workspace/group/`** for files generated inside the container.
2. **Mix text and markers freely** — markers are extracted, text is sent first, media follows.
3. **One marker per file** — each `[图片:]` / `[文件:]` tag sends one attachment.
4. **No quoting needed** — the path is everything between the colon-space and the closing bracket.
5. **Ensure the file exists before referencing it** — generate or download the file first, then include the marker in your response.

## Examples

### Single image

```
分析完成，以下是数据可视化：
[图片: /workspace/group/output.png]
```

### Multiple images

```
以下是本月三个维度的对比：
[图片: /workspace/group/revenue.png]
[图片: /workspace/group/users.png]
[图片: /workspace/group/retention.png]
```

### Image + file

```
报告已生成。概览图如下：
[image: /workspace/group/summary.png]

完整 Excel 数据见附件：
[file: /workspace/group/monthly_report.xlsx]
```

### Markdown image style

```
运行结果：

![benchmark](/workspace/group/benchmark.png)

详细日志见附件：[文件: /workspace/group/benchmark.log]
```
