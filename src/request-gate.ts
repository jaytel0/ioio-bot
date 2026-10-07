import { DurableObject } from 'cloudflare:workers';
import type { Env } from './shared';

// Disposable request counters live separately from identities and messages.
export class BtbRequestGate extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, window INTEGER NOT NULL, requests INTEGER NOT NULL, auth INTEGER NOT NULL)');
  }
  consume(sensitive: boolean, limits: { requests: number; auth: number }) {
    return this.ctx.storage.transactionSync(() => {
      const window = Math.floor(Date.now() / 60000);
      const saved = this.ctx.storage.sql.exec<{ window: number; requests: number; auth: number }>('SELECT window, requests, auth FROM counter WHERE id = 1').toArray()[0];
      const counts = saved?.window === window ? saved : { window, requests: 0, auth: 0 };
      if (counts.requests >= limits.requests || (sensitive && counts.auth >= limits.auth)) return { success: false };
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO counter VALUES (1, ?, ?, ?)', window, counts.requests + 1, counts.auth + Number(sensitive));
      return { success: true };
    });
  }
}
