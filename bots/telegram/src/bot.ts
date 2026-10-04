'use strict';
/**
 * 🛰️ Skimmer Telegram bot — onboarding + status ONLY.
 * No swaps. No buy/sell. Trading happens on other apps.
 * The bot never holds keys and never signs for the user.
 * Commands: /start /help /connect /set_rate /set_destination /add_mint
 *           /spawn_wallet /status /accrued /pause /resume
 */
import { Bot, InlineKeyboard } from 'grammy';
import { Connection, PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';
dotenv.config();

import { getState, saveState, parseBps, bpsToPct, addMint, setPaused } from './store';
import { formatStatus, verifyDelegations, walletPda } from './status';
import { buildSetupPlans, formatSetupMessage } from './onboarding';

const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN in bots/telegram/.env');
  process.exit(1);
}
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const KEEPER_DELEGATE = process.env.KEEPER_DELEGATE ?? '';
const TREASURY = process.env.TREASURY ?? '';
const PROGRAM_ID = process.env.PROGRAM_ID ?? '2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp';
const MAX_ALLOWANCE_UI = process.env.MAX_ALLOWANCE_UI ?? '100';
const connection = new Connection(RPC, 'confirmed');
const bot = new Bot(token);

/** 🏠 Main menu — every action one tap away. */
const mainKb = () =>
  new InlineKeyboard()
    .text('🔗 Connect', 'nav:connect')
    .text('💰 Rate', 'nav:rate')
    .row()
    .text('🏦 Savings', 'nav:dest')
    .text('🪙 Mint', 'nav:mint')
    .row()
    .text('🚀 Wallet', 'nav:wallet')
    .text('📊 Status', 'nav:status')
    .row()
    .text('💎 Accrued', 'nav:accrued')
    .text('❓ Help', 'nav:help');

const WELCOME = [
  '✂️ *Skimmer Protocol* — pay yourself first! 💸',
  '',
  '🤖 I auto-save a cut of every trade you make — anywhere. You keep trading, I keep skimming. 🏖️',
  '',
  '👣 *4 tiny steps:*',
  '1️⃣ 🔗 /connect — link your wallet',
  '2️⃣ 💰 /set_rate — pick your cut (e.g. 5)',
  '3️⃣ 🏦 /set_destination — where savings land',
  '4️⃣ 🪙 /add_mint — the token you trade',
  '',
  '🚀 Then /spawn_wallet hands you a ONE-TIME bounded approval to sign. ✅ Trade after!',
  '🔑 I never hold your keys. I never trade. I just save. 🛡️',
].join('\n');

const HELP = [
  '❓ *What I understand:*',
  '',
  '🔗 /connect — link your trading wallet',
  '💰 /set_rate — your savings cut (0–10%)',
  '🏦 /set_destination — your savings wallet',
  '🪙 /add_mint — register a token you trade',
  '🚀 /spawn_wallet — get your one-time approval tx',
  '📊 /status — your real configured state',
  '💎 /accrued — savings balance',
  '⏸️ /pause — pause saving (keeper skips you)',
  '▶️ /resume — resume saving',
  '',
  '🚫 No buying or selling here — trade on any app, saving is automatic! ✨',
].join('\n');

bot.command('start', async (ctx) => {
  await ctx.reply(WELCOME, { reply_markup: mainKb(), parse_mode: 'Markdown' });
});

bot.command('help', async (ctx) => {
  await ctx.reply(HELP, { parse_mode: 'Markdown' });
});

bot.command('connect', async (ctx) => {
  const arg = ctx.match.toString().trim();
  try {
    const pk = new PublicKey(arg);
    if (pk.equals(PublicKey.default)) throw new Error('zero address');
    const s = getState(ctx.chat.id);
    s.authority = pk.toBase58();
    if (!s.delegate && KEEPER_DELEGATE) s.delegate = KEEPER_DELEGATE;
    saveState(ctx.chat.id);
    await ctx.reply(
      `🔗 *Connected!* ✅\n\`${pk.toBase58()}\`\n\nNext: 💰 /set_rate 5`,
      { parse_mode: 'Markdown' },
    );
  } catch {
    await ctx.reply(
      '🔗 *Connect your wallet:*\n`/connect YOUR_WALLET_ADDRESS`\n\n📌 Paste your Solana address (Phantom, Solflare…).',
      { parse_mode: 'Markdown' },
    );
  }
});

