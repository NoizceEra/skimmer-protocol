import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

// Never approve u64::MAX. Bounded allowance only: 10 SOL-equiv cap.
export const MAX_SAFE_ALLOWANCE = 10_000_000_000n;
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const USER_CONFIG_SEED = 'user_config';

/** Fee math: the whole protocol in one line. Like slippage, auto-applied. */
export function skimFor(output: bigint, bps: number): bigint {
  return (output * BigInt(bps)) / 10000n;
}

export function computeSafeAllowance(opts: {
  expectedTradeSize: bigint;
  savingsBps: number;
  topUps: number;
}): bigint {
  const perTrade = skimFor(opts.expectedTradeSize, opts.savingsBps);
  const total = perTrade * BigInt(Math.max(1, opts.topUps));
  if (total <= 0n) throw new Error('allowance must be > 0');
  if (total > MAX_SAFE_ALLOWANCE) throw new Error('allowance exceeds safe ceiling');
  return total;
}

function encodeApprove(amount: bigint): Buffer {
  const b = Buffer.alloc(9);
  b.writeUInt8(4, 0); // Approve tag
  b.writeBigUInt64LE(amount, 1);
  return b;
}

export function buildApproveIx(sourceAta: PublicKey, delegate: PublicKey, owner: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: delegate, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: encodeApprove(amount),
  });
}

export function configPda(authority: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(USER_CONFIG_SEED), authority.toBuffer()],
    programId,
  );
}

export * from './setup';
export * from './fees';
