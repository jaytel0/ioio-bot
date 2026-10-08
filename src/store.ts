import type { Row } from './shared';

export class Store {
  constructor(private sql: SqlStorage) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, capabilities TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS accounts (owner_id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS setup_links (hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL, remaining INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_activity (agent_id TEXT PRIMARY KEY, last_seen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS friendships (id TEXT PRIMARY KEY, requester TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(requester, target));
      CREATE TABLE IF NOT EXISTS google_owners (subject TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE, email TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agents_owner ON agents(owner_id);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, agent_id TEXT, owner_id TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER, client_id TEXT, resource TEXT, family TEXT, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, capabilities TEXT NOT NULL, agent_id TEXT, expires_at INTEGER NOT NULL, credential_ttl_seconds INTEGER);
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (room_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY(room_id, agent_id));
      CREATE INDEX IF NOT EXISTS members_agent ON members(agent_id, room_id);
      CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, requester TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(requester, target));
      CREATE INDEX IF NOT EXISTS connections_target ON connections(target, status);
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, target TEXT, room_id TEXT, text TEXT, data TEXT, kind TEXT NOT NULL, thread_id TEXT NOT NULL, reply_to INTEGER, client_message_id TEXT NOT NULL, mentions TEXT NOT NULL, hop_count INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(sender, client_message_id));
      CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id, seq);
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, seq);
      CREATE TABLE IF NOT EXISTS deliveries (agent_id TEXT NOT NULL, seq INTEGER NOT NULL, acked INTEGER NOT NULL DEFAULT 0, directed INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(agent_id, seq));
      CREATE INDEX IF NOT EXISTS deliveries_inbox ON deliveries(agent_id, acked, seq);
      CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_flows (id TEXT PRIMARY KEY, verification_hash TEXT UNIQUE NOT NULL, display_code TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, state TEXT NOT NULL, resource TEXT NOT NULL, agent_id TEXT, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, flow_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, callback_url TEXT NOT NULL, grant_family TEXT, secret TEXT NOT NULL, old_secret TEXT, rotate_until INTEGER, directed_only INTEGER NOT NULL, expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, seq INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', last_status INTEGER, UNIQUE(subscription_id, seq));
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, next_at);
      CREATE TABLE IF NOT EXISTS webhook_hosts (host TEXT PRIMARY KEY);
    `);
    if (!sql.exec('PRAGMA table_info(invites)').toArray().some(column => column.name === 'credential_ttl_seconds')) sql.exec('ALTER TABLE invites ADD COLUMN credential_ttl_seconds INTEGER');
    if (!sql.exec('PRAGMA table_info(subscriptions)').toArray().some(column => column.name === 'event_name')) sql.exec("ALTER TABLE subscriptions ADD COLUMN event_name TEXT NOT NULL DEFAULT 'btb.message.created'");
    sql.exec("INSERT OR IGNORE INTO rooms VALUES ('home', 'home', 'My agents')");
    sql.exec("INSERT OR IGNORE INTO webhook_hosts VALUES ('chatgpt.com'), ('api.openai.com')");
  }
  all(query: string, ...values: SqlStorageValue[]): Row[] { return this.sql.exec(query, ...values).toArray(); }
  one(query: string, ...values: SqlStorageValue[]): Row | undefined { return this.all(query, ...values)[0]; }
  run(query: string, ...values: SqlStorageValue[]) { this.sql.exec(query, ...values); }
  export() {
    const tables = ['accounts', 'setup_links', 'agent_activity', 'friendships', 'agents', 'google_owners', 'tokens', 'invites', 'rooms', 'members', 'connections', 'messages', 'deliveries', 'subscriptions', 'outbox', 'webhook_hosts'];
    return Object.fromEntries(tables.map(table => [table, this.all(`SELECT * FROM ${table}`)]));
  }
  restore(tables: Record<string, Row[]>) {
    const allowed = Object.keys(this.export());
    tables = { accounts: [], setup_links: [], agent_activity: [], friendships: [], ...tables };
    if (Object.keys(tables).some(table => !allowed.includes(table)) || allowed.some(table => !Array.isArray(tables[table]))) throw new Error('Invalid backup tables');
    for (const table of allowed) {
      const columns = this.all(`PRAGMA table_info(${table})`).map(row => row.name as string);
      this.run(`DELETE FROM ${table}`);
      for (const original of tables[table]) {
        // Backups made before expiring enrollment preserve their permanent-key default.
        const compatible = table === 'subscriptions' && !Object.hasOwn(original, 'event_name') ? { ...original, event_name: 'btb.message.created' } : original;
        const row = table === 'invites' && !Object.hasOwn(original, 'credential_ttl_seconds') ? { ...original, credential_ttl_seconds: null } : compatible;
        const keys = Object.keys(row);
        if (keys.length !== columns.length || keys.some(key => !columns.includes(key))) throw new Error('Invalid backup row');
        this.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(key => row[key]));
      }
    }
  }
  transaction<T>(storage: DurableObjectStorage, fn: () => T): T { return storage.transactionSync(fn); }
}
