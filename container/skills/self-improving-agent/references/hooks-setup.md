# Hook Setup Guide

Configure automatic self-improvement triggers for Claude Code.

## Overview

Hooks enable proactive learning capture by injecting reminders at key moments:
- **SessionStart**: Injects learning context when a session begins
- **UserPromptSubmit**: Reminder after each prompt to evaluate learnings
- **PostToolUse (Bash)**: Error detection when commands fail

## Automatic Registration (Recommended)

Hooks are declared in `SKILL.md` frontmatter and auto-register when the skill is active. No manual configuration needed.

```yaml
# SKILL.md frontmatter (already configured)
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "./scripts/session-start.sh"
          statusMessage: "Loading self-improvement context"
  UserPromptSubmit:
    - hooks:
        - type: command
          command: "./scripts/activator.sh"
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/error-detector.sh"
```

## Manual Setup

If frontmatter hooks are not supported, add hooks to `.claude/settings.json` in your project root:

### Full Setup (All Hooks)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/session-start.sh"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/activator.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/error-detector.sh"
          }
        ]
      }
    ]
  }
}
```

### User-Level Configuration

Add to `~/.claude/settings.json` for global activation across all projects:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/skills/self-improvement/scripts/activator.sh"
          }
        ]
      }
    ]
  }
}
```

### Minimal Setup (Activator Only)

For lower overhead, use only the UserPromptSubmit hook:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/activator.sh"
          }
        ]
      }
    ]
  }
}
```

## GitHub Copilot Setup

Copilot doesn't support hooks. Add guidance to `.github/copilot-instructions.md`:

```markdown
## Self-Improvement

After completing tasks that involved:
- Debugging non-obvious issues
- Discovering workarounds
- Learning project-specific patterns
- Resolving unexpected errors

Consider logging the learning to `.learnings/` using the format from the self-improvement skill.

For high-value learnings that would benefit other sessions, consider skill extraction.
```

## How the Hooks Work

### SessionStart (`session-start.sh`)

- Runs when a session starts
- Checks if `.learnings/` directory exists (silent if not initialized)
- Outputs a `<self-improvement-context>` reminder with key file locations
- ~50 tokens overhead

### UserPromptSubmit (`activator.sh`)

- Runs when user submits a prompt
- Outputs a static `<self-improvement-reminder>` XML block
- Reminds Claude to evaluate if extractable knowledge emerged
- ~50-100 tokens overhead per prompt

### PostToolUse for Bash (`error-detector.sh`)

- Runs after Bash tool calls succeed
- Reads JSON from stdin, extracts `tool_response`
- Scans response against error patterns (case-insensitive)
- Only outputs `<error-detected>` reminder when error patterns match
- Zero overhead when no error is detected

## Verification

### Test SessionStart Hook

```bash
mkdir -p .learnings
bash scripts/session-start.sh
# Should output <self-improvement-context> block
```

### Test Error Detector Hook

```bash
echo '{"tool_name":"Bash","tool_response":"npm ERR! code E404\nnpm ERR! 404 Not Found"}' | bash scripts/error-detector.sh
# Should output <error-detected> block

echo '{"tool_name":"Bash","tool_response":"Successfully compiled 3 files"}' | bash scripts/error-detector.sh
# Should output nothing
```

### Test Activator Hook

```bash
bash scripts/activator.sh
# Should output <self-improvement-reminder> block
```

### Test with Non-Bash Tool

```bash
echo '{"tool_name":"Read","tool_response":"file contents here"}' | bash scripts/error-detector.sh
# Should output nothing (only processes Bash tool)
```

## Troubleshooting

### Hook Not Triggering

1. **Check script permissions**: `chmod +x scripts/*.sh`
2. **Verify path**: Use absolute paths or paths relative to project root
3. **Check settings location**: Project vs user-level settings
4. **Restart session**: Hooks are loaded at session start
5. **Verify frontmatter**: Ensure `hooks:` field is properly indented in SKILL.md

### Permission Denied

```bash
chmod +x scripts/session-start.sh scripts/activator.sh scripts/error-detector.sh scripts/extract-skill.sh
```

### Script Not Found

If using relative paths, ensure you're in the correct directory or use absolute paths:

```json
{
  "command": "/absolute/path/to/scripts/activator.sh"
}
```

### Too Much Overhead

1. **Use minimal setup**: Only UserPromptSubmit, skip PostToolUse and SessionStart
2. **Edit activator.sh**: Reduce reminder text to lower token count

## Security Considerations

- Hook scripts run with the same permissions as Claude Code
- Scripts only output text; they don't modify files or run commands
- Error detector reads tool response from stdin JSON — treat responses as potentially sensitive
- All scripts are opt-in (you must configure them explicitly if not using frontmatter hooks)
- Recommended default: enable `UserPromptSubmit` and `SessionStart` only; add `PostToolUse` when you want error-pattern reminders

## Disabling Hooks

To temporarily disable all hooks:

```json
{
  "disableAllHooks": true
}
```

Or remove individual hook entries from settings / SKILL.md frontmatter.
