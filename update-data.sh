#!/usr/bin/env bash
# update-data.sh — Fetch latest presidential approval polling data from NYT
#
# Usage:
#   ./update-data.sh              # fetch + report changes
#   ./update-data.sh --quiet      # fetch silently (for cron)
#
# Data source: NYT / FiveThirtyEight presidential approval polls
# License: CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CSV_FILE="$SCRIPT_DIR/president.csv"
SOURCE_URL="https://www.nytimes.com/newsgraphics/polls/approval/president.csv"
QUIET="${1:-}"

log() {
  [[ "$QUIET" == "--quiet" ]] || echo "$@"
}

# Count rows before update
BEFORE=0
if [[ -f "$CSV_FILE" ]]; then
  BEFORE=$(wc -l < "$CSV_FILE")
fi

log "Fetching latest polling data from NYT..."

# Download to temp file first, only overwrite if successful
TMPFILE=$(mktemp)
trap "rm -f $TMPFILE" EXIT

HTTP_CODE=$(curl -sS -w '%{http_code}' -o "$TMPFILE" "$SOURCE_URL")

if [[ "$HTTP_CODE" != "200" ]]; then
  log "ERROR: HTTP $HTTP_CODE from $SOURCE_URL"
  exit 1
fi

# Sanity check — file should have CSV headers and at least some data rows
LINES=$(wc -l < "$TMPFILE")
if [[ "$LINES" -lt 10 ]]; then
  log "ERROR: Downloaded file has only $LINES lines — looks malformed, keeping old data"
  exit 1
fi

# Check if data actually changed
if [[ -f "$CSV_FILE" ]] && cmp -s "$TMPFILE" "$CSV_FILE"; then
  log "No changes — data is already up to date ($BEFORE lines)"
  exit 0
fi

# Replace the file
cp "$TMPFILE" "$CSV_FILE"
AFTER=$(wc -l < "$CSV_FILE")
DIFF=$((AFTER - BEFORE))

if [[ "$BEFORE" -eq 0 ]]; then
  log "Downloaded $AFTER lines (fresh download)"
else
  log "Updated: $BEFORE → $AFTER lines (${DIFF:+$DIFF} new)"
fi

log "Done — $(date -Iseconds)"
