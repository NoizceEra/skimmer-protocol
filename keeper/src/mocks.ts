/**
 * Offline mocks — no network. Used by the test suite and the simulation
 * harness so the engine can be exercised before the chain is funded.
 *
 * Token accounts are packed into the real 165-byte SPL layout and parsed by
 * the real `@solana/spl-token` `getAccount`, so the mock is faithful.
 */
import { AccountInfo, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

/** 32 zero bytes in base58 — a valid, deterministic placeholder blockhash. */
export const ZERO_BLOCKHASH = '11111111111111111111111111111111';

export interface TokenAccountSpec {
  mint: PublicKey | string;
  owner: PublicKey | string;
  amount: bigint | number | string;
  delegate?: PublicKey | string | null;
  delegatedAmount?: bigint | number | string;
  state?: number;
  lamports?: number;
  tokenProgram?: PublicKey | string;
}

function pk(value: PublicKey | string): PublicKey {
  return value instanceof PublicKey ? value : new PublicKey(value);
}

/** Pack an SPL token account using the canonical 165-byte layout. */
export function packTokenAccount(spec: TokenAccountSpec): Buffer {
  const buf = Buffer.alloc(165);
  pk(spec.mint).toBuffer().copy(buf, 0);
  pk(spec.owner).toBuffer().copy(buf, 32);
  buf.writeBigUInt64LE(BigInt(spec.amount), 64);
  if (spec.delegate) {
    buf.writeUInt32LE(1, 72);
    pk(spec.delegate).toBuffer().copy(buf, 76);
  } else {
    buf.writeUInt32LE(0, 72);
  }
  buf.writeUInt8(spec.state ?? 1, 108);
  buf.writeUInt32LE(0, 109); // isNative = None
  buf.writeBigUInt64LE(0n, 113);
  buf.writeBigUInt64LE(BigInt(spec.delegatedAmount ?? 0), 121);
  buf.writeUInt32LE(0, 129); // closeAuthority = None
  return buf;
}

export interface MockConnectionOptions {
  keeper: PublicKey;
  keeperSol?: number;
  /** ATA / account specs keyed by address base58. */
  accounts?: Record<string, TokenAccountSpec>;
  /** Mint pubkey (base58) -> owning program (base58). Defaults to legacy. */
  mintPrograms?: Record<string, string>;
  blockhash?: string;
  sendSignature?: string;
  failSend?: Error;
  failConfirm?: Error;
  failGetBalance?: Error;
}

export interface MockConnection {
  connection: any;
  sentRaw: Uint8Array[];
  sentTransactions: Transaction[];
  sentSignatures: string[];
  sendCount: () => number;
}

export function createMockConnection(options: MockConnectionOptions): MockConnection {
  const accounts = new Map<string, AccountInfo<Buffer>>();
  for (const [address, spec] of Object.entries(options.accounts ?? {})) {
    accounts.set(address, {
      data: packTokenAccount(spec),
      executable: false,
      lamports: spec.lamports ?? 2_039_280,
      owner: pk(spec.tokenProgram ?? TOKEN_PROGRAM_ID),
    });
  }
  const mintPrograms = new Map<string, string>(
    Object.entries(options.mintPrograms ?? {}),
  );

  const sentRaw: Uint8Array[] = [];
  const sentTransactions: Transaction[] = [];
  const sentSignatures: string[] = [];

  const connection = {
    async getBalance(address: PublicKey | string): Promise<number> {
      if (options.failGetBalance) throw options.failGetBalance;
      const key = typeof address === 'string' ? address : address.toBase58();
      return key === options.keeper.toBase58() ? options.keeperSol ?? 0 : 0;
    },
    async getAccountInfo(address: PublicKey | string): Promise<AccountInfo<Buffer> | null> {
      const key = typeof address === 'string' ? address : address.toBase58();
      const direct = accounts.get(key);
      if (direct) return direct;
      const program = mintPrograms.get(key);
      if (program) {
        return { data: Buffer.alloc(82), executable: false, lamports: 1_461_600, owner: new PublicKey(program) };
      }
      return null;
    },
    async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
      return { blockhash: options.blockhash ?? ZERO_BLOCKHASH, lastValidBlockHeight: 1000 };
    },
    async sendRawTransaction(raw: Uint8Array): Promise<string> {
      if (options.failSend) throw options.failSend;
      sentRaw.push(raw);
      try {
        sentTransactions.push(Transaction.from(Buffer.from(raw)));
      } catch {
        // best-effort decode; the recorded signature still suffices
      }
      const sig = options.sendSignature ?? `sig-${sentSignatures.length + 1}`;
      sentSignatures.push(sig);
      return sig;
    },
    async confirmTransaction(): Promise<{ value: { err: null } }> {
      if (options.failConfirm) throw options.failConfirm;
      return { value: { err: null } };
    },
  };

  return {
    connection,
    sentRaw,
    sentTransactions,
    sentSignatures,
    sendCount: () => sentSignatures.length,
  };
}

/** Deterministic throwaway keeper for offline runs. */
export function offlineKeeper(seed = 'skim-offline-keeper-000000000000000000000000'): Keypair {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = seed.charCodeAt(i % seed.length) ^ i;
  return Keypair.fromSeed(bytes);
}
