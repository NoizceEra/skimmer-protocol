import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { buildApproveIx, computeSafeAllowance, configPda } from './index';

/**
 * One-click onboarding: approve bounded allowance for the keeper delegate.
 * The wallet signs ONE tx. No unlimited approvals, revocable anytime via Revoke.
 * On-chain config init (initialize_config) is appended by the caller with Anchor.
 */
export function buildSetupTx(params: {
  user: PublicKey;
  userAta: PublicKey;
  keeperDelegate: PublicKey;
  expectedTradeSize: bigint;
  savingsBps: number;
  topUps?: number;
}): Transaction {
  const allowance = computeSafeAllowance({
    expectedTradeSize: params.expectedTradeSize,
    savingsBps: params.savingsBps,
    topUps: params.topUps ?? 20,
  });
  const tx = new Transaction();
  tx.add(buildApproveIx(params.userAta, params.keeperDelegate, params.user, allowance));
  return tx;
}

export async function readConfig(
  connection: Connection,
  programId: PublicKey,
  authority: PublicKey,
): Promise<{ savingsBps: number; destination: string; paused: boolean } | null> {
  const [pda] = configPda(authority, programId);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  // Minimal decode: Anchor discriminator (8) + authority(32) + wallet(32) + dest(32) + bps(u16) + paused(bool)
  // For status display only — full decode lives in the bot.
  const bps = info.data.readUInt16LE(8 + 32 + 32 + 32);
  const paused = info.data.readUInt8(8 + 32 + 32 + 32 + 2) === 1;
  const dest = new PublicKey(info.data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32)).toBase58();
  return { savingsBps: bps, destination: dest, paused };
}
