# 💰 Skimmer Protocol — cost breakdown (minimal v1)

**v1 does not deploy a custom on-chain program.** The rail is plain SPL Token
(`Approve` + `TransferChecked`), so one-time on-chain cost is **$0** and monthly
infra targets **$0–5**. See `docs/MINIMAL_DEPLOY.md` for the runbook.

SOL used below: **$120.89**, and the rent figure is the **live** devnet/mainnet
rent: `(size + 128) × 5080` lamports — i.e. `solana rent <size>`. (The old
`(size + 45) × 6960` formula this file used before is the obsolete
6960-lamports/byte-year constant; it overstates rent ~27%.)

## One-time: v1

| Item | SOL | Notes |
|---|---:|---|
| Program deploy | **0** | No program needed for the used rail. |
| Deploy tx fees | **0** | Nothing to deploy. |
| **Total** | **0** | **$0** |

If you *choose* to keep the Anchor program deployed (it is only needed for the
deferred session/PDA rail), the 328,912-byte build rents for **1.67152320 SOL**
locked — see `docs/DEPLOYMENT_COSTS.md`. The program already live on devnet is
**free faucet SOL**, so keeping it costs nothing in real money.

## Monthly: v1

| Item | Cost | Notes |
|---|---:|---|
| Host (one process) | $0–5 | Own PC = $0; Railway Hobby = $5/mo (includes $5 usage). |
| RPC | $0 | Public devnet RPC; Helius Free if a webhook is used. |
| Static site | $0 | Cloudflare Pages / GitHub Pages (Vercel Hobby is non-commercial-only). |
| Domain | $0 | `*.pages.dev` / `*.github.io` subdomain. |
| **Total** | **$0–5** | |

## Per user (v1)

| Item | SOL |
|---|---:|
| SPL `Approve` setup tx (user signs once) | ~0.000005 (base fee) |
| Per-mint allowance top-up (later re-approve) | ~0.000005 |
| **Typical total per user** | **pennies** |

## Per sweep (paid by the keeper)

| Item | SOL |
|---|---:|
| Sweep tx (2× `TransferChecked`, 1 signature, base fee) | 0.000005 |
| First sweep of a **new mint** (+ destination ATA rent) | 0.00148844 |
| Priority fee (optional, network-dependent) | ~0.000005–0.0001 |

**Keeper gas:** devnet = $0 (faucet). Mainnet = a **held float**, not a subscription;
**0.2–0.5 SOL** is plenty for a small beta (1 SOL ≈ 200,000 base-fee sweeps).

## Guide

- Minimal launch: `docs/MINIMAL_DEPLOY.md` ($0–5/mo).
- Full cost model + sources + deferred/full stack: `docs/DEPLOYMENT_COSTS.md`.
