---
name: agent-browser
description: Browse the web for any task — research topics, read articles, interact with web apps, fill forms, take screenshots, extract data, and test web pages. Use whenever a browser would be useful, not just when the user explicitly asks. Includes anti-fingerprint disguise for accessing sites that block headless browsers.
allowed-tools: Bash(agent-browser:*)
---

# Browser Automation with agent-browser

## Quick start

```bash
agent-browser open <url>        # Navigate to page
agent-browser snapshot -i       # Get interactive elements with refs
agent-browser click @e1         # Click element by ref
agent-browser fill @e2 "text"   # Fill input by ref
agent-browser close             # Close browser
```

## Core workflow

1. Navigate: `agent-browser open <url>`
2. Snapshot: `agent-browser snapshot -i` (returns elements with refs like `@e1`, `@e2`)
3. Interact using refs from the snapshot
4. Re-snapshot after navigation or significant DOM changes

## Commands

### Navigation

```bash
agent-browser open <url>      # Navigate to URL
agent-browser back            # Go back
agent-browser forward         # Go forward
agent-browser reload          # Reload page
agent-browser close           # Close browser
```

### Snapshot (page analysis)

```bash
agent-browser snapshot            # Full accessibility tree
agent-browser snapshot -i         # Interactive elements only (recommended)
agent-browser snapshot -c         # Compact output
agent-browser snapshot -d 3       # Limit depth to 3
agent-browser snapshot -s "#main" # Scope to CSS selector
```

### Interactions (use @refs from snapshot)

```bash
agent-browser click @e1           # Click
agent-browser dblclick @e1        # Double-click
agent-browser fill @e2 "text"     # Clear and type
agent-browser type @e2 "text"     # Type without clearing
agent-browser press Enter         # Press key
agent-browser hover @e1           # Hover
agent-browser check @e1           # Check checkbox
agent-browser uncheck @e1         # Uncheck checkbox
agent-browser select @e1 "value"  # Select dropdown option
agent-browser scroll down 500     # Scroll page
agent-browser upload @e1 file.pdf # Upload files
```

### Get information

```bash
agent-browser get text @e1        # Get element text
agent-browser get html @e1        # Get innerHTML
agent-browser get value @e1       # Get input value
agent-browser get attr @e1 href   # Get attribute
agent-browser get title           # Get page title
agent-browser get url             # Get current URL
agent-browser get count ".item"   # Count matching elements
```

### Screenshots & PDF

```bash
agent-browser screenshot          # Save to temp directory
agent-browser screenshot path.png # Save to specific path
agent-browser screenshot --full   # Full page
agent-browser pdf output.pdf      # Save as PDF
```

### Wait

```bash
agent-browser wait @e1                     # Wait for element
agent-browser wait 2000                    # Wait milliseconds
agent-browser wait --text "Success"        # Wait for text
agent-browser wait --url "**/dashboard"    # Wait for URL pattern
agent-browser wait --load networkidle      # Wait for network idle
```

### Semantic locators (alternative to refs)

```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find placeholder "Search" type "query"
```

### Authentication with saved state

```bash
# Login once
agent-browser open https://app.example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "username"
agent-browser fill @e2 "password"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
agent-browser state save auth.json

# Later: load saved state
agent-browser state load auth.json
agent-browser open https://app.example.com/dashboard
```

### Cookies & Storage

```bash
agent-browser cookies                     # Get all cookies
agent-browser cookies set name value      # Set cookie
agent-browser cookies clear               # Clear cookies
agent-browser storage local               # Get localStorage
agent-browser storage local set k v       # Set value
```

### JavaScript

```bash
agent-browser eval "document.title"   # Run JavaScript
```

## Example: Form submission

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output shows: textbox "Email" [ref=e1], textbox "Password" [ref=e2], button "Submit" [ref=e3]

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i  # Check result
```

## Example: Data extraction

```bash
agent-browser open https://example.com/products
agent-browser snapshot -i
agent-browser get text @e1  # Get product title
agent-browser get attr @e2 href  # Get link URL
agent-browser screenshot products.png
```

## Anti-Fingerprint Disguise

Many websites (Zhihu, Baidu, Xiaohongshu, etc.) detect and block headless browsers. **Always apply anti-fingerprint config before accessing such sites.**

### Quick setup (environment variables)

```bash
# Disguise as a normal Windows Chrome browser
export AGENT_BROWSER_USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
export AGENT_BROWSER_ARGS="--disable-blink-features=AutomationControlled,--lang=zh-CN"
export AGENT_BROWSER_COLOR_SCHEME="light"
export AGENT_BROWSER_PROXY_BYPASS="localhost,127.0.0.1"
export NO_PROXY="localhost,127.0.0.1"
export no_proxy="localhost,127.0.0.1"

# Now use agent-browser normally
agent-browser open "https://www.xiaohongshu.com"
```

### Config file approach

Create `agent-browser.json`:

```json
{
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "colorScheme": "light",
  "proxyBypass": "localhost,127.0.0.1",
  "args": "--disable-blink-features=AutomationControlled,--lang=zh-CN"
}
```

```bash
agent-browser --config ./agent-browser.json open "https://example.com"
```

### Key parameters

| Parameter | Purpose |
|-----------|---------|
| `AGENT_BROWSER_USER_AGENT` | Remove "HeadlessChrome" marker, disguise as normal Chrome |
| `--disable-blink-features=AutomationControlled` | Make `navigator.webdriver` return `false` |
| `--lang=zh-CN` | Set browser language for Chinese sites |
| `AGENT_BROWSER_COLOR_SCHEME` | Simulate real user theme preference |
| `NO_PROXY` / `AGENT_BROWSER_PROXY_BYPASS` | Bypass proxy for localhost CDP connections |

### When to use anti-fingerprint

- Accessing Chinese platforms (知乎, 小红书, 百度, etc.)
- Any site that triggers CAPTCHA or "security verification" on normal access
- When `agent-browser snapshot` returns unexpected verification pages instead of real content

### Verify disguise effectiveness

```bash
agent-browser eval "JSON.stringify({
  userAgent: navigator.userAgent,
  webdriver: navigator.webdriver,
  platform: navigator.platform,
  languages: navigator.languages,
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: navigator.deviceMemory
})"
```

Expected: `webdriver` should be `false`, `userAgent` should contain no "HeadlessChrome".

### Advanced: connect to real browser (most reliable)

```bash
# On macOS host: launch Chrome with remote debugging
open -a "Google Chrome" --args --remote-debugging-port=9222

# Inside container: connect to host Chrome
agent-browser connect host.docker.internal:9222
```

### Known limitations

- `navigator.platform` still returns `Linux x86_64` — some sites may detect UA/platform mismatch
- WebGL/Canvas fingerprints may still reveal headless mode
- Overly fast or mechanical interaction patterns can trigger behavioral analysis
