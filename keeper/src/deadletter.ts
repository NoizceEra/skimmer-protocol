/**
 * Persistent dead-letter / skip log.
 *
 * Terminal conditions (no delegate, allowance too low, paused, dust) are
 * recorded here with a reason instead of being retried forever. A human or a
 * top-up flow can act on the `no-keeper-funds` / `allowance-too-low` records.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface DeadLetterRecord {
  signature: string;
  user: string;
  mint: string;
  outputAmount: string;
  reason: string;
  attempts: number;
  at: number;
  detail?: string;
}

export interface DeadLetterLike {
  add(record: DeadLetterRecord): void;
  list(): DeadLetterRecord[];
}

const MAX_RECORDS = 2000;

export class InMemoryDeadLetter implements DeadLetterLike {
  private readonly records: DeadLetterRecord[] = [];

  add(record: DeadLetterRecord): void {
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
  }

  list(): DeadLetterRecord[] {
    return [...this.records];
  }
}

export class FileDeadLetter implements DeadLetterLike {
  private records: DeadLetterRecord[] = [];

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(parsed)) {
        this.records = parsed.filter(
          (r): r is DeadLetterRecord =>
            r !== null && typeof r === 'object' && typeof (r as DeadLetterRecord).reason === 'string',
        );
      }
    } catch {
      this.records = [];
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Never let an audit-log write break a sweep.
    }
  }

  add(record: DeadLetterRecord): void {
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    this.persist();
  }

  list(): DeadLetterRecord[] {
    return [...this.records];
  }
}
