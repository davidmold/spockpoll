#!/usr/bin/env bash
# Refresh the dashboard's polling and economic data caches.
#
# Usage:
#   ./update-data.sh              # fetch + report changes
#   ./update-data.sh --quiet      # fetch silently (for cron)

# Sources:
#   Polling: The New York Times / FiveThirtyEight
#   Economic series: FRED, Federal Reserve Bank of St. Louis

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLL_FILE="$SCRIPT_DIR/president.csv"
ECON_FILE="$SCRIPT_DIR/economic.csv"
POLL_URL="https://www.nytimes.com/newsgraphics/polls/approval/president.csv"
FRED_URL="https://fred.stlouisfed.org/graph/fredgraph.csv"
QUIET="${1:-}"

log() {
  [[ "$QUIET" == "--quiet" ]] || echo "$@"
}

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

download() {
  local url="$1"
  local target="$2"
  local http_code

  http_code=$(curl --fail --location --silent --show-error \
    --write-out '%{http_code}' --output "$target" "$url")

  if [[ "$http_code" != "200" ]]; then
    log "ERROR: HTTP $http_code from $url"
    exit 1
  fi
}

replace_if_changed() {
  local candidate="$1"
  local destination="$2"
  local label="$3"

  if [[ -f "$destination" ]] && cmp -s "$candidate" "$destination"; then
    log "$label is already up to date"
    return
  fi

  cp "$candidate" "$destination"
  log "Updated $label ($(($(wc -l < "$destination") - 1)) observations)"
}

log "Fetching presidential approval polling…"
poll_tmp="$TMP_DIR/president.csv"
download "$POLL_URL" "$poll_tmp"

if [[ $(wc -l < "$poll_tmp") -lt 10 ]] || ! head -n 1 "$poll_tmp" | grep -q 'poll_id'; then
  log "ERROR: Polling download looks malformed; keeping the existing cache"
  exit 1
fi

replace_if_changed "$poll_tmp" "$POLL_FILE" "polling data"

log "Fetching economic indicators from FRED…"
econ_tmp="$TMP_DIR/economic.csv"
printf 'date,series,value\n' > "$econ_tmp"

# Fetch extra history so twelve complete months remain available after release lags
# and so PAYEMS can calculate the first displayed month-over-month change.
start_date=$(date -d '15 months ago' +%F)
series_ids=(SP500 NASDAQCOM DJIA CPIAUCSL PAYEMS GASREGW BOPGSTB)

for series_id in "${series_ids[@]}"; do
  series_tmp="$TMP_DIR/$series_id.csv"
  download "$FRED_URL?id=$series_id&cosd=$start_date" "$series_tmp"

  if ! head -n 1 "$series_tmp" | grep -q "$series_id"; then
    log "ERROR: FRED response for $series_id looks malformed; keeping the existing cache"
    exit 1
  fi

  awk -F, -v series="$series_id" '
    NR > 1 {
      gsub(/\r/, "", $2)
      if ($2 != "" && $2 != ".") print $1 "," series "," $2
    }
  ' "$series_tmp" >> "$econ_tmp"
done

if [[ $(wc -l < "$econ_tmp") -lt 50 ]]; then
  log "ERROR: Economic download has too few observations; keeping the existing cache"
  exit 1
fi

replace_if_changed "$econ_tmp" "$ECON_FILE" "economic data"
log "Done — $(date -Iseconds)"
