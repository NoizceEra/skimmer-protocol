# Skimmer Protocol — Deployment & Operating Costs

**Document type:** cost analysis (read-only; no code, no deployment performed)
**Prepared:** 2026-10-04
**SOL/USD used for every USD figure:** **$120.89**, fetched live from
`https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd`
at **2026-10-04 07:45:30 UTC** (CoinGecko).

> Every SOL/USD number in this document is derived from that single price point. If SOL moves,
> every USD figure moves proportionally — recompute before quoting. Sources are cited inline;
> anything not verified from a command or a fetched URL is explicitly marked **UNVERIFIED**.

---

## 0. Verified ground truth (commands run, chain state)

| Fact | Value | How verified |
|---|---|---|
| Solana CLI | `solana-cli 2.2.0 (Agave)` | `solana --version` |
| Configured keypair | `C:\Users\vclin_jjufoql\.config\solana\deployer.json` | `solana config get` |
| Deployer address | `95DmM5xt695F18s7ouhRHf9wETgyUKxWYWa9z5gma6YG` | `solana address -k deployer.json` |
| Devnet program | `2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp` — **deployed, upgradeable** | `solana program show -u devnet` |
| Devnet program data length | **322,896 bytes** | same (on-chain) |
| Devnet program data balance | **1.64119052 SOL** | same (on-chain) |
| Devnet program data account | `AoygmTGhQfBHcEfBpwMw73f8F1rmJZ739PpKV6uBoWyg` | same |
| Devnet upgrade authority | `95DmM5xt695F18s7ouhRHf9wETgyUKxWYWa9z5gma6YG` (the deployer) | same |
| Mainnet program `ECZ6ZsA79WqYEonfJcmSzp51SPg9nSDiTqu4bAxrfvc9` | **NOT deployed** (`Error: Unable to find the account`) | `solana program show -u mainnet-beta` |
| Deployer devnet balance | **0.52713284 SOL** | `solana balance -u devnet` |
| Deployer mainnet balance | **0.00105664 SOL** | `solana balance -u mainnet-beta` |
| Repo | `D:\ai-studio\skim-protocol`, branch tip `18c1f88` | `git log --oneline` |
| Program source | one Anchor 0.29 program, 494 lines | `programs/skim_protocol/src/lib.rs` |

### Live rent parameters (from the on-chain Rent sysvar)

Fetched the mainnet `SysvarRent111…` account via RPC and decoded it:

```
data (base64) 2BMAAAAAAAAAAAAAAADwPzI=
lamports_per_byte_year = 5080
exemption_threshold    = 1.0
burn_percent           = 50
=> rent_exempt(size) = (128 + size) * 5080 lamports
```

Cross-checked against the RPC method that wallets/programs actually use
(`getMinimumBalanceForRentExemption` on `mainnet-beta`), and against `solana rent`:

| Data length | Rent-exempt (lamports) | SOL | Source |
|---|---|---|---|
| 36 (upgradeable program account) | 833,120 | 0.00083312 | `solana rent 36` + RPC |
| 165 (SPL token account / ATA) | 1,488,440 | **0.00148844** | `solana rent 165` + RPC |
| 322,896 (program data) | 1,640,961,920 | **1.64096192** | `solana rent 322896` + RPC |

> ⚠️ **Rent discrepancy you should know about.** The brief quoted the familiar
> **0.00203928 SOL** ATA rent (the long-standing value at `lamports_per_byte_year = 3480`,
> `exemption_threshold = 2.0`). **This network's live rent sysvar is 5080 / 1.0**, so a
> 165-byte token account rents for **0.00148844 SOL** here — confirmed three independent ways
> (CLI, mainnet RPC, decoded sysvar, and the real on-chain program-data balance). All ATA
> figures below use the **measured 0.00148844 SOL**, not the historical 0.00203928.

### Anchor provider-wallet mismatch (deploy blocker — see §H)

`Anchor.toml:24` sets `[provider] wallet = "~/.config/solana/id.json"`. That file **exists**
(219 bytes), but its address is:

