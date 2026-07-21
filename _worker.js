// Warehouse Fulfillment System — single-file Cloudflare Pages worker (advanced mode).
// Handles /api/* itself and serves static files (index.html) via env.ASSETS.
// Bindings (set in the Cloudflare Pages dashboard):
//   DB           -> D1 database "warehouse-db"
//   APP_PASSWORD -> shared login password
//
// This file contains NO secrets, so it is safe to keep in a public repo.

// ---------------- allocation engine ----------------
function normalizeItem(x) {
  return String(x == null ? "" : x).trim().toUpperCase();
}
function priorityTuple(need) {
  return [
    Number.isFinite(need.project_priority) ? need.project_priority : 1e9,
    Number.isFinite(need.jb_priority) ? need.jb_priority : 1e9,
    String(need.jb_number || ""),
    String(need.item_number || ""),
  ];
}
function compareNeeds(a, b) {
  const ta = priorityTuple(a), tb = priorityTuple(b);
  for (let i = 0; i < ta.length; i++) { if (ta[i] < tb[i]) return -1; if (ta[i] > tb[i]) return 1; }
  return 0;
}
function computeAllocation(inventory, needs) {
  const pool = new Map();
  for (const inv of inventory) {
    const key = normalizeItem(inv.item_number);
    if (!key) continue;
    pool.set(key, (pool.get(key) || 0) + Math.max(0, Number(inv.qty_available) || 0));
  }
  const demand = new Map();
  for (const n of needs) {
    const key = normalizeItem(n.item_number);
    const rem = Math.max(0, Number(n.remaining) || 0);
    if (rem > 0) demand.set(key, (demand.get(key) || 0) + rem);
  }
  const ordered = needs.filter((n) => (Number(n.remaining) || 0) > 0).slice().sort(compareNeeds);
  const allocations = [];
  for (const n of ordered) {
    const key = normalizeItem(n.item_number);
    const available = pool.get(key) || 0;
    if (available <= 0) continue;
    const give = Math.min(available, Math.max(0, Number(n.remaining) || 0));
    if (give <= 0) continue;
    pool.set(key, available - give);
    allocations.push({ jb_id: n.jb_id, jb_number: n.jb_number, project_id: n.project_id,
      item_number: n.item_number, description: n.description || "", qty_allocated: give });
  }
  const leftover = {};
  for (const [k, q] of pool.entries()) leftover[k] = q;
  const allocByItem = new Map();
  for (const a of allocations) {
    const k = normalizeItem(a.item_number);
    allocByItem.set(k, (allocByItem.get(k) || 0) + a.qty_allocated);
  }
  const shortages = [];
  for (const [k, dem] of demand.entries()) {
    const got = allocByItem.get(k) || 0;
    if (dem - got > 1e-9) shortages.push({ item_number: k, demand: dem, allocated: got, short: dem - got });
  }
  shortages.sort((a, b) => b.short - a.short);
  return { allocations, leftover, shortages };
}

