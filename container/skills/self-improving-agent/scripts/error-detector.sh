#!/bin/bash
# Self-Improvement Error Detector Hook
# PostToolUse hook for Bash — detects command failures via stdin JSON.
# Claude Code sends hook input as JSON on stdin with fields:
#   tool_name, tool_input, tool_response, tool_use_id, session_id, etc.

# Read JSON input from stdin
INPUT=$(cat)

# Extract tool name — silently exit on malformed/empty JSON
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0

# Only process Bash tool calls
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# Extract tool response — may be a string or object
TOOL_RESPONSE=$(echo "$INPUT" | jq -r '.tool_response // empty' 2>/dev/null) || true
if [ -z "$TOOL_RESPONSE" ]; then
  exit 0
fi

# Also check for non-zero exit in tool_input description or explicit failure signals
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || true

# Error patterns (case-insensitive matching)
ERROR_PATTERNS=(
    "error:"
    "Error:"
    "ERROR:"
    "failed"
    "FAILED"
    "command not found"
    "No such file"
    "Permission denied"
    "fatal:"
    "Exception"
    "Traceback"
    "npm ERR!"
    "ModuleNotFoundError"
    "SyntaxError"
    "TypeError"
    "exit code"
    "non-zero"
)

# Check if response contains any error pattern
contains_error=false
for pattern in "${ERROR_PATTERNS[@]}"; do
  if echo "$TOOL_RESPONSE" | grep -qi "$pattern"; then
    contains_error=true
    break
  fi
done

# Only output reminder if error detected
if [ "$contains_error" = true ]; then
  cat << 'EOF'
<error-detected>
A command error was detected. Consider logging this to .learnings/ERRORS.md if:
- The error was unexpected or non-obvious
- It required investigation to resolve
- It might recur in similar contexts
- The solution could benefit future sessions

Use the self-improvement skill format: [ERR-YYYYMMDD-XXX]
</error-detected>
EOF
fi
