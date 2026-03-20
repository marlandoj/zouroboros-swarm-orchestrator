#!/usr/bin/env bash
# Claude Code bridge script — invokes Claude Code CLI in one-shot mode
# Returns only the response text, suitable for scripted/orchestrator invocation
#
# Usage:
#   ./claude-code-bridge.sh "Your prompt here"
#   ./claude-code-bridge.sh "Your prompt here" /path/to/workdir
#
# Environment:
#   CLAUDE_CODE_MODEL — override model (default: uses CLI default)
#   CLAUDE_CODE_TIMEOUT — timeout in seconds (default: 600)

set -euo pipefail

PROMPT="${1:?Usage: claude-code-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-/home/workspace}"
TIMEOUT="${CLAUDE_CODE_TIMEOUT:-600}"

# Resolve claude binary — check PATH, then known install locations
CLAUDE_BIN="${CLAUDE_CODE_BIN:-}"
if [ -z "$CLAUDE_BIN" ]; then
  if command -v claude &>/dev/null; then
    CLAUDE_BIN="claude"
  elif [ -x "$HOME/.local/bin/claude" ]; then
    CLAUDE_BIN="$HOME/.local/bin/claude"
  elif [ -x "/root/.local/bin/claude" ]; then
    CLAUDE_BIN="/root/.local/bin/claude"
  elif [ -x "/usr/local/bin/claude" ]; then
    CLAUDE_BIN="/usr/local/bin/claude"
  else
    echo "ERROR: claude binary not found. Install with: npm install -g @anthropic-ai/claude-code" >&2
    exit 1
  fi
fi

cd "$WORKDIR"

# Unset CLAUDECODE to allow spawning from within a Claude Code session
unset CLAUDECODE

# Run Claude Code in print mode (non-interactive, one-shot)
# Permissions: relies on settings.json defaultMode=bypassPermissions
# (--dangerously-skip-permissions is blocked when running as root)
# --output-format text: returns clean text without JSON wrapping

# Log stderr for debugging; stdout is the response
STDERR_LOG="/tmp/claude-code-bridge-stderr-$$.log"

EXTRA_ARGS=""
if [ -n "${CLAUDE_CODE_MODEL:-}" ]; then
  EXTRA_ARGS="--model $CLAUDE_CODE_MODEL"
fi

set +e
timeout "$TIMEOUT" "$CLAUDE_BIN" -p "$PROMPT" --yolo --output-format text $EXTRA_ARGS 2>"$STDERR_LOG"
EXIT_CODE=$?
set -e 

if [ $EXIT_CODE -ne 0 ]; then
  echo "BRIDGE_ERROR: exit=$EXIT_CODE stderr=$(cat "$STDERR_LOG" 2>/dev/null | head -5)" >&2
fi
rm -f "$STDERR_LOG"
exit $EXIT_CODE