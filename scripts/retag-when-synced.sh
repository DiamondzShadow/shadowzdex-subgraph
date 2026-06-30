#!/usr/bin/env bash
# Poll Goldsky until shadowzdex-arb/v0.2.1 and shadowzdex-base/v0.2.1 finish
# syncing, then move their `latest` tags to v0.2.1. Runs in the background so the
# `latest` endpoint (used by the live stats/activity charts) is never pointed at a
# half-indexed version. Polygon was already tagged at deploy.
set -uo pipefail
cd "$(dirname "$0")/.."

synced_pct() { # $1 = subgraph/version  -> integer percent (floor), or -1
  goldsky subgraph list 2>/dev/null \
    | awk -v target="* $1" '
        $0 ~ target {found=1}
        found && /Synced:/ { gsub(/%/,""); print int($2); exit }
      '
}

for i in $(seq 1 240); do   # up to ~12h at 180s
  arb=$(synced_pct "shadowzdex-arb/v0.2.1")
  base=$(synced_pct "shadowzdex-base/v0.2.1")
  echo "[$(date -u +%H:%M:%S)] arb=${arb:-?}% base=${base:-?}%"
  if [ "${arb:-0}" -ge 100 ] && [ "${base:-0}" -ge 100 ]; then
    echo "Both synced — moving latest tags."
    npm run tag:arb && npm run tag:base
    echo "RETAG_DONE"
    exit 0
  fi
  sleep 180
done
echo "RETAG_TIMEOUT"
exit 1
