/* Test world: a fresh Postgres database with the LifeOS SQL, plus helpers
   to boot "devices" (tests/harness/device.mjs workers) against it. */
import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PG_ADMIN = process.env.LIFEOS_TEST_PG || "postgresql://postgres@localhost:5433/postgres?host=/tmp/pg";

export async function makeDb(name, root, { sections = true } = {}) {
  const admin = new pg.Client({ connectionString: PG_ADMIN });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = PG_ADMIN.replace(/\/postgres\?/, `/${name}?`);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const run = async f => { await c.query(readFileSync(f, "utf8")); };
  await c.query("set client_min_messages = warning");
  await run(join(HERE, "..", "sql", "supabase-shim.sql"));
  await run(join(root, "supabase-setup.sql"));
  if (sections) await run(join(root, "supabase-sections.sql"));
  // Realtime stand-in: NOTIFY with the row's user and its timestamp in
  // Postgres TEXT form ("2026-11-22 04:05:06.123+00"), one of the spellings
  // the app has to cope with.
  await c.query(`
    create or replace function public._test_notify() returns trigger language plpgsql as $$
    begin perform pg_notify('lifeos_changes', json_build_object('user_id', new.user_id, 'updated_at_text', new.updated_at::text)::text); return new; end $$;
    drop trigger if exists _test_notify on public.lifeos_data;
    create trigger _test_notify after insert or update on public.lifeos_data for each row execute function public._test_notify();`);
  await c.end();
  return {
    url,
    async sql(q, params) { const k = new pg.Client({ connectionString: url }); await k.connect(); try { return await k.query(q, params); } finally { await k.end(); } },
    async applySections() { const k = new pg.Client({ connectionString: url }); await k.connect(); await k.query("set client_min_messages = warning"); await k.query(readFileSync(join(root, "supabase-sections.sql"), "utf8")); await k.end(); },
    async addUser(uid) { await this.sql("insert into auth.users(id) values ($1) on conflict do nothing", [uid]); },
  };
}

export function versionOf(root) {
  const m = readFileSync(join(root, "index.html"), "utf8").match(/js\/app\.js\?v=([0-9A-Za-z]+)/);
  return m ? m[1] : "";
}

export async function bootDevice({ root, db, uid, name, seedLocal = null }) {
  const worker = new Worker(join(HERE, "device.mjs"), {
    workerData: { root, dbUrl: db.url, uid, name, seedLocal, version: versionOf(root) },
  });
  let seq = 0; const waiting = new Map();
  await new Promise((res, rej) => {
    worker.once("error", rej);
    worker.on("message", m => {
      if (m.ready) return res();
      const w = waiting.get(m.id); if (!w) return;
      waiting.delete(m.id);
      m.ok ? w.res(m.result) : w.rej(new Error(name + ": " + m.error));
    });
  });
  const call = (cmd, code) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); worker.postMessage({ id, cmd, code }); });
  const dev = {
    name,
    run: code => call("run", code),
    stats: () => call("stats"),
    resetStats: () => call("reset-stats"),
    async localStorageDump() { return dev.run("const o={}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); o[k]=localStorage.getItem(k);} return o;"); },
    async close() { try { await call("close"); } catch (_) {} await worker.terminate().catch(() => {}); },
  };
  await call("boot");
  return dev;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function until(fn, { timeout = 20000, every = 100, what = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("timed out waiting for " + what);
    await sleep(every);
  }
}
export const sum = (rows, re = /.*/) => rows.filter(([k]) => re.test(k)).reduce((a, [, b]) => a + b, 0);
