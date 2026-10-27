'use strict';
// One tiny database layer. Production = Postgres (Neon) through "pg". Tests = PGlite (in-memory Postgres).
const toPg = (sql) => { let n = 0; return sql.replace(/\?/g, () => '$' + ++n); };

function makePg() {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, (v) => Number(v)); // bigint -> number (money is micro-USDT, fits easily)
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, idleTimeoutMillis: 10000 });
  const wrap = (c) => ({
    async q(sql, p = []) { const r = await c.query(toPg(sql), p); return { rows: r.rows, count: r.rowCount }; },
  });
  return {
    ...wrap(pool),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(wrap(c));
        await c.query('COMMIT');
        return r;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (x) {}
        throw e;
      } finally { c.release(); }
    },
  };
}

function makeLite(lite) {
  const wrap = (c) => ({
    async q(sql, p = []) { const r = await c.query(toPg(sql), p); return { rows: r.rows.map(fixBig), count: r.affectedRows ?? r.rows.length }; },
  });
  const fixBig = (row) => { const o = {}; for (const k in row) o[k] = typeof row[k] === 'bigint' ? Number(row[k]) : row[k]; return o; };
  return {
    ...wrap(lite),
    async tx(fn) { return lite.transaction(async (t) => fn(wrap(t))); },
  };
}

let inst = global.__faucetDb;
function db() {
  if (inst) return inst;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  inst = global.__faucetDb = makePg();
  return inst;
}
db.use = (d) => { inst = global.__faucetDb = d; };
db.lite = makeLite;
module.exports = db;
