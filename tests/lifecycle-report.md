# 🧪 Devnet lifecycle report — Skimmer Protocol v1

> SUPERSEDES the 2026-10-04 program-deploy report below. v1 runs on the plain
> SPL-delegation rail — **no program deploy needed**. Live devnet program
> `2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp` is unrelated to v1 flow.
> Canonical IDs: `docs/PROGRAM_IDS.md`.

## v1 swap lifecycle (`scripts/lifecycle-devnet.js`)

| Step | Status | Evidence |
|---|---|---|
| Keeper engine builds (`keeper/dist/engine.js`) | ✅ PASS | `npm run build` clean |
| Fee math (5% skim + 0.4% fee) | ✅ PASS | `node tests/fee-math.test.js` |
| Listener webhook (SWAP → queued, noise ignored) | ✅ PASS | `POST /webhook/tx` → `{"queued":1}` / `{"queued":0}` |
| Bot parsers + per-chat isolation | ✅ PASS | 500/250 bps, 25% rejected, states isolated |
| On-chain swap test (approve → mint → sweep → verify) | ✅ PASS 2026-10-04 | `scripts/lifecycle-devnet.js` → `LIFECYCLE PASS`. Sweep `2YtmRTRhGurWCF27HEqsKk8ZeB5gMK8wzAQ6xBvWKuLeXMA6hX5VbfQsiNoWXvjEPSjof97Kc3jFVWu7unDoyfBB` ([explorer](https://explorer.solana.com/tx/2YtmRTRhGurWCF27HEqsKk8ZeB5gMK8wzAQ6xBvWKuLeXMA6hX5VbfQsiNoWXvjEPSjof97Kc3jFVWu7unDoyfBB?cluster=devnet)): test mint `HgVEZS5P615jWoAFbzyuRZLH9bf4XTXYng7ok6rxneHr`, 1000 tokens in → savings `50.0` (5%), treasury `4.0` (0.4%). |

Run: `node scripts/lifecycle-devnet.js` (expects 5% → savings, 0.4% → treasury `85TK12...S3ka`).

---
*Archived 2026-10-04 program-deploy report (deferred rail — kept for history):*
- `skim_protocol.so` 328,912 B built via `build-sbf-msvc.bat` (BUILD-OK). Rent ≈ 2.29 SOL.
- Fresh devnet ID `EbRLUsTw…` retired (never deployed, key parked per `docs/PROGRAM_IDS.md`).
- Devnet deploy + fund loop never fired (faucet rate-limited); loop retired with the rail.
