# Skimmer Protocol — Deployment & Operating Costs

**Document type:** cost analysis (no deployment performed by this document itself).
**Prepared:** 2026-10-04.
**SOL/USD for every USD figure:** **$120.89**, from
`https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd`
at **2026-10-04 07:45:30 UTC** (CoinGecko; carried over from the prior revision —
re-fetch before quoting). Sources are cited inline; anything not verified from a
command or fetched URL is marked **UNVERIFIED**.

---

## 0. Headline — the v1 stack is $0 one-time and $0–5/month

**v1 needs no custom on-chain program.** Verified from the code: the user grants a
bounded SPL delegate via a plain SPL Token `Approve` (`sdk/src/setup.ts:85-87`;
encoder tag 4 in `sdk/src/index.ts:202-204`) and the keeper moves skim + the 0.4%
fee via plain SPL `TransferChecked` (`keeper/src/sweeper.ts:69-80`), signing as the
delegate. Both are stock SPL Token instructions. The Anchor program is used only by
the PDA factory / `user_config` / `session_consume` session rail — **all three
unreachable in v1** (`docs/FUNCTIONAL_GAPS.md`). Runbook: `docs/MINIMAL_DEPLOY.md`.

> **Honest trade-off:** in v1 the skim and the 0.4% fee are enforced by the keeper's
> **off-chain** code; the only on-chain protection is the bounded, revocable SPL
> delegate the user approves. The atomic `session_consume` rail (which would enforce
> per-trade amounts on-chain) is **not wired** and is deferred.

| v1 line | Cost |
|---|---|
| One-time on-chain | **$0** (no program deploy) |
| Monthly infra | **$0** (self-host / local PC) … **$5** (Railway Hobby, includes $5 usage) |
| RPC + webhooks | **$0** (public RPC; Helius Free if webhook used) |
| Static site | **$0** (Cloudflare Pages or GitHub Pages) |
| Domain | **$0** (`*.pages.dev` / `*.github.io`) |
| Keeper gas | **$0** devnet (faucet); mainnet held float ~0.2–0.5 SOL |

---

## 1. Verified ground truth (commands run, chain state)

| Fact | Value | How verified |
|---|---|---|
| Solana CLI | `solana-cli 2.2.0 (Agave)` | `solana --version` |
| cargo-build-sbf | `2.2.0`, `platform-tools v1.43` | `cargo-build-sbf --version` |
| Solana CLI keypair | `~/.config/solana/deployer.json` | `solana config get` |
| Deployer address | `95DmM5xt695F18s7ouhRHf9wETgyUKxWYWa9z5gma6YG` | `solana-keygen pubkey` |
| **Devnet program (live)** | `2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp` — upgradeable | `solana program show -u devnet` |
| Devnet program data length | **322,896 bytes** | same |
| Devnet program-data account | `AoygmTGhQfBHcEfBpwMw73f8F1rmJZ739PpKV6uBoWyg`, balance **1.64119052 SOL** | `solana account` / `program show` |
| Devnet program (executable) account | balance **833,120 lamports = 0.00083312 SOL** | `solana account 2YHE64…` |
| Devnet upgrade authority | `95DmM5xt695F18s7ouhRHf9wETgyUKxWYWa9z5gma6YG` | `solana program show` |
| Fresh-id `EbRLUsTw…` | **NOT deployed** (`Error: Unable to find the account`) | `solana program show -u devnet` |
| Mainnet `ECZ6ZsA79WqYEonfJcmSzp51SPg9nSDiTqu4bAxrfvc9` | **NOT deployed**, no keypair exists | `solana program show -u mainnet-beta` |
| Deployer devnet balance | **0.52713284 SOL** | `solana balance -u devnet` |
| Repo SBF build | `target/deploy/skim_protocol.so`, **328,912 bytes** | `scripts/build-sbf.sh` (via `build-sbf-msvc.bat`) |

### Live rent parameters

Decoded from the on-chain `SysvarRent…` account: `lamports_per_byte_year = 5080`,
`exemption_threshold = 1.0`, `burn_percent = 50`, so
**`rent_exempt(size) = (128 + size) × 5080` lamports**, cross-checked with
`solana rent <size>`.

| Data length | Lamports | SOL | Source |
|---|---|---|---|
| 36 (upgradeable program account) | 833,120 | 0.00083312 | `solana rent 36` |
| 165 (SPL token account / ATA) | 1,488,440 | **0.00148844** | `solana rent 165` |
| 322,896 (bytecode currently live) | 1,640,961,920 | **1.64096192** | `solana rent 322896` |
| **328,912 (current build .so)** | **1,671,523,200** | **1.67152320** | `solana rent 328912` |

> ⚠️ **Two obsolete numbers to stop using.** (1) The **6960 lamports/byte-year**
> constant (and the `(size + 45) × 6960` formula) is from an older network rent
> schedule — on this network rent is **5080**, so 6960 overstates by ~27%. This
> document (and `docs/COSTS.md`) now use 5080. (2) The historical ATA rent
> **0.00203928 SOL** assumes 3480/2.0; here a 165-byte token account is
> **0.00148844 SOL**, confirmed by CLI, mainnet RPC, and the real on-chain
> program-data balance.

