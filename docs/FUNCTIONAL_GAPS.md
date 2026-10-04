# Skimmer Protocol — Functional Readiness Audit

Audit date: 2026-10-04. Scope: `D:/ai-studio/skim-protocol` at commit `18c1f88`.
Method: read of every source file in the repo plus live `solana`/`anchor`/`tsc`/`node` probes.
Every claim below carries a `file:line` or a command result. Claims I could not verify are marked **UNVERIFIED** with the reason.

Deployed-state facts re-confirmed in this audit:

- Devnet program `2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp` is live: `solana program show … --url devnet` → `Data Length: 322896`, `Owner: BPFLoaderUpgradeab1e…`, `Authority: 95DmM5xt695F18s7ouhRHf9wETgyUKxWYWa9z5gma6YG`.
- Mainnet id `ECZ6ZsA79WqYEonfJcmSzp51SPg9nSDiTqu4bAxrfvc9` is **not deployed**: `solana program show … --url mainnet-beta` → `Error: Unable to find the account`.

---

## 1. Current reality — what actually works today vs. what is aspirational

**Blunt version: nothing skims. Not one end-to-end path exists.** The Telegram bot is a config notepad; the listener drops every swap on the floor; the keeper's sweep function has no caller; the one-time approval the whole rail depends on is never built or sent; and the on-chain "atomic session rail" described in the README is dead code that nothing references.

What genuinely works:

- **Fee math** is correct and consistent across Rust, keeper, and SDK: `output * bps / 10000` (`programs/skim_protocol/src/lib.rs:9`, `keeper/src/sweeper.ts:12-14`, `sdk/src/index.ts:9-11`), and the 4-assertion test passes (`node tests/fee-math.test.js` → `fee-math: all pass`).
- **All four TypeScript packages typecheck clean**: `npm --prefix {keeper,listener,sdk,bots/telegram} run typecheck` → no errors.
- **The devnet program is deployed** and its instructions are internally coherent enough to have built and deployed once.
- **The Telegram bot's onboarding state machine** (`/connect` → `/set_rate` → `/set_destination`) writes a local JSON record (`bots/telegram/src/store.ts:44-58`).

What does **not** work end-to-end (details in §3):

- A swap webhook is parsed, pushed into an **in-memory array** (`listener/src/queue.ts:8`), and `drain()` is **never called** (`grep` shows `drain` appears only at its own definition, `queue.ts:15`).
- The keeper's `processSkim` is exported and **never invoked** (`grep` shows it only at `keeper/src/sweeper.ts:28`). The keeper HTTP server exposes **only `/health`** and has **no sweep route**, despite its own comment claiming a "manual trigger" exists (`keeper/src/server.ts:6-7`).
- The one-time SPL delegate approval that makes the keeper able to move anything is built by `buildSetupTx` (`sdk/src/setup.ts:9`) and **never called** — not in the bot, not in any script (`grep` → only the definition).
- No code anywhere builds or sends `initialize_config`, `initialize_smart_wallet`, `grant_session`, or `session_consume`.
- The Telegram bot, run the documented way, **cannot even start** (`npm start` → `node src/bot.js`, but the build emits `dist/bot.js`; see gap G13).

The README's central promise — "Sign once. We remember your settings and get limited permission to move just that cut" and "Session rail (atomic): enforced on-chain… caller cannot skip or redirect" (`README.md:11-13,22`) — is **not true of any code in the repo today**.

---

## 2. Fund-safety findings (read this first)

Two flaws are money-relevant the moment the pipeline is connected. Ranked.

### F-1 (Critical) — Unauthenticated public webhook can move user funds

`listener/src/server.ts:11-35`: `POST /webhook/tx` accepts any JSON array from anyone. There is **no auth-header check** (Helius sends a configurable `Authorization` header that the code never inspects) and **no rate limiting**. Any caller can POST a forged event array.

