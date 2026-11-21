// HELLBALL ULTIMATE server (Cloudflare Worker, free plan): online 1v1 relay rooms + WORLD BOARD leaderboards and stat sheets.
// Based on the HELLBALL 2 server. Deployed from the server/ folder of this repo.
// HELLBALL server: serves the game files and relays online matches.
// 1v1 rooms: one Durable Object holding at most two WebSockets; it forwards every message to the other player.
// King of the Hill rooms (name starts with "k"): up to KOTH_MAX players; two play, the rest spectate in a queue.
// The server decides who is on, who is next and who holds the streak; the players still referee their own ends.
// Inside Discord the room name comes from the activity instance id, so everyone in the same activity shares a room.
const KOTH_MAX = 4, KOTH_WIN = 5;
export class Room {
  constructor(state) { this.state = state; this.k = null; }
  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
    const room = req.headers.get("X-Room") || "";
    if (room[0] === "k") return this.kJoin();
    const [client, server] = Object.values(new WebSocketPair());
    const open = this.state.getWebSockets();
    if (open.length >= 2) {                                   // two already playing: say so and hang up
      server.accept(); server.send(JSON.stringify({ t: "full" })); server.close(1000, "full");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ host: open.length === 0 });  // the first one in serves first
    const all = this.state.getWebSockets();
    if (all.length === 2) for (const w of all) w.send(JSON.stringify({ t: "peer", host: !!(w.deserializeAttachment() || {}).host }));
    else server.send(JSON.stringify({ t: "wait" }));
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, msg) {
    if (typeof msg !== "string" || msg.length > 2048) return;
    for (const w of this.state.getWebSockets()) if (w !== ws) try { w.send(msg); } catch (e) {}
  }
  gone(ws) {
    for (const w of this.state.getWebSockets()) if (w !== ws) {   // whoever is left keeps the room and becomes the host
      w.serializeAttachment({ host: true });
      try { w.send(JSON.stringify({ t: "left" })); w.send(JSON.stringify({ t: "wait" })); } catch (e) {}
    }
  }
  webSocketClose(ws, code) { this.gone(ws); try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch (e) {} }
  webSocketError(ws) { this.gone(ws); }

  /* ---------- King of the Hill: plain (non-hibernating) sockets, state kept in memory while anyone is connected ---------- */
  kJoin() {
    const k = this.k || (this.k = { socks: new Map(), line: [], champ: null, chal: null, streak: 0, ep: 0, serve: null, next: 1 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    if (k.socks.size >= KOTH_MAX) { server.send(JSON.stringify({ t: "full", max: KOTH_MAX })); server.close(1000, "full"); return new Response(null, { status: 101, webSocket: client }); }
    const id = k.next++;
    k.socks.set(id, server); k.line.push(id);
    server.addEventListener("message", e => this.kMsg(id, e.data));
    server.addEventListener("close", () => this.kLeave(id));
    server.addEventListener("error", () => this.kLeave(id));
    this.kFill(); this.kSend();
    return new Response(null, { status: 101, webSocket: client });
  }
  kFill() {                                                   // put people on court from the front of the line
    const k = this.k; let changed = false;
    if (k.champ == null && k.line.length) { k.champ = k.line.shift(); k.streak = 0; changed = true; }
    if (k.chal == null && k.champ != null && k.line.length) { k.chal = k.line.shift(); k.serve = k.chal; changed = true; }
    if (changed) k.ep++;
  }
  kState(you, extra) {
    const k = this.k;
    return JSON.stringify(Object.assign({ t: "ks", you, champ: k.champ, chal: k.chal, streak: k.streak, line: k.line, serve: k.serve, ep: k.ep, win: KOTH_WIN, max: KOTH_MAX }, extra || {}));
  }
  kSend(extra) { for (const [id, w] of this.k.socks) try { w.send(this.kState(id, extra)); } catch (e) {} }
  kMsg(id, data) {
    const k = this.k; if (!k || typeof data !== "string" || data.length > 2048) return;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (m.t === "ping") { try { k.socks.get(id).send(JSON.stringify({ t: "pong", ts: m.ts })); } catch (e) {} return; }
    const active = id === k.champ || id === k.chal;
    if (m.t === "kmiss") {                                    // a player missed at their own end: the point is decided
      if (!active || m.ep !== k.ep || k.champ == null || k.chal == null) return;
      const loser = id, winner = id === k.champ ? k.chal : k.champ;
      if (winner === k.champ) k.streak++; else { k.champ = winner; k.streak = 1; }
      const won = k.streak >= KOTH_WIN ? winner : null;
      if (won) k.streak = 0;                                  // a new game starts straight away, the winner stays on
      if (k.line.length) { k.line.push(loser); k.chal = k.line.shift(); } else k.chal = loser;
      k.serve = k.chal; k.ep++;
      this.kSend({ pt: { winner, loser, won } });
      return;
    }
    if (!active || (m.t !== "p" && m.t !== "hit")) return;    // only the two on court talk; spectators just watch
    m.from = id; m.ep = k.ep; const s = JSON.stringify(m);
    for (const [oid, w] of k.socks) if (oid !== id) try { w.send(s); } catch (e) {}
  }
  kLeave(id) {
    const k = this.k; if (!k || !k.socks.has(id)) return;
    k.socks.delete(id); k.line = k.line.filter(x => x !== id);
    if (id === k.champ || id === k.chal) {                    // someone on court left: the other stays on, the next in line steps up
      const other = id === k.champ ? k.chal : k.champ;
      if (id === k.champ) { k.champ = other; k.streak = 0; }
      k.chal = null; k.serve = null;
      if (k.champ == null && k.line.length) k.champ = k.line.shift();
      this.kFill(); k.ep++;
    }
    if (!k.socks.size) { this.k = null; return; }
    this.kSend({ left: id });
  }
}

/* ---------- Leaderboards: one Durable Object per scope (a Discord server, a DM, or "web"), best score per player per board ---------- */
const LB_BOARD = /^(normal|hard|gef|classic|cls|goth|1v1|koth|daily-\d{4}-\d{2}-\d{2})$/, LB_PID = /^[a-z0-9]{8,24}$/, LB_KEEP = 100, LB_SHOW = 10;
const lbName = n => String(n || "").toUpperCase().replace(/[^A-Z0-9 _.-]/g, "").trim().slice(0, 12);
const lbCORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const lbJSON = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, lbCORS) });
// public id for a player: a one-way hash of their secret pid, so board rows never reveal the pid itself
// (the pid is what lets a player write to their own entries; anyone who had it could post as them)
const pubId = async pid => { const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hbu|" + pid)));
  return Array.from(h.slice(0, 6), b => b.toString(16).padStart(2, "0")).join(""); };