---

## 2. The on-chain program (DEFERRED for v1)

Only needed for the PDA factory / session rail. Two ways to have it:

### 2.1 Keep the current devnet program as-is — $0

It is already deployed on devnet with free faucet SOL locked. Nothing to pay.
Upgrading it to the current 328,912-byte build is optional.

### 2.2 A FRESH deploy of the 328,912-byte build (mainnet, or a new devnet id)

| Item | Size | SOL | Refundable? |
|---|---|---|---|
| Program-data account (holds code) | 328,912 B | **1.67152320** | ❌ locked (returns on `program close`) |
| Program (executable) account | 36 B | **0.00083312** | ❌ locked (same) |
| Deploy buffer (temp) | 328,912 B | 1.67152320 | ✅ refunded on success |
| Tx fees (≈325 writes ×5,000 + setup) | — | ≈0.0017 | ❌ spent |

```
permanent lock = 1.67152320 + 0.00083312            = 1.67235632 SOL
buffer (refunded)                                   = 1.67152320 SOL
fees                                                ≈ 0.00170000 SOL
PEAK transiently required = 1.67235632 + 1.67152320 = 3.34387952
                          + 0.0017                  ≈ 3.3456 → ~3.346 SOL
```

**Recommended deployer float: 4 SOL.** (Bare minimum ~3.35; 4 leaves retry
margin.) A fresh deploy also needs the **program keypair** for the target id.

### 2.3 In-place UPGRADE of the live program (devnet) — cheaper

No program keypair needed; `solana program deploy --program-id <pubkey>` upgrades
in place when the signer is the current authority.

```
buffer rent (refunded)   = rent(328,912)            = 1.67152320 SOL
program-data top-up      = 1.67152320 − 1.64119052  = 0.03033268 SOL  (permanent)
fees                                                ≈ 0.00200000 SOL
PEAK transiently required                           ≈ 1.70385588 SOL
```

**Available: 0.52713284 SOL → short ≈1.177 SOL** (transient). Run
`scripts/deploy-devnet.sh`; it prints the exact shortfall and the faucet command.

### 2.4 If you close the devnet program

`solana program close 2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp --url devnet`
refunds the program-data account to the authority:
`1,641,190,520 + 833,120 = 1,642,023,640 lamports ≈ 1.64202364 SOL`.
**Do not do this while other work depends on the id resolving** — closing it makes
`2YHE64pk…` disappear, and the whole point of the current state is source/chain
agreement. Treat it as a future option once the id is no longer referenced.

---

## 3. Hosting — the v1 target is ONE process ($0–5/mo)

The bot uses grammy **long-polling** (no inbound URL). The listener webhook and the
keeper can share one port, and the keeper's `processSkim` is a plain exported
function (`keeper/src/engine.ts:345`), so an **in-process call replaces the
listener→keeper HTTP hop**. One small always-on process:

| Host | Cost | Note |
|---|---|---|
| Owner's own PC | **$0** | Fine for a devnet beta. |
| Railway Hobby | **$5/mo** | Subscription **includes $5 usage**; one tiny service fits. https://railway.com/pricing |
| Railway Pro (3 separate services) | ~$10–36/mo | Deferred; only if you split services again. |

### Simplest v1: outbound polling instead of a webhook

Replace the inbound webhook with **outbound polling** of the user's recent
transactions on an interval. That removes the need for any public URL, ingress, or
webhook provider — so it runs on the cheapest host or a local PC. Downside: latency
(seconds→tens of seconds) and more RPC calls. (Small listener change: the current
parser consumes Helius **enhanced**-tx JSON.) The webhook is the sub-second upgrade.

### Static site

