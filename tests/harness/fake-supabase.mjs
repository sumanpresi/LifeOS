/* A stand-in for the supabase-js client, backed by a REAL Postgres with
   the real LifeOS SQL applied (tests/sql/supabase-shim.sql +
   supabase-setup.sql + supabase-sections.sql).

   Every call runs as role `authenticated` with auth.uid() set to the
   device's user, so RLS and the SQL functions behave as they do on
   Supabase. Responses are serialised exactly the way PostgREST would
   (Postgres JSON), and their size is counted as "egress" — the number
   this whole exercise is about. */
import pg from "pg";

export function createFakeClient({ dbUrl, uid, onEgress, onRequest }) {
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  let listenClient = null;

  async function asUser(sql, params) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      const r = await c.query(sql, params);
      await c.query("commit");
      return r;
    } catch (e) {
      try { await c.query("rollback"); } catch (_) {}
      throw e;
    } finally { c.release(); }
  }
  function pgError(e) {
    // PostgREST reports a missing function as PGRST202 (HTTP 404).
    if (e.code === "42883") return { code: "PGRST202", message: "Could not find the function " + (e.message || ""), hint: null };
    return { code: e.code, message: e.message, hint: e.hint || null, details: e.detail || null };
  }
  const count = (kind, body, sentBytes) => {
    const bytes = body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body));
    onEgress && onEgress(kind, bytes);
    onRequest && onRequest(kind, sentBytes || 0);
  };

  function from(table) {
    const q = { table, cols: "*", filters: [] };
    const api = {
      select(cols) { q.cols = cols; q.op = "select"; return api; },
      eq(col, val) { q.filters.push([col, val]); return api; },
      async maybeSingle() {
        const where = q.filters.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
        const cols = q.cols.split(",").map(s => s.trim()).join(", ");
        try {
          // row_to_json: the same serialisation PostgREST uses.
          const r = await asUser(`select row_to_json(t) as j from (select ${cols} from public.${table} where ${where}) t`,
                                 q.filters.map(f => f[1]));
          const data = r.rows[0] ? r.rows[0].j : null;
          count("select " + table + "(" + cols + ")", data);
          return { data, error: null };
        } catch (e) { count("select-error", null); return { data: null, error: pgError(e) }; }
      },
      async upsert(row) {
        const keys = Object.keys(row);
        const sent = Buffer.byteLength(JSON.stringify(row));
        try {
          await asUser(
            `insert into public.${table} (${keys.join(",")}) values (${keys.map((k, i) => `$${i + 1}`).join(",")})
             on conflict (user_id) do update set ${keys.filter(k => k !== "user_id").map(k => `${k} = excluded.${k}`).join(", ")}`,
            keys.map(k => (row[k] !== null && typeof row[k] === "object") ? JSON.stringify(row[k]) : row[k]));
          count("upsert " + table, undefined, sent);
          return { data: null, error: null };
        } catch (e) { count("upsert-error", undefined, sent); return { data: null, error: pgError(e) }; }
      },
    };
    return api;
  }

  async function rpc(name, args) {
    const keys = Object.keys(args || {});
    const sent = Buffer.byteLength(JSON.stringify(args || {}));
    const casts = { p_have: "jsonb", p_head: "jsonb", p_sections: "jsonb", p_base: "timestamptz", p_stamp: "timestamptz" };
    try {
      const r = await asUser(`select to_jsonb(public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${casts[k] || "text"}`).join(", ")})) as j`,
        keys.map(k => (args[k] !== null && typeof args[k] === "object") ? JSON.stringify(args[k]) : args[k]));
      const data = r.rows[0] ? r.rows[0].j : null;
      count("rpc " + name, data, sent);
      return { data, error: null };
    } catch (e) { count("rpc-error " + name, null, sent); return { data: null, error: pgError(e) }; }
  }

  const session = { user: { id: uid, email: uid + "@test" }, access_token: "test-token" };
  const auth = {
    async getSession() { return { data: { session } }; },
    onAuthStateChange(cb) { setTimeout(() => cb("SIGNED_IN", session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
    async signInWithOAuth() { return { data: {}, error: null }; },
    async signOut() { return { error: null }; },
  };

  /* Realtime: a trigger in the test database NOTIFYs on every write to
     lifeos_data; this delivers it the way Supabase would, with the
     column selection honoured (user_id, updated_at only). */
  const channels = [];
  function channel(name) {
    const ch = { name, handlers: [], status: null };
    ch.on = (type, opts, cb) => { ch.handlers.push({ opts, cb }); return ch; };
    ch.subscribe = statusCb => {
      (async () => {
        if (!listenClient) {
          listenClient = new pg.Client({ connectionString: dbUrl });
          await listenClient.connect();
          await listenClient.query("listen lifeos_changes");
          listenClient.on("notification", msg => {
            let p; try { p = JSON.parse(msg.payload); } catch (_) { return; }
            if (p.user_id !== uid) return;
            const bytes = Buffer.byteLength(msg.payload);
            onEgress && onEgress("realtime", bytes);
            for (const c of channels) for (const h of c.handlers) {
              try { h.cb({ eventType: "UPDATE", new: { user_id: p.user_id, updated_at: p.updated_at_text } }); } catch (_) {}
            }
          });
        }
        statusCb && statusCb("SUBSCRIBED");
      })();
      channels.push(ch);
      return ch;
    };
    return ch;
  }
  function removeChannel(ch) { const i = channels.indexOf(ch); if (i >= 0) channels.splice(i, 1); }

  async function close() { try { await pool.end(); } catch (_) {} try { if (listenClient) await listenClient.end(); } catch (_) {} }

  return { from, rpc, auth, channel, removeChannel, close };
}
