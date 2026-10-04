import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

export const PROTOCOL_FEE_BPS = 40; // 0.4%
const seen = new Map<string, number>(); // sig -> expiry ms (24h dedup)

export function skimFor(output: bigint, bps: number): bigint {
  return (output * BigInt(bps)) / 10000n;
}

export function claimOnce(signature: string): boolean {
  const now = Date.now();
  const exp = seen.get(signature);
  if (exp && exp > now) return false;
  seen.set(signature, now + 24 * 3600 * 1000);
  return true;
}

/**
 * Background sweep: delegated transfer of skim + fee after an external trade.
 * Skips when paused / 0% / duplicate. Verifies delegate allowance before send.
 */
export async function processSkim(params: {
  connection: Connection;
  keeper: Keypair;
  treasury: PublicKey;
  user: PublicKey;
  mint: PublicKey;
  outputAmount: bigint;
  decimals: number;
  savingsBps: number;
  savingsDestination: PublicKey;
  paused: boolean;
  swapSignature: string;
}): Promise<{ skipped?: string; signature?: string; skim?: string; fee?: string }> {
  if (params.paused || params.savingsBps === 0) return { skipped: 'paused-or-zero' };
  if (!claimOnce(params.swapSignature)) return { skipped: 'duplicate' };

  const skim = skimFor(params.outputAmount, params.savingsBps);
  const fee = skimFor(params.outputAmount, PROTOCOL_FEE_BPS);
  if (skim <= 0n) return { skipped: 'dust' };

  const source = getAssociatedTokenAddressSync(params.mint, params.user);
  const dest = getAssociatedTokenAddressSync(params.mint, params.savingsDestination);
  const treasuryAta = getAssociatedTokenAddressSync(params.mint, params.treasury);

  const acct = await getAccount(params.connection, source);
  const delegate = acct.delegate;
  if (!delegate?.equals(params.keeper.publicKey)) throw new Error('no delegate');
  if (acct.delegatedAmount < skim + fee) throw new Error('allowance too low');

  const tx = new Transaction();
  const destInfo = await params.connection.getAccountInfo(dest);
  if (!destInfo) {
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        params.keeper.publicKey,
        dest,
        params.savingsDestination,
        params.mint,
      ),
    );
  }
  tx.add(
    createTransferCheckedInstruction(
      source, params.mint, dest, params.keeper.publicKey, skim, params.decimals,
    ),
  );
  if (fee > 0n) {
    tx.add(
      createTransferCheckedInstruction(
        source, params.mint, treasuryAta, params.keeper.publicKey, fee, params.decimals,
      ),
    );
  }
  tx.feePayer = params.keeper.publicKey;
  const { blockhash } = await params.connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(params.keeper);
  const sig = await params.connection.sendRawTransaction(tx.serialize());
  await params.connection.confirmTransaction(sig, 'confirmed');
  return { signature: sig, skim: skim.toString(), fee: fee.toString() };
}
