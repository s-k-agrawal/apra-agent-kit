// host/memory/conversation-store/mssql.mjs
//
// Chat turns in Microsoft SQL Server. Selectable, never the default.
//
// Same lazy-import rule as the facts adapter: `mssql` is loaded inside `open()`
// and nowhere else, and is not declared in package.json — an adopter who selects
// this store installs the driver themselves, exactly as for `@azure/cosmos`.

const TABLE = 'agent_conversation_turns';

const DDL = (table) => `
IF OBJECT_ID('${table}', 'U') IS NULL
CREATE TABLE ${table} (
  id         NVARCHAR(200) NOT NULL PRIMARY KEY,
  session_id NVARCHAR(200) NOT NULL,
  seq        INT           NOT NULL,
  role       NVARCHAR(40)  NULL,
  goal       NVARCHAR(MAX) NULL,
  answer     NVARCHAR(MAX) NULL,
  at         NVARCHAR(40)  NULL,
  metadata   NVARCHAR(MAX) NULL
);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_${table}_session')
CREATE INDEX ix_${table}_session ON ${table} (session_id, seq);`;

const fromRow = (r) => ({
  id: r.id, sessionId: r.session_id, seq: r.seq, role: r.role,
  goal: r.goal, answer: r.answer, at: r.at,
  metadata: r.metadata == null ? null : safeParse(r.metadata),
});

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function createConversationMssqlStore({ connectionString, driver = null, table = TABLE } = {}) {
  if (!connectionString && !driver) {
    throw new Error('createConversationMssqlStore requires connectionString');
  }
  let sql = driver;
  let pool = null;

  const ensureOpen = () => {
    if (!pool) throw new Error('mssql conversation store is not open');
    return pool;
  };

  return {
    async open() {
      if (pool) return;
      sql ??= (await import('mssql')).default ?? (await import('mssql'));
      pool = await sql.connect(connectionString);
      await pool.request().query(DDL(table));
    },

    async close() {
      if (!pool) return;
      await pool.close();
      pool = null;
    },

    async append(sessionId, turn) {
      const p = ensureOpen();
      // The sequence is derived rather than supplied, so two appends to one
      // session cannot land on the same number and reorder the conversation.
      const next = await p.request()
        .input('session_id', sessionId)
        .query(`SELECT ISNULL(MAX(seq), 0) + 1 AS n FROM ${table} WHERE session_id = @session_id`);
      const seq = next.recordset?.[0]?.n ?? 1;
      const id = turn.id ?? `${sessionId}-${seq}`;

      await p.request()
        .input('id', id)
        .input('session_id', sessionId)
        .input('seq', seq)
        .input('role', turn.role ?? null)
        .input('goal', turn.goal ?? null)
        .input('answer', turn.answer ?? null)
        .input('at', turn.at ?? new Date().toISOString())
        .input('metadata', turn.metadata == null ? null : JSON.stringify(turn.metadata))
        .query(`INSERT INTO ${table} (id, session_id, seq, role, goal, answer, at, metadata)
                VALUES (@id, @session_id, @seq, @role, @goal, @answer, @at, @metadata)`);

      return { ...turn, id, sessionId, seq };
    },

    async get(sessionId, turnId) {
      const p = ensureOpen();
      const res = await p.request()
        .input('session_id', sessionId).input('id', turnId)
        .query(`SELECT * FROM ${table} WHERE session_id = @session_id AND id = @id`);
      const row = res.recordset?.[0];
      return row ? fromRow(row) : null;
    },

    async update(sessionId, turnId, patch) {
      const p = ensureOpen();
      await p.request()
        .input('session_id', sessionId).input('id', turnId)
        .input('goal', patch.goal ?? null).input('answer', patch.answer ?? null)
        .query(`UPDATE ${table} SET
                  goal = ISNULL(@goal, goal),
                  answer = ISNULL(@answer, answer)
                WHERE session_id = @session_id AND id = @id`);
      return this.get(sessionId, turnId);
    },

    async listSession(sessionId, { limit } = {}) {
      const p = ensureOpen();
      const res = await p.request()
        .input('session_id', sessionId)
        .query(`SELECT * FROM ${table} WHERE session_id = @session_id ORDER BY seq ASC`);
      const rows = (res.recordset ?? []).map(fromRow);
      return limit ? rows.slice(-limit) : rows;
    },

    async purgeSessions({ sessionIds = [], olderThan } = {}) {
      if (!sessionIds.length && !olderThan) return 0;
      const p = ensureOpen();
      const req = p.request();
      const where = [];
      if (sessionIds.length) {
        where.push(`session_id IN (${sessionIds.map((s, i) => { req.input(`s${i}`, s); return `@s${i}`; }).join(',')})`);
      }
      if (olderThan) {
        req.input('older', olderThan);
        where.push('at < @older');
      }
      const res = await req.query(`DELETE FROM ${table} WHERE ${where.join(' AND ')}`);
      return res.rowsAffected?.[0] ?? 0;
    },
  };
}
