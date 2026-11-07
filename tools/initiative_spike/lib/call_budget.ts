/** 実 API の呼び出し回数の上限。回をまたいで数えるため、ファイルに残す。超える前に例外で止める。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class CallBudgetExceeded extends Error {
  constructor(limit: number) {
    super(`call budget of ${limit} is used up`);
    this.name = 'CallBudgetExceeded';
  }
}

export class CallBudget {
  constructor(
    private readonly path: string,
    readonly limit: number,
  ) {}

  used(): number {
    if (!existsSync(this.path)) return 0;
    return (JSON.parse(readFileSync(this.path, 'utf8')) as { used: number }).used;
  }

  /** 呼び出しの前に1回ぶん確保する。同じプロセスの中で直列に呼ぶこと（同期処理なので競合しない）。 */
  consume(label: string): number {
    const used = this.used();
    if (used >= this.limit) throw new CallBudgetExceeded(this.limit);
    const next = used + 1;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify({ used: next, limit: this.limit, last: label }, null, 2)}\n`);
    return next;
  }
}
