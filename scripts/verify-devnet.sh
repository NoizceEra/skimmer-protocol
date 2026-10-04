#!/usr/bin/env bash
# Assert that the program ACTUALLY LIVE on devnet matches what the repo declares
# (programs/skim_protocol/src/lib.rs declare_id! + Anchor.toml [programs.devnet]).
#
# Exits non-zero if the id or the upgrade authority disagree with this repo.
# Byte size is reported and compared to the local build (a mismatch only PRINTS a
# note — it means a build/upgrade is pending, not that the repo is inconsistent).
#
# Usage: scripts/verify-devnet.sh [--url devnet|mainnet-beta|<rpc>]
set -uo pipefail
cd "$(dirname "$0")/.."

EXPECTED_ID="2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp"
EXPECTED_AUTHORITY="95DmM5xt695F18s7ouhRHf9wETgyUKxWYWa9z5gma6YG"
URL="${SOLANA_URL:-devnet}"
if [[ "${1:-}" == "--url" ]]; then URL="${2:-devnet}"; fi
LOCAL_SO="target/deploy/skim_protocol.so"

echo "== solana program show $EXPECTED_ID --url $URL =="
if ! OUT="$(solana program show "$EXPECTED_ID" --url "$URL" 2>&1)"; then
  echo "$OUT"
  echo "FAIL: program $EXPECTED_ID is NOT deployed on $URL"
  exit 1
fi

id_chain="$(grep -m1 '^Program Id:' <<<"$OUT" | awk '{print $3}')"
auth_chain="$(grep -m1 '^Authority:' <<<"$OUT" | awk '{print $2}')"
size_chain="$(grep -m1 '^Data Length:' <<<"$OUT" | awk '{print $3}')"
bal_chain="$(grep -m1 '^Balance:' <<<"$OUT" | awk '{print $2}')"

echo "on-chain id       : $id_chain"
echo "on-chain size     : ${size_chain:-?} bytes"
echo "on-chain balance  : ${bal_chain:-?} SOL"
echo "upgrade authority : $auth_chain"

fail=0
[[ "$id_chain"   == "$EXPECTED_ID"        ]] || { echo "FAIL id:        chain=$id_chain expected=$EXPECTED_ID"; fail=1; }
[[ "$auth_chain" == "$EXPECTED_AUTHORITY" ]] || { echo "FAIL authority: chain=$auth_chain expected=$EXPECTED_AUTHORITY"; fail=1; }

if [[ -f "$LOCAL_SO" ]]; then
  local_size="$(stat -c %s "$LOCAL_SO")"
  echo "local .so size    : $local_size bytes"
  if [[ "$local_size" == "$size_chain" ]]; then
    echo "OK: deployed bytecode size matches the local build."
  else
    echo "NOTE: local .so ($local_size) != deployed ($size_chain) — build/upgrade pending."
  fi
else
  echo "NOTE: no local .so at $LOCAL_SO (run scripts/build-sbf.sh)."
fi

if [[ "$fail" -eq 0 ]]; then echo "RESULT: OK — repo id/authority agree with $URL."; else echo "RESULT: FAIL"; fi
exit $fail