| Key file | Address | Role |
|---|---|---|
| `~/.config/solana/id.json` (Anchor provider wallet) | `6FvyEfsRbRcvDDaUeu6xKDhiJCYzkZVx1n46QfnwMrsu` | what **Anchor would use** to deploy |
| `~/.config/solana/deployer.json` (solana CLI config keypair) | `95DmM5xt695F18s7ouhRHf9wETgyUKxWYWa9z5gma6YG` | the **funded** key + devnet **upgrade authority** |

The two differ, so `anchor deploy` would **not** use the funded/owning deployer key. See §H.

---

## A. One-time on-chain deploy cost (mainnet)

**Program size used:** the **measured on-chain 322,896 bytes** (devnet account `Aoygm…`).
The repo has **no `target/deploy/` and no `.so`** (verified: `find . -name "*.so"` → empty),
so a fresh `anchor build` output size could not be measured. **UNVERIFIED:** exact byte size a
clean `anchor build` would emit; a fresh build can differ from the deployed artifact by a few
percent. The deployed size is the best available proxy and is what the network has already
accepted.

### A.1 What gets charged

| Item | Size | Lamports | SOL | Refundable? |
|---|---|---|---|---|
| **Program data account** (holds the code) | 322,896 B | 1,640,961,920 | **1.64096192** | ❌ **locked** — only recoverable via `solana program close` (burns the program, returns rent to authority) |
| **Program (executable) account** | 36 B | 833,120 | **0.00083312** | ❌ **locked** — same, returned on `program close` |
| **Deploy buffer** (temporary, written then upgraded in) | 322,896 B | 1,640,961,920 | **1.64096192** | ✅ **refunded automatically** on successful deploy (buffer account closed) |
| **Transaction fees** — buffer writes (≈1,012 B/tx ⇒ 320 txs × 5,000 lamports) + ~5 setup/upgrade txs | — | ≈1,625,000 | **≈0.001625** | ❌ spent (plus any priority fees) |
| **TOTAL permanently locked** | | | **≈1.64179504** | |
| **Peak balance transiently required** | | | **≈3.284382** | |

Arithmetic:

```
permanent lock = 1.64096192 + 0.00083312            = 1.64179504 SOL   ($198.48)
peak           = 1.64179504 + 1.64096192 (buffer)   = 3.28275696 SOL
               + 0.001625  (fees)                   = 3.28438196 SOL  ($397.05)
```

> **Assumptions marked UNVERIFIED:** (1) the deploy buffer is sized to the program (322,896 B),
> so its rent equals the program-data rent — this is the standard behavior of the upgradeable
> loader used by `solana program deploy`/`anchor deploy`, but was not directly observed.
> (2) Transaction-fee estimate assumes ~1,012 bytes of program data per write transaction and
> the 5,000-lamport base fee; **priority fees are omitted** because they are set at deploy time
> and can add anything from ~0.001 to ~0.05 SOL.

### A.2 Recommended deployer float

| Scenario | SOL to hold | USD |
|---|---|---|
| Bare minimum (peak + tiny retry margin) | 3.30 | $398.97 |
| **Recommended — fund the deployer with** | **4.00** | **$483.56** |
| Comfortable (retries + one redeploy) | 6.00 | $725.34 |

**Recommendation: fund the mainnet deployer with ~4 SOL.** Of that, ~1.642 SOL stays locked
in the program (recoverable only by closing the program); ~1.641 SOL comes back when the
buffer closes; the rest covers fees. Currently the deployer holds **0.00105664 SOL on mainnet**
— i.e. it is **~3,782× short** of even the bare minimum, and ~4,000× short of the recommended float.

### A.3 Devnet equivalent

**Devnet SOL is free** from the faucet (`solana airdrop` / `https://faucet.solana.com`), so the
devnet deployment has **no dollar cost**. The devnet program is already deployed and has
**1.64119052 SOL of free devnet SOL locked** in its program-data account
(`solana program show -u devnet`). To redeploy or create fresh devnet programs you just request
more faucet SOL. Devnet one-time cost = **$0**; devnet monthly cost = **$0** (faucet SOL has no USD value).