const PUB_ID = /^[a-f0-9]{12}$/;
const lvBoard = k => !/(^|:)(1v1|koth)$/.test(k);                 // v0.48: every run-based board ranks by the deepest LEVEL reached; score breaks ties
const lbCmp = k => lvBoard(k) ? (a, b) => (b.l || 0) - (a.l || 0) || b.s - a.s || a.t - b.t : (a, b) => b.s - a.s || a.t - b.t;
const fxN = (x, lo, hi) => { x = Number(x); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
function fxClean(f) {                                          // keep only numbers and short A-Z labels; nothing else can ride along
  if (!f || typeof f !== "object" || !/^\d{4}-\d{2}-\d{2}$/.test(f.d || "")) return null;
  const g = fxN(f.g, 1, 10), v = fxN(f.v, 0, 100), s = fxN(f.s, 0, 30);
  if (g === null || v === null) return null;
  const p = (Array.isArray(f.p) ? f.p : []).slice(0, 10).filter(r => Array.isArray(r) && /^[A-Z0-9 ]{1,10}$/.test(r[0]) && fxN(r[1], 0, 100) !== null).map(r => [r[0], Math.round(r[1]), r[2] ? 1 : 0]);
  const c = (Array.isArray(f.c) ? f.c : []).slice(0, 10).filter(r => Array.isArray(r) && /^[A-Z0-9 ]{1,8}$/.test(r[0]) && fxN(r[1], 0, 2) !== null).map(r => [r[0], Math.round(r[1]), r[2] ? 1 : 0]);
  return { d: f.d, g: Math.round(g), v: Math.round(v * 10) / 10, s: s === null ? 7.83 : Math.round(s * 100) / 100, p, c, t: Date.now() };
}
function pfClean(p) {                                         // v0.45: profile = cosmetic picks + achievements + best score (short strings and numbers only)
  const cos = {}, ach = {};
  if (p && typeof p.cos === "object" && p.cos) for (const [k, v] of Object.entries(p.cos).slice(0, 12)) if (/^[a-z0-9]{1,12}$/i.test(k) && typeof v === "string" && /^[a-z0-9_-]{1,24}$/i.test(v)) cos[k] = v;
  if (p && typeof p.ach === "object" && p.ach) for (const [k, v] of Object.entries(p.ach).slice(0, 200)) if (/^[a-z0-9_]{1,24}$/i.test(k) && Number.isFinite(Number(v))) ach[k] = Math.floor(Number(v));
  const ts = Math.floor(Number(p && p.ts)) || 0;
  return { cos, ach, best: Math.max(0, Math.min(1e8, Math.floor(Number(p && p.best)) || 0)), ts: ts > 0 && ts < 4e12 ? ts : 0 };
}
function pfMerge(a, b) {                                       // achievements: union (earliest date); best: max; cosmetics: whichever was picked most recently
  const ach = Object.assign({}, a.ach);
  for (const k in b.ach) ach[k] = ach[k] ? Math.min(ach[k], b.ach[k]) : b.ach[k];
  const bNew = Object.keys(b.cos).length && (b.ts > a.ts || !Object.keys(a.cos).length);
  return { cos: bNew ? b.cos : a.cos, ach, best: Math.max(a.best, b.best), ts: Math.max(a.ts, b.ts) };
}
export class Board {
  constructor(state, env) { this.s = state.storage; this.env = env; }
  async dugInfo() {                                              // v0.49: the owner's account (every player named DUG, folded into the one with the best scores) is pinned atop every board and hidden from the ranks
    const now = Date.now(); if (this._dug && now - this._dug.t < 60000) return this._dug;
    const ids = []; for (const [k, v] of await this.s.list({ prefix: "n:" })) if (String(v).toUpperCase() === "DUG") ids.push(k.slice(2));
    let main = null;
    if (ids.length) { const sum = {}; for (const id of ids) sum[id] = 0; for (const [, l] of await this.s.list({ prefix: "b:" })) for (const e of l) if (e.p in sum) sum[e.p] += e.s; main = ids.slice().sort((a, b) => sum[b] - sum[a])[0]; }
    return this._dug = { t: now, ids: new Set(ids), main, pub: main ? await pubId(main) : null };
  }
  async view(b, pid) {
    const D = await this.dugInfo(), all = ((await this.s.get("b:" + b)) || []).sort(lbCmp(b)), list = all.filter(e => !D.ids.has(e.p)), top = list.slice(0, LB_SHOW), mine = !!pid && D.ids.has(pid);
    const names = top.length ? await this.s.get(top.map(e => "n:" + e.p)) : new Map();
    const i = pid && !mine ? list.findIndex(e => e.p === pid) : -1;
    const ids = await Promise.all(top.map(e => pubId(e.p)));
    let near = [];                                             // the players just above and below you, for the end-of-run comparison
    if (i >= 0) { const lo = Math.max(0, i - 3), sl = list.slice(lo, Math.min(list.length, i + 4)), nm = await this.s.get(sl.map(e => "n:" + e.p));
      near = sl.map((e, k) => ({ r: lo + k + 1, n: nm.get("n:" + e.p) || "PLAYER", s: e.s, l: e.l || 0, me: e.p === pid })); }
    const pin = D.main ? [{ n: "DUG", s: 0, l: 0, me: false, id: D.pub, dug: 1, mine }] : [], my = mine ? all.find(e => e.p === pid) : null;
    return { board: b, top: pin.concat(top.map((e, k) => ({ n: names.get("n:" + e.p) || "PLAYER", s: e.s, l: e.l || 0, me: e.p === pid, id: ids[k] }))),
      you: i >= 0 ? { rank: i + 1, s: list[i].s } : my ? { rank: 1, s: my.s } : null, total: list.length, near };
  }
  async mergePlayers(A, B) {                                     // fold player B into player A: boards (best score; counts add), profile, HELLWORLD save, name, ghost copy; B becomes an alias of A
    const boards = await this.s.list({ prefix: "b:" });
    for (const [k, list] of boards) {
      const eB = list.find(x => x.p === B); if (!eB) continue;
      const eA = list.find(x => x.p === A), count = k === "b:1v1" || k === "b:koth";
      if (eA) { if (count) eA.s += eB.s; else { if (eB.s > eA.s) { eA.s = eB.s; eA.t = eB.t; } eA.l = Math.max(eA.l || 0, eB.l || 0); } list.splice(list.indexOf(eB), 1); }
      else eB.p = A;
      list.sort(lbCmp(k));
      await this.s.put(k, list);
    }
    const pB = await this.s.get("pf:" + B), pA = await this.s.get("pf:" + A);   // v0.45: profile merges too (cosmetics, achievements, best)
    if (pB) { await this.s.put("pf:" + A, { t: Date.now(), pf: pA ? pfMerge(pA.pf, pB.pf) : pB.pf }); await this.s.delete("pf:" + B); }
    const hB = await this.s.get("h:" + B); if (hB && !(await this.s.get("h:" + A))) await this.s.put("h:" + A, hB);
    await this.s.delete("h:" + B); await this.s.delete("n:" + B);
    const gp = ((await this.s.get("gp")) || []).filter(x => x.pid !== B); await this.s.put("gp", gp);
    const cb = await this.s.get("lp:" + B); if (cb) { await this.s.delete("lk:" + cb); await this.s.delete("lp:" + B); }
    await this.s.put("al:" + B, A);
  }
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "GET") {
      if (u.searchParams.get("fx")) return lbJSON({ fx: (await this.s.get("fx")) || null, h: (await this.s.get("fxh")) || [], ks: !!(this.env && this.env.FX_KEY && String(this.env.FX_KEY).length >= 16), ep: (await this.s.get("ep")) || 0 });   // v0.44: the daily Fatalix reading + its 30-day history
      const prof = u.searchParams.get("prof") || "";                // HELLBALL ULTIMATE: a player's public stat sheet
      if (prof) {
        if (!PUB_ID.test(prof)) return lbJSON({ error: "bad player" }, 400);
        const rec = (await this.s.get("q:" + prof)) || null;
        return lbJSON({ n: rec ? rec.n : "PLAYER", p: rec ? rec.p : null });
      }
      if (u.searchParams.get("pool")) {                          // v0.28: recent players' paddle copies, a few at random (never your own)
        const me = u.searchParams.get("pid") || "", all = ((await this.s.get("gp")) || []).filter(x => x.pid !== me);
        for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
        return lbJSON({ list: all.slice(0, 3).map(x => ({ n: x.n, s: x.s, l: x.l, p: x.p, v: x.v || [], m: x.m || "", ar: x.ar || "" })) });
      }
      const gx = u.searchParams.get("gx") || "";                  // v0.35: one player's copy, looked up by the public id the world board shows
      if (gx) { if (!PUB_ID.test(gx)) return lbJSON({ error: "bad player" }, 400); return lbJSON((await this.s.get("gx:" + gx)) || { g: null }); }
      const gh = u.searchParams.get("ghost") || "";               // the #1 player's recorded paddle for that board (daily ghost race)
      if (gh) { if (!LB_BOARD.test(gh)) return lbJSON({ error: "bad board" }, 400); return lbJSON((await this.s.get("g:" + gh)) || { g: null }); }
      const b = u.searchParams.get("b") || "", pid = u.searchParams.get("pid") || "";
      if (!LB_BOARD.test(b)) return lbJSON({ error: "bad board" }, 400);
      return lbJSON(await this.view(b, LB_PID.test(pid) ? ((await this.s.get("al:" + pid)) || pid) : ""));
    }
    let m; try { m = JSON.parse(await req.text()); } catch (e) { return lbJSON({ error: "bad json" }, 400); }
    if (m && m.op === "mergename") {                             // v0.47: OWNER ONLY (FX_KEY): merge every player with this exact name into the one with the best scores
      const key = this.env && this.env.FX_KEY ? String(this.env.FX_KEY) : "";
      if (key.length < 16 || typeof m.key !== "string" || m.key.length !== key.length) return lbJSON({ error: "forbidden" }, 403);
      let diff = 0; for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ m.key.charCodeAt(i);
      if (diff) return lbJSON({ error: "forbidden" }, 403);
      const nm = lbName(m.name); if (!nm) return lbJSON({ error: "name missing" }, 400);
      const names = await this.s.list({ prefix: "n:" }), ids = [];
      for (const [k, v] of names) if (v === nm) ids.push(k.slice(2));
      if (ids.length < 2) return lbJSON({ ok: true, found: ids.length, merged: 0 });
      const sum = {}; for (const id of ids) sum[id] = 0;
      for (const [k, list] of await this.s.list({ prefix: "b:" })) for (const e of list) if (e.p in sum) sum[e.p] += e.s;
      ids.sort((a, b) => sum[b] - sum[a]);
      const A = ids[0]; for (const B of ids.slice(1)) await this.mergePlayers(A, B);
      return lbJSON({ ok: true, found: ids.length, merged: ids.length - 1 });
    }
    if (m && m.op === "mergeall") {                              // v0.49: OWNER ONLY (FX_KEY): fold every group of players sharing a name (any capitals) into the one with the best scores
      const key = this.env && this.env.FX_KEY ? String(this.env.FX_KEY) : "";
      if (key.length < 16 || typeof m.key !== "string" || m.key.length !== key.length) return lbJSON({ error: "forbidden" }, 403);
      let diff = 0; for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ m.key.charCodeAt(i);
      if (diff) return lbJSON({ error: "forbidden" }, 403);
      const groups = {}; for (const [k, v] of await this.s.list({ prefix: "n:" })) (groups[String(v).toUpperCase()] = groups[String(v).toUpperCase()] || []).push(k.slice(2));
      const sum = {}; for (const [, l] of await this.s.list({ prefix: "b:" })) for (const e of l) sum[e.p] = (sum[e.p] || 0) + e.s;
      const out = []; for (const [nm, ids] of Object.entries(groups)) { if (ids.length < 2) continue; ids.sort((a, b) => (sum[b] || 0) - (sum[a] || 0)); for (const B of ids.slice(1)) await this.mergePlayers(ids[0], B); out.push([nm, ids.length]); }
      this._dug = null; return lbJSON({ ok: true, groups: out });
    }
    if (m && m.op === "wipe") {                                  // v0.46: OWNER ONLY (needs FX_KEY + a typed confirmation): erase every board, name, profile, link code and HELLWORLD save, keep the daily reading, and start a new epoch so devices reset their own local progress
      const key = this.env && this.env.FX_KEY ? String(this.env.FX_KEY) : "";
      if (key.length < 16 || typeof m.key !== "string" || m.key.length !== key.length) return lbJSON({ error: "forbidden" }, 403);
      let diff = 0; for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ m.key.charCodeAt(i);
      if (diff) return lbJSON({ error: "forbidden" }, 403);
      if (m.confirm !== "WIPE EVERYTHING") return lbJSON({ error: "confirmation missing" }, 400);
      const fx = await this.s.get("fx"), fxh = await this.s.get("fxh"), ep = Date.now();
      await this.s.deleteAll();
      await this.s.put("ep", ep); if (fx) await this.s.put("fx", fx); if (fxh) await this.s.put("fxh", fxh);
      return lbJSON({ ok: true, ep });
    }
    if (m && m.op === "fxpush") {                                // v0.44: Fatalix pushes one meters-only reading (secret FX_KEY set in the worker's Variables and Secrets)
      const key = this.env && this.env.FX_KEY ? String(this.env.FX_KEY) : "";
      if (key.length < 16 || typeof m.key !== "string" || m.key.length !== key.length) return lbJSON({ error: "forbidden" }, 403);
      let diff = 0; for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ m.key.charCodeAt(i);
      if (diff) return lbJSON({ error: "forbidden" }, 403);
      const f = fxClean(m.fx); if (!f) return lbJSON({ error: "bad reading" }, 400);
      const h = ((await this.s.get("fxh")) || []).filter(x => x.d !== f.d); h.push({ d: f.d, g: f.g, v: f.v }); h.sort((a, b) => a.d < b.d ? -1 : 1);
      await this.s.put("fx", f); await this.s.put("fxh", h.slice(-30));
      return lbJSON({ ok: true, d: f.d });
    }
    if (!m || !LB_PID.test(m.pid || "")) return lbJSON({ error: "bad player" }, 400);
    { const al = await this.s.get("al:" + m.pid); if (al) m.pid = al; }          // v0.47: a device whose player was merged keeps posting, and it all lands on the merged player
    const name = lbName(m.n);
    if (name) { await this.s.put("n:" + m.pid, name); if (name === "DUG") this._dug = null; }
    if (m.op === "name") return lbJSON({ ok: true, n: name });
    if (m.op === "linkmk" || m.op === "linkreset") {            // v0.43: your link code is permanent (any device can show it again); RESET makes a new one and kills the old
      let code = await this.s.get("lp:" + m.pid);
      if (!code || m.op === "linkreset") {
        if (code) await this.s.delete("lk:" + code);
        const al = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", rb = crypto.getRandomValues(new Uint8Array(10)); code = Array.from(rb, x => al[x % 32]).join("");
        await this.s.put("lk:" + code, { p: m.pid, t: Date.now() }); await this.s.put("lp:" + m.pid, code);
      }
      return lbJSON({ ok: true, code });
    }
    if (m.op === "linkuse") {                                    // the other device types the code: its scores merge into the code owner's player
      const now = Date.now(), rl = (await this.s.get("lkf")) || { t: 0, n: 0 };
      if (now - rl.t > 60000) { rl.t = now; rl.n = 0; }
      if (rl.n >= 30) return lbJSON({ ok: false, err: "slow down" }, 429);
      const code = String(m.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""), rec = /^[A-Z2-9]{10}$/.test(code) ? await this.s.get("lk:" + code) : null;
      if (!rec || rec.p === m.pid) { rl.n++; await this.s.put("lkf", rl); return lbJSON({ ok: false, err: rec && rec.p === m.pid ? "same device" : "bad code" }); }
      const A = rec.p, B = m.pid;
      await this.mergePlayers(A, B);
      return lbJSON({ ok: true, pid: A, n: (await this.s.get("n:" + A)) || "" });
    }
    if (m.op === "pfsync") {                                     // v0.45: merge this device's profile into the player's stored one and hand the merged copy back
      const wep = (await this.s.get("ep")) || 0;                 // after a wipe, devices that have not reset yet may not push their old progress back
      if (wep && (Math.floor(Number(m.ep)) || 0) < wep) return lbJSON({ ok: false, ep: wep });
      const inc = pfClean(m.pf), old = await this.s.get("pf:" + m.pid), now = Date.now();
      if (old && now - (old.t || 0) < 1500) return lbJSON({ ok: true, pf: old.pf });
      const mg = old ? pfMerge(old.pf, inc) : inc;
      await this.s.put("pf:" + m.pid, { t: now, pf: mg });
      return lbJSON({ ok: true, pf: mg });
    }
    if (m.op === "hwsave") {                                     // HELLWORLD: the player's whole save, so the bud follows them between games and devices
      if (!m.save || typeof m.save !== "object" || !m.save.seed) return lbJSON({ error: "bad save" }, 400);
      if (JSON.stringify(m.save).length > 200000) return lbJSON({ error: "save too big" }, 413);
      await this.s.put("h:" + m.pid, { t: Date.now(), save: m.save });
      return lbJSON({ ok: true });
    }
    if (m.op === "gpool") {                                      // v0.28: keep the latest copy per player, newest 60 overall
      const g = m.g;
      if (!g || typeof g.p !== "string" || g.p.length > 6000 || !/^[A-Za-z0-9+/=]*$/.test(g.p)) return lbJSON({ error: "bad ghost" }, 400);
      const mm = typeof g.m === "string" && /^[0-5]{7}$/.test(g.m) ? g.m : "", ar = typeof g.ar === "string" && /^[A-Z ]{0,14}$/.test(g.ar) ? g.ar : "";
      let all = ((await this.s.get("gp")) || []).filter(x => x.pid !== m.pid);
      const v = Array.isArray(g.v) ? g.v.slice(0, 8).filter(r => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)).map(r => r.map(q => Math.round(q * 100) / 100)) : [];
      all.push({ pid: m.pid, n: name || (await this.s.get("n:" + m.pid)) || "PLAYER", s: Math.floor(Number(g.s)) || 0, l: Math.floor(Number(g.l)) || 1, p: g.p, v, m: mm, ar, t: Date.now() });
      await this.s.put("gp", all.slice(-60));
      await this.s.put("gx:" + (await pubId(m.pid)), { g: { n: all[all.length - 1].n, s: all[all.length - 1].s, l: all[all.length - 1].l, p: g.p, v, m: mm, ar } });
      return lbJSON({ ok: true });
    }
    if (m.op === "ghost") {                                      // only the current #1 on that board may store the ghost
      if (!LB_BOARD.test(m.b || "") || !m.g || typeof m.g.p !== "string" || !Array.isArray(m.g.sc)) return lbJSON({ error: "bad ghost" }, 400);
      if (m.g.p.length > 70000 || !/^[A-Za-z0-9+/=]*$/.test(m.g.p)) return lbJSON({ error: "bad ghost" }, 413);
      const top = ((await this.s.get("b:" + m.b)) || [])[0];
      if (!top || top.p !== m.pid) return lbJSON({ ok: false });
      await this.s.put("g:" + m.b, { n: name || (await this.s.get("n:" + m.pid)) || "PLAYER", s: top.s, g: { p: m.g.p, sc: m.g.sc.slice(0, 2000).map(v => Math.floor(Number(v)) || 0) } });
      return lbJSON({ ok: true });
    }
    if (m.op === "hwcash") {                                     // v0.44: HELLBALL pays HELLWORLD cash for levels won (small, rate limited, only into an existing save)
      const amt = Math.floor(Number(m.amt)); if (!(amt >= 1 && amt <= 50)) return lbJSON({ error: "bad amount" }, 400);
      const now = Date.now(); let w = (await this.s.get("hc:" + m.pid)) || { t: now, n: 0 }; if (now - w.t > 3600000) w = { t: now, n: 0 };
      if (w.n + amt > 400) return lbJSON({ ok: false, err: "slow down" });
      const r = await this.s.get("h:" + m.pid); if (!r || !r.save) return lbJSON({ ok: false, err: "no save" });
      const sv = r.save; sv.cash = Math.max(0, Math.floor(Number(sv.cash) || 0)) + amt; sv._ts = now; w.n += amt;
      await this.s.put("hc:" + m.pid, w); await this.s.put("h:" + m.pid, { t: now, save: sv });
      return lbJSON({ ok: true, cash: sv.cash });
    }
    if (m.op === "hwload") { const r = await this.s.get("h:" + m.pid); return lbJSON({ save: r ? r.save : null, t: r ? r.t : 0 }); }
    if (m.op === "prof") {                                       // HELLBALL ULTIMATE: store the stat sheet (numbers and short strings only, capped)
      const p = m.p && typeof m.p === "object" ? m.p : null;
      if (!p) return lbJSON({ error: "bad profile" }, 400);
      const clean = {};
      for (const [k, v] of Object.entries(p).slice(0, 40)) {
        if (!/^[a-z0-9]{1,12}$/i.test(k)) continue;
        if (typeof v === "number" && isFinite(v)) clean[k] = Math.round(v * 100) / 100;
        else if (typeof v === "string") clean[k] = v.slice(0, 24);
        else if (Array.isArray(v)) clean[k] = v.slice(0, 16).map(x => Math.max(0, Math.min(1e6, Math.round(Number(x) || 0))));
      }
      const json = JSON.stringify(clean);
      if (json.length > 3000) return lbJSON({ error: "profile too big" }, 413);
      await this.s.put("q:" + (await pubId(m.pid)), { n: name || (await this.s.get("n:" + m.pid)) || "PLAYER", p: clean });
      return lbJSON({ ok: true });
    }
    if (!LB_BOARD.test(m.b || "")) return lbJSON({ error: "bad board" }, 400);
    const list = (await this.s.get("b:" + m.b)) || [];
    let e = list.find(x => x.p === m.pid);
    if (m.op === "win") { if (!e) list.push(e = { p: m.pid, s: 0 }); e.s += 1; e.t = Date.now(); }   // 1v1 wins / King of the Hill crowns: a running count
    else {                                                     // a run's score: only the player's best counts
      const sc = Math.floor(Number(m.s)), lv = Math.floor(Number(m.l)) || 0;
      if (!(sc > 0 && sc < 1e8)) return lbJSON({ error: "bad score" }, 400);
      if (!e) list.push(e = { p: m.pid, s: 0 });
      if (sc > e.s) { e.s = sc; e.t = Date.now(); }
      e.l = Math.max(e.l || 0, Math.min(999, lv));              // v0.48: the level shown is the deepest this player reached on this board, not just the level of their best-scoring run
    }
    list.sort(lbCmp(m.b));
    if (list.length > LB_KEEP) list.length = LB_KEEP;
    await this.s.put("b:" + m.b, list);
    return lbJSON(await this.view(m.b, m.pid));
  }
}
export default {
  async fetch(req, env, ctx) {
    const m = new URL(req.url).pathname.match(/^\/(?:\.proxy\/)?(?:ws\/)?((?:kdc|kweb|dc|web)-[A-Za-z0-9_-]{1,80})$/);   // /ws/<room>, or just /<room> if a Discord URL mapping stripped the /ws
    if (m) {
      const r = new Request(req); r.headers.set("X-Room", m[1]);
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(r);
    }
    const lb = new URL(req.url).pathname.match(/^\/(?:\.proxy\/)?(?:ws\/)?lb\/([A-Za-z0-9_-]{1,80})$/);   // leaderboards ride the same /ws URL mapping as the rooms
    if (lb) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: lbCORS });
      if (req.method !== "GET" && req.method !== "POST") return lbJSON({ error: "method" }, 405);
      if (req.method === "GET" && new URL(req.url).searchParams.get("fx") && typeof caches !== "undefined" && caches.default) {   // v0.44: the daily reading changes once a day, so serve it from the edge for a minute
        const ck = new Request("https://fx.cache/" + lb[1]); const hit = await caches.default.match(ck); if (hit) return hit;
        const r = await env.BOARDS.get(env.BOARDS.idFromName("lb:" + lb[1])).fetch(req);
        const out = new Response(r.body, { status: r.status, headers: r.headers });
        if (r.ok) { out.headers.set("Cache-Control", "public, max-age=60"); if (ctx && ctx.waitUntil) ctx.waitUntil(caches.default.put(ck, out.clone())); }
        return out;
      }
      return env.BOARDS.get(env.BOARDS.idFromName("lb:" + lb[1])).fetch(req);
    }
    return new Response("HELLBALL ULTIMATE server: online 1v1 relay + world board", { headers: { "Content-Type": "text/plain" } });
  }
};