**Blast radius, precisely:** a forged event supplies `user`, mint, and `outputAmount` (`listener/src/parser.ts:10-22`). Once the listener→keeper link is wired, the keeper will act on it and call `processSkim` for that user (`keeper/src/sweeper.ts:28`). The keeper moves `skim = outputAmount * savingsBps / 10000` from the user's ATA to the user's **own** savings destination, plus `fee = outputAmount * 40 / 10000` to the treasury, using the user's pre-approved SPL delegate (`sweeper.ts:69-80`). So an attacker **cannot redirect funds to themselves** — but they can:
- force the keeper to move *up to the entire delegated allowance* of an arbitrary user by inflating `outputAmount`, not just that user's real trade cut;
- drain the user's delegated allowance so legitimate skims then fail (`sweeper.ts:55` → `allowance too low`);
- spam arbitrary transfers and consume keeper SOL for fees.

That is unauthorized value movement and a griefing/DoS vector, not theft-to-attacker. Today the only live impact is unbounded memory growth (`queue.ts:8`) and log noise, because `drain()` is never called — the severity lands the day the pipeline is connected.

Fix: verify the shared secret/`Authorization` header, rate-limit, and (best) validate the referenced signature on-chain before sweeping.

### F-2 (Critical/High) — Parser skims non-swap inflows and charges the 0.4% fee

`listener/src/parser.ts:11`:

```ts
if (!event || (event.type !== 'SWAP' && !event.tokenTransfers?.length)) return null;
```

The guard rejects an event **only** when it is not a SWAP **and** has no token transfers. Any transaction with a token transfer passes, regardless of type. Then `parser.ts:14` selects *any* transfer where `toUserAccount === feePayer`, and `parser.ts:20` reports it as swap output.

**Blast radius:** a plain token transfer-in, an airdrop, a claim, a wrap, or a self-initiated receive — anything where the user pays the fee and receives a token — is treated as a swap output and gets skimmed, and the user is charged 0.4% on it (`sweeper.ts:45,74-80`). This moves user funds on events that were never trades.

Extension found in this audit (G17): `parser.ts:14` uses `.find()`, i.e. the **first** incoming transfer. For a multi-hop swap that can be an intermediate token, so the keeper may skim the wrong mint/amount.

Fix: require `event.type === 'SWAP'` (or provenance from a known swap program) and select the true net output leg.

### F-3 (High) — The used rail is bounded by a cap, not by "just that cut"

The rail the README actually describes (approve a delegate, keeper sweeps) is pure SPL delegation. The delegate can move **any amount up to the approved cap** (`sdk/src/index.ts:32-42`), not "just the savings cut." The only thing that constrains the keeper is the approve amount and the keeper's own honesty. The on-chain rule enforcement the docs imply (`session_consume`) is not on this path at all (see G09). This is a trust-boundary disclosure the docs currently obscure.

---

## 3. Prioritized gap table

Severity counts: **Critical 6 · High 7 · Medium 10 · Low 5 = 28 gaps.**

