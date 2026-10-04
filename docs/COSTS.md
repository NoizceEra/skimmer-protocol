# 💰 Skimmer Protocol — SOL cost breakdown

Math anchored to real devnet deploy receipts from this team's prior build
(`SAS-Vaults-Skim/MAINNET_COST_REPORT.md`): program rent formula
`(size + 45) × 6,960 lamports`, validated within 0.005 SOL of the on-chain balance
(210,368 B → 1.0696 SOL). SOL ≈ $120 at report time — recheck before funding.

## One-time: program deploy

| Item | SOL | Notes |
|---|---:|---|
| `skim_protocol` rent (~150–210 KB est.) | ~1.0–1.1 | Our program is smaller than the 210 KB reference; budget the full 1.1 |
| Deploy tx fees | ~0.0002 | |
| Retry / upgrade buffer | 0.5 | Failed deploys still cost rent — don't skip this |
| **Fund the deployer wallet with** | **~1.6** | **≈ $190 @ $120/SOL** |
| Expected actual spend | ~1.1 | ≈ $130 |

After `anchor build`, get the exact byte size of `target/deploy/skim_protocol.so`
and compute `(size + 45) × 6960 / 1e9` for the precise rent.

## Per user (paid by whoever signs setup — user or you)

| Item | SOL |
|---|---:|
| `UserSavingsConfig` PDA (~108 B) | ~0.0012 |
| `SmartWallet` PDA (~110 B) | ~0.0013 |
| `SessionKey` PDA (only if session rail used) | ~0.004 |
| Setup tx fees | ~0.00001 |
| **Typical total per user** | **~$0.30–0.50** |

Pennies. Subsidize it if you want zero-friction onboarding.

## Per trade (paid by keeper, covered by your 0.4%)

| Item | SOL |
|---|---:|
| Sweep tx (1 sig + priority fee) | ~0.00026 (~$0.03) |

One average trade's 0.4% fee dwarfs this. Profitable from trade one.

## Monthly recurring

| Item | Cost |
|---|---|
| Railway (bot + listener + keeper) | $5–20 |
| RPC (Helius/QuickNode; free tier to start) | $0–50+ by volume |
| Vercel marketing site | $0 (hobby) |

## Launch budget

| Scenario | Total |
|---|---|
| Devnet trial (play money) | **$0** |
| Mainnet launch | **~1.6 SOL + $5–20/mo infra** |
