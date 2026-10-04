#!/usr/bin/env bash
# Upgrade the LIVE devnet program IN PLACE. No new program keypair is needed:
# `solana program deploy --program-id <pubkey>` upgrades the existing program when
# the signer is the current upgrade authority.
#
# v1 DOES NOT NEED THIS. The v1 rail is plain SPL (Approve + TransferChecked) and
# runs against the stock SPL Token program — see docs/MINIMAL_DEPLOY.md. Run this
# only once you actually want the on-chain PDA factory / session rail.
#
# SOL REQUIRED (devnet; faucet is rate-limited):
#   buffer rent (refunded on success) = (size + 128) * 5080 lamports
#   program-data top-up (permanent)   = rent(size) - programdata balance
#   + ~0.002 SOL fees
# The script prints the exact shortfall and exits 1 if the authority is short.
set -euo pipefail
cd "$(dirname "$0")/.."

PROGRAM_ID="${PROGRAM_ID:-2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp}"
URL="${SOLANA_URL:-devnet}"
LOCAL_SO="target/deploy/skim_protocol.so"
AUTH="${DEPLOYER_KEYPAIR:-$HOME/.config/solana/deployer.json}"
# solana.exe needs a native path under git-bash/MSYS
if command -v cygpath >/dev/null 2>&1; then AUTH="$(cygpath -m "$AUTH")"; fi

[[ -f "$LOCAL_SO" ]] || { echo "no $LOCAL_SO — run scripts/build-sbf.sh first"; exit 1; }
SIZE=$(stat -c %s "$LOCAL_SO")
RENT=$(( (SIZE + 128) * 5080 ))
AUTH_PUB="$(solana-keygen pubkey "$AUTH")"
BAL_LAMPORTS="$(solana balance "$AUTH_PUB" --url "$URL" --lamports 2>/dev/null | awk '{print $1}')"
ACC_JSON="$(solana account AoygmTGhQfBHcEfBpwMw73f8F1rmJZ739PpKV6uBoWyg --url "$URL" --output json 2>/dev/null || true)"
PD_BAL="$(grep -m1 lamports <<<"$ACC_JSON" | tr -dc '0-9')"
PD_BAL="${PD_BAL:-0}"
TOPUP=$(( RENT - PD_BAL )); [[ $TOPUP -lt 0 ]] && TOPUP=0
FEES=2000000
NEED=$(( RENT + TOPUP + FEES ))

sol() { awk "BEGIN{printf \"%.8f\", $1/1e9}"; }
echo "program id        : $PROGRAM_ID"
echo "artifact          : $LOCAL_SO ($SIZE bytes)"
echo "upgrade authority : $AUTH ($AUTH_PUB)"
echo "authority balance : $(sol "${BAL_LAMPORTS:-0}") SOL"
echo "buffer rent (refd): $RENT lamports = $(sol $RENT) SOL"
echo "programdata top-up: $TOPUP lamports = $(sol $TOPUP) SOL (permanent)"
echo "fees (approx)     : $FEES lamports"
echo "transient need    : $NEED lamports = $(sol $NEED) SOL"

if [[ "${BAL_LAMPORTS:-0}" -lt "$NEED" ]]; then
  SHORT=$(( NEED - BAL_LAMPORTS ))
  echo
  echo "SHORT by $(sol $SHORT) SOL on $URL — cannot upgrade yet."
  echo "Free devnet SOL: solana airdrop 2 $AUTH_PUB --url $URL  (rate-limited),"
  echo "or https://faucet.solana.com. Re-run when funded."
  exit 1
fi

echo
echo "== solana program deploy $LOCAL_SO =="
solana program deploy "$LOCAL_SO" \
  --program-id "$PROGRAM_ID" \
  --upgrade-authority "$AUTH" \
  --url "$URL"
echo "== verify =="
scripts/verify-devnet.sh --url "$URL"
