# 🧪 Devnet lifecycle report — Skimmer Protocol

Program: `EbRLUsTwqTtMi2M9keQCgkaspNUi1JCBMuVb5v5MjTnJ` (fresh devnet ID)
Binary: `target/deploy/skim_protocol.so`, 328,912 bytes → rent ≈ 2.2895 SOL
Date: 2026-10-04. RPC: devnet.

## Results

| Check | Status | Evidence |
|---|---|---|
| Toolchain (anchor 0.29 + solana 2.2 + MSVC) | ✅ PASS | `anchor build` path fixed via `build-sbf-msvc.bat` (cargo `build-bpf`→`build-sbf` + crate pins in `Cargo.lock`) |
| `anchor build` / BUILD-OK | ✅ PASS | `skim_protocol.so` 328,912 B |
| Fee math (skim + 0.4%) | ✅ PASS | `node tests/fee-math.test.js` — 5% of 1M = 50000, 0.4% = 4000 |
| Listener webhook (SWAP → queued) | ✅ PASS | `POST /webhook/tx` → `{"queued":1}`; non-SWAP → `{"queued":0}` |
| Bot parsers (rate, cap, per-chat isolation) | ✅ PASS | `parseBps('5')=500`, `parseBps('2.5%')=250`, `25%` rejected, chat states isolated |
| Telegram bot online (new copy) | ✅ PASS | `@SkimmerProtocol_Bot`, log `skim-telegram online`, PROGRAM_ID updated |
| Fund deployer (needs ≥3 SOL devnet) | ⏳ BLOCKED | Faucet rate-limited; `scripts/fund-deploy-devnet.bat` looping detached, logging to `fund-deploy.log` |
| `solana program deploy` devnet | ⏳ PENDING | Auto-fires when funded (see log) |
| `scripts/lifecycle-devnet.js` (init wallet+config, SPL mint→approve→sweep→verify 5%) | ⏳ PENDING | Ready to run once deployed: `node scripts/lifecycle-devnet.js` |
| Helius devnet webhook → public listener | ⬜ TODO | Needs public URL (Railway) — synthetic POST proven locally |

## Watch

- `fund-deploy.log` — when it shows FUNDED + deploy signature, run:
  `solana program show EbRLUsTwqTtMi2M9keQCgkaspNUi1JCBMuVb5v5MjTnJ --url devnet`
  then `node scripts/lifecycle-devnet.js` (needs user wallet airdrop — same faucet).
- Private keys stay in `keys/` (gitignored). Nothing secret is committed.
