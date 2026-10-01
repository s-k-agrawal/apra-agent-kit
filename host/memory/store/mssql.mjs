// host/memory/store/mssql.mjs
//
// Long-term facts in Microsoft SQL Server. **Selectable, never the default** —
// the default is the task hub, so a clone needs no server at all.
//
// The `mssql` driver is imported lazily, inside `open()`, exactly the way the
// Cosmos adapter imports `@azure/cosmos`. Neither is declared in package.json:
// a clone that never selects the adapter never loads the module and never needs
// it, and declaring it would pull tedious, @azure/identity and keyvault into
// every install for a store almost nobody selects.
//
// **An adopter who sets `store: 'mssql'` installs `mssql` themselves.**
//
// The predicates match host/memory/store/sqlite.mjs: same filters, any-of tag
// match, sort by retrieval strength, limit applied after the sort. Tags are
// stored as JSON and filtered in the process rather than in SQL, because a
// tag-array containment test is the one predicate that does not translate
// cleanly and is not worth a second table for a store capped at 500 rows.

const TABLE = 'agent_memories';

const DDL = `
IF OBJECT_ID('${TABLE}', 'U') IS NULL
CREATE TABLE ${TABLE} (
  id                 NVARCHAR(200) NOT NULL PRIMARY KEY,
  kind               NVARCHAR(40)  NOT NULL,
  text               NVARCHAR(MAX) NOT NULL,
  tags               NVARCHAR(MAX) NULL,
  source             NVARCHAR(40)  NULL,
  confidence         FLOAT         NULL,
  storage_strength   FLOAT         NULL,
  retrieval_strength FLOAT         NULL,
  state              NVARCHAR(40)  NULL,
  stability          FLOAT         NULL,
  difficulty         FLOAT         NULL,
  reps               INT           NULL,
  lapses             INT           NULL,
  last_promoted_at   NVARCHAR(40)  NULL,
  last_review_rating NVARCHAR(40)  NULL,
  created_at         NVARCHAR(40)  NULL,
  last_used_at       NVARCHAR(40)  NULL,
  use_count          INT           NULL,
  metadata           NVARCHAR(MAX) NULL
);`;

const toRow = (e) => ({
  id: e.id, kind: e.kind, text: e.text,
  tags: JSON.stringify(e.tags ?? []),
  source: e.source ?? null,
  confidence: e.confidence ?? null,
  storage_strength: e.storageStrength ?? null,
  retrieval_strength: e.retrievalStrength ?? null,
  state: e.state ?? null,
  stability: e.stability ?? null,
  difficulty: e.difficulty ?? null,
  reps: e.reps ?? null,
  lapses: e.lapses ?? null,
  last_promoted_at: e.lastPromotedAt ?? null,
  last_review_rating: e.lastReviewRating ?? null,
  created_at: e.createdAt ?? null,
  last_used_at: e.lastUsedAt ?? null,
  use_count: e.useCount ?? null,
  metadata: e.metadata == null ? null : JSON.stringify(e.metadata),
});

const fromRow = (r) => ({
  id: r.id, kind: r.kind, text: r.text,
  tags: safeParse(r.tags, []),
  source: r.source,
  confidence: r.confidence,
  storageStrength: r.storage_strength,
  retrievalStrength: r.retrieval_strength,
  state: r.state,
  stability: r.stability,
  difficulty: r.difficulty,
  reps: r.reps,
  lapses: r.lapses,
  lastPromotedAt: r.last_promoted_at,
  lastReviewRating: r.last_review_rating,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count,
  metadata: safeParse(r.metadata, null),
});