---

## B. Recurring on-chain / operational gas

The keeper (`keeper/src/sweeper.ts`) sends one transaction per trade: it pays the fee, and it
creates the **destination ATA** when missing. The **skimmed value itself is the output token**,
not SOL — so the keeper's SOL is purely fee/rent gas.

| Cost component | Lamports | SOL | Source |
|---|---|---|---|
| Base transaction fee (1 signature) | 5,000 | 0.000005 | Solana base fee |
| Priority fee (set at send time, network-dependent) | variable | typically 0.000005 – 0.0001 | **UNVERIFIED / variable** |
| New destination ATA rent (first sweep of a new mint) | 1,488,440 | **0.00148844** | `solana rent 165` |
| New treasury ATA rent (per mint; must be pre-created — `sweeper.ts:50` transfers to `treasuryAta` but never creates it) | 1,488,440 | 0.00148844 | `sweeper.ts:50,74-80` |

### B.1 How many sweeps a SOL buys

Derived from the real base fee (5,000 lamports) and the measured ATA rent:

| Sweep type | Cost / sweep (SOL) | Sweeps per 1 SOL |
|---|---|---|
| Steady-state, base fee only | 0.000005 | **≈200,000** |
| Steady-state + modest priority (~15k lamports) | 0.000015 | **≈66,666** |
| Steady-state + high priority (~105k lamports) | 0.000105 | **≈9,523** |
| First sweep of a new mint (base + destination ATA) | 0.00149344 | **≈669** |

Practical budget guidance:

| Keeper SOL float | Buys (base-fee steady state) | Buys (with ATA creation, ~1 new mint per 20 trades) |
|---|---|---|
| 0.1 SOL | ~20,000 sweeps | ~7,700 |
| 0.5 SOL | ~100,000 sweeps | ~38,600 |
| 1.0 SOL | ~200,000 sweeps | ~77,200 |

**The keeper must hold SOL, or every sweep fails.** `keeper/src/sweeper.ts:81` sets
`tx.feePayer = params.keeper.publicKey`; with an empty keeper wallet `sendRawTransaction`
(`sweeper.ts:85`) reverts — the skim silently stops. **Monitor the keeper SOL balance and alert
on low balance** (see §G).

---

## C. Infrastructure hosting — monthly

All prices fetched 2026-10-04 from the vendors' own pages. USD, excl. tax.

### C.1 Vercel (static marketing site)

| Plan | Price | Source (fetched 2026-10-04) |
|---|---|---|
| Hobby | **$0/mo** | https://vercel.com/pricing |
| Pro | **$20/mo** (per developer seat) | https://vercel.com/pricing |

The static site (`web/index.html`) is squarely inside Vercel's fair-use list ("Static sites",
"marketing sites" — https://vercel.com/docs/limits/fair-use-policy). **However**, Hobby is
**non-commercial only**: *"Hobby teams are restricted to non-commercial personal use only. All
commercial usage of the platform requires either a Pro or Enterprise plan"* (same page). A
protocol that takes a 0.4% fee and promotes a paid service is commercial, so a **real launch
must use Pro ($20/mo)**. Hobby ($0) is fine only for a devnet demo / pre-revenue.

### C.2 Railway (bot, listener, keeper — 3 always-on Node services)

