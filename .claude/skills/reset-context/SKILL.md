---
name: reset-context
description: Clear an agent's conversation history and session state so it starts fresh on the next invocation. Use when an agent's context is corrupted, stale, or too long.
---

# Reset Agent Context

Each NanoClaw group's agent context has two layers:

| Layer | Location | What it stores |
|-------|----------|----------------|
| **Session mapping** | SQLite `sessions` table | Maps `group_folder` → Claude SDK `session_id` (used to resume conversations) |
| **Claude Code session cache** | `data/sessions/{group}/.claude/sessions/` | Session metadata files that Claude Code writes internally |

Clearing both layers ensures the agent starts completely fresh.

## Usage

```
/reset-context
/reset-context feishu_main
/reset-context all
```

- No argument: reset the **main** group.
- Group folder name: reset that specific group.
- `all`: reset every group.

## Steps

### 1. Determine the target group(s)

If the user passed a group folder name, use that. If `all`, operate on every group. If no argument, default to the main group (look up which folder is `is_main = 1` in the database).

List available groups to help the user choose:

```bash
sqlite3 store/messages.db "SELECT folder, name, is_main FROM registered_groups ORDER BY is_main DESC, name;"
```

### 2. Delete session mapping from SQLite

```bash
# Single group
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{groupFolder}';"

# All groups
sqlite3 store/messages.db "DELETE FROM sessions;"
```

### 3. Delete Claude Code session cache files

```bash
# Single group
rm -rf data/sessions/{groupFolder}/.claude/sessions/*

# All groups
rm -rf data/sessions/*/.claude/sessions/*
```

### 4. Confirm

Print what was cleared:

```
Cleared session for group "{name}" (folder: {groupFolder}).
The agent will start a fresh conversation on the next message.
```

## What is NOT cleared

These persist across session resets by design:

| What | Location | Purpose |
|------|----------|---------|
| Group memory (CLAUDE.md) | `groups/{folder}/CLAUDE.md` | Persistent instructions and context |
| Auto memory | `data/sessions/{folder}/.claude/projects/` | Claude Code's remembered preferences |
| Message history | SQLite `messages` table | Chat log for context assembly |
| Scheduled tasks | SQLite `scheduled_tasks` table | Recurring task definitions |
| Skills | `data/sessions/{folder}/.claude/skills/` | Container skills available to the agent |

If the user wants a **full reset** including CLAUDE.md and auto memory, they should delete those files manually or ask explicitly.
