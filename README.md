# Skimmer Protocol

> Pay yourself first. Set a percent once, trade anywhere, auto-save every trade like a fee.

Telegram onboarding + status only — `@SkimmerProtocol_Bot`. No trading in Telegram. No custodial trading platform.

## How it works (normal words)

1. Connect your normal wallet in Telegram. No new seed.
2. Pick a percent (e.g. 5%) and where savings go.
3. Sign once. We remember your settings and get limited permission to move just that cut.
4. Trade like normal on any app.
5. Seconds later your cut lands in savings. We take 0.4% to keep the lights on.

You keep your keys. Revoke or pause anytime.

## Fees (how we get paid)

- Trades: `fee = output * 40 / 10000` (0.4%) to treasury `85TK12gDB5HEJog6g9Gs7sw9xomrsMfsAy8ZSgGtS3ka`, in the same sweep tx as the user skim. `keeper/src/sweeper.ts`
- Deposits to vault: 0.4% to treasury, rest to savings. `sdk/src/fees.ts:buildDepositTx`
- Withdraws from vault: 0.4% to treasury, rest to user. `sdk/src/fees.ts:buildWithdrawTx`
- Session rail (atomic): enforced on-chain in `session_consume` — caller cannot skip or redirect.

## Layout

```
skimmer-protocol/
├── programs/skim_protocol/src/lib.rs  # factory + fee enforcer
├── sdk/src/                           # setup + deposit/withdraw fee builders
├── keeper/src/sweeper.ts              # trade sweep: skim + 0.4% fee
├── listener/src/                      # trade watcher webhook
├── bots/telegram/src/                 # onboarding + status only
├── web/                               # marketing site (Vercel/Railway)
└── tests/fee-math.test.js
```

## Run

- Bot: `npm --prefix bots/telegram run dev` (needs `bots/telegram/.env`)
- Listener: `npm --prefix listener start` (needs `WEBHOOK_PORT`, Helius webhook pointed here)
- Keeper: `npm --prefix keeper start` (needs keeper SOL for gas)
- Web: `npx vercel --cwd web --prod` or Railway from `railway.json`

Secrets (`.env`, `keys/`) are gitignored and never pushed.