// ---------------- helpers ----------------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ---------------- worker entry ----------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    // Static assets (index.html, etc.)
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = request.method.toUpperCase();
  const route = parts[0] || "";

  if (route === "login" && method === "POST") {
    let body = {}; try { body = await request.json(); } catch {}
    const ok = env.APP_PASSWORD && body.password === env.APP_PASSWORD;
    return ok ? json({ ok: true }) : bad("Wrong password.", 401);
  }

  const supplied = request.headers.get("x-app-password") || "";
  if (!env.APP_PASSWORD) return bad("Server has no APP_PASSWORD set.", 401);
  if (supplied !== env.APP_PASSWORD) return bad("Wrong password.", 401);
  if (!env.DB) return bad("Database (D1 binding 'DB') is not configured.", 500);
  const db = env.DB;

  try {
    if (route === "state" && method === "GET") return json(await getState(db));

    if (route === "projects" && method === "POST") {
      const b = await request.json();
      if (!b.name) return bad("Project name is required.");
      const r = await db.prepare("INSERT INTO projects (name, priority) VALUES (?, ?)").bind(b.name, num(b.priority, 100)).run();
      return json({ id: r.meta.last_row_id });
    }
    if (route === "projects" && method === "DELETE" && parts[1]) {
      await db.prepare("DELETE FROM projects WHERE id = ?").bind(+parts[1]).run();
      return json({ ok: true });
    }

    if (route === "jbs" && method === "POST") {
      const b = await request.json();
      if (!b.project_id || !b.jb_number) return bad("project_id and jb_number are required.");
      const r = await db.prepare(
        "INSERT INTO jbs (project_id, jb_number, name, priority) VALUES (?,?,?,?) " +
        "ON CONFLICT(project_id, jb_number) DO UPDATE SET name=excluded.name, priority=excluded.priority"
      ).bind(+b.project_id, String(b.jb_number), b.name || null, num(b.priority, 100)).run();
      return json({ id: r.meta.last_row_id });
    }
    if (route === "jbs" && method === "DELETE" && parts[1]) {
      await db.prepare("DELETE FROM jbs WHERE id = ?").bind(+parts[1]).run();
      return json({ ok: true });
    }

    if (route === "priority" && method === "POST") {
      const b = await request.json();
      const stmts = [];
      for (const p of b.projects || []) stmts.push(db.prepare("UPDATE projects SET priority=? WHERE id=?").bind(num(p.priority, 100), +p.id));
      for (const j of b.jbs || []) stmts.push(db.prepare("UPDATE jbs SET priority=? WHERE id=?").bind(num(j.priority, 100), +j.id));
      if (stmts.length) await db.batch(stmts);
      return json({ ok: true });
    }

    if (route === "jb-upload" && method === "POST") {
      const b = await request.json();
      let jbId = b.jb_id;
      if (!jbId) {
        if (!b.project_id || !b.jb_number) return bad("Need jb_id, or project_id + jb_number.");
        const r = await db.prepare(
          "INSERT INTO jbs (project_id, jb_number, name, priority) VALUES (?,?,?,?) " +
          "ON CONFLICT(project_id, jb_number) DO UPDATE SET name=COALESCE(excluded.name,jbs.name) RETURNING id"
        ).bind(+b.project_id, String(b.jb_number), b.name || null, num(b.priority, 100)).first();
        jbId = r.id;
      }
      const lines = Array.isArray(b.lines) ? b.lines : [];
      const stmts = [db.prepare("DELETE FROM jb_lines WHERE jb_id = ?").bind(+jbId)];
      const merged = new Map();
      for (const ln of lines) {
        const key = normalizeItem(ln.item_number); if (!key) continue;
        const prev = merged.get(key) || { item_number: String(ln.item_number).trim(), description: ln.description || "", qty: 0 };
        prev.qty += num(ln.qty_needed, 0);
        if (!prev.description && ln.description) prev.description = ln.description;
        merged.set(key, prev);
      }
      for (const m of merged.values())
        stmts.push(db.prepare("INSERT INTO jb_lines (jb_id, item_number, description, qty_needed) VALUES (?,?,?,?)").bind(+jbId, m.item_number, m.description, m.qty));
      await db.batch(stmts);
      return json({ ok: true, jb_id: jbId, lines: merged.size });
    }

    if (route === "inventory-upload" && method === "POST") {
      const b = await request.json();
      const items = Array.isArray(b.items) ? b.items : [];
      const merged = new Map();
      for (const it of items) {
        const key = normalizeItem(it.item_number); if (!key) continue;
        const prev = merged.get(key) || { item_number: String(it.item_number).trim(), description: it.description || "", qty: 0 };
        prev.qty += num(it.qty_available, 0);
        if (!prev.description && it.description) prev.description = it.description;
        merged.set(key, prev);
      }
      const stmts = [db.prepare("DELETE FROM inventory")];
      for (const m of merged.values())
        stmts.push(db.prepare("INSERT INTO inventory (item_number, description, qty_available) VALUES (?,?,?)").bind(m.item_number, m.description, m.qty));
      await db.batch(stmts);
      return json({ ok: true, items: merged.size });
    }

    if (route === "allocate" && method === "POST") {
      const b = await request.json().catch(() => ({}));
      return json(await runAllocation(db, b.created_by || ""));
    }

    if (route === "commit" && method === "POST") {
      const b = await request.json();
      if (!b.run_id) return bad("run_id required.");
      const run = await db.prepare("SELECT * FROM runs WHERE id=?").bind(+b.run_id).first();
      if (!run) return bad("Run not found.", 404);
      if (run.committed) return bad("Run already committed.");
      const allocs = (await db.prepare("SELECT * FROM allocations WHERE run_id=?").bind(+b.run_id).all()).results || [];
      const stmts = allocs.map((a) =>
        db.prepare("UPDATE jb_lines SET qty_fulfilled = qty_fulfilled + ? WHERE jb_id=? AND item_number=?").bind(a.qty_allocated, a.jb_id, a.item_number));
      stmts.push(db.prepare("UPDATE runs SET committed=1 WHERE id=?").bind(+b.run_id));
      if (stmts.length) await db.batch(stmts);
      return json({ ok: true });
    }

    if (route === "report" && method === "GET") return json(await getReport(db));
    if (route === "run" && method === "GET" && parts[1]) return json(await getRun(db, +parts[1]));

    return bad("Unknown route: /api/" + parts.join("/"), 404);
  } catch (err) {
    return bad("Server error: " + (err && err.message ? err.message : String(err)), 500);
  }
}