| Host | Cost | Commercial use? |
|---|---|---|
| **Cloudflare Pages** free | **$0** | Static asset requests free & unlimited (https://developers.cloudflare.com/pages/functions/pricing/). Not documented as non-commercial-only — verify before relying on it. |
| **GitHub Pages** free | **$0** | Public repo (https://docs.github.com/en/pages). |
| Vercel Hobby | $0 | **Non-commercial only** — a fee-taking protocol needs **Pro $20/mo** (https://vercel.com/docs/limits/fair-use-policy). |

The free `*.pages.dev` / `*.github.io` subdomain keeps the domain cost at **$0**.

---

## 4. RPC + webhooks

| Provider | Plan | $/mo | Webhooks? |
|---|---|---|---|
| Helius | **Free** | **$0** | ✅ yes — 1M credits, **1 credit per delivered event** (https://www.helius.dev/pricing, https://www.helius.dev/docs/webhooks) |
| Helius | Developer | $49 | ✅ yes (7-day window) |
| QuickNode | Free trial | $0 | 1-month trial only (https://www.quicknode.com/pricing) |

**For v1 the $49/mo Developer tier is NOT needed** — Helius Free includes the
webhook the listener uses. If you take the polling path (§3), you need no webhook
provider at all.

---

## 5. Keeper gas float (mainnet; devnet = $0)

| Component | Lamports | SOL |
|---|---|---|
| Base tx fee (1 signature) | 5,000 | 0.000005 |
| Priority fee (optional) | variable | ~0.000005–0.0001 |
| New destination ATA rent (first sweep of a new mint) | 1,488,440 | 0.00148844 |
| Treasury ATA rent (pre-create per mint; the keeper does not create it) | 1,488,440 | 0.00148844 |

1 SOL ≈ **200,000** base-fee sweeps. A small beta needs a **held float of ~0.2–0.5
SOL**, not a subscription. Monitor the keeper balance (the engine refuses below a
`KEEPER_MIN_LAMPORTS` floor, default 0.005 SOL — `keeper/src/config.ts:16`).

---

## 6. Deferred / full stack (do not optimise for this yet)

| Item | Cost | Source |
|---|---|---|
| Mainnet program deploy (fresh) | ≈3.346 SOL peak; **4 SOL** float | §2.2 |
| Security audit (delegation/fee paths) | $7K–$20K (simple) → $20K–$60K (standard) | https://accretion.xyz/blog/solana-audit-cost , https://techfyte.com/solana-smart-contract-audit-cost-in-2026/ , https://weiblocks.io/smart-contract-audit-cost-guide-2026/ |
| Bug bounty seed (optional) | $10K–$50K | same |
| Treasury → Squads multisig + hardware signer | multisig $0; device ~$60–$150 (**UNVERIFIED**) | — |
| 3-service hosting (bot/listener/keeper) + Helius Developer | ~$15–$70/mo | §3, §4 |
| Custom `.com` domain | ~$10/yr | https://porkbun.com/products/domains |
| Uptime/alerting | $0 (Better Stack free) | https://betterstack.com/pricing |

> **Audit note:** v1 asks users to grant a delegate that can move their tokens, so a
> focused review of the delegation + fee paths is **recommended before mainnet**.
> The ranges above are published industry estimates, not firm quotes.

---

## 7. Deploy blockers & flags (be honest)

1. **v1 needs no program deploy** — so the historic program blockers do not block
   v1. They matter only when you adopt §2.
2. **Anchor provider wallet** — *fixed*: `Anchor.toml` now sets
   `wallet = "~/.config/solana/deployer.json"` (address `95DmM5…`), which is both
   funded and the on-chain upgrade authority. Anchor expands the leading `~`
   (`shellexpand::tilde`, anchor-cli 0.29 `config.rs:624`). Override with
   `--provider.wallet`. (Was `~/.config/solana/id.json` = `6Fvy…`, the wrong key.)
3. **Devnet program id** — the repo now declares the **live** id `2YHE64pk…`; the
   never-deployed `EbRLUsTw…` id is retired. `scripts/verify-devnet.sh` asserts this.
4. **`anchor build` is broken on this host** — `error: no such command: build-bpf`
   (anchor-cli 0.29 calls the removed `cargo build-bpf`). Use
   `scripts/build-sbf.sh` / `build-sbf-msvc.bat` (`cargo-build-sbf 2.2.0`).
5. **Treasury ATA is never created by the keeper** (`keeper/src/sweeper.ts:50,74`) —
   pre-create treasury ATAs per mint or the fee leg fails the whole tx.
6. **Mainnet program id not deployed** and no keypair exists — a mainnet deploy at
   `ECZ6Zs…` needs the keypair, or generate a fresh id.

---

## 8. Sources

| Source | What it gave |
|---|---|
| Terminal: `solana program show`, `solana account`, `solana rent`, `solana balance`, `solana --version`, `cargo-build-sbf --version` | program size/balance/authority, rent figures, balances, toolchain |
| RPC `getMinimumBalanceForRentExemption` + `SysvarRent…` decode (mainnet) | rent params 5080/1.0/burn 50; authoritative rent |
| `https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd` | SOL/USD = $120.89 @ 2026-10-04 07:45:30 UTC |
| `https://vercel.com/pricing` + `/docs/limits/fair-use-policy` | Hobby $0 non-commercial; Pro $20 |
| `https://developers.cloudflare.com/pages/functions/pricing/` | Pages free: static assets free & unlimited |
| `https://docs.github.com/en/pages/.../what-is-github-pages` | Pages free for public repos |
| `https://railway.com/pricing` | Hobby $5 (incl. $5 usage) |
| `https://www.helius.dev/pricing` + `/docs/webhooks` | Free tier incl. webhooks; 1 credit/event; Developer $49 |
| `https://www.quicknode.com/pricing` | Free trial only |
| `https://porkbun.com/products/domains` | domain prices |
| `https://betterstack.com/pricing` | free monitors |
| `https://accretion.xyz/...`, `https://techfyte.com/...`, `https://weiblocks.io/...` | audit ranges |
| anchor-cli 0.29 `cli/src/config.rs` (v0.29.0) | wallet `~` expansion via `shellexpand::tilde` |