bot.command('set_rate', async (ctx) => {
  try {
    const bps = parseBps(ctx.match.toString());
    getState(ctx.chat.id).savingsBps = bps;
    saveState(ctx.chat.id);
    await ctx.reply(`💰 *Rate set: ${bpsToPct(bps)}%!* 🎯\nEvery trade saves you ${bpsToPct(bps)}%. 🪙\n\nNext: 🏦 /set_destination YOUR_SAVINGS_WALLET`, { parse_mode: 'Markdown' });
  } catch (e: any) {
    await ctx.reply('💰 *Pick your cut:*\n`/set_rate 5` = save 5% of every trade 🪙\n\n📏 Min 0%, max 10%. Try 2, 5, or 10!', { parse_mode: 'Markdown' });
  }
});

bot.command('set_destination', async (ctx) => {
  const arg = ctx.match.toString().trim();
  try {
    const pk = new PublicKey(arg);
    getState(ctx.chat.id).destination = pk.toBase58();
    saveState(ctx.chat.id);
    const s = getState(ctx.chat.id);
    await ctx.reply(
      `🏦 *Savings pot set!* ✅\n\`${pk.toBase58()}\`\n💰 Rate: ${s.savingsBps ?? '?'} bps\n\nNext: 🪙 /add_mint MINT (the token you trade) → 🚀 /spawn_wallet`,
      { parse_mode: 'Markdown' },
    );
  } catch {
    await ctx.reply('🏦 *Where should savings land?*\n`/set_destination SAVINGS_WALLET`\n\n💡 Tip: use a separate wallet so savings pile up untouched! 🐷', { parse_mode: 'Markdown' });
  }
});

