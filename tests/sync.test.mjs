#!/usr/bin/env node
/* LifeOS sync — end-to-end tests and egress benchmark.

   Boots the REAL app (index.html + js/app.js and everything it imports)
   as several independent "devices" in worker threads, against a real
   local Postgres running the real supabase-setup.sql and
   supabase-sections.sql. Nothing in js/ is mocked; only the network layer
   (supabase-js) is replaced by a client that runs the same SQL as
   authenticated users would.

     LIFEOS_TEST_PG=postgresql://postgres@localhost:5433/postgres?host=/tmp/pg \
       node tests/sync.test.mjs [--baseline /path/to/original/checkout]

   --baseline runs the same workload against another checkout (e.g. the
   commit before this change) and prints the before/after egress table. */
import { makeDb, bootDevice, sleep, until, sum } from "./harness/world.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselineIdx = process.argv.indexOf("--baseline");
const BASELINE = baselineIdx > 0 ? process.argv[baselineIdx + 1] : null;
const only = (process.argv.find(a => a.startsWith("--only=")) || "").slice(7);

const UID = "11111111-1111-1111-1111-111111111111";
const UID2 = "22222222-2222-2222-2222-222222222222";
let failures = 0, passes = 0;
const results = [];
function check(cond, msg, extra) {
  if (cond) { passes++; console.log("    ✓ " + msg); }
  else { failures++; console.log("    ✗ " + msg + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}
const KB = b => (b / 1024).toFixed(1) + " KB";

/* A document of realistic weight: ~300 tasks, 200 journal days and a
   whiteboard with 800 pen strokes — about 1.2 MB of JSON, ~0.6 MB gzipped,
   close to the real account's 648 KB row. */
const FILL = `
  const st = S.state.state;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const word = () => Math.floor(rnd() * 1e9).toString(36);
  const words = n => Array.from({ length: n }, word).join(" ");
  for (let i = 0; i < 300; i++) st.tasks.push({ id: "bt" + i, text: "Task " + words(6), done: false, category: "work", flag: false, link: "", dueDate: "", updatedAt: Date.now() });
  for (let d = 0; d < 200; d++) { const k = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10); st.journal[k] = "<p>" + words(90) + "</p>"; st.journalUpdated[k] = Date.now(); }
  st.whiteboards.overview.strokes = Array.from({ length: 800 }, () => ({ color: "#333", width: 2, points: Array.from({ length: 60 }, () => ({ x: +(rnd() * 1000).toFixed(1), y: +(rnd() * 800).toFixed(1) })) }));
  S.state.persist();
  return JSON.stringify(st).length;`;

const toggle = id => `const t = S.state.state.tasks.find(t => t.id === ${JSON.stringify(id)}); t.done = !t.done; t.updatedAt = Date.now(); S.state.persist(); return t.done;`;
const taskDone = id => `const t = S.state.state.tasks.find(t => t.id === ${JSON.stringify(id)}); return t ? t.done : null;`;
const addTask = (id, text) => `S.state.state.tasks.push({ id: ${JSON.stringify(id)}, text: ${JSON.stringify(text)}, done: false, category: "work", flag: false, link: "", dueDate: "", updatedAt: Date.now() }); S.state.persist(); return true;`;
const hasTask = id => `return !!S.state.state.tasks.find(t => t.id === ${JSON.stringify(id)});`;

async function cloudTask(db, id) {
  const r = await db.sql("select data from lifeos_data where user_id = $1", [UID]);
  if (!r.rows[0]) return undefined;
  const d = r.rows[0].data;
  if (d._layout === "lifeos-sections-v1") {
    const s = (await db.sql("select enc, body from lifeos_sections where user_id = $1 and key = 'tasks'", [UID])).rows[0];
    const { gunzipSync } = await import("node:zlib");
    const json = s.enc === "gz" ? gunzipSync(Buffer.from(s.body, "base64")).toString() : s.body;
    const t = JSON.parse(json).find(t => t.id === id); return t ? t.done : null;
  }
  let doc = d;
  if (d._transport === "lifeos-gzip-v1" && d.z) { const { gunzipSync } = await import("node:zlib"); doc = JSON.parse(gunzipSync(Buffer.from(d.z, "base64")).toString()); }
  const t = (doc.tasks || []).find(t => t.id === id); return t ? t.done : null;
}

/* ---------- the workload used for the before/after numbers ---------- */
async function workload(root, label, { sections }) {
  const db = await makeDb("w_" + label, root, { sections });
  await db.addUser(UID);
  const A = await bootDevice({ root, db, uid: UID, name: "A" });
  await sleep(1500);
  const raw = await A.run(FILL);
  await until(async () => (await A.stats()).pill.startsWith("Synced") && (await db.sql("select 1 from lifeos_data")).rowCount, { what: "A seeded" });
  await sleep(2500);       // compression handshake on the original build takes one more save
  await A.run(toggle("bt0")); await sleep(2500);
  await A.run(toggle("bt0")); await sleep(2500);
  const B = await bootDevice({ root, db, uid: UID, name: "B" });
  await until(async () => (await B.run(hasTask("bt299"))), { what: "B has the document", timeout: 30000 });
  await sleep(2000);
  const row = (await db.sql("select length(data::text) as n from lifeos_data")).rows[0].n;
  await A.resetStats(); await B.resetStats();

  const EDITS = 10;
  for (let i = 0; i < EDITS; i++) {
    const want = await A.run(toggle("bt" + (10 + i)));
    await until(async () => (await B.run(taskDone("bt" + (10 + i)))) === want, { what: "B sees edit " + i, timeout: 30000 });
    await sleep(1200);
  }
  await sleep(3000);
  const a = await A.stats(), b = await B.stats();
  const out = {
    label, rawDoc: raw, cloudRow: row,
    perEdit: {
      aDown: sum(a.egress) / EDITS, bDown: sum(b.egress) / EDITS,
      aUp: sum(a.uploads) / EDITS, aDownFull: a.egress.filter(([k, n]) => n > 50000).length,
    },
    aDiag: a.diag.slice(-6), bDiag: b.diag.slice(-4), errors: [...a.errors, ...b.errors],
  };
  await A.close(); await B.close();
  return out;
}

const scenarios = {
  /* ---------------------------------------------------------------- */
  async "SQL: functions, CAS, consistency, RLS"() {
    const db = await makeDb("t_sql", ROOT);
    await db.addUser(UID); await db.addUser(UID2);
    const as = async (uid, q, p) => db.sql(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true); ${q}; commit;`.replace("; commit;", ""), p).catch(e => e);
    const one = async (uid, q, p) => {
      const k = new (await import("pg")).default.Client({ connectionString: db.url }); await k.connect();
      try { await k.query("begin"); await k.query("set local role " + (uid ? "authenticated" : "anon"));
        if (uid) await k.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
        const r = await k.query(q, p); await k.query("commit"); return r; }
      catch (e) { await k.query("rollback").catch(() => {}); return e; } finally { await k.end(); }
    };
    void as;
    const head = m => JSON.stringify({ _transport: "lifeos-gzip-v1", z: "", _layout: "lifeos-sections-v1", m, core: { rev: 1 }, compressionReady: true, updatedAt: 0, rev: 0 });
    const push = (uid, base, stamp, m, secs) => one(uid, "select lifeos_push($1::timestamptz, $2::timestamptz, $3::jsonb, $4::jsonb) as r", [base, stamp, head(m), JSON.stringify(secs)]);
    const pull = (uid, have) => one(uid, "select lifeos_pull($1::jsonb) as r", [JSON.stringify(have)]);

    let r = await push(UID, null, "2026-11-22T01:00:00.000Z", { tasks: "h1", notes: "n1" },
      { tasks: { hash: "h1", enc: "json", body: "[1]" }, notes: { hash: "n1", enc: "json", body: "{}" } });
    check(r.rows && r.rows[0].r.ok === true, "first push creates the head and sections", r.message);
    r = await pull(UID, {});
    check(r.rows[0].r.sections.length === 2, "pull with nothing held returns every section");
    r = await pull(UID, { tasks: "h1" });
    check(r.rows[0].r.sections.length === 1 && r.rows[0].r.sections[0].key === "notes", "pull returns only sections whose fingerprint differs");
    check(/\+00:00$/.test(r.rows[0].r.updated_at), "pull reports the stamp in the REST spelling the client must normalise", r.rows[0].r.updated_at);

    r = await push(UID, "2026-11-22T00:59:00.000Z", "2026-11-22T01:01:00.000Z", { tasks: "h2", notes: "n1" }, { tasks: { hash: "h2", enc: "json", body: "[2]" } });
    check(r.rows && r.rows[0].r.conflict === true, "push from a stale base is refused as a conflict");
    r = await pull(UID, {});
    check(r.rows[0].r.sections.find(s => s.key === "tasks").body === "[1]", "…and nothing was written by the refused push");

    r = await push(UID, "2026-11-22T01:00:00.000+00:00", "2026-11-22T01:02:00.000Z", { tasks: "h2", notes: "n1" }, { tasks: { hash: "h2", enc: "json", body: "[2]" } });
    check(r.rows && r.rows[0].r.ok === true, "push from the current base (any spelling) succeeds and sends only the changed section");

    r = await push(UID, "2026-11-22T01:02:00.000Z", "2026-11-22T01:03:00.000Z", { tasks: "h3", notes: "n9" }, { tasks: { hash: "h3", enc: "json", body: "[3]" } });
    check(r instanceof Error && /section\(s\) missing/.test(r.message), "a head naming a section the cloud lacks is rejected", r.message);
    r = await pull(UID, {});
    check(r.rows[0].r.sections.find(s => s.key === "tasks").body === "[2]" && r.rows[0].r.data.m.tasks === "h2", "…and the whole push rolled back (sections and head)");

    r = await push(UID, "2026-11-22T01:02:00.000Z", "2026-11-22T01:04:00.000Z", { tasks: "h2" }, {});
    r = await pull(UID, {});
    check(r.rows[0].r.sections.length === 1, "sections dropped from the head are deleted");

    r = await pull(UID2, {});
    check(r.rows && r.rows[0].r === null, "another user sees no row at all (RLS)");
    r = await one(UID2, "select count(*)::int n from lifeos_sections", []);
    check(r.rows[0].n === 0, "another user cannot read this user's sections (RLS)");
    r = await push(UID2, null, "2026-11-22T01:00:00.000Z", { x: "1" }, { x: { hash: "1", enc: "json", body: "1" } });
    r = await one(UID, "select count(*)::int n from lifeos_sections where key = 'x'", []);
    check(r.rows[0].n === 0, "one user's push never lands in another user's sections");
    r = await one(null, "select lifeos_pull('{}'::jsonb)", []);
    check(r instanceof Error && /permission denied/.test(r.message), "anonymous callers cannot execute the functions", r.message);
  },

  /* ---------------------------------------------------------------- */
  async "Own saves are not downloaded back (stamp spelling bug)"() {
    const db = await makeDb("t_echo", ROOT, { sections: false });   // legacy mode: isolates the stamp fix
    await db.addUser(UID);
    const A = await bootDevice({ root: ROOT, db, uid: UID, name: "A" });
    await sleep(1500);
    await A.run(FILL);
    await until(async () => (await A.stats()).pill.startsWith("Synced"), { what: "seed" });
    await sleep(3000);
    await A.resetStats();
    for (let i = 0; i < 3; i++) { await A.run(toggle("bt" + i)); await sleep(2500); }
    await sleep(2500);
    const s = await A.stats();
    const fullReads = s.egress.filter(([, n]) => n > 50000).length;
    check(fullReads === 0, "after 3 saves the saving device downloaded its own document 0 times", s.egress.filter(([, n]) => n > 1000));
    check(s.errors.length === 0, "no errors", s.errors);
    await A.close();
  },

  /* ---------------------------------------------------------------- */
  async "Per-section sync between two devices"() {
    const r = await workload(ROOT, "new", { sections: true });
    results.push(r);
    check(r.perEdit.aDownFull === 0, "editing device never downloads a full document");
    check(r.perEdit.bDown < 40 * 1024, "other device downloads < 40 KB per edit", KB(r.perEdit.bDown));
    check(r.perEdit.aUp < 40 * 1024, "editing device uploads < 40 KB per edit", KB(r.perEdit.aUp));
    check(r.errors.length === 0, "no errors", r.errors);
  },

  /* ---------------------------------------------------------------- */
  async "Concurrent edits on two devices: nothing overwritten"() {
    const db = await makeDb("t_conflict", ROOT);
    await db.addUser(UID);
    const A = await bootDevice({ root: ROOT, db, uid: UID, name: "A" });
    await sleep(1500); await A.run(FILL);
    await until(async () => (await A.stats()).pill.startsWith("Synced"), { what: "seed" });
    const B = await bootDevice({ root: ROOT, db, uid: UID, name: "B" });
    await until(async () => B.run(hasTask("bt299")), { what: "B loaded", timeout: 30000 });
    await sleep(2000);
    // Both devices add a different task in the same instant; both saves race.
    await Promise.all([A.run(addTask("fromA", "made on A")), B.run(addTask("fromB", "made on B"))]);
    await until(async () => (await A.run(hasTask("fromB"))) && (await B.run(hasTask("fromA"))),
      { what: "both devices hold both tasks", timeout: 40000 });
    await sleep(4000);
    const both = (await A.run(hasTask("fromA"))) && (await A.run(hasTask("fromB"))) && (await B.run(hasTask("fromA"))) && (await B.run(hasTask("fromB")));
    check(both, "both new tasks survive on both devices");
    const inCloud = (await cloudTask(db, "fromA")) !== undefined && (await cloudTask(db, "fromA")) !== null && (await cloudTask(db, "fromB")) !== null;
    check(inCloud, "both new tasks are in the cloud");
    const a = await A.stats(), b = await B.stats();
    check([...a.diag, ...b.diag].some(l => /save held back/.test(l)), "the race was detected (a save was held back rather than overwriting)",
      [...a.diag, ...b.diag].slice(-8));
    check(a.errors.length + b.errors.length === 0, "no errors", [...a.errors, ...b.errors]);
    await A.close(); await B.close();
  },

  /* ---------------------------------------------------------------- */
  async "Edit made while an upload is in flight is not lost"() {
    const db = await makeDb("t_inflight", ROOT);
    await db.addUser(UID);
    const A = await bootDevice({ root: ROOT, db, uid: UID, name: "A" });
    await sleep(1500); await A.run(FILL);
    await until(async () => (await A.stats()).pill.startsWith("Synced"), { what: "seed" });
    await sleep(2000);
    // Hold the next upload on the wire for 3 s, then edit mid-flight.
    await A.run(`const orig = window.supabase.createClient().rpc; window.__slow = true;
      const c = window.supabase.createClient(); const rpc = c.rpc;
      c.rpc = async (n, a) => { if (window.__slow && n === "lifeos_push") { window.__slow = false; await new Promise(r => setTimeout(r, 3000)); } return rpc(n, a); };`);
    await A.run(toggle("bt1"));                      // save starts after 1.5 s, lands at ~4.5 s
    await sleep(2000);
    await A.run(toggle("bt2"));                      // edited while that upload is still in flight
    await sleep(9000);                               // no further edits
    check((await cloudTask(db, "bt2")) === true, "the mid-flight edit reached the cloud without any further edit");
    await A.close();
  },

  /* ---------------------------------------------------------------- */
  async "Migration from a whole-document account"() {
    const db = await makeDb("t_migrate", ROOT, { sections: false });
    await db.addUser(UID);
    let A = await bootDevice({ root: ROOT, db, uid: UID, name: "A" });
    await sleep(1500); await A.run(FILL);
    await until(async () => (await A.stats()).pill.startsWith("Synced"), { what: "seed" });
    await sleep(3000);
    let B = await bootDevice({ root: ROOT, db, uid: UID, name: "B" });
    await until(async () => B.run(hasTask("bt299")), { what: "B loaded", timeout: 30000 });
    await sleep(2000);
    const before = (await db.sql("select length(data::text) n, data->>'_layout' l from lifeos_data")).rows[0];
    check(!before.l && before.n > 100000, "account starts as one whole-document row", before);
    // The person runs supabase-sections.sql; both devices reload.
    await db.applySections();
    const la = await A.localStorageDump(), lb = await B.localStorageDump();
    await A.close(); await B.close();
    A = await bootDevice({ root: ROOT, db, uid: UID, name: "A2", seedLocal: la });
    B = await bootDevice({ root: ROOT, db, uid: UID, name: "B2", seedLocal: lb });
    await sleep(3000);
    await A.resetStats(); await B.resetStats();
    const want = await A.run(toggle("bt5"));
    await until(async () => (await B.run(taskDone("bt5"))) === want, { what: "B sees the edit after migration", timeout: 30000 });
    await sleep(2000);
    const after = (await db.sql("select length(data::text) n, data->>'_layout' l from lifeos_data")).rows[0];
    check(after.l === "lifeos-sections-v1" && after.n < 10000, "row converted to a small head on the first save", after);
    const b = await B.stats();
    check(sum(b.egress) < 40 * 1024, "the other device's first read after conversion fetches only what differs, not the document", KB(sum(b.egress)));
    check([...(await A.stats()).errors, ...b.errors].length === 0, "no errors");
    await A.close(); await B.close();
  },

  /* ---------------------------------------------------------------- */
  async "An older build writes over the head"() {
    const db = await makeDb("t_oldwrite", ROOT);
    await db.addUser(UID);
    const A = await bootDevice({ root: ROOT, db, uid: UID, name: "A" });
    await sleep(1500); await A.run(FILL);
    await until(async () => (await A.stats()).pill.startsWith("Synced"), { what: "seed" });
    await sleep(2500);
    // What an old build's upsert puts there: its whole document, gzipped, with one task of its own.
    const doc = await A.run("return JSON.parse(JSON.stringify(S.state.state));");
    doc.tasks.push({ id: "fromOld", text: "made on an old build", done: false, updatedAt: Date.now() });
    doc.syncToken = "oldbuild"; doc.updatedAt = Date.now();
    const z = gzipSync(Buffer.from(JSON.stringify(doc))).toString("base64");
    await db.sql("update lifeos_data set data = $1::jsonb, updated_at = now() where user_id = $2",
      [JSON.stringify({ _transport: "lifeos-gzip-v1", z, compressionReady: true, updatedAt: 0, rev: 0 }), UID]);
    await until(async () => A.run(hasTask("fromOld")), { what: "A merges the old build's write", timeout: 30000 });
    await until(async () => (await db.sql("select data->>'_layout' l from lifeos_data")).rows[0].l === "lifeos-sections-v1",
      { what: "A converts the row back", timeout: 30000 });
    const snaps = await A.run(`try { return JSON.parse(localStorage.getItem("lifeos-snapshots") || "[]").map(s => s.reason); } catch (e) { return []; }`);
    check(snaps.includes("before-older-build-overwrite"), "a restorable snapshot was taken first", snaps);
    check(true, "the old build's task was merged in and the row was converted back");
    await A.close();
  },

  /* ---------------------------------------------------------------- */
  async "Original build meets a sectioned row: fails safe"() {
    if (!BASELINE) { console.log("    (skipped — needs --baseline)"); return; }
    const db = await makeDb("t_oldread", ROOT);
    await db.addUser(UID);
    const A = await bootDevice({ root: ROOT, db, uid: UID, name: "A" });
    await sleep(1500); await A.run(FILL);
    await until(async () => (await A.stats()).pill.startsWith("Synced"), { what: "seed" });
    await sleep(2500);
    const head0 = (await db.sql("select data::text t, updated_at from lifeos_data")).rows[0];
    const OLD = await bootDevice({ root: BASELINE, db, uid: UID, name: "OLD" });
    await sleep(3000);
    await OLD.run(addTask("oldEdit", "edit on the old build"));
    await sleep(6000);
    const head1 = (await db.sql("select data::text t, updated_at from lifeos_data")).rows[0];
    check(head1.t === head0.t, "the original build never wrote over the sectioned row");
    check(/fail/i.test((await OLD.stats()).pill), "…and it says sync failed instead of pretending", (await OLD.stats()).pill);
    await OLD.close(); await A.close();
  },

  /* ---------------------------------------------------------------- */
  async "Projects without supabase-sections.sql keep working"() {
    const db = await makeDb("t_nosql", ROOT, { sections: false });
    await db.addUser(UID);
    const A = await bootDevice({ root: ROOT, db, uid: UID, name: "A" });
    await sleep(1500); await A.run(FILL);
    await until(async () => (await A.stats()).pill.startsWith("Synced"), { what: "seed" });
    const B = await bootDevice({ root: ROOT, db, uid: UID, name: "B" });
    await until(async () => B.run(hasTask("bt299")), { what: "B loaded", timeout: 30000 });
    const want = await A.run(toggle("bt7"));
    await until(async () => (await B.run(taskDone("bt7"))) === want, { what: "B sees A's edit", timeout: 30000 });
    check(true, "whole-document sync still works end to end");
    const d = (await A.stats()).diag;
    check(d.some(l => /per-section sync unavailable/.test(l)), "the device explains why it is using whole-document sync");
    await A.close(); await B.close();
  },
};

for (const [name, fn] of Object.entries(scenarios)) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) continue;
  console.log("\n● " + name);
  const t0 = Date.now();
  try { await fn(); } catch (e) { failures++; console.log("    ✗ threw: " + (e.stack || e)); }
  console.log("    (" + ((Date.now() - t0) / 1000).toFixed(1) + " s)");
}

if (BASELINE && (!only || /baseline|section/i.test(only))) {
  console.log("\n● Baseline: the same workload on " + BASELINE);
  try { results.unshift(await workload(BASELINE, "before", { sections: false })); }
  catch (e) { console.log("    baseline failed: " + e.message); }
}
if (results.length) {
  console.log("\n  Egress per single edit (10 edits, two devices open)");
  console.log("  " + ["", "cloud row", "editing device ↓", "other device ↓", "editing device ↑"].map(s => s.padEnd(18)).join(""));
  for (const r of results) console.log("  " + [r.label, KB(r.cloudRow), KB(r.perEdit.aDown), KB(r.perEdit.bDown), KB(r.perEdit.aUp)].map(s => String(s).padEnd(18)).join(""));
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
