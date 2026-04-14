#!/bin/bash
# Self-Improvement Session Start Hook
# Injects learning reminder at session start via Claude Code SessionStart event.
# Stdout is added as context for Claude. Only runs if .learnings/ is initialized.

# Check if .learnings/ exists to confirm skill is active
if [ ! -d ".learnings" ]; then
  exit 0
fi

# Output reminder as additional context for Claude
cat << 'EOF'
<self-improvement-context>
Self-improvement skill is active. Key files:
- .learnings/LEARNINGS.md — corrections, insights, knowledge gaps
- .learnings/ERRORS.md — command failures, exceptions
- .learnings/FEATURE_REQUESTS.md — user-requested capabilities

After completing tasks, evaluate if any learnings should be captured.
Promote high-value learnings to CLAUDE.md or .github/copilot-instructions.md.
</self-improvement-context>
EOF