bot.command('add_mint', async (ctx) => {
  const arg = ctx.match.toString().trim();
  try {
    const pk = new PublicKey(arg);
    if (pk.equals(PublicKey.default)) throw new Error('zero address');
    const added = addMint(ctx.chat.id, pk.toBase58());
    const s = getState(ctx.chat.id);
    await ctx.reply(
      [
        added ? `🪙 *Mint registered!* ✅` : `🪙 *Mint already registered.*`,
        `\`${pk.toBase58()}\``,
        ``,
        `Total mints: ${s.approvedMints?.length ?? 0}`,
        ``,
        `Next: 🚀 /spawn_wallet to get your one-time approval tx.`,
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );
  } catch {
    await ctx.reply(
      '🪙 *Register a token you trade:*\n`/add_mint MINT_ADDRESS`\n\n💡 SOL (wrapped) = So111…1112 · USDC = EPjFWdd5…Dt1v',
      { parse_mode: 'Markdown' },
    );
  }
});

bot.command('spawn_wallet', async (ctx) => {
  const s = getState(ctx.chat.id);
  if (!s.authority) {
    await ctx.reply('🔗 First link a wallet: /connect YOUR_WALLET');
    return;
  }
  if (s.savingsBps == null) {
    await ctx.reply('💰 First pick a rate: /set_rate 5');
    return;
  }
  if (!s.destination) {
    await ctx.reply('🏦 First set savings: /set_destination YOUR_SAVINGS_WALLET');
    return;
  }
  s.wallet = walletPda(new PublicKey(s.authority))[0].toBase58();

  // The keeper delegate whose bounded approval the user grants.
  const delegate = s.delegate || KEEPER_DELEGATE;
  if (!delegate) {
    saveState(ctx.chat.id);
    await ctx.reply(
      '⚙️ Protocol not configured — the operator must set KEEPER_DELEGATE in the bot environment. Nothing to sign yet.',
    );
    return;
  }
  s.delegate = delegate;

  const mints = (s.approvedMints ?? []).slice();
  if (mints.length === 0) {
    saveState(ctx.chat.id);
    await ctx.reply(
      [
        `🚀 *Your skim wallet PDA:* \`${s.wallet}\``,
        ``,
        `🪙 I still need the token(s) you trade so I can build a BOUNDED approval.`,
        `Register each mint, then re-run /spawn_wallet:`,
        `\`/add_mint MINT_ADDRESS\``,
        ``,
        `💡 SOL (wrapped) = \`So11111111111111111111111111111111111111112\``,
        `💡 USDC = \`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\``,
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );
    return;
  }

  saveState(ctx.chat.id);
  await ctx.reply(`🚀 Building your one-time, bounded approval tx for ${mints.length} mint(s)… 🔧`);
  try {
    const plans = await buildSetupPlans(connection, {
      user: s.authority,
      keeperDelegate: delegate,
      savingsBps: s.savingsBps,
      mints,
      topUps: 20,
      maxUiAmount: MAX_ALLOWANCE_UI,
    });
    for (const plan of plans) {
      // Plain text (no Markdown) so the base64 blob can never break an entity.
      await ctx.reply(
        formatSetupMessage(plan, {
          user: s.authority,
          savingsBps: s.savingsBps as number,
          delegate,
        }),
      );
    }
    await ctx.reply(
      `✅ Done. That is everything — approve the tx in YOUR wallet and go trade anywhere! 🔑 I never see your keys.`,
    );
  } catch (e: any) {
    await ctx.reply(`😅 Couldn't build the approval tx: ${e.message}`);
  }
});

bot.command('status', async (ctx) => {
  const s = getState(ctx.chat.id);
  const text = formatStatus(s);
  if (!s.authority) {
    await ctx.reply(text, { reply_markup: mainKb(), parse_mode: 'Markdown' });
    return;
  }
  // Read the REAL configured state from the shared store; enrich best-effort with chain.
  const chain = await verifyDelegations(connection, s);
  await ctx.reply(chain ? `${text}\n\n${chain}` : text, { parse_mode: 'Markdown' });
});

bot.command('accrued', async (ctx) => {
  const s = getState(ctx.chat.id);
  if (!s.destination) {
    await ctx.reply('🏦 Set savings first: /set_destination YOUR_SAVINGS_WALLET 🐷');
    return;
  }
  try {
    const bal = await connection.getBalance(new PublicKey(s.destination));
    await ctx.reply(
      `💎 *Your savings pot* 🐷\n\`${s.destination}\`\n\n💰 SOL: *${bal / 1e9}* ✨\n🪙 Tokens: skim lands as the traded token — peek in an explorer! 🔍`,
      { parse_mode: 'Markdown' },
    );
  } catch (e: any) {
    await ctx.reply('💎 Balance check hiccup 😅: ' + e.message);
  }
});

bot.command('pause', async (ctx) => {
  const s = getState(ctx.chat.id);
  if (!s.authority) {
    await ctx.reply('🔗 Link a wallet first: /connect YOUR_WALLET 🙂');
    return;
  }
  setPaused(ctx.chat.id, true);
  await ctx.reply(
    [
      `⏸️ *Saving paused.*`,
      ``,
      `I recorded ⏸️ paused = true in your shared config, which the keeper reads — so it will skip your sweeps.`,
      ``,
      `⚠️ Honest note: pausing the keeper is not the same as REVOKING its on-chain permission. To revoke the delegate entirely you must additionally sign an SPL Revoke (or a 0-amount approve) from your wallet — I never hold keys, so I can't sign it for you. Run 🚀 /spawn_wallet for the tx blob, or approve 0 on that token account.`,
    ].join('\n'),
    { parse_mode: 'Markdown' },
  );
});

bot.command('resume', async (ctx) => {
  const s = getState(ctx.chat.id);
  if (!s.authority) {
    await ctx.reply('🔗 Link a wallet first: /connect YOUR_WALLET 🙂');
    return;
  }
  setPaused(ctx.chat.id, false);
  await ctx.reply(
    `▶️ *Saving resumed!* 🚀\n\n⏸️ paused = false is recorded. The keeper will sweep your cut on your next trade. 💰`,
    { parse_mode: 'Markdown' },
  );
});

// 🚫 Explicit: no trading surface.
bot.hears(/^\/(buy|sell|swap|trade)\b/i, async (ctx) => {
  await ctx.reply('🚫 No trading here — by design! 😎\n\nTrade on any app 📱, saving happens on its own ✨. Check 📊 /status to peek! 👀');
});

bot.on('callback_query:data', async (ctx) => {
  const d = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();
  switch (d) {
    case 'nav:connect':
      await ctx.reply('🔗 Tap then type:\n`/connect YOUR_WALLET_ADDRESS` 📋', { parse_mode: 'Markdown' });
      break;
    case 'nav:rate':
      await ctx.reply('💰 Tap then type:\n`/set_rate 5` = save 5% 🪙 (max 10%)', { parse_mode: 'Markdown' });
      break;
    case 'nav:dest':
      await ctx.reply('🏦 Tap then type:\n`/set_destination SAVINGS_WALLET` 🐷', { parse_mode: 'Markdown' });
      break;
    case 'nav:mint':
      await ctx.reply('🪙 Tap then type:\n`/add_mint MINT_ADDRESS`\n\n💡 SOL (wrapped) = `So11111111111111111111111111111111111111112`', { parse_mode: 'Markdown' });
      break;
    case 'nav:wallet':
      await ctx.reply('🚀 Run /spawn_wallet to get your one-time approval tx! 🎉');
      break;
    case 'nav:status':
      await ctx.reply('📊 Run /status for your live setup! ⚡');
      break;
    case 'nav:accrued':
      await ctx.reply('💎 Run /accrued to see savings! 🐷✨');
      break;
    default:
      await ctx.reply(HELP, { parse_mode: 'Markdown' });
  }
});

bot.catch((err) => console.error('bot error', err));

if (require.main === module) {
  bot.start();
  console.log('skim-telegram online (onboarding+status only, no trading)');
}
export default bot;
