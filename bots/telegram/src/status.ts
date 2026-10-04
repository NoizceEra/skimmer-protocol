import { Connection, PublicKey } from '@solana/web3.js';
import type { UserState } from './store';
import { bpsToPct } from './store';

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? '2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp',
);

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

export function walletPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('smart_wallet'), owner.toBuffer()], PROGRAM_ID);
}

export function configPda(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('user_config'), authority.toBuffer()], PROGRAM_ID);
}

function short(pk: string): string {
  return pk.length > 12 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
}

/**
 * 📊 /status — renders the REAL configured state from the frozen shared store
 * (not an on-chain config PDA, which is never initialised on this rail).
 */
export function formatStatus(s: UserState): string {
  if (!s.authority) {
    return [
      `📊 *Your skim status* 🔍`,
      ``,
      `😴 No wallet linked yet.`,
      ``,
      `👣 Start here:`,
      `1️⃣ 🔗 /connect YOUR_WALLET`,
      `2️⃣ 💰 /set_rate 5`,
      `3️⃣ 🏦 /set_destination SAVINGS_WALLET`,
      `4️⃣ 🚀 /spawn_wallet`,
    ].join('\n');
  }

  const rate = typeof s.savingsBps === 'number' ? `${bpsToPct(s.savingsBps)}% (${s.savingsBps} bps)` : '❌ not set';
  const dest = s.destination ? `\`${s.destination}\`` : '❌ not set';
  const delegate = s.delegate ? `\`${short(s.delegate)}\`` : '❌ not set (KEEPER_DELEGATE missing)';
  const paused = s.paused ? '⏸️ yes' : '▶️ no';

  const ready = !!s.destination && !!s.delegate && typeof s.savingsBps === 'number' && s.savingsBps > 0;

  return [
    s.paused ? `⏸️ *Saving paused* 😴` : `📊 *Your skim status* ✅`,
    ``,
    `👤 Wallet: \`${s.authority}\``,
    `💰 Rate: *${rate}*`,
    `🏦 Savings pot: ${dest}`,
    `🔑 Keeper delegate: ${delegate}`,
    `⏸️ Paused: ${paused}`,
    ``,
    ready
      ? `👉 Run 🚀 /spawn_wallet to (re)issue your one-time approval tx, then trade anywhere! ✨`
      : `👣 Finish setup: ${!s.destination ? '🏦 /set_destination · ' : ''}${!s.savingsBps ? '💰 /set_rate 5 · ' : ''}🚀 /spawn_wallet`,
  ].join('\n');
}

/**
 * Best-effort on-chain delegate check (read-only). Never throws — a flaky RPC
 * must not break /status. Returns '' when there is nothing to check.
 */
export async function verifyDelegations(connection: Connection, s: UserState): Promise<string> {
  if (!s.authority || !s.delegate) return '';
  try {
    const owner = new PublicKey(s.authority);
    const resp = await connection.getParsedTokenAccountsByOwner(owner, {
      programId: TOKEN_PROGRAM_ID,
    });
    const lines: string[] = [];
    let ok = 0;
    for (const { account } of resp.value) {
      const info = (account.data as any).parsed?.info;
      if (!info?.mint) continue;
      if (info.delegate === s.delegate) {
        ok += 1;
        lines.push(`✅ ${short(info.mint)}: approved, allowance left ${info.delegatedAmount?.amount ?? info.delegatedAmount ?? '0'}`);
      } else {
        lines.push(`⚠️ ${short(info.mint)}: not approved yet`);
      }
    }
    if (!lines.length) return '🔐 *On-chain check:* no tokens in this wallet yet. Make a first trade — I will message you to approve it.';
    const head = ok === lines.length ? '🔐 *On-chain check:* all your tokens are approved ✅' : '🔐 *On-chain check:* some tokens need approval — run 🚀 /spawn_wallet';
    return `${head}\n${lines.slice(0, 15).join('\n')}`;
  } catch {
    return '';
  }
}

/**
 * Legacy helper kept for compatibility. Prefer formatStatus() with the store
 * record; this falls back to an authority-only view.
 */
export async function fetchStatus(
  _connection: Connection,
  authority: PublicKey,
  record?: UserState,
): Promise<string> {
  return formatStatus(record ?? { authority: authority.toBase58() });
}
