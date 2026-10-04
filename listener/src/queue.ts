export interface SkimJob {
  user: string;
  tokenMint: string;
  outputAmount: string;
  signature: string;
}

const mem: SkimJob[] = [];

/** In-memory queue (swap to BullMQ/Redis in prod). */
export async function enqueue(job: SkimJob): Promise<void> {
  mem.push(job);
}

export function drain(): SkimJob[] {
  return mem.splice(0, mem.length);
}
