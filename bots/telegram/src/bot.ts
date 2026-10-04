'use strict';
/**
 * 🛰️ Skimmer Telegram bot — onboarding + status ONLY.
 * No swaps. No buy/sell. Trading happens on other apps.
 * Commands: /start /help /connect /set_rate /set_destination /spawn_wallet
 *           /status /accrued /pause /resume
 */
import { Bot, InlineKeyboard } from 'grammy';
import { Connection, PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';
dotenv.config();

import { getState, saveState, parseBps, bpsToPct } from './store';
import { fetchStatus, walletPda } from './status';

const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN in bots/telegram/.env');
  process.exit(1);
}
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const connection = new Connection(RPC, 'confirmed');
const bot = new Bot(token);

/** 🏠 Main menu — every action one tap away. */
const mainKb = () =>
  new InlineKeyboard()
    .text('🔗 Connect', 'nav:connect')
    .text('💰 Rate', 'nav:rate')
    .row()
    .text('🏦 Savings', 'nav:dest')
    .text('🚀 Wallet', 'nav:wallet')
    .row()
    .text('📊 Status', 'nav:status')
    .text('💎 Accrued', 'nav:accrued')
    .row()
    .text('❓ Help', 'nav:help');

const WELCOME = [
  '✂️ *Skimmer Protocol* — pay yourself first! 💸',
  '',
  '🤖 I auto-save a cut of every trade you make — anywhere. You keep trading, I keep skimming. 🏖️',
  '',
  '👣 *3 tiny steps:*',
  '1️⃣ 🔗 /connect — link your wallet',
  '2️⃣ 💰 /set_rate — pick your cut (e.g. 5)',
  '3️⃣ 🏦 /set_destination — where savings land',
  '',
  '✅ Then just trade! Every win drops savings in your pot. 🪙',
  '🔑 I never hold your keys. I never trade. I just save. 🛡️',
].join('\n');

const HELP = [
  '❓ *What I understand:*',
  '',
  '🔗 /connect — link your trading wallet',
  '💰 /set_rate — your savings cut (0–10%)',
  '🏦 /set_destination — your savings wallet',
  '🚀 /spawn_wallet — show your skim wallet',
  '📊 /status — your setup + rate',
  '💎 /accrued — savings balance',
  '⏸️ /pause — pause saving',
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
    getState(ctx.chat.id).authority = pk.toBase58();
    saveState(ctx.chat.id);
    await ctx.reply(`🔗 *Connected!* ✅\n\`${pk.toBase58()}\`\n\nNext: 💰 /set_rate 5`, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply('🔗 *Connect your wallet:*\n`/connect YOUR_WALLET_ADDRESS`\n\n📌 Paste your Solana address (Phantom, Solflare…).', { parse_mode: 'Markdown' });
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
      `🏦 *Savings pot set!* ✅\n\`${pk.toBase58()}\`\n💰 Rate: ${s.savingsBps ?? '?'} bps\n\n🚀 Finish with /spawn_wallet`,
      { parse_mode: 'Markdown' },
    );
  } catch {
    await ctx.reply('🏦 *Where should savings land?*\n`/set_destination SAVINGS_WALLET`\n\n💡 Tip: use a separate wallet so savings pile up untouched! 🐷', { parse_mode: 'Markdown' });
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
  const [pda] = walletPda(new PublicKey(s.authority));
  s.wallet = pda.toBase58();
  saveState(ctx.chat.id);
  await ctx.reply(
    [
      `🚀 *Your skim wallet is ready!* 🎉`,
      `\`${pda.toBase58()}\``,
      ``,
      `👤 Owner: \`${s.authority}\``,
      `💰 Saves ${bpsToPct(s.savingsBps)}% of every trade → 🏦 savings 🪙`,
      `⛽ Tiny 0.4% keeps the protocol running.`,
      ``,
      `✅ You're set! Go trade anywhere — saving is automatic! ✨`,
      `🔑 Sign the setup in your wallet app — I never touch keys. 🛡️`,
    ].join('\n'),
    { parse_mode: 'Markdown' },
  );
});

bot.command('status', async (ctx) => {
  const s = getState(ctx.chat.id);
  if (!s.authority) {
    await ctx.reply('🔗 Link a wallet first: /connect YOUR_WALLET 🙂', { reply_markup: mainKb() });
    return;
  }
  try {
    const text = await fetchStatus(connection, new PublicKey(s.authority));
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (e: any) {
    await ctx.reply('📊 Status hiccup 😅: ' + e.message + '\nTry again in a sec! 🔄');
  }
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
  await ctx.reply('⏸️ *Pause saving:* sign “pause” on your savings setup in your wallet app. 🔑\n\n💡 I can’t pause for you — I never hold keys! Your funds stay safe either way. 🛡️', { parse_mode: 'Markdown' });
});

bot.command('resume', async (ctx) => {
  await ctx.reply('▶️ *Resume saving:* sign “resume” on your savings setup in your wallet app. 🚀\n\n💰 Back to stacking every trade! 🪙', { parse_mode: 'Markdown' });
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
    case 'nav:wallet':
      await ctx.reply('🚀 Run /spawn_wallet to see your skim wallet! 🎉');
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
