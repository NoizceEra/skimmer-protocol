export interface ParsedSwap {
  signature: string;
  user: string;
  outputMint: string;
  outputAmount: bigint;
  ok: boolean;
}

/** Parse Helius Enhanced SWAP webhook event -> skim job. Null = not a swap. */
export function parseSwapEvent(event: any): ParsedSwap | null {
  if (!event || (event.type !== 'SWAP' && !event.tokenTransfers?.length)) return null;
  const trader: string | undefined = event.feePayer;
  if (!trader) return null;
  const incoming = (event.tokenTransfers ?? []).find((t: any) => t.toUserAccount === trader);
  if (!incoming) return null;
  return {
    ok: !event.transactionError,
    signature: event.signature,
    user: trader,
    outputMint: incoming.mint,
    outputAmount: BigInt(incoming.rawTokenAmount?.tokenAmount ?? '0'),
  };
}