Railway bills by metered usage (https://railway.com/pricing, fetched 2026-10-04):

| Resource | Metered rate | Per-month equivalent |
|---|---|---|
| Memory | $0.00000386 / GB / sec | **$10.005 / GB-month** |
| CPU (active) | $0.00000772 / vCPU / sec | **$20.01 / vCPU-month** |
| Volume storage | $0.00000006 / GB / sec | $0.156 / GB-month |
| Egress | $0.05 / GB | — |
| **Hobby plan** | **$5/mo** subscription **includes $5 usage** | overage billed |
| **Pro plan** | **$20/mo** subscription **includes $20 usage** | overage billed |

Estimate for the three services (all `"type": "commonjs"` Node processes, tiny footprint):

| Service profile | Memory | Active CPU | $/service/mo | ×3 services |
|---|---|---|---|---|
| Tiny (0.25 GB, 0.02 vCPU) | $2.50 | $0.40 | ~$2.90 | **~$8.70/mo** |
| Comfortable (0.5 GB, 0.05 vCPU) | $5.00 | $1.00 | ~$6.00 | **~$18.01/mo** |
| Busy (1 GB, 0.1 vCPU) | $10.00 | $2.00 | ~$12.00 | **~$36.00/mo** |

> **UNVERIFIED:** actual CPU/memory each service will hold; these are model estimates from
> Railway's published per-second rates, not observed bills. On **Hobby** the first $5 is
> included, so a ~$8.70 usage month bills **~$8.70 total** (subscription $5 + $3.70 overage),
> and an ~$18 month bills **~$18**. Plan on **$10–20/mo for the three services** at launch.

### C.3 Solana RPC + webhook provider (the listener)

`listener/src/server.ts:10` ingests a Helius-style webhook (`POST /webhook/tx`), so the listener
needs a provider that offers **transaction webhooks**.

**Helius** (https://www.helius.dev/pricing and https://www.helius.dev/docs/webhooks, fetched 2026-10-04):

| Plan | $/mo | Credits | RPS | Webhooks? |
|---|---|---|---|---|
| Free | **$0** | 1M | 10 | ✅ yes (24-h failure window) |
| Developer | **$49** | 10M | 50 | ✅ yes (7-day window + email on auto-disable) |
| Business | $499 | 100M | 200 | ✅ yes |
| Professional | $999 | 200M | 500 | ✅ yes |

Webhook billing: **1 credit per event delivered**; **100 credits per API create/edit/delete**
(`helius.dev/docs/webhooks`). So a 1M-credit Free tier ≈ up to ~1M delivered events/mo — enough
for a launch; **Developer $49/mo** is the realistic always-on public tier.

**QuickNode** (https://www.quicknode.com/pricing, fetched 2026-10-04) — webhooks included from
the trial tier up:

| Plan | $/mo (monthly / annual) | Credits | Active webhooks |
|---|---|---|---|
| Free trial | **$0** (1-month trial) | 10M | 1 |
| Build | **$49 / $34** | 80M | 10 |
| Accelerate | $249 / $212 | 450M | 20 |
| Scale | $499 / $424 | 950M | 50 |

> QuickNode's $0 tier is a **1-month trial**, not a permanent free tier, so continuous webhooks
> require at least **Build $49/mo**. Helius's Free tier *is* permanent and webhook-capable —
> the cheaper launch choice.

### C.4 Domain name

Porkbun pricing (https://porkbun.com/products/domains, fetched 2026-10-04; "All prices include
ICANN and any other fees"):

| TLD | First year | Renewal |
|---|---|---|
| `.com` | **$10.08** | (~$10–11 typical) |
| `.xyz` | $2.04 | $14.21 |
| `.io` | $28.12 | $51.80 |

A `.com` is **~$10.08/year ≈ $0.84/month** (amortized).

### C.5 Uptime / alerting (optional)

| Tool | Free tier | Paid | Source |
|---|---|---|---|
| Better Stack | **$0** — 10 monitors & heartbeats, 1 status page, Slack/email alerts | $29–34/responder/mo; extra status page $12–15/mo | https://betterstack.com/pricing |
| UptimeRobot | **$0** — 50 monitors, 5-min interval | Solo $12/mo (60s checks); Team $39/mo (30s, webhooks) | https://uptimerobot.com/pricing/ |

**$0 is enough at launch** (Better Stack free gives a hosted status page + keeper-balance alerts
via heartbeat monitors).

### C.6 Monthly totals

| Line item | Minimal launch (mainnet, commercial) | Production-grade |
|---|---|---|
| Vercel | $20 (Pro, required for commercial) | $20 |
| Railway (3 services) | ~$10–20 | ~$30–60 (Pro + more usage/regions) |
| Helius | $49 (Developer) | $499 (Business) |
| Domain (.com amortized) | $0.84 | $0.84 |
| Uptime/alerting | $0 (Better Stack free) | $29 (Better Stack paid) |
| **Monthly total** | **≈ $80–90** | **≈ $579–609** |

Devnet-only demo monthly (no revenue, Hobby allowed): **≈ $5–11/mo** (Railway $5–10 + free
Helius + no domain) or **$0** if run entirely locally.

---

## D. Telegram bot

**Creating a bot is free** via `@BotFather` — there is no charge for a bot, an account, or
messaging users. Confirmed on the official Bot FAQ (https://core.telegram.org/bots/faq).

Limits that matter for a public multi-user bot:

| Limit | Value | Source |
|---|---|---|
| Messages to a single chat | **~1 / second** (short bursts tolerated) | Bot FAQ |
| Messages to a single group | **20 / minute** | Bot FAQ |
| Bulk broadcast (all chats) | **~30 / second** | Bot FAQ |
| Exceeding a limit | HTTP **429** with `retry_after` seconds — must back off exactly | Bot FAQ / API errors |
| Paid Broadcasts (raise limit) | up to **1000 msg/s**, **0.1 Telegram Stars per message** over the free 30/s | https://telegram.org/tos/bot-developers |

Paid Broadcasts requires **≥100,000 Stars balance and ≥100,000 monthly active users** — so at
launch a public bot pays **$0** for messaging and only needs to respect the ~30/s global and
1/s-per-chat limits (the onboarding/status bot in `bots/telegram/src/bot.ts` is low-volume, so
it will never approach these). **Nothing about the Telegram side needs to be paid for at any
plausible launch scale.** (Telegram Stars have no fixed USD price — **UNVERIFIED** USD cost.)

---

## E. Security / assurance (optional line items, real market ranges)

**This program moves user funds via SPL delegation** — the keeper is granted a delegate
allowance (`sdk/src/setup.ts`, `keeper/src/sweeper.ts:52-55`) and pulls tokens out of the user's
ATA. That makes it custody-adjacent: a program bug can move user tokens. An audit is **strongly
recommended before mainnet**, and for a protocol that asks users to grant a delegate, I'd treat
it as **required**, not optional.

Published 2026 market ranges (these are **published industry guides/estimates, not firm
quotes** — Solana specialist firms quote per scope; mark any single firm number UNVERIFIED):

| Scope | Range | Timeline | Source |
|---|---|---|---|
| Simple program (<~2,000 nSLOC Anchor) | **$7,000 – $20,000** | 1 week | https://accretion.xyz/blog/solana-audit-cost |
| Standard DeFi protocol (2,000–6,000 nSLOC) | **$20,000 – $60,000** | 1–3 weeks | same |
| Solana vs EVM premium | **+20–40%** | — | https://techfyte.com/solana-smart-contract-audit-cost-in-2026/ |
| Solana specialists (OtterSec, Neodyme) | **$20,000 – $150,000** (quote-based) | 4–10 wk lead | https://weiblocks.io/smart-contract-audit-cost-guide-2026/ |
| Bug bounty | **$50,000 – $300,000** (researcher bounties + platform fee; e.g. Immunefi) | ongoing | same |

**Skim is ~494 lines / single program** → the **"simple program" tier ($7K–$20K)** is the
closest fit, but the delegation/fee logic and the on-chain fee enforcer push it toward the
**low end of "standard" ($20K–$60K)** with a specialist. **Recommended:** budget **~$15K–$30K**
for a focused review of the delegation + fee-enforcement paths before mainnet, plus an optional
$10K–$50K bounty seed. *Nothing in this section came from a firm's own price list — Solana
specialists do not publish fixed prices; treat these as ranges, not quotes.*

---

## F. Summary tables

**Conversion: 1 SOL = $120.89 @ 2026-10-04 07:45:30 UTC (CoinGecko).**

### F.1 Absolute minimum to go live

| | Devnet-only demo | Real mainnet launch (minimal) |
|---|---|---|
| **One-time, on-chain** | 0 SOL / **$0** (free faucet SOL; already deployed, 1.641 SOL of free devnet SOL locked) | 1.64179504 SOL permanently locked = **$198.48**; ≈0.001625 SOL fees = **$0.20** → **≈$198.68** |
| **Deployer float (not spent, must be held)** | 0 | **4 SOL = $483.56** (peak draw ~3.284 SOL = $397.05; ~1.641 SOL returns after deploy) |
| **Keeper gas float (held, drawn down over time)** | free devnet SOL | **0.5–1 SOL = $60.45–$120.89** |
| **Monthly infra** | Railway ~$5–10; Vercel Hobby $0; Helius Free $0 → **≈ $5–10/mo** | Vercel Pro $20 + Railway ~$10–20 + Helius Dev $49 + domain $0.84 + uptime $0 → **≈ $80–90/mo** |
| **Monthly, USD total** | **≈ $5–10** | **≈ $80–90** |

### F.2 Production-grade

| | One-time | Monthly |
|---|---|---|
| Mainnet deploy (locked) | 1.64179504 SOL = $198.48 | — |
| Deploy + redeploy float | 6 SOL = $725.34 | — |
| Audit (simple→standard tier) | $15,000 – $30,000 | — |
| Bug bounty seed (optional) | $10,000 – $50,000 | — |
| Vercel Pro | — | $20 |
| Railway Pro (3 services + usage) | — | $30 – $60 |
| Helius Business | — | $499 |
| Domain (.com) | — | $0.84 |
| Better Stack paid | — | $29 |
| **Subtotal** | **≈ $25,924 – $80,924** (mid ~$40K–$50K) | **≈ $579 – $609/mo** |

Arithmetic shown inline above. All USD = SOL × $120.89.

### F.3 Show-your-work: the deploy number

```
programdata rent  solana rent 322896          = 1.64096192 SOL
program acct rent solana rent 36              = 0.00083312 SOL
                                        lock  = 1.64179504 SOL
buffer rent (refunded)  solana rent 322896    = 1.64096192 SOL
deploy fees ≈ 320 write tx × 5,000 lamports   = 0.00160000 SOL
             + ~5 setup/upgrade tx × 5,000     = 0.00002500 SOL
                                      fees    = 0.00162500 SOL
                                      PEAK    = 3.28438196 SOL
1.64179504 × 120.89 = $198.48 ;  3.28438196 × 120.89 = $397.05 ;  4 × 120.89 = $483.56
```

---

## G. What else is needed to be operational (non-code, costed)

| # | Item | Cost | Notes |
|---|---|---|---|
| 1 | **RPC + webhook account** | Helius Free $0 → Developer $49/mo | The listener is useless without a webhook feed (`listener/src/server.ts:10`). |
| 2 | **Railway project + env vars** | $10–20/mo | 3 services (bot, listener, keeper). Required env: `TELEGRAM_BOT_TOKEN`, `RPC_URL`, `TREASURY`, keeper keypair, ports (`KEEPER_PORT`, `WEBHOOK_PORT`). |
| 3 | **Treasury key custody** | ~$0 (or multisig) | `sdk/src/fees.ts:5` defaults treasury to `85TK12gDB5HEJog6g9Gs7sw9xomrsMfsAy8ZSgGtS3ka` = `keys/treasury.json`. For real fee revenue, move to a Squads multisig + hardware signer. Multisig itself is free; hardware signer ~$60–$150 one-time (**UNVERIFIED** device price). |
| 4 | **Keeper SOL monitoring** | $0 (Better Stack heartbeat) | Alert when keeper SOL < a threshold (every sweep fails otherwise — §B). |
| 5 | **Treasury/destination ATA setup** | 0.00148844 SOL per (mint × treasury) and per (mint × user destination) | Treasury ATAs must be **pre-created** (sweeper never creates them). |
| 6 | **ToS / Privacy page** | $0 (write it) | Required for a public bot that connects user wallets. |
| 7 | **Support channel** | $0 (Telegram group/Discord) | — |
| 8 | **Domain + DNS** | ~$10/yr | §C.4. |

---

## H. Deploy blockers & flags (BE HONEST — do not launch without these)

1. **Mainnet deployer is effectively unfunded.** `95DmM…` holds **0.00105664 SOL** on mainnet;
   the deploy needs a **~3.284 SOL peak** (recommended float **4 SOL**). **Blocked until funded.**
2. **Anchor provider-wallet mismatch.** `Anchor.toml:24` points at `~/.config/solana/id.json`
   (address `6Fvy…`), **not** the funded deployer `95DmM…`. `anchor deploy` would sign with the
   wrong key. The file **exists** (so this is a *wrong-key* blocker, not a missing-file one) —
   fix by setting `[provider] wallet` to the deployer key (or export `ANCHOR_WALLET`).
3. **Mainnet program id not deployed.** `ECZ6ZsA79WqYEonfJcmSzp51SPg9nSDiTqu4bAxrfvc9` does not
   exist on mainnet (confirmed by RPC). The repo also has **no program keypair** for it
   (`keys/` contains only `treasury.json`), so Anchor would need the keypair file to deploy at
   that exact id, or it will generate a fresh address.
4. **`Anchor.toml` still points the default cluster at devnet** (`[provider] cluster = "devnet"`).
   A mainnet deploy must pass `--provider.cluster mainnet` explicitly.
5. **Treasury ATA never created by the keeper** (`sweeper.ts:50,74`) — pre-create treasury ATAs
   per mint or fee transfers fail.

---

## I. Sources (all fetched 2026-10-04)

| Source | What it gave |
|---|---|
| Terminal: `solana program show`, `solana rent`, `solana balance`, `solana address` | program size/balance/authority, all rent figures, deployer balances, key addresses |
| RPC `getMinimumBalanceForRentExemption` on `api.mainnet-beta.solana.com` | authoritative mainnet rent (36/165/322896 B) |
| RPC `getAccountInfo` of `SysvarRent111…` (mainnet) | rent params: 5080 lamports/byte-yr, threshold 1.0, burn 50% |
| `https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd` | SOL/USD = $120.89 @ 2026-10-04 07:45:30 UTC |
| `https://vercel.com/pricing` + `/docs/limits/fair-use-policy` | Hobby $0 (non-commercial), Pro $20 |
| `https://railway.com/pricing` | $10.005/GB-mo mem, $20.01/vCPU-mo CPU, Hobby $5 / Pro $20 |
| `https://www.helius.dev/pricing` + `/docs/webhooks` | Free $0 … Developer $49 … Business $499; 1 credit/event |
| `https://www.quicknode.com/pricing` | $0 trial … Build $49/$34; webhook counts |
| `https://porkbun.com/products/domains` | .com $10.08, .xyz $2.04, .io $28.12/yr |
| `https://betterstack.com/pricing` | free 10 monitors / 1 status page; $29–34 paid |
| `https://uptimerobot.com/pricing/` | free 50 monitors; Solo $12, Team $39 |
| `https://core.telegram.org/bots/faq` + `https://telegram.org/tos/bot-developers` | free bots; 30/s, 1/s, 20/min; paid broadcast 0.1 Stars |
| `https://accretion.xyz/blog/solana-audit-cost`, `https://techfyte.com/solana-smart-contract-audit-cost-in-2026/`, `https://weiblocks.io/smart-contract-audit-cost-guide-2026/`, `https://www.smartcontractaudit.com/guides/solana-smart-contract-audit-firms-2026`, `https://www.zealynx.io/research/smart-contracts/solana-2026-security` | audit ranges |