// ---------------- data access ----------------
async function getState(db) {
  const projects = (await db.prepare("SELECT * FROM projects ORDER BY priority, name").all()).results || [];
  const jbs = (await db.prepare("SELECT * FROM jbs ORDER BY priority, jb_number").all()).results || [];
  const lineCounts = (await db.prepare(
    "SELECT jb_id, COUNT(*) AS lines, SUM(qty_needed) AS needed, SUM(qty_fulfilled) AS fulfilled FROM jb_lines GROUP BY jb_id"
  ).all()).results || [];
  const invAgg = await db.prepare("SELECT COUNT(*) AS items, SUM(qty_available) AS qty, MAX(updated_at) AS updated FROM inventory").first();
  const lastRun = await db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").first();
  const lc = {}; for (const x of lineCounts) lc[x.jb_id] = x;
  for (const j of jbs) { const c = lc[j.id] || {}; j.line_count = c.lines || 0; j.total_needed = c.needed || 0; j.total_fulfilled = c.fulfilled || 0; }
  for (const p of projects) p.jbs = jbs.filter((j) => j.project_id === p.id);
  return { projects, inventory: { items: invAgg?.items || 0, qty: invAgg?.qty || 0, updated: invAgg?.updated || null }, last_run: lastRun || null };
}

async function loadNeeds(db) {
  const rows = (await db.prepare(
    `SELECT l.jb_id, l.item_number, l.description, l.qty_needed, l.qty_fulfilled,
            j.jb_number, j.priority AS jb_priority, j.project_id,
            p.priority AS project_priority, p.name AS project_name
     FROM jb_lines l JOIN jbs j ON j.id=l.jb_id JOIN projects p ON p.id=j.project_id`
  ).all()).results || [];
  return rows.map((r) => ({
    jb_id: r.jb_id, jb_number: r.jb_number, project_id: r.project_id, project_name: r.project_name,
    project_priority: r.project_priority, jb_priority: r.jb_priority, item_number: r.item_number,
    description: r.description, remaining: (Number(r.qty_needed) || 0) - (Number(r.qty_fulfilled) || 0),
  }));
}

