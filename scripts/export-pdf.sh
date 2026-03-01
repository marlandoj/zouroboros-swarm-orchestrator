#!/usr/bin/env bash
# =============================================================================
# Swarm Results → PDF Export
# =============================================================================
# Runs an orchestration and exports the full output as a PDF report.
#
# Usage:
#   bash scripts/export-pdf.sh <tasks.json> [orchestrator options...]
#
# Examples:
#   bash scripts/export-pdf.sh examples/website-review.json --swarm-id my-review
#   bash scripts/export-pdf.sh tasks.json --swarm-id audit --timeout 120
#
# Output:
#   Markdown: ~/.swarm/reports/<swarm-id>.md
#   PDF:      ~/.swarm/reports/<swarm-id>.pdf
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPORTS_DIR="${HOME}/.swarm/reports"
mkdir -p "$REPORTS_DIR"

if [ $# -lt 1 ]; then
  echo "Usage: bash scripts/export-pdf.sh <tasks.json> [orchestrator options...]"
  echo ""
  echo "Examples:"
  echo "  bash scripts/export-pdf.sh examples/website-review.json --swarm-id my-review"
  echo "  bash scripts/export-pdf.sh tasks.json --swarm-id audit --timeout 120"
  exit 1
fi

# Extract swarm-id from args if provided, otherwise generate one
SWARM_ID=""
ARGS=("$@")
for i in "${!ARGS[@]}"; do
  if [ "${ARGS[$i]}" = "--swarm-id" ] && [ $((i + 1)) -lt ${#ARGS[@]} ]; then
    SWARM_ID="${ARGS[$((i + 1))]}"
    break
  fi
done

if [ -z "$SWARM_ID" ]; then
  SWARM_ID="swarm-$(date +%Y%m%d_%H%M%S)"
  ARGS+=("--swarm-id" "$SWARM_ID")
fi

MD_FILE="$REPORTS_DIR/${SWARM_ID}.md"
PDF_FILE="$REPORTS_DIR/${SWARM_ID}.pdf"

echo "================================================"
echo "Swarm → PDF Export"
echo "================================================"
echo "  Swarm ID:  $SWARM_ID"
echo "  Markdown:  $MD_FILE"
echo "  PDF:       $PDF_FILE"
echo "================================================"
echo ""

# Run orchestrator, capture full output
cd "$SCRIPT_DIR"
bun orchestrate-v4.ts "${ARGS[@]}" 2>&1 | tee "$MD_FILE"

echo ""
echo "--- Generating PDF ---"

# Convert markdown to PDF
if command -v pandoc &>/dev/null; then
  pandoc "$MD_FILE" \
    -o "$PDF_FILE" \
    --pdf-engine=xelatex \
    -V geometry:margin=1in \
    -V fontsize=11pt \
    --highlight-style=tango \
    2>/dev/null || \
  # Fallback: try without xelatex
  pandoc "$MD_FILE" -o "$PDF_FILE" 2>/dev/null || \
  echo "Warning: pandoc PDF generation failed. Markdown saved to: $MD_FILE"
else
  echo "Warning: pandoc not installed. Markdown saved to: $MD_FILE"
  echo "  Install pandoc to enable PDF export: sudo apt install pandoc texlive-xetex"
fi

echo ""
echo "================================================"
echo "EXPORT COMPLETE"
echo "================================================"
if [ -f "$PDF_FILE" ]; then
  echo "  PDF:      $PDF_FILE"
fi
echo "  Markdown: $MD_FILE"
echo "================================================"