function safeParse(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

/**
 * @param {object} config
 * @param {string|object} config.connectionString  or an `mssql` config object
 * @param {object} [config.driver]  injectable for tests; defaults to `mssql`
 */
export function createMssqlStore({ connectionString, driver = null, table = TABLE } = {}) {
  if (!connectionString && !driver) {
    throw new Error('createMssqlStore requires connectionString');
  }
  let sql = driver;
  let pool = null;

  const ensureOpen = () => {
    if (!pool) throw new Error('mssql store is not open');
    return pool;
  };

  return {
    async open() {
      if (pool) return;
      // Lazily, and only here. A clone that never selects mssql never needs
      // the driver installed.
      sql ??= (await import('mssql')).default ?? (await import('mssql'));
      pool = await sql.connect(connectionString);
      await pool.request().query(DDL.replaceAll(TABLE, table));
    },

    async close() {
      if (!pool) return;
      await pool.close();
      pool = null;
    },

    async store(entry) {
      const p = ensureOpen();
      const r = toRow(entry);
      const req = p.request();
      for (const [k, v] of Object.entries(r)) req.input(k, v);
      // MERGE rather than INSERT: `store` is upsert-shaped everywhere else.
      await req.query(`
        MERGE ${table} AS target
        USING (SELECT @id AS id) AS src ON target.id = src.id
        WHEN MATCHED THEN UPDATE SET
          kind=@kind, text=@text, tags=@tags, source=@source, confidence=@confidence,
          storage_strength=@storage_strength, retrieval_strength=@retrieval_strength,
          state=@state, stability=@stability, difficulty=@difficulty, reps=@reps,
          lapses=@lapses, last_promoted_at=@last_promoted_at,
          last_review_rating=@last_review_rating, created_at=@created_at,
          last_used_at=@last_used_at, use_count=@use_count, metadata=@metadata
        WHEN NOT MATCHED THEN INSERT
          (id, kind, text, tags, source, confidence, storage_strength, retrieval_strength,
           state, stability, difficulty, reps, lapses, last_promoted_at, last_review_rating,
           created_at, last_used_at, use_count, metadata)
        VALUES
          (@id, @kind, @text, @tags, @source, @confidence, @storage_strength, @retrieval_strength,
           @state, @stability, @difficulty, @reps, @lapses, @last_promoted_at, @last_review_rating,
           @created_at, @last_used_at, @use_count, @metadata);`);
    },

    async get(id) {
      const p = ensureOpen();
      const res = await p.request().input('id', id).query(`SELECT * FROM ${table} WHERE id = @id`);
      const row = res.recordset?.[0];
      return row ? fromRow(row) : null;
    },

    async update(id, patch) {
      const existing = await this.get(id);
      if (!existing) return null;
      await this.store({ ...existing, ...patch });
      return { ...existing, ...patch };
    },

    async remove(id) {
      const p = ensureOpen();
      const res = await p.request().input('id', id).query(`DELETE FROM ${table} WHERE id = @id`);
      return res.rowsAffected?.[0] ?? 0;
    },

    async query({ kinds, tags, states, query: textQuery, limit } = {}) {
      const p = ensureOpen();
      const req = p.request();
      const where = [];

      if (kinds?.length) {
        where.push(`kind IN (${kinds.map((k, i) => { req.input(`k${i}`, k); return `@k${i}`; }).join(',')})`);
      }
      if (states?.length) {
        where.push(`state IN (${states.map((s, i) => { req.input(`s${i}`, s); return `@s${i}`; }).join(',')})`);
      }
      if (textQuery) {
        req.input('q', `%${textQuery}%`);
        where.push('text LIKE @q');
      }

      const sqlText = `SELECT * FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY retrieval_strength DESC`;
      const res = await req.query(sqlText);
      let results = (res.recordset ?? []).map(fromRow);
      // Any-of, in the process — same as the sqlite adapter.
      if (tags?.length) results = results.filter(e => (e.tags ?? []).some(t => tags.includes(t)));
      return limit ? results.slice(0, limit) : results;
    },

    /** With no predicate this removes nothing, exactly as sqlite does. */
    async purge({ states, olderThan } = {}) {
      if (!states?.length && !olderThan) return 0;
      const p = ensureOpen();
      const req = p.request();
      const where = [];
      if (states?.length) {
        where.push(`state IN (${states.map((s, i) => { req.input(`s${i}`, s); return `@s${i}`; }).join(',')})`);
      }
      if (olderThan) {
        req.input('older', olderThan);
        where.push('created_at < @older');
      }
      const res = await req.query(`DELETE FROM ${table} WHERE ${where.join(' AND ')}`);
      return res.rowsAffected?.[0] ?? 0;
    },

    async count({ kinds, states } = {}) {
      const p = ensureOpen();
      const req = p.request();
      const where = [];
      if (kinds?.length) {
        where.push(`kind IN (${kinds.map((k, i) => { req.input(`k${i}`, k); return `@k${i}`; }).join(',')})`);
      }
      if (states?.length) {
        where.push(`state IN (${states.map((s, i) => { req.input(`s${i}`, s); return `@s${i}`; }).join(',')})`);
      }
      const res = await req.query(`SELECT COUNT(*) AS n FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`);
      return res.recordset?.[0]?.n ?? 0;
    },
  };
}