async function runAllocation(db, createdBy) {
  const inventory = (await db.prepare("SELECT item_number, description, qty_available FROM inventory").all()).results || [];
  const needs = await loadNeeds(db);
  const { allocations, leftover, shortages } = computeAllocation(inventory, needs);
  const run = await db.prepare("INSERT INTO runs (created_by, committed) VALUES (?, 0) RETURNING id").bind(createdBy || null).first();
  const runId = run.id;
  if (allocations.length) {
    await db.batch(allocations.map((a) =>
      db.prepare("INSERT INTO allocations (run_id, jb_id, item_number, description, qty_allocated) VALUES (?,?,?,?,?)")
        .bind(runId, a.jb_id, a.item_number, a.description || "", a.qty_allocated)));
  }
  const pick = await getRun(db, runId);
  return { run_id: runId, ...pick, leftover, shortages };
}

async function getRun(db, runId) {
  const run = await db.prepare("SELECT * FROM runs WHERE id=?").bind(runId).first();
  const rows = (await db.prepare(
    `SELECT a.jb_id, a.item_number, a.description, a.qty_allocated,
            j.jb_number, p.id AS project_id, p.name AS project_name
     FROM allocations a JOIN jbs j ON j.id=a.jb_id JOIN projects p ON p.id=j.project_id
     WHERE a.run_id=? ORDER BY p.priority, j.priority, j.jb_number, a.item_number`
  ).bind(runId).all()).results || [];
  const projects = {};
  for (const r of rows) {
    const pk = r.project_id;
    projects[pk] = projects[pk] || { project_id: pk, project_name: r.project_name, jbs: {} };
    const jk = r.jb_id;
    projects[pk].jbs[jk] = projects[pk].jbs[jk] || { jb_id: jk, jb_number: r.jb_number, items: [] };
    projects[pk].jbs[jk].items.push({ item_number: r.item_number, description: r.description, qty: r.qty_allocated });
  }
  const grouped = Object.values(projects).map((p) => ({ ...p, jbs: Object.values(p.jbs) }));
  return { run, pick_list: grouped, total_lines: rows.length };
}

async function getReport(db) {
  const jbRows = (await db.prepare(
    `SELECT p.id AS project_id, p.name AS project_name, p.priority AS project_priority,
            j.id AS jb_id, j.jb_number, j.priority AS jb_priority,
            l.item_number, l.description, l.qty_needed, l.qty_fulfilled
     FROM projects p JOIN jbs j ON j.project_id=p.id
     LEFT JOIN jb_lines l ON l.jb_id=j.id
     ORDER BY p.priority, j.priority, j.jb_number, l.item_number`
  ).all()).results || [];
  const projects = {}, totals = {};
  for (const r of jbRows) {
    projects[r.project_id] = projects[r.project_id] || { project_id: r.project_id, project_name: r.project_name, jbs: {} };
    if (r.jb_id) {
      const jb = (projects[r.project_id].jbs[r.jb_id] = projects[r.project_id].jbs[r.jb_id] || { jb_id: r.jb_id, jb_number: r.jb_number, items: [] });
      if (r.item_number) {
        const needed = Number(r.qty_needed) || 0, fulfilled = Number(r.qty_fulfilled) || 0;
        jb.items.push({ item_number: r.item_number, description: r.description, needed, fulfilled, remaining: needed - fulfilled });
        totals[r.project_id] = totals[r.project_id] || {};
        const t = (totals[r.project_id][normalizeItem(r.item_number)] =
          totals[r.project_id][normalizeItem(r.item_number)] || { item_number: r.item_number, description: r.description, needed: 0, fulfilled: 0 });
        t.needed += needed; t.fulfilled += fulfilled;
      }
    }
  }
  const out = Object.values(projects).map((p) => ({
    project_id: p.project_id, project_name: p.project_name, jbs: Object.values(p.jbs),
    totals: Object.values(totals[p.project_id] || {}).map((t) => ({ ...t, remaining: t.needed - t.fulfilled })),
  }));
  return { projects: out };
}
