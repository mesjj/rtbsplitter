// One async database interface over two backends, so the app runs unchanged on
// Node (node:sqlite, synchronous) and Cloudflare Workers (D1, asynchronous).
//
//   await db.get(sql, ...params)   → first row or null
//   await db.all(sql, ...params)   → array of rows
//   await db.run(sql, ...params)   → { changes }
//   await db.batch([[sql, ...params], …]) → runs all statements in ONE transaction,
//                                          returns each statement's rows
//
// D1 has no BEGIN/COMMIT, so anything that must be atomic goes through batch().

const clean = params => params.map(p => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));

// node:sqlite DatabaseSync
export function nodeStore(sqlite) {
  const prep = sql => sqlite.prepare(sql);
  return {
    async get(sql, ...params) { return prep(sql).get(...clean(params)) ?? null; },
    async all(sql, ...params) { return prep(sql).all(...clean(params)); },
    async run(sql, ...params) { return { changes: Number(prep(sql).run(...clean(params)).changes) }; },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const out = statements.map(([sql, ...params]) => prep(sql).all(...clean(params)));
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

// Cloudflare D1 binding
export function d1Store(d1) {
  const bind = (sql, params) => d1.prepare(sql).bind(...clean(params));
  return {
    async get(sql, ...params) { return (await bind(sql, params).first()) ?? null; },
    async all(sql, ...params) { return (await bind(sql, params).all()).results; },
    async run(sql, ...params) { return { changes: (await bind(sql, params).run()).meta.changes }; },
    async batch(statements) {
      if (!statements.length) return [];
      const results = await d1.batch(statements.map(([sql, ...params]) => bind(sql, params)));
      return results.map(r => r.results || []);
    },
  };
}