| ID | Sev | Area | One-line description | Evidence | Concrete fix |
|----|-----|------|----------------------|----------|--------------|
| G01 | Critical | keeper | Pipeline has no entry point: `processSkim` is never called; keeper serves only `/health` (no sweep route, no keypair load, no env config). | `keeper/src/sweeper.ts:28`; `keeper/src/server.ts:6-9`; grep "processSkim" → def only; grep keeper env → only `KEEPER_PORT` | Add an authenticated `POST /sweep`; load keeper keypair + RPC/treasury from env; call `processSkim` |
| G02 | Critical | listener | listener→keeper is not connected: jobs enter an in-memory array and are silently lost (`drain` never called). | `listener/src/queue.ts:8,15`; `listener/src/server.ts:22`; grep "drain" → def only; listener env has only `WEBHOOK_PORT` (`server.ts:37`) | Replace with authenticated HTTP POST to keeper, or Redis/BullMQ; keeper consumes |
| G03 | Critical | bot/sdk | One-time setup tx never built/sent: `buildSetupTx` has no caller; no code builds `initialize_config`/`initialize_smart_wallet`; `/spawn_wallet` just prints the PDA and tells the user to sign manually. | `sdk/src/setup.ts:9`; grep `buildSetupTx` → def only; `bots/telegram/src/bot.ts:105-116` | `/spawn_wallet` should produce a signable approve tx (or deep link); optionally append Anchor `initialize_config` |
| G04 | Critical | sdk/keeper | Delegate is per-token-account, but setup approves a **single** ATA → keeper throws `'no delegate'` for every other output mint. | `sdk/src/index.ts:32`; `sdk/src/setup.ts:9-24` (one `userAta`); `keeper/src/sweeper.ts:52-54` (reads that mint's ATA) | Approve each traded mint's ATA, or add a per-mint approve/top-up flow |
| G05 | Critical | listener | **Fund safety F-1**: `/webhook/tx` is unauthenticated and unrate-limited; forged events move user funds once wired. | `listener/src/server.ts:11-35` | Verify Helius `Authorization`/shared secret; rate-limit; validate signature on-chain |
| G06 | Critical | listener | **Fund safety F-2**: parser treats any tx with a token transfer to the fee payer as a swap output → non-swap inflows skimmed + 0.4% fee. | `listener/src/parser.ts:11,14,20` | Require `type === 'SWAP'`/known swap program; pick the true output leg |
| G07 | High | keeper | Treasury ATA is never ensured (only the savings ATA is) → a missing treasury ATA fails the **entire** sweep tx. | `keeper/src/sweeper.ts:58-68` (dest create) vs `74-79` (treasury, no create) | Idempotent-create `treasuryAta` before the fee transfer |
| G08 | High | keeper | No retry/backoff/requeue and in-memory 24h dedupe → a job that throws (`'no delegate'`, `'allowance too low'`) is lost forever; dedupe resets on restart. | `keeper/src/sweeper.ts:10,42,54-55` | Persistent store + retry/backoff + dead-letter queue |
| G09 | High | on-chain/sdk | Session rail is unreachable **and unsound**: nothing calls `grant_session`/`session_consume`, nothing funds the PDA, caller-supplied `output_amount` lets a session key underpay, and it can simply never call it. | `programs/.../lib.rs:133,186-299`; checks only `amount == output_amount*bps/10000` (`lib.rs:231-232,266-267`); `JupiterSwap` does no value leg (`lib.rs:289-291`); grep → no refs | v1: don't rely on it. Later: derive `output_amount` from a verified swap CPI inside one atomic tx |
| G10 | High | on-chain | Two sources of truth diverge: `UserSavingsConfig` and `SmartWallet` each store destination + bps; `update_config` never touches the wallet. | `lib.rs:41-57` vs `95-124`; structs `lib.rs:320-356`; `initialize_config` takes `smart_wallet` with no equality constraint (`lib.rs:22-39`) | Single canonical PDA, or have the keeper read one and forbid the other |
| G11 | High | on-chain | No instruction to close the smart wallet or withdraw SOL/tokens from the PDA → anything sent to it is stuck. | `lib.rs` `pub fn` list = initialize/update/pause/grant/revoke/consume only; no close/withdraw | Add `close_wallet` / `withdraw` |
| G12 | High | ops | `Anchor.toml` provider wallet is `id.json` (`6Fvy…`, 0.0287 SOL) which is neither the `solana` CLI keypair nor the program upgrade authority (`deployer.json`, `95DmM…`, 0.527 SOL) → `anchor deploy` signs with the wrong, underfunded key. | `Anchor.toml:24`; `solana config get`; `solana-keygen pubkey`; `solana program show`; `solana balance` | Point `provider.wallet` at `deployer.json`, or re-key authority |
| G13 | High | ops | Bot cannot start: `npm start`/`dev` run `node src/bot.js`, but `tsc` emits to `dist/`. | `bots/telegram/package.json` (`start`/`dev`); `ls bots/telegram/src` lacks `.js`; `node -e "require.resolve(...)"` → `MODULE_NOT_FOUND` | Run `dist/bot.js` (align `dev`) |
| G14 | Medium | keeper | No priority fee / `ComputeBudget` → sweep txs may not land under congestion. | grep `ComputeBudget|setComputeUnitPrice|priority` → NONE; `sweeper.ts:57-85` | Add a `ComputeBudget` price/limit |
| G15 | Medium | sdk/keeper | No allowance top-up flow; allowance is computed from skim only but each sweep spends skim+fee → allowance exhausts early and skims silently stop. | `sdk/src/index.ts:18`; `keeper/src/sweeper.ts:44-45`; `sweeper.ts:55` | Include fee in allowance math; add re-approve flow + user notice |
| G16 | Medium | sdk | `MAX_SAFE_ALLOWANCE` ("10 SOL-equivalent") is actually 10^10 **base units of any mint** — decimals-unaware, so real value varies wildly by token. | `sdk/src/index.ts:4,13-23` | Cap by USD value / require decimals |
| G17 | Medium | listener/keeper | Parser picks the first incoming transfer → multi-hop swaps may skim an intermediate token/amount. | `listener/src/parser.ts:14` | Select the net output mint |
| G18 | Medium | bot | `/status` reads a config PDA that is never initialized → always "No skim config yet"; no local-vs-chain reconciliation. | `bots/telegram/src/bot.ts:119-131`; `bots/telegram/src/status.ts:22-29` | Initialize the config PDA and read it |
| G19 | Medium | bot | `/pause` and `/resume` are no-ops that only print instructions. | `bots/telegram/src/bot.ts:147-153` | Build/send `set_paused` tx (or a deep link) |
| G20 | Medium | bot | No way to see accrued token savings per mint (only a SOL balance check). | `bots/telegram/src/bot.ts:133-145` | Read destination ATAs per mint |
| G21 | Medium | bot | State is a single JSON file with no locking / multi-process safety. | `bots/telegram/src/store.ts:33-42` | DB or atomic writes |
| G22 | Medium | tests | Only 4 fee-math assertions; no parser/sweeper test and no devnet integration test. | `tests/fee-math.test.js:12-15` (4 `assertEq`); single test file | Add unit + devnet integration tests |
| G23 | Medium | sdk | No IDL/`target` artifacts, and the SDK has encoders only for SPL `Approve` — no encoder for any program instruction it would need. | no `target/`, no `.so`, no `idls/` (`find`); `sdk/src/index.ts:25-42` only encodes Approve | `anchor build` → IDL; use `@coral-xyz/anchor` |
| G24 | Low | docs | README and a source comment claim on-chain enforcement "cannot skip or redirect/underpay" — false for the unused session rail and irrelevant to the used delegation rail. | `README.md:22`; `programs/.../lib.rs:184-185` | Correct the docs / the comment |
| G25 | Low | ops | `.gitignore` ignores `bots/telegram/data/`, but the runtime writes `bots/data/users.json` → user PII is not ignored. | `bots/telegram/src/store.ts:15`; `.gitignore` | Fix the ignored path |
| G26 | Low | ops | No `.env`/`.env.example` for keeper or listener (RPC, treasury, webhook secret all undefined). | `keeper/`, `listener/` dirs contain no env file; env reads limited to ports | Add `.env.example` + loader |
| G27 | Low | docs/ops | No Helius webhook registration/config documented despite README instruction to "point Helius here". | `README.md:40` | Document webhook setup + auth token |
| G28 | Low | security | `/connect` accepts any address with no ownership proof; any user can register anyone's address locally. | `bots/telegram/src/bot.ts:52-63` | Add sign-to-connect (message signature) |

---

## 4. Minimum path to a working product (one real user, devnet, end to end)

Smallest ordered set of changes that makes one user's trade actually auto-save on devnet. Each step is minimal-change; no architecture rewrite is required.

1. **Make the bot runnable** (G13). Point `bots/telegram` `start`/`dev` at `dist/bot.js`.
2. **Create a shared per-user config store the keeper can read** (G01/G18). Have the bot persist `{ authority, savingsBps, destination, paused, delegate }` to a file/DB; give the keeper a config loader. (This is the missing bridge between hypothesis 2's two halves.)
3. **Give the keeper a real entry point** (G01). Add `POST /sweep` (authenticated) that loads the user's config and calls `processSkim` with keeper keypair + treasury from env.
4. **Wire listener → keeper** (G02) and **authenticate the webhook** (G05). Replace the in-memory array with an authenticated HTTP call (or Redis) to the keeper; verify the Helius `Authorization`/shared secret and rate-limit.
5. **Fix the parser** (G06/G17) so only genuine swap outputs produce jobs.
6. **Build and send the one-time approve** (G03/G04). `/spawn_wallet` must return a signable transaction (or deep link) that approves the keeper delegate on the traded mint's ATA — this is the step the entire rail depends on and it does not exist today.
7. **Ensure the treasury ATA exists** (G07) so the fee leg doesn't fail the whole tx.

That yields: *user approves delegate once → trades on an app → webhook fires → listener forwards → keeper sweeps the user's real output-mint cut to their savings and 0.4% to treasury, on devnet.* Steps 5–7 can be stubbed by pinning one known mint and pre-creating its treasury ATA, but the ordering above is the honest minimum.

Hardening after that (not required to see one skim, required before real users): G08 retry/backoff/persistent dedupe, G14 priority fee, G15/G16 allowance top-up and decimals-aware cap, G09/G10/G11 on-chain correctness.

Explicitly **UNVERIFIED**: that `anchor build` succeeds in this environment. I did not run it (it writes `target/` into the repo, and the instruction was to modify only this doc). The program's prior devnet deployment proves it built at least once; a fresh build is unproven.

---

## 5. Not needed for v1 (deliberately not flagged as blocking)

- **The on-chain session system** (`grant_session`/`session_consume`, session PDAs, PDA-owned ATAs, funding the PDA). The documented flow uses a plain SPL delegate on the user's own ATA; the keeper never touches the smart-wallet PDA. The whole session rail is optional for v1 (G09, G11 become relevant only if you adopt the atomic rail).
- **Smart-wallet PDA funding / close.** Only needed if the session rail is adopted.
- **Deposit/withdraw vault builders** (`sdk/src/fees.ts:12-42`). No vault, no deposit UI is on the trade-skim path.
- **Mainnet deployment.** Out of scope for a devnet end-to-end proof.
- **The marketing web app** (`web/index.html`). It is static and fine; it does not block the rail.
- **Production queue infrastructure** (multi-region Redis, dashboards). A single shared secret + a durable store is enough for one user.
- **Multi-mint allowance batching beyond the mints a user actually trades** — approving on demand per mint is acceptable for v1.

---

## 6. Hypothesis verdicts (CONFIRMED / REFUTED / PARTIALLY TRUE)

| # | Hypothesis (abridged) | Verdict | Evidence |
|---|-----------------------|---------|----------|
| 1 | Pipeline not connected: keeper serves only `/health`; `processSkim` uncalled; `drain()` uncalled; swap webhook lost in memory. | **CONFIRMED** | `keeper/src/server.ts:7`; grep `processSkim`/`drain` → definitions only; `listener/src/queue.ts:8,15`; `listener/src/server.ts:22`. Extension: keeper's "manual trigger" comment (`server.ts:6`) is false. |
| 2 | Keeper has no per-user config source; bot JSON unread; config PDA never read or initialized. | **CONFIRMED** | `keeper/src/sweeper.ts:28-39`; keeper env reads only `KEEPER_PORT` (`server.ts:9`); bot store `bots/telegram/src/store.ts:15`; config PDA `lib.rs:320-329` has no reader/initializer (only a comment `sdk/src/setup.ts:7` and bot text `bot.ts:114`). |
| 3 | Nothing builds/sends the setup tx; `/spawn_wallet` only prints the PDA. | **CONFIRMED** (+ extended) | `sdk/src/setup.ts:9`; grep `buildSetupTx` → def only; `bots/telegram/src/bot.ts:105-116`. Extension **G04**: setup approves a single ATA while the delegate is per-ATA. |
| 4 | Atomic session rail is unreachable dead code; assess under-report and skip. | **CONFIRMED**, and both sub-questions **CONFIRMED** (underpay possible; can skip) | grep `grant_session`/`session_consume` → no refs; nothing funds the PDA or creates PDA ATAs; `lib.rs:231-232,266-267` tie `amount` only to caller-supplied `output_amount`; `lib.rs:289-291` does no value leg. The README:22 and `lib.rs:184-185` "caller cannot underpay" claims are **REFUTED**. |
| 5 | Webhook unauthenticated; forged events can trigger sweeps. | **CONFIRMED** (with a corrected blast radius) | `listener/src/server.ts:11-35`. Nuance: funds go to the user's own savings/treasury, not the attacker — it is unauthorized value movement + allowance drain + DoS, **not** theft-to-attacker. |
| 6 | Parser false positives move funds on non-swap inflows (+ 0.4% fee). | **CONFIRMED** | `listener/src/parser.ts:11,14,20`. Extension **G17**: first incoming transfer, multi-hop mismatch. |
| 7 | Keeper robustness gaps: in-memory dedupe; no retry/requeue; treasury ATA not ensured; no priority fee; no allowance top-up. | **CONFIRMED** | `sweeper.ts:10` (dedupe), `:58-79` (dest ensured, treasury not), `:54-55` (throw, no caller), grep priority → NONE; `index.ts:18` allowance from skim only. |
| 8 | Two sources of truth diverge; `update_config` doesn't touch the PDA. | **CONFIRMED** | `lib.rs:41-57` vs `95-124`; structs `lib.rs:320-356`. |
| 9 | No instruction to close the smart wallet / withdraw stuck funds. | **CONFIRMED** | `grep "pub fn "` on `lib.rs` → no close/withdraw. |
| 10 | `Anchor.toml` wallet = `id.json`, `solana` config = `deployer.json`; verify `id.json` existence; if missing a fresh build/deploy fails. | **PARTIALLY TRUE — premise REFUTED, underlying divergence CONFIRMED** | `id.json` **exists** (`solana-keygen pubkey` → `6FvyEf…`, 219 B). So "missing file" is wrong. But `Anchor.toml:24` (`id.json`, 0.0287 SOL) ≠ `solana config get` and the on-chain upgrade authority (`deployer.json`, `95DmM…`, 0.527 SOL) → `anchor deploy` fails for a different reason (G12). |
| 11 | Test coverage 4 assertions; no devnet/parser/sweeper tests; no IDL/target artifacts though the SDK hand-rolls encoding. | **CONFIRMED** | `tests/fee-math.test.js:12-15`; single test file; `find` → no `target/`, `.so`, `idls/`. Extension **G23**: SDK encodes only SPL `Approve` (`index.ts:25-42`), no program-call encoders. |
| 12 | Bot gaps: single JSON no locking; `/pause`//`/resume` mere text; no reconciliation; `.env` PROGRAM_ID is devnet; no per-mint accrued view. | **CONFIRMED** (+ extended) | `store.ts:33-42`; `bot.ts:147-153`; `bot.ts:119-131`+`status.ts:22-29`; `bots/telegram/.env` `PROGRAM_ID=2YHE64…`; `bot.ts:133-145`. Extension **G13**: bot cannot start (`src/bot.js` vs `dist/`). |

---

## 7. Reproducing the key evidence

```bash
cd /d/ai-studio/skim-protocol
solana program show 2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp --url devnet   # live, 322896 bytes
solana program show ECZ6ZsA79WqYEonfJcmSzp51SPg9nSDiTqu4bAxrfvc9 --url mainnet-beta  # not found
solana config get                                                               # keypair = deployer.json
solana-keygen pubkey 'C:/Users/vclin_jjufoql/.config/solana/id.json'             # 6FvyEf… (Anchor.toml uses this)
solana-keygen pubkey 'C:/Users/vclin_jjufoql/.config/solana/deployer.json'       # 95DmM… (upgrade authority)
grep -rn "processSkim\|drain\|buildSetupTx\|session_consume\|grant_session" --include='*.ts' . | grep -v node_modules | grep -v dist/
node tests/fee-math.test.js                                                      # 4 pass
npm --prefix keeper run typecheck && npm --prefix listener run typecheck && npm --prefix sdk run typecheck && npm --prefix bots/telegram run typecheck
node -e "require.resolve('./bots/telegram/src/bot.js')"                          # MODULE_NOT_FOUND
```
