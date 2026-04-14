# Anti-Fingerprint Disguise

Disguise browser fingerprints to avoid bot detection when automating Chinese websites (Zhihu, Xiaohongshu, Baidu, etc.).

**Related**: [proxy-support.md](proxy-support.md) for proxy bypass, [commands.md](commands.md) for global options.

## Contents

- [Why Fingerprinting Matters](#why-fingerprinting-matters)
- [Exposed Fingerprint Signals](#exposed-fingerprint-signals)
- [Configuration](#configuration)
- [Verifying Disguise](#verifying-disguise)
- [Test Results](#test-results)
- [Limitations](#limitations)
- [Advanced: Connect to Host Browser](#advanced-connect-to-host-browser)

## Why Fingerprinting Matters

Websites detect headless browsers through fingerprint signals like `HeadlessChrome` in the User-Agent, `navigator.webdriver === true`, mismatched platform/language, and abnormal WebGL/Canvas rendering. When detected, sites show CAPTCHAs, security verification pages, or block access entirely.

Symptoms of fingerprint detection:
- Xiaohongshu: redirect to "IP at risk" verification page
- Baidu search: triggers graphical CAPTCHA
- Zhihu: redirect to security verification page

## Exposed Fingerprint Signals

| Signal | Headless Default | Normal Browser | Risk |
|--------|-----------------|---------------|------|
| User-Agent | `HeadlessChrome/147.0.0.0` | `Chrome/122.0.0.0` | Critical |
| navigator.webdriver | `true` | `false` | Critical |
| platform | `Linux x86_64` | `Win32` / `MacIntel` | Medium |
| languages | `["en-US","en"]` | `["zh-CN","zh","en"]` | Medium |
| WebGL renderer | Abnormal/missing | Normal GPU info | Medium |
| Canvas fingerprint | Differs from real browser | Normal | Medium |
| Viewport size | Small/abnormal default | 1920x1080 standard | Medium |

## Configuration

### Environment Variables (Recommended)

Set these before running agent-browser commands:

```bash
export AGENT_BROWSER_USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
export AGENT_BROWSER_ARGS="--disable-blink-features=AutomationControlled,--lang=zh-CN"
export AGENT_BROWSER_COLOR_SCHEME="light"
export AGENT_BROWSER_PROXY_BYPASS="localhost,127.0.0.1"
export NO_PROXY="localhost,127.0.0.1"
export no_proxy="localhost,127.0.0.1"

# Then use agent-browser normally
agent-browser open "https://www.xiaohongshu.com"
agent-browser screenshot /path/to/screenshot.png
```

### Config File

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

### Key Parameters

| Parameter | Purpose | Details |
|-----------|---------|---------|
| `AGENT_BROWSER_USER_AGENT` | Spoof User-Agent | Removes "HeadlessChrome" marker, pretends to be normal Windows Chrome |
| `--disable-blink-features=AutomationControlled` | Hide automation marker | Makes `navigator.webdriver` return `false` |
| `--lang=zh-CN` | Set browser language | Tells the site the user is Chinese-speaking |
| `AGENT_BROWSER_COLOR_SCHEME` | Set color scheme | Mimics real user theme preference |
| `AGENT_BROWSER_PROXY_BYPASS` / `NO_PROXY` | Bypass local proxy | Prevents localhost requests from going through proxy, which would break CDP connections |

## Verifying Disguise

Run JavaScript to check fingerprint after configuration:

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

Expected output:
```json
{
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "webdriver": false,
  "platform": "Linux x86_64",
  "languages": ["en-US", "en"]
}
```

### Online Detection Tools

| Tool | URL | What It Detects |
|------|-----|----------------|
| BrowserLeaks | https://browserleaks.com/javascript | JS environment info |
| Bot Detection | https://bot.sannysoft.com | Headless browser detection |
| CreepJS | https://abrahamjuliot.github.io/creepjs | Comprehensive fingerprint test |
| httpbin | https://httpbin.org/ip | Exit IP query |

## Test Results

| Platform | Before Disguise | After Disguise |
|----------|----------------|----------------|
| Zhihu | Security verification blocked | Normal access |
| Xiaohongshu | "IP at risk" blocked | Normal access |
| Baidu homepage | Normal | Normal |
| Baidu search | Security verification blocked | Partially resolved |

## Limitations

1. **Platform mismatch**: Even with a Windows UA, `navigator.platform` still returns `Linux x86_64`. Advanced detection can catch this inconsistency.
2. **WebGL/Canvas fingerprints**: Headless mode has abnormal GPU rendering traits that some sites may detect.
3. **Behavioral analysis**: If operations are too fast or click patterns too regular, behavioral analysis may still trigger.
4. **Language setting**: `--lang=zh-CN` only affects the Chromium launch argument; `navigator.languages` may still show `en-US`.

## Advanced: Connect to Host Browser

The most reliable approach when container disguise isn't enough — connect to a real browser on the host machine:

```bash
# Start Chrome on host with remote debugging
open -a "Google Chrome" --args --remote-debugging-port=9222

# Connect from container
agent-browser connect host.docker.internal:9222
```

This uses a real browser with genuine fingerprints, eliminating all headless detection vectors.

---
*Tested with agent-browser v0.25.3 + Chromium 147*
