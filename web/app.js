/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 Interchained LLC. All rights reserved.
 * CHALK / Sports-Rater — https://sports-rater.com — Licensor: Interchained LLC
 */
// Sports-Rater client — thin, dependency-free. Every number on screen comes
// from the CHALK API; this file never calculates football metrics (V3 §23).
const $ = (s, el = document) => el.querySelector(s);
const FAV_KEY = "sr.favorite";
const state = { team: "TB", season: null, favorite: (() => { try { return localStorage.getItem("sr.favorite") || null; } catch { return null; } })(), teams: [], seasons: [], coach: false, defs: [], rating: null, meta: null, home: null, view: "home" };

const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmtPct = (v) => (v === null || v === undefined ? "—" : `${v}%`);
const fmtNum = (v, d = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
const signed = (v, d = 2) => (v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(d)}`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

// Team identity: primary color drives the accent; names for prose.
const TEAMS = {
  ARI: ["Arizona Cardinals", "#97233F"], ATL: ["Atlanta Falcons", "#A71930"], BAL: ["Baltimore Ravens", "#9B7CD6"], BUF: ["Buffalo Bills", "#4C8DFF"],
  CAR: ["Carolina Panthers", "#0085CA"], CHI: ["Chicago Bears", "#F26522"], CIN: ["Cincinnati Bengals", "#FB4F14"], CLE: ["Cleveland Browns", "#FF3C00"],
  DAL: ["Dallas Cowboys", "#6FA0E0"], DEN: ["Denver Broncos", "#FB4F14"], DET: ["Detroit Lions", "#0076B6"], GB: ["Green Bay Packers", "#FFB612"],
  HOU: ["Houston Texans", "#E02347"], IND: ["Indianapolis Colts", "#5A9BFF"], JAX: ["Jacksonville Jaguars", "#D7A22A"], KC: ["Kansas City Chiefs", "#E31837"],
  LA: ["Los Angeles Rams", "#FFA300"], LAR: ["Los Angeles Rams", "#FFA300"], LAC: ["Los Angeles Chargers", "#FFC20E"], LV: ["Las Vegas Raiders", "#C4C9CC"],
  MIA: ["Miami Dolphins", "#008E97"], MIN: ["Minnesota Vikings", "#FFC62F"], NE: ["New England Patriots", "#C60C30"], NO: ["New Orleans Saints", "#D3BC8D"],
  NYG: ["New York Giants", "#5B8DFF"], NYJ: ["New York Jets", "#2FBF71"], PHI: ["Philadelphia Eagles", "#00B38F"], PIT: ["Pittsburgh Steelers", "#FFB612"],
  SF: ["San Francisco 49ers", "#B3995D"], SEA: ["Seattle Seahawks", "#69BE28"], TB: ["Tampa Bay Buccaneers", "#FF4B3E"], TEN: ["Tennessee Titans", "#4B92DB"], WAS: ["Washington Commanders", "#FFB612"], WSH: ["Washington Commanders", "#FFB612"],
};
const teamName = (t) => (TEAMS[t]?.[0] ?? t).split(" ").slice(0, -1).join(" ") || t;
// Team logos: config comes from /api/v1/meta (CHALK_TEAM_LOGOS=0 turns them off server-side).
// Same resolver as src/server/logos.ts. Every <img> falls back to the wordmark on error.
function logoUrl(abbr) {
  const cfg = state.meta?.team_logos;
  if (!cfg?.enabled || !abbr) return null;
  const a = String(abbr).toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(a)) return null;
  return cfg.url_template.replace("{abbr}", (cfg.abbr_map?.[a] ?? a).toLowerCase());
}
function logoImg(abbr, cls = "logo") {
  const u = logoUrl(abbr);
  if (!u) return "";
  return `<img class="${cls}" src="${esc(u)}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />`;
}
// Team hero: /hero/{abbr}.jpg — generated field atmosphere in the team's palette (no logos/marks; we own them).
// Two stacked layers crossfade so a team switch never flashes; a missing file leaves the gradient fallback.
let heroFront = "a";
function setHero(t) {
  const front = $(`#team-hero-${heroFront}`), backId = heroFront === "a" ? "b" : "a", back = $(`#team-hero-${backId}`);
  if (!front || !back) return;
  const url = `/hero/${encodeURIComponent(String(t).toUpperCase())}.jpg`;
  if (front.dataset.team === t) return;
  const img = new Image();
  img.onload = () => { back.style.backgroundImage = `url("${url}")`; back.dataset.team = t; back.classList.add("on"); front.classList.remove("on"); heroFront = backId; $("#team-hero").classList.add("has-img"); };
  img.onerror = () => { console.warn(`hero: no image for ${t} — gradient fallback`); front.classList.remove("on"); $("#team-hero").classList.remove("has-img"); };
  img.src = url;
}
function applyTeamTheme(t) {
  const c = TEAMS[t]?.[1] ?? "#c8ff3d";
  document.documentElement.style.setProperty("--accent", c);
  document.documentElement.style.setProperty("--accent-2", c);
  // Ink on accent: dark for light accents, light for dark ones.
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  document.documentElement.style.setProperty("--accent-ink", (r * 299 + g * 587 + b * 114) / 1000 > 140 ? "#07090d" : "#ffffff");
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `${res.status} ${path}`), { status: res.status, detail: body.detail });
  return body;
}

// ------------------------------------------------------------------ boot
async function boot() {
  try { state.meta = await api("/api/v1/meta"); renderSiteFoot(); } catch (e) { (document.querySelector("main") ?? document.body).prepend(el(`<div class="card"><div class="err">CHALK API unreachable: ${esc(e.message)}</div></div>`)); return; }
  state.teams = state.meta.teams; state.seasons = state.meta.seasons; state.defs = state.meta.rating_definitions;
  const url = new URL(location.href);
  // Allegiance beats the server default: your team opens first unless the URL says otherwise.
  state.team = (url.searchParams.get("team") || state.favorite || state.meta.defaults.team || "TB").toUpperCase();
  state.season = Number(url.searchParams.get("season") || state.meta.defaults.season || state.seasons[0]);
  state.coach = url.searchParams.get("mode") === "coach";
  const ts = $("#team"); ts.innerHTML = state.teams.map((t) => `<option ${t === state.team ? "selected" : ""}>${t}</option>`).join("");
  const ss = $("#season"); ss.innerHTML = state.seasons.map((s) => `<option ${s === state.season ? "selected" : ""}>${s}</option>`).join("");
  ts.onchange = () => { state.team = ts.value; syncUrl(); loadHome(); renderSuggest(); loadFeed(); loadHistory(true); };
  ss.onchange = () => { state.season = Number(ss.value); syncUrl(); loadHome();  loadHistory(true); };
  const mode = $("#mode");
  const applyMode = () => { mode.textContent = state.coach ? "Coach" : "Fan"; mode.setAttribute("aria-pressed", String(state.coach)); document.body.classList.toggle("mode-coach", state.coach); document.querySelectorAll(".card.answer").forEach((c) => c.classList.toggle("coach-on", state.coach)); $("#coach-deck").hidden = !state.coach; if (state.coach) loadCoachDeck(); };
  mode.onclick = () => { state.coach = !state.coach; syncUrl(); applyMode(); };
  state.view = url.searchParams.get("view") === "feed" ? "feed" : "home";
  state.headline = HEADLINES.some((h) => h[0] === url.searchParams.get("headline")) ? url.searchParams.get("headline") : "third_down";
  renderHeadlinePicker();
  document.querySelectorAll(".view-tab").forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  $("#feed-refresh").onclick = () => pollFeed(true);
  setView(state.view, { silent: true });
  applyMode(); renderSuggest(); loadHome(); renderWho(); loadFeed(); loadHistory(true);
  tele("view");
  setInterval(() => { if (state.view === "feed" && document.visibilityState === "visible") pollFeed(); }, 30_000);
  $("#take").onsubmit = async (e) => { e.preventDefault(); const text = $("#take-text").value.trim(); if (!text) return; try { const r = await fanPost("/api/v1/fans/posts", { text, team: state.team }); if (r) { $("#take-text").value = ""; loadFeed(); } } catch (err) { alert(err.message + (err.detail ? ` — ${err.detail.join("; ")}` : "")); } };
  $("#ask").onsubmit = (e) => { e.preventDefault(); const q = $("#q").value.trim(); if (!q) return; $("#q").value = ""; ask(q); };
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-ask]"); if (b) ask(b.dataset.ask.replaceAll("Tampa", teamName(state.team))); });
  $("#rate-differently").onclick = rateDifferently;
  $("#fav").onclick = setFavorite;
  syncFavoriteFromServer();
  $("#show-league").onclick = showLeague;
  const q0 = url.searchParams.get("q"); if (q0) ask(q0);
}
function syncUrl() { const u = new URL(location.href); u.searchParams.set("team", state.team); u.searchParams.set("season", state.season); u.searchParams.set("mode", state.coach ? "coach" : "fan"); u.searchParams.set("view", state.view); if (state.headline && state.headline !== "third_down") u.searchParams.set("headline", state.headline); else u.searchParams.delete("headline"); history.replaceState(null, "", u); }
function renderSuggest() { const s = $("#suggest"); s.innerHTML = ""; for (const q of state.meta.suggested_questions) s.append(el(`<button class="chip" data-ask="${esc(q)}">${esc(q.replaceAll("Tampa", teamName(state.team)))}</button>`)); }

// ------------------------------------------------------------------ home
// Provenance drawer: the causal graph as a readable list — record counts by collection, one line per
// node (collection · label · hash prefix), never the raw records (an observation carries up to 500
// evidence ids; dumping them buried the graph). The raw JSON stays one link away.
function renderProvenance(p, coll, id) {
  const box = el(`<div></div>`);
  box.append(el(`<div class="h">Provenance · ${p.node_count} records · ${p.edge_count} edges · depth ${p.depth}</div><div class="muted">${esc(Object.entries(p.collections || {}).map(([k, v]) => `${k.replace("football_", "")}: ${v}`).join(" · "))}</div>`));
  const prov = el(`<div class="prov"></div>`);
  for (const n of (p.nodes || []).slice(0, 60)) prov.append(el(`<div><span class="c">${esc(String(n._coll || "").replace("football_", ""))}</span><span>${esc(n.label || n._id)}</span><span class="hsh">${esc(String(n._hash || "").slice(0, 12))}</span></div>`));
  box.append(prov);
  if (p.node_count > 60) box.append(el(`<div class="muted">… ${p.node_count - 60} more</div>`));
  const ev = (p.records || []).find((r) => Array.isArray(r.data?.evidence_ids))?.data;
  if (ev) box.append(el(`<div class="muted" style="margin-top:6px">${ev.evidence_ids.length} of ${ev.evidence_count ?? ev.evidence_ids.length} evidence plays behind this answer — open Show evidence on a live card to page through them.</div>`));
  box.append(el(`<div class="muted" style="margin-top:6px"><a href="/api/v1/provenance/${esc(coll)}/${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer">raw provenance JSON ↗</a></div>`));
  return box;
}
function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
// The Record: what CHALK has already said about this team, newest first. Tap a
// card to open the stored answer (no model call); "Re-ask live" streams fresh.
async function loadRecord() {
  const strip = $("#record-strip"); if (!strip) return;
  try {
    const r = await api(`/api/v1/record?team=${state.team}&season=${state.season}&limit=20`);
    $("#record-sub").textContent = r.count ? `${r.count} answer${r.count === 1 ? "" : "s"} on record` : "nothing on record yet — ask something";
    strip.innerHTML = "";
    for (const it of r.items) {
      const c = el(`<button class="rec"><div class="rec-q">${esc(it.question)}</div><div class="rec-s">${esc(it.statements[0] ?? (it.answer ?? "").slice(0, 140))}</div><div class="rec-m"><span>${esc(it.model)}</span><span>${esc(ago(it.created_at))}</span><span>👍 ${it.reactions.agree + it.reactions.like} · 👎 ${it.reactions.disagree}</span></div></button>`);
      c.onclick = () => openRecorded(it);
      strip.append(c);
    }
  } catch (e) { strip.innerHTML = `<div class="err">record unavailable: ${esc(e.message)}</div>`; }
}
function openRecorded(it) {
  if (state.view !== "feed") setView("feed");
  const existing = $(`#feed [data-obs="${CSS.escape(it.id)}"]`);
  if (existing) { existing.scrollIntoView({ behavior: "smooth", block: "start" }); existing.classList.add("flash"); setTimeout(() => existing.classList.remove("flash"), 1200); return; }
  showCard(recordedCard(it));
}
// A stored completion rendered as a full answer card — no model call, no
// execution. Same affordances as a live card minus Evidence/Plan (those need
// the live package): agree/disagree on the observation, Provenance, Re-ask live.
function recordedCard(it) {
  const card = $("#tpl-answer").content.firstElementChild.cloneNode(true);
  card.dataset.obs = it.id;
  card.classList.toggle("coach-on", state.coach);
  $(".q", card).textContent = it.question;
  const badges = $(".badges", card), statements = $(".statements", card), prose = $(".prose", card), drawer = $(".drawer", card);
  badges.append(el(`<span class="badge lime">${esc(it.intent)}</span>`), el(`<span class="badge lime" title="stored observation ${esc(it.id)}">from the record · ${esc(ago(it.created_at))}</span>`), el(`<span class="badge">${esc(it.model)}</span>`));
  if (it.register === "coach") badges.append(el(`<span class="badge">coach read</span>`));
  for (const st of it.statements) statements.append(el(`<div class="statement">${esc(st)}</div>`));
  prose.textContent = it.answer ?? "";
  $(".coach", card).innerHTML = `<div class="muted">Coach view needs the live evidence package — use Re-ask live.</div>`;
  $(".act-evidence", card).remove(); $(".act-plan", card).remove();
  const re = el(`<button class="chip">Re-ask live</button>`); re.onclick = () => ask(it.question, { live: true }); $(".card-foot", card).prepend(re);
  $(".act-coach", card).onclick = () => card.classList.toggle("coach-on");
  card.querySelectorAll(".act-react").forEach((b) => { b.onclick = async () => { try { const r = await fanPost("/api/v1/fans/reactions", { target_coll: "football_observations", target_id: it.id, reaction: b.dataset.kind }); if (r) { b.classList.add("on"); b.textContent = `${b.dataset.kind === "agree" ? "👍" : "👎"} ${r.replaced ? "changed" : "saved"} · #${r.chain_index}`; loadRecord(); } } catch (e) { b.textContent = e.message; } }; });
  $(".act-provenance", card).onclick = async () => { drawer.innerHTML = `<div class="muted">tracing football_observations/${esc(it.id)}…</div>`; try { const pv = await api(`/api/v1/provenance/football_observations/${encodeURIComponent(it.id)}`); drawer.innerHTML = ""; drawer.append(renderProvenance(pv, "football_observations", it.id)); } catch (e) { drawer.innerHTML = `<div class="err">${esc(e.message)}</div>`; } };
  return card;
}

// ---- Coach deck: the room a coach wants — tables, percentiles, situations. Fetched only in coach mode.
const SUBJECTS = ["third_down", "offense", "defense", "red_zone", "explosiveness", "ball_security"];
function tblEl(rows, cols) {
  if (!rows?.length) return el(`<div class="muted">none</div>`);
  const t = el(`<div class="tbl"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.h)}</th>`).join("")}</tr></thead><tbody></tbody></table></div>`);
  const tb = $("tbody", t);
  for (const r of rows) tb.append(el(`<tr>${cols.map((c) => `<td class="${c.num ? "num" : ""}">${esc(c.f ? c.f(r) : r[c.k] ?? "—")}</td>`).join("")}</tr>`));
  return t;
}
let coachDeckKey = "";
async function loadCoachDeck() {
  const key = `${state.team}|${state.season}`;
  if (coachDeckKey === key) return; // already built for this team/season
  coachDeckKey = key;
  const box = $("#coach-panels"); box.innerHTML = "";
  $("#coach-sub").textContent = `${state.team} ${state.season} · loading…`;
  const q = `team=${state.team}&season=${state.season}`;
  // Progressive: every panel gets a placeholder immediately and fills in as ITS request lands — the deck
  // used to wait for the slowest of nine store-bound requests before painting anything (v0.9.3).
  // Every failure names itself in its panel; nothing is skipped silently.
  const panel = (title, score) => {
    const p = el(`<section class="tile cpanel pending"><div class="ph"><div class="t">${esc(title)}${score !== undefined ? ` <b>${esc(String(score))}</b>` : ""}</div><div class="s">…</div></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:60%"></div></section>`);
    box.append(p);
    return {
      fill(score, sub, node) { p.classList.remove("pending"); p.querySelectorAll(".skeleton").forEach((x) => x.remove()); if (score !== undefined) $(".t", p).innerHTML = `${esc(title)} <b>${esc(String(score))}</b>`; $(".s", p).textContent = sub ?? ""; if (node) p.append(node); },
      fail(msg) { p.classList.remove("pending"); p.querySelectorAll(".skeleton").forEach((x) => x.remove()); $(".s", p).textContent = "unavailable"; p.append(el(`<div class="err">${esc(msg)}</div>`)); },
    };
  };
  const compCols = [{ h: "component", f: (c) => c.label ?? c.metric }, { h: "w", f: (c) => `${Math.round((c.weight ?? 0) * 100)}%`, num: 1 }, { h: "raw", f: (c) => (String(c.metric).includes("rate") ? fmtPct(c.raw === null ? null : Math.round(c.raw * 1000) / 10) : fmtNum(c.raw, 3)), num: 1 }, { h: "lg med", f: (c) => (String(c.metric).includes("rate") ? fmtPct(c.league_median === null || c.league_median === undefined ? null : Math.round(c.league_median * 1000) / 10) : fmtNum(c.league_median, 3)), num: 1 }, { h: "pct", f: (c) => (c.percentile ?? "—"), num: 1 }, { h: "rank", f: (c) => (c.rank ?? "—"), num: 1 }, { h: "pts", f: (c) => fmtNum(c.points, 1), num: 1 }];
  const jobs = [];
  let okRatings = 0;
  const run = (ph, url, render) => jobs.push(api(url).then((r) => { if (coachDeckKey !== key) return; render(r); }).catch((e) => { if (coachDeckKey !== key) return; console.warn(`coach deck: ${url} failed — ${e.message}`); ph.fail(e.message); }));
  for (const subject of SUBJECTS) {
    const ph = panel(subject.replace("_", " "));
    run(ph, `/api/v1/ratings/${subject.replace("_", "-")}?${q}`, (r) => {
      const snap = r.snapshot; if (!snap) throw new Error(`no snapshot in response (keys: ${Object.keys(r).join(", ")})`);
      const of = Array.isArray(r.league) ? r.league.length : (r.population ?? "?");
      okRatings++;
      ph.fill(`${snap.score}/100`, `#${r.rank} of ${of} · ${snap.definition_name ?? snap.definition_id} · n=${snap.sample_size}${snap.provisional ? " · provisional" : ""}`, tblEl(snap.components, compCols));
    });
  }
  const phThird = panel("Third down by distance");
  run(phThird, `/api/v1/analyses/third-down?${q}`, (third) => { const a = third.summary; if (!a) throw new Error("no summary in response"); phThird.fill(undefined, `${a.conversions}/${a.attempts} (${fmtPct(a.conversion_pct)}) · ${a.confidence}`, tblEl(a.by_distance, [{ h: "to go", k: "distance" }, { h: "att", k: "attempts", num: 1 }, { h: "conv", k: "conversions", num: 1 }, { h: "conv%", f: (r) => fmtPct(r.conversion_pct), num: 1 }, { h: "epa/p", f: (r) => fmtNum(r.epa_per_play, 3), num: 1 }])); });
  const phWeak = panel("Weakest situations"), phStrong = panel("Strongest situations");
  run(phWeak, `/api/v1/analyses/scan?${q}&side=offense`, (scan) => {
    const row = (b) => ({ situation: b.label, snaps: b.metrics?.attempts, epa: b.metrics?.epa_per_play, d: b.epa_delta_vs_team, succ: b.metrics?.success_rate });
    const cols = [{ h: "situation", k: "situation" }, { h: "snaps", k: "snaps", num: 1 }, { h: "epa/p", f: (r) => fmtNum(r.epa, 3), num: 1 }, { h: "vs team", f: (r) => fmtNum(r.d, 3), num: 1 }, { h: "succ%", f: (r) => fmtPct(r.succ === null || r.succ === undefined ? null : Math.round(r.succ * 1000) / 10), num: 1 }];
    phWeak.fill(undefined, `baseline ${fmtNum(scan.baseline?.epa_per_play, 3)} EPA/play · min ${scan.min_sample} snaps`, tblEl((scan.weakest ?? []).slice(0, 8).map(row), cols));
    phStrong.fill(undefined, `vs team baseline`, tblEl((scan.strongest ?? []).slice(0, 6).map(row), cols));
  });
  const phOpp = panel("Opponent");
  run(phOpp, `/api/v1/reports/opponent?${q}`, (opp) => { const o = opp.summary; if (!o) throw new Error("no summary in response"); phOpp.fill(undefined, `${o.opponent} ${o.opponent_side} · ${o.baseline?.snaps ?? "?"} snaps · ${fmtPct(o.baseline?.pass_pct)} pass · ${fmtNum(o.baseline?.epa_per_play, 3)} EPA/play`, tblEl(o.sections, [{ h: "situation", k: "situation" }, { h: "snaps", k: "snaps", num: 1 }, { h: "pass%", f: (r) => fmtPct(r.pass_pct), num: 1 }, { h: "epa/p", f: (r) => fmtNum(r.epa_per_play, 3), num: 1 }, { h: "succ%", f: (r) => fmtPct(r.success_pct), num: 1 }])); });
  await Promise.allSettled(jobs);
  if (coachDeckKey !== key) return;
  // the scan request feeds two panels; if it failed, the second must say so too rather than sit pending
  if (phStrong && box.querySelector(".cpanel.pending")) for (const p of box.querySelectorAll(".cpanel.pending")) { p.classList.remove("pending"); p.querySelectorAll(".skeleton").forEach((x) => x.remove()); $(".s", p).textContent = "unavailable"; p.append(el(`<div class="err">the situational scan request failed — see Weakest situations</div>`)); }
  $("#coach-sub").textContent = `${state.team} ${state.season} · ${okRatings}/${SUBJECTS.length} ratings · deterministic, every number traceable`;
}

// ---- Views: Dashboard (team home) | Feed (every completion, live asks on top).
function setView(v, opts = {}) {
  state.view = v === "feed" ? "feed" : "home";
  const main = $("#main");
  main.classList.toggle("view-home", state.view === "home");
  main.classList.toggle("view-feed", state.view === "feed");
  document.querySelectorAll(".view-tab").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
  if (!opts.silent) { syncUrl(); window.scrollTo({ top: 0, behavior: "smooth" }); tele("tab"); }
  if (state.view === "feed") pollFeed();
}
// Every interactive card (answer, league table, rate-differently, rate tile, handle card) lives in
// #feed, which sits inside #feedview — hidden while the Dashboard is showing. A card prepended from the
// Dashboard without switching views lands in a display:none container: the button "does nothing".
// (v0.9.2 — League and Rate differently did exactly that.) Always go through here.
function showCard(card, opts = {}) {
  if (state.view !== "feed") { setView("feed", { silent: true }); syncUrl(); }
  $("#feed").prepend(card);
  card.scrollIntoView({ behavior: "smooth", block: opts.block ?? "start" });
  return card;
}
// Newest answers since the top of the feed — from this tab or any other fan. Prepends unseen ones with a flash.
let feedPolling = false;
async function pollFeed(force = false) {
  if (feedPolling) return; feedPolling = true;
  try {
    const r = await api(`/api/v1/record?team=${state.team}&season=${state.season}&limit=10`);
    $("#feed-count").textContent = r.total ? String(r.total) : "";
    const feed = $("#feed");
    const fresh = r.items.filter((it) => !$(`#feed [data-obs="${CSS.escape(it.id)}"]`)).reverse();
    for (const it of fresh) { const c = recordedCard(it); c.classList.add("recorded"); if (force || fresh.length) c.classList.add("flash"); feed.prepend(c); setTimeout(() => c.classList.remove("flash"), 1500); }
    $("#history-empty")?.remove();
    if (fresh.length) $("#feed-sub").textContent = `${fresh.length} new · ${r.total} answers on record`;
    else if (r.total) $("#feed-sub").textContent = `${r.total} answers on record · updates every 30s`;
  } catch (e) { $("#feed-sub").textContent = `feed refresh failed: ${e.message}`; }
  finally { feedPolling = false; }
}

// ---- History: the feed IS the record. Every completion for this team/season,
// newest first, paginated by seq with infinite scroll. Live asks prepend.
const hist = { before: null, loading: false, done: false, token: 0 };
function skeletonCard() {
  return el(`<article class="card skel" aria-hidden="true"><header class="card-head"><div class="skeleton" style="width:60%;height:22px;margin:0"></div><div class="skeleton" style="width:90px;height:18px;margin:0"></div></header><div class="statements"><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:65%"></div></div><div class="skeleton" style="width:95%"></div><div class="skeleton" style="width:88%"></div><div class="skeleton" style="width:40%"></div></article>`);
}
async function loadHistory(reset = false) {
  const feed = $("#feed");
  if (reset) { hist.before = null; hist.done = false; hist.loading = false; hist.token++; feed.innerHTML = ""; $("#history-sentinel")?.remove(); }
  if (hist.loading || hist.done) return;
  hist.loading = true;
  const token = hist.token;
  const skels = [skeletonCard(), skeletonCard(), skeletonCard()];
  feed.append(...skels);
  try {
    const r = await api(`/api/v1/record?team=${state.team}&season=${state.season}&limit=10${hist.before ? `&before=${hist.before}` : ""}`);
    if (token !== hist.token) return; // team/season changed mid-flight
    skels.forEach((k) => k.remove());
    for (const it of r.items) { const c = recordedCard(it); c.classList.add("recorded"); if (!$(`#feed [data-obs="${CSS.escape(it.id)}"]`)) feed.append(c); }
    hist.before = r.next_before;
    hist.done = r.next_before === null;
    $("#feed-count").textContent = r.total ? String(r.total) : "";
    $("#feed-sub").textContent = r.total ? `${r.total} answers on record · updates every 30s` : "nothing asked yet — every answer is kept and shows up here for the next fan";
    if (!feed.children.length) feed.append(el(`<div class="card muted" id="history-empty">Nothing asked about ${esc(teamName(state.team))} ${state.season} yet — every answer you get here is kept, with its evidence, and shows up for the next fan.</div>`));
    if (!hist.done) { const sn = el(`<div id="history-sentinel" class="muted" style="text-align:center;padding:10px">${r.total - $$("#feed .recorded").length} older answers · scroll for more</div>`); feed.append(sn); historyObserver.observe(sn); }
  } catch (e) {
    skels.forEach((k) => k.remove());
    feed.append(el(`<div class="card"><div class="err">history unavailable: ${esc(e.message)}</div></div>`));
  } finally { hist.loading = false; }
}
const historyObserver = new IntersectionObserver((entries) => { for (const en of entries) if (en.isIntersecting) { en.target.remove(); loadHistory(); } }, { rootMargin: "600px" });
// Anonymous telemetry: team/season/mode/view/viewport bucket (+ handle if you made one). No IP, no user agent — see admin.ts.
function tele(event) {
  if (state.meta && state.meta.telemetry === false) return;
  const w = innerWidth; const viewport = w < 480 ? "xs" : w < 768 ? "sm" : w < 1100 ? "md" : "lg";
  const body = JSON.stringify({ event, team: state.team, season: state.season, mode: state.coach ? "coach" : "fan", view: state.view, viewport, handle: loadIdentity()?.handle ?? null });
  try { if (navigator.sendBeacon) navigator.sendBeacon("/api/v1/telemetry", new Blob([body], { type: "application/json" })); else fetch("/api/v1/telemetry", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {}); } catch (e) { console.warn("telemetry", e.message); }
}
function renderSiteFoot() {
  const f = $("#site-foot"); if (!f) return;
  const lic = state.meta?.licensing;
  const src = lic ? Object.values(lic).map((l) => l?.name || l?.source).filter(Boolean) : [];
  f.innerHTML = `<div>${esc(state.meta?.team_logos?.disclaimer ?? "")}</div>${src.length ? `<div>Data: ${esc(src.join(" · "))}. The database knows. Deterministic code calculates. The model interprets. Provenance proves.</div>` : ""}<div class="legal">© ${new Date().getUTCFullYear()} <b>Interchained LLC</b> · CHALK / Sports-Rater · Business Source License 1.1 (SPDX: BUSL-1.1) · Licensor: Interchained LLC</div>`;
}
let homeRefreshAttempts = 0;
async function loadHome(defId) {
  applyTeamTheme(state.team);
  setHero(state.team);
  coachDeckKey = "";
  $("#home").classList.add("loading");
  $("#ring").classList.add("loading");
  $("#h-abbr").textContent = state.team;
  const heroLogo = $("#h-logo"); heroLogo.innerHTML = logoImg(state.team, "hero-logo"); $("#hero").classList.toggle("has-logo", Boolean(heroLogo.firstChild));
  $("#h-name").textContent = TEAMS[state.team]?.[0] ?? "";
  $("#rc-score").textContent = "…";
  ["#h-badges", "#form-body", "#last-body", "#next-body", "#weak-body", "#rc-components", "#trend-headline", "#ratings", "#scout-body"].forEach((s) => { $(s).innerHTML = ""; });
  $("#trend-svg").innerHTML = "";
  // If the server has no persisted snapshot for this team/season it computes
  // inline (~30s from 48k plays). Say so instead of showing three dots.
  const slow = setTimeout(() => { for (const sel of ["#scout-body", "#trend-headline", "#weak-body"]) $(sel).innerHTML = `<div class="muted">Computing from the full season's plays — first look at this team since the data changed (~30s). Next time is instant.</div>`; }, 1500);
  try {
    const h = await api(`/api/v1/teams/${state.team}/home?season=${state.season}${defId ? `&definition=${encodeURIComponent(defId)}` : ""}`);
    clearTimeout(slow);
    state.home = h; state.rating = h.rating ? { summary: h.rating, snapshot: { definition_id: h.rating.definition_id, id: h.rating_snapshot_id } } : null;
    $("#home").classList.remove("loading"); $("#ring").classList.remove("loading");
    // Served from a snapshot built before the latest data change: show it, then re-pull once the background rebuild lands.
    if (h.served?.refreshing) { $("#rc-rank").insertAdjacentHTML("beforeend", ' <span class="badge amber" id="refreshing" title="data changed since this was computed; refreshing">refreshing…</span>'); homeRefreshAttempts = (homeRefreshAttempts ?? 0) + 1; if (homeRefreshAttempts <= 8) setTimeout(() => { if (state.team === h.team && state.season === h.season) loadHome(defId); }, 4000); } else homeRefreshAttempts = 0;
    renderHeadline(h);
    renderFav();
    renderTrend(h.trend);
    renderForm(h.form);
    renderLast(h.last_game);
    renderNext(h.next_game);
    renderWeak(h);
    renderBadges(h.badges);
    renderRatings(h.ratings);
    renderScout(h.scout, h.next_game);
    renderTrendChips(h.ratings);
    loadGames();
    loadRecord();
    if (state.coach) loadCoachDeck();
  } catch (e) { clearTimeout(slow); $("#home").classList.remove("loading"); $("#ring").classList.remove("loading");
    $("#rc-score").textContent = "–";
    $("#rc-line1").innerHTML = `<span class="err">${esc(e.message)}</span>`;
    $("#rc-rank").textContent = e.status === 404 ? `No ${state.season} data — run: chalk ingest --season ${state.season}` : "";
  }
}
function renderRating(h) {
  const s = h.rating;
  if (!s) { $("#rc-score").textContent = "–"; $("#rc-rank").textContent = "no third-down data"; return; }
  const score = s.score ?? 0;
  $("#rc-score").innerHTML = `${s.score ?? "–"}<small>/100</small>`;
  const fg = $("#ring-fg"); fg.style.strokeDashoffset = 326.7 * (1 - score / 100);
  $("#rc-rank").innerHTML = `<b>#${s.rank}</b> of ${s.of}${s.provisional ? ' <span class="badge amber">provisional</span>' : ""}`;
  $("#rc-line1").textContent = `${s.definition} · ${s.sample_size} third downs · ${s.normalization}`;
  $("#rc-components").innerHTML = s.components.map((c) => `<div class="comp"><div class="k">${esc(c.metric.replace(/_/g, " "))} · ${c.weight_pct}%</div><div class="v">${c.raw_unit === "%" ? fmtPct(c.raw) : fmtNum(c.raw, 3)}</div><div class="p">${c.percentile === null ? "—" : `${c.percentile}th pct`} · #${c.rank ?? "—"} · +${fmtNum(c.points, 1)} pts</div><div class="bar"><i style="width:${c.percentile ?? 0}%"></i></div></div>`).join("");
}
function renderTrend(t, subject = "third_down") {
  const svg = $("#trend-svg"); const sub = $("#trend-sub"); const head = $("#trend-headline");
  const unit = headlineUnit(subject);
  if (!t || !t.points.length) { head.textContent = "No trend yet."; return; }
  const pts = t.points; const W = 320, H = 96, padL = 8, padR = 26, padT = 14, padB = 16;
  const xs = pts.map((_, i) => padL + (i * (W - padL - padR)) / Math.max(1, pts.length - 1));
  const ys = pts.map((p) => H - padB - ((p.score ?? 0) / 100) * (H - padT - padB));
  const line = pts.map((_, i) => `${i ? "L" : "M"}${xs[i].toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const area = `${line} L${xs[xs.length - 1].toFixed(1)},${H - padB} L${xs[0].toFixed(1)},${H - padB} Z`;
  const last = pts[pts.length - 1];
  svg.innerHTML = `<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    <path class="area" d="${area}"/><path class="line" d="${line}"/>
    ${pts.map((p, i) => `<circle class="dot ${p.provisional ? "prov" : ""}" cx="${xs[i].toFixed(1)}" cy="${ys[i].toFixed(1)}" r="3"><title>Week ${p.week}: ${p.score}/100 · rank ${p.rank} · ${p.attempts} ${unit}${p.provisional ? " (provisional)" : ""}</title></circle>`).join("")}
    ${pts.filter((_, i) => i % Math.ceil(pts.length / 6) === 0 || i === pts.length - 1).map((p) => `<text class="lbl" x="${xs[pts.indexOf(p)].toFixed(1)}" y="${H - 3}" text-anchor="middle">W${p.week}</text>`).join("")}
    <text class="val" x="${(xs[xs.length - 1] + 5).toFixed(1)}" y="${(ys[ys.length - 1] + 4).toFixed(1)}">${last.score}</text>`;
  sub.textContent = `${headlineLabel(subject).toLowerCase()} · wk ${pts[0].week}–${last.week} · as known then`;
  head.textContent = t.headline;
}
// Trend follows the headline (v0.10.1): one loader for both the chips and the hero picker. Third down uses
// the trend already in the Home payload (it follows the Home formula); other subjects fetch the per-subject
// trend, with the active formula when one was applied via Rate differently.
let trendKey = "";
async function showTrendFor(subject, defId) {
  const key = `${state.team}|${state.season}|${subject}|${defId ?? ""}`;
  trendKey = key;
  document.querySelectorAll("#trend-chips .chip").forEach((x) => x.classList.toggle("on", x.dataset.subject === subject));
  if (subject === "third_down") { renderTrend(state.home?.trend, subject); return; }
  $("#trend-headline").textContent = "…";
  try {
    const t = await api(`/api/v1/ratings/${subjectPath(subject)}/trend?team=${state.team}&season=${state.season}${defId ? `&definition=${encodeURIComponent(defId)}` : ""}`);
    if (trendKey !== key) return;
    renderTrend({ points: t.points.map((p) => ({ ...p, attempts: p.sample })), headline: t.headline }, subject);
  } catch (e) { if (trendKey === key) $("#trend-headline").innerHTML = `<span class="err">trend unavailable: ${esc(e.message)}</span>`; }
}
function renderTrendChips(ratings) {
  const box = $("#trend-chips"); box.innerHTML = "";
  for (const r of ratings) {
    const b = el(`<button class="chip ${r.subject === state.headline ? "on" : ""}" data-subject="${esc(r.subject)}">${esc(r.label)}</button>`);
    b.onclick = () => showTrendFor(r.subject);
    box.append(b);
  }
  if (state.headline && state.headline !== "third_down") showTrendFor(state.headline);
}
async function loadGames() {
  const body = $("#games-body"); const sub = $("#games-sub");
  try {
    const g = await api(`/api/v1/games?season=${state.season}&team=${state.team}`);
    const played = g.games.filter((x) => x.home_score !== null);
    const w = played.filter((x) => x.winner === state.team).length, l = played.filter((x) => x.winner && x.winner !== state.team).length, t = played.length - w - l;
    sub.textContent = played.length ? `${w}-${l}${t ? `-${t}` : ""}` : "";
    body.innerHTML = "";
    for (const x of g.games) {
      const home = x.home_team === state.team; const opp = home ? x.away_team : x.home_team;
      const us = home ? x.home_score : x.away_score, them = home ? x.away_score : x.home_score;
      const wl = x.home_score === null ? "S" : x.winner === state.team ? "W" : x.winner === null ? "T" : "L";
      const row = el(`<div class="gm" title="${esc(x.id)}"><div class="wl ${wl}">${wl === "S" ? "·" : wl}</div><div><div class="o">${home ? "vs" : "@"} ${esc(opp)}${x.home_score !== null ? ` <span class="muted">${us}–${them}</span>` : ""}</div><div class="m">Wk ${x.week}${x.gameday ? ` · ${esc(x.gameday.slice(5))}` : ""}${x.div_game ? " · div" : ""}</div></div></div>`);
      row.onclick = () => ask(x.home_score === null ? `What should I know about the ${opp} offense?` : `Why did ${teamName(state.team)} ${wl === "W" ? "win" : wl === "L" ? "lose" : "tie"} ${x.id}`);
      body.append(row);
    }
    if (!g.games.length) body.innerHTML = `<div class="empty">No games ingested for ${state.season}.</div>`;
  } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
function renderForm(f) {
  const b = $("#form-body");
  if (!f) { b.innerHTML = `<div class="empty">No snaps yet.</div>`; return; }
  const row = (k, v, d, unit) => `<div class="form-row"><span class="k">${k}</span><span class="v">${v} <span class="delta ${d >= 0 ? "up" : "down"}">${unit === "pp" ? signed(d, 1) + " pts" : signed(d, 3)}</span></span></div>`;
  const dm = Object.fromEntries(f.deltas.map((d) => [d.metric, d]));
  b.innerHTML = `<div class="muted">last ${f.last_games.length} games vs season · ${f.recent.attempts} snaps</div>` +
    row("EPA / play", fmtNum(f.recent.epa_per_play, 3), dm.epa_per_play.delta, "epa") +
    row("Success", fmtPct(Math.round((f.recent.success_rate ?? 0) * 1000) / 10), dm.success_rate.delta, "pp") +
    row("Explosive", fmtPct(Math.round((f.recent.explosive_rate ?? 0) * 1000) / 10), dm.explosive_rate.delta, "pp") +
    row("Turnovers", fmtPct(Math.round((f.recent.turnover_rate ?? 0) * 1000) / 10), -(dm.turnover_rate.delta ?? 0), "pp");
}
function renderLast(l) {
  const b = $("#last-body");
  if (!l) { b.innerHTML = `<div class="empty">No games played.</div>`; return; }
  const g = l.game; const wl = l.team_line[0];
  b.innerHTML = `<div class="score-line"><span class="wl ${wl}">${wl}</span>${esc(l.team_line.slice(2))}</div>
    <div class="sub-line">Week ${g.week} · 3rd down ${l.third_down.conversions}/${l.third_down.attempts} (${fmtPct(l.third_down.conversion_pct)})</div>
    ${l.deviation ? `<div class="dev ${esc(l.deviation.level)}" title="${esc(l.deviation.headline)}">DEVIATION ${esc(l.deviation.level)}${l.deviation.driver ? ` · ${esc(l.deviation.driver.replace(/_/g, " "))}` : ""}</div>` : ""}
    <div style="margin-top:8px"><button class="chip" data-ask="Why did Tampa ${wl === "W" ? "win" : "lose"} ${esc(g.id)}">Why?</button></div>`;
  b.querySelector("[data-ask]").dataset.ask = `Why did ${teamName(state.team)} ${wl === "W" ? "win" : "lose"} ${g.id}`;
}
function renderNext(n) {
  const b = $("#next-body");
  if (!n || !n.opponent) { b.innerHTML = `<div class="empty">No upcoming game found.</div>`; return; }
  const g = n.game; const p = n.pulse;
  const when = g?.gameday ? new Date(g.gameday + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : p?.kickoff ? new Date(p.kickoff).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric" }) : "";
  const home = g ? g.home_team === state.team : p ? p.home_team === state.team : true;
  b.innerHTML = `<div class="opp">${logoImg(n.opponent, "logo opp-logo")}<div><div class="abbr">${home ? "vs" : "@"} ${esc(n.opponent)}</div><div class="kick">${esc(TEAMS[n.opponent]?.[0] ?? "")}${when ? ` · ${esc(when)}` : ""}${g?.week ? ` · Wk ${g.week}` : ""}${p?.phase === "live" ? ` · <b style="color:var(--red)">LIVE</b>` : ""}</div></div>
    ${n.opponent_rating ? `<div class="oscore">${n.opponent_rating.score}<small>their 3rd down · #${n.opponent_rating.rank}</small></div>` : ""}</div>
    <div style="margin-top:10px"><button class="chip" data-ask="What should I know about the ${esc(n.opponent)} offense?">Scout them</button></div>
    <div class="pick" id="pick"></div><div class="hype" id="hype"></div>`;
  if (g?.id) renderPick(g, n);
  if (g?.week) renderHype(g.week);
}

// ---------------------------------------------------- fan knobs (not facts)
// Picks: who you got, before kickoff; the facts settle it later. Hype: how you feel, 1-5. Neither touches
// a CHALK number — the fact wall (tests/fact_wall.test.ts) keeps it that way.
async function renderPick(g, n) {
  const box = $("#pick"); if (!box) return;
  const id = loadIdentity();
  const [crowd, mine] = await Promise.all([
    api(`/api/v1/fans/picks/game?game_id=${encodeURIComponent(g.id)}`).catch((e) => ({ total: 0, by_team: {}, __err: e.message })),
    id ? api(`/api/v1/fans/picks?fan_id=${id.fan_id}&season=${state.season}`).catch((e) => ({ picks: [], record: null, __err: e.message })) : Promise.resolve({ picks: [], record: null }),
  ]);
  if (!$("#pick")) return;
  const my = mine.picks.find((p) => p.game_id === g.id)?.pick ?? null;
  const locked = g.home_score !== null || (g.gameday && g.gameday < new Date().toISOString().slice(0, 10));
  const rec = mine.record; const recTxt = rec ? `you ${rec.wins}-${rec.losses}${rec.pushes ? `-${rec.pushes}` : ""}${rec.pending ? ` · ${rec.pending} pending` : ""}` : "";
  const sides = [g.away_team, g.home_team];
  const total = crowd.total || 0; const a = crowd.by_team?.[sides[0]] ?? 0, b = crowd.by_team?.[sides[1]] ?? 0;
  box.innerHTML = `<div class="ph"><span>Who you got</span><span class="rec">${esc(recTxt)}</span></div>
    <div class="sides">${sides.map((t) => `<button class="side ${my === t ? "on" : ""}" data-pick="${esc(t)}" ${locked ? "disabled" : ""}>${logoImg(t, "")}<span>${esc(t)}</span>${total ? `<small class="muted" style="margin-left:auto">${Math.round(((t === sides[0] ? a : b) / total) * 100)}%</small>` : ""}</button>`).join("")}</div>
    ${total ? `<div class="split" title="${a} ${esc(sides[0])} · ${b} ${esc(sides[1])}"><i style="width:${(a / total) * 100}%"></i><i class="b" style="width:${(b / total) * 100}%"></i></div>` : ""}
    <div class="note">${crowd.__err ? `crowd unavailable: ${esc(crowd.__err)}` : locked ? "locked at kickoff — the facts settle it" : total ? `${total} fan${total === 1 ? "" : "s"} picked · ${my ? `you took ${esc(my)}` : "your pick is stored on your chain; the final score grades it"}` : "first pick on this game · stored on your chain; the final score grades it"}${mine.__err ? ` · your record unavailable: ${esc(mine.__err)}` : ""}</div>`;
  box.querySelectorAll("[data-pick]").forEach((btn) => { btn.onclick = async () => { try { const r = await fanPost("/api/v1/fans/picks", { game_id: g.id, pick: btn.dataset.pick }); if (!r) return; tele("pick"); renderPick(g, n); loadFeed(); } catch (e) { $(".note", box).innerHTML = `<span class="err">${esc(e.message)}</span>`; } }; });
}
async function renderHype(week) {
  const box = $("#hype"); if (!box) return;
  const id = loadIdentity();
  let agg; try { agg = await api(`/api/v1/fans/hype?team=${state.team}&season=${state.season}&week=${week}`); } catch (e) { box.innerHTML = `<div class="note">hype unavailable: ${esc(e.message)}</div>`; return; }
  if (!$("#hype")) return;
  const mineKey = `sr.hype.${state.team}.${state.season}.${week}`; let mine = null; try { mine = Number(localStorage.getItem(mineKey)) || null; } catch {}
  const crowd = agg.mean ? Math.round(agg.mean) : null;
  box.innerHTML = `<div class="ph" style="font-family:var(--display);font-weight:700;text-transform:uppercase;letter-spacing:.12em;font-size:11px;color:var(--fg-3);display:flex;justify-content:space-between"><span>How you feel · wk ${week}</span><span class="note">${agg.n ? `${agg.n} fan${agg.n === 1 ? "" : "s"} · ${esc(agg.label)} (${agg.mean})` : "no reads yet"}</span></div>
    <div class="scale">${agg.labels.map((l, i) => `<button data-h="${i + 1}" class="${mine === i + 1 ? "on" : ""} ${crowd === i + 1 ? "crowd" : ""}" title="${i + 1}/5">${esc(l)}</button>`).join("")}</div>
    <div class="note">sentiment, not a stat — it never touches a CHALK number</div>`;
  box.querySelectorAll("[data-h]").forEach((btn) => { btn.onclick = async () => { try { const r = await fanPost("/api/v1/fans/hype", { team: state.team, season: state.season, week, value: Number(btn.dataset.h) }); if (!r) return; try { localStorage.setItem(mineKey, String(r.mine)); } catch {} tele("hype"); renderHype(week); } catch (e) { $(".note", box).innerHTML = `<span class="err">${esc(e.message)}</span>`; } }; });
}
function renderFav() { const b = $("#fav"); if (!b) return; const on = state.favorite === state.team; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); b.textContent = on ? "★ my team" : "☆ my team"; }
async function setFavorite() {
  try {
    const r = await fanPost("/api/v1/fans/favorites", { team: state.team }); if (!r) return;
    state.favorite = r.team; try { localStorage.setItem(FAV_KEY, r.team); } catch {}
    renderFav(); tele("favorite");
  } catch (e) { alert(e.message); }
}
async function syncFavoriteFromServer() {
  const id = loadIdentity(); if (!id) return;
  try { const r = await api(`/api/v1/fans/favorite?fan_id=${id.fan_id}`); if (r.team && r.team !== state.favorite) { state.favorite = r.team; try { localStorage.setItem(FAV_KEY, r.team); } catch {} renderFav(); } }
  catch (e) { console.warn(`favorite: server sync failed — ${e.message}`); }
}
async function renderLeaderboard() {
  const box = $("#leaderboard"); if (!box) return;
  try {
    const lb = await api(`/api/v1/fans/picks/leaderboard?season=${state.season}&limit=5`);
    const me = loadIdentity()?.fan_id;
    box.innerHTML = lb.count ? `<div class="lbh">Pick'em · ${state.season}</div>` + lb.rows.map((r, i) => `<div class="row ${r.fan_id === me ? "me" : ""}"><span>${i + 1}</span><img src="/api/v1/identicon/${r.fan_id}.svg?size=20" alt="" /><span class="h">${esc(r.handle)}</span><span class="r">${r.record.wins}-${r.record.losses}${r.record.pushes ? `-${r.record.pushes}` : ""}${r.record.pct !== null ? ` · ${r.record.pct}%` : ""}${r.record.pending ? ` · ${r.record.pending} pending` : ""}</span></div>`).join("") : "";
  } catch (e) { box.innerHTML = `<div class="note err">leaderboard unavailable: ${esc(e.message)}</div>`; }
}
function renderWeak(h) {
  const b = $("#weak-body");
  if (!h.weakest.length) { b.innerHTML = `<div class="empty">Not enough snaps to rank situations.</div>`; return; }
  b.innerHTML = "";
  for (const w of h.weakest) b.append(el(`<div class="weak-row" data-ask="What does Tampa do in this situation: ${esc(w.situation)}"><div>${esc(w.situation)}<div class="n">${w.snaps} snaps</div></div><div class="epa">${signed(w.epa_vs_team, 2)} EPA</div></div>`));
  for (const s of h.strongest.slice(0, 1)) b.append(el(`<div class="weak-row" data-ask="What does Tampa do in this situation: ${esc(s.situation)}"><div>${esc(s.situation)}<div class="n">${s.snaps} snaps · strongest</div></div><div class="epa good">${signed(s.epa_vs_team, 2)} EPA</div></div>`));
}
const SUBJECT_Q = { offense: "How is the Tampa offense rated overall?", defense: "Grade the Tampa defense", third_down: "How does Tampa's third-down rating break down?", red_zone: "What is Tampa's red zone rating?", explosiveness: "How explosive is Tampa's offense rated?", ball_security: "What is Tampa's ball security rating?" };
// Headline rating (v0.10.0): the hero ring shows one subject; default third down. Every subject's default
// rating is already in the Home payload (ratings[]), so switching is a re-render, not a rebuild; the
// components table for a non-third-down subject is one cheap fetch. URL: ?headline=offense.
const HEADLINES = [["third_down", "Third Down", "third downs"], ["offense", "Offense", "plays"], ["defense", "Defense", "plays faced"], ["red_zone", "Red Zone", "red-zone plays"], ["explosiveness", "Explosiveness", "plays"], ["ball_security", "Ball Security", "plays"]];
const headlineLabel = (sj) => (HEADLINES.find((h) => h[0] === sj) || HEADLINES[0])[1];
const headlineUnit = (sj) => (HEADLINES.find((h) => h[0] === sj) || HEADLINES[0])[2];
const subjectPath = (sj) => sj.replace("_", "-");
function renderHeadlinePicker() {
  const box = $("#headline-pick"); box.innerHTML = "";
  for (const [sj, label] of HEADLINES) { const b = el(`<button class="hp ${state.headline === sj ? "on" : ""}" role="tab" aria-selected="${state.headline === sj}" data-headline="${sj}">${esc(label)}</button>`); b.onclick = () => setHeadline(sj); box.append(b); }
}
function setHeadline(sj, opts = {}) {
  if (!HEADLINES.some((h) => h[0] === sj)) sj = "third_down";
  state.headline = sj; state.headlineDef = null;
  renderHeadlinePicker();
  document.querySelectorAll("#ratings .rt").forEach((c) => c.classList.toggle("headline", c.dataset.subject === sj));
  if (!opts.silent) { syncUrl(); tele("headline"); }
  if (state.home) { renderHeadline(state.home); showTrendFor(sj); }
}
// Paint the hero ring for the active headline. Third down keeps the full Home rating (trend, components
// from the snapshot); other subjects paint from ratings[] immediately and pull components after.
async function renderHeadline(h, override) {
  const sj = state.headline || "third_down";
  $("#rc-label").textContent = `${headlineLabel(sj)} Rating`;
  $("#rc-why").dataset.ask = SUBJECT_Q[sj] || `How is Tampa rated on ${headlineLabel(sj).toLowerCase()}?`;
  if (sj === "third_down" && !override) { renderRating(h); return; }
  const r = override || (h.ratings || []).find((x) => x.subject === sj);
  if (!r) { $("#rc-score").textContent = "–"; $("#rc-rank").textContent = `no ${headlineLabel(sj).toLowerCase()} rating for ${state.season}`; $("#rc-line1").textContent = ""; $("#rc-components").innerHTML = ""; return; }
  const score = r.score ?? 0;
  $("#rc-score").innerHTML = `${r.score ?? "–"}<small>/100</small>`;
  $("#ring-fg").style.strokeDashoffset = 326.7 * (1 - score / 100);
  $("#rc-rank").innerHTML = `<b>#${r.rank}</b> of ${r.of}${r.provisional ? ' <span class="badge amber">provisional</span>' : ""}`;
  $("#rc-line1").textContent = `${r.definition_name} · ${r.sample} ${headlineUnit(sj)} · percentile_rank@1.0.0`;
  state.rating = { summary: { definition_id: r.definition_id, score: r.score, rank: r.rank, of: r.of }, snapshot: { definition_id: r.definition_id, id: r.snapshot_id } };
  $("#rc-components").innerHTML = `<div class="muted">components…</div>`;
  try {
    const full = r.components ? r : await api(`/api/v1/ratings/${subjectPath(sj)}?team=${state.team}&season=${state.season}&definition=${encodeURIComponent(r.definition_id)}`);
    if (state.headline !== sj) return;
    const comps = full.components || full.snapshot?.components || [];
    $("#rc-components").innerHTML = comps.map((c) => `<div class="comp"><div class="k">${esc(c.label ?? c.metric)} · ${Math.round((c.weight ?? 0) * 100)}%</div><div class="v">${String(c.metric).includes("rate") ? fmtPct(c.raw === null ? null : Math.round(c.raw * 1000) / 10) : fmtNum(c.raw, 3)}</div><div class="p">${c.normalized === null || c.normalized === undefined ? "—" : `${Math.round(c.normalized * 100)}th pct`}</div></div>`).join("");
  } catch (e) { $("#rc-components").innerHTML = `<div class="err">components unavailable: ${esc(e.message)}</div>`; }
}
function renderRatings(list) {
  const box = $("#ratings"); box.innerHTML = "";
  for (const r of list) {
    const card = el(`<div class="rt ${r.provisional ? "prov" : ""}" data-subject="${esc(r.subject)}" title="${esc(r.definition_name)} · ${r.sample} sample"><div class="k">${esc(r.label)}</div><div class="v">${r.score ?? "–"}<small>/100</small></div><div class="r">#${r.rank} of ${r.of}${r.top_component ? ` · ${esc(r.top_component.label.toLowerCase())} ${r.top_component.percentile}th` : ""}${r.provisional ? " · provisional" : ""}</div><div class="rx" style="margin-top:6px;display:flex;gap:4px"><button class="chip" data-why style="padding:4px 8px;font-size:12px">Why?</button></div><div class="bar"><i style="width:${r.score ?? 0}%"></i></div></div>`);
    card.querySelector("[data-why]").onclick = () => ask((SUBJECT_Q[r.subject] || `How is Tampa rated on ${r.label.toLowerCase()}?`).replaceAll("Tampa", teamName(state.team)));
    card.classList.toggle("headline", r.subject === state.headline);
    card.onclick = (e) => { if (e.target.closest("button")) return; setHeadline(r.subject); $("#rating-card").scrollIntoView({ behavior: "smooth", block: "center" }); };
    box.append(card);
  }
}
function renderScout(s, n) {
  const box = $("#scout-body"); const sub = $("#scout-sub");
  if (!s) { box.innerHTML = `<div class="empty">${n?.opponent ? `No ${state.season} plays ingested for ${esc(n.opponent)} yet.` : "No upcoming opponent found."}</div>`; return; }
  sub.textContent = `${TEAMS[s.opponent]?.[0] ?? s.opponent} offense · ${s.snaps} snaps`;
  const stat = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
  box.innerHTML = `<div class="scout-body"><div class="scout-abbr">${esc(s.opponent)}</div><div><div class="scout-stats">${stat("pass", fmtPct(s.pass_pct))}${stat("EPA / play", fmtNum(s.epa_per_play, 3))}${s.shotgun_pct !== null ? stat("shotgun", fmtPct(s.shotgun_pct)) : ""}${s.personnel ? stat("top personnel", esc(s.personnel)) : ""}${s.third_medium ? stat("3rd & 4–6 pass", `${fmtPct(s.third_medium.pass_pct)} <small class="muted">${s.third_medium.snaps} snaps</small>`) : ""}</div><div class="scout-lines">${s.weakest ? `<div>Weakest: ${esc(s.weakest)}</div>` : ""}${s.strongest ? `<div>Strongest: ${esc(s.strongest)}</div>` : ""}</div><div style="margin-top:10px"><button class="chip" data-ask="What should I know about the ${esc(s.opponent)} offense?">Full scouting report</button> <button class="chip" data-ask="What should I know about the ${esc(s.opponent)} defense?">Their defense</button></div></div></div>`;
}
function renderBadges(badges) {
  const b = $("#h-badges"); b.innerHTML = "";
  const order = { tier: 0, signature: 1, heel: 2 };
  for (const x of [...badges].sort((p, q) => (order[p.kind] ?? 0) - (order[q.kind] ?? 0))) b.append(el(`<button class="badge-pill ${x.tone} ${esc(x.kind ?? "tier")}" title="${esc(x.description)} · ${esc(x.qualification_rule)} · ${x.percentile}th pct · #${x.rank} of ${x.of} · n=${x.sample}" data-ask="${x.kind === "signature" ? `What is Tampa's signature strength and why?` : x.kind === "heel" ? `What is Tampa's biggest weakness and why?` : `Why does Tampa have the ${esc(x.name.toLowerCase())} badge?`}">${esc(x.emoji)} ${esc(x.name)}</button>`));
  if (!badges.length) b.append(el(`<span class="muted">Badges need a full league sample — not enough snaps yet this season.</span>`));
}

// ---------------------------------------------------------------- identity
// No account. nickname + a salt that never leaves this device -> sha256 ->
// fan_id; handle = nick#first6. The server stores only handle + fan_id on writes.
const ID_KEY = "sr.identity";
function loadIdentity() { try { return JSON.parse(localStorage.getItem(ID_KEY) || "null"); } catch { return null; } }
async function sha256hex(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
async function createIdentity(nickname) {
  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const fan_id = await sha256hex(`${nickname}:${salt}`);
  const id = { nickname, salt, fan_id, handle: `${nickname}#${fan_id.slice(0, 6)}` };
  localStorage.setItem(ID_KEY, JSON.stringify(id));
  return id;
}
function renderWho() {
  const id = loadIdentity(); const b = $("#who");
  b.innerHTML = id ? `<img src="/api/v1/identicon/${id.fan_id}.svg?size=18" alt="" /> ${esc(id.handle)}` : "rate as…";
  b.onclick = () => whoDialog();
}
function whoDialog() {
  const id = loadIdentity();
  const card = el(`<article class="card"><header class="card-head"><div class="q">${id ? "You" : "Pick a handle"}</div></header><div class="muted">No account. Your nickname plus a secret this device keeps become a hash — that hash is your identity on every rating and take. Lose the device, lose the handle; that's the deal.</div><div class="drawer"></div></article>`);
  const d = $(".drawer", card);
  if (id) d.append(el(`<div class="fi"><img src="/api/v1/identicon/${id.fan_id}.svg?size=32" alt="" /><div><div class="h">${esc(id.handle)}</div><div class="t muted">${esc(id.fan_id)}</div><div class="rx"><button data-chain>Verify my chain</button><button data-forget>Forget this device</button></div></div></div>`));
  const form = el(`<form class="who-form"><input name="nick" placeholder="nickname (letters, numbers, _ . -)" maxlength="24" pattern="[A-Za-z0-9_][A-Za-z0-9_ .\\-]{0,23}" required /><button class="chip go" type="submit">${id ? "New handle" : "Create"}</button><div class="err out"></div></form>`);
  form.onsubmit = async (e) => { e.preventDefault(); const nick = new FormData(form).get("nick").trim(); if (!/^[A-Za-z0-9_][A-Za-z0-9_ .\-]{0,23}$/.test(nick)) { $(".out", form).textContent = "1-24 chars: letters, numbers, _ . -"; return; } await createIdentity(nick); renderWho(); card.remove(); loadFeed(); };
  d.append(form);
  d.querySelector("[data-forget]")?.addEventListener("click", () => { localStorage.removeItem(ID_KEY); renderWho(); card.remove(); });
  d.querySelector("[data-chain]")?.addEventListener("click", async () => { const c = await api(`/api/v1/fans/${id.fan_id}`); const box = el(`<div></div>`); box.append(el(`<div class="h">Chain · ${c.length} writes · ${c.verified ? "every link verified" : "history in chain (re-rated)"}</div>`)); const prov = el(`<div class="prov"></div>`); for (const l of c.links) prov.append(el(`<div><span class="c">${esc(l.kind)}</span><span>#${l.chain_index} ${esc(l.created_at.slice(0, 16))}</span><span class="hsh">${esc(l.hash.slice(0, 12))} ← ${esc((l.prev || "genesis").slice(0, 12))}</span></div>`)); box.append(prov); d.append(box); });
  showCard(card, { block: "nearest" });
}
async function requireIdentity() { const id = loadIdentity(); if (id) return id; whoDialog(); return null; }
async function fanPost(path, body) {
  const id = await requireIdentity(); if (!id) return null;
  return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fan_id: id.fan_id, handle: id.handle, ...body }) });
}

// ------------------------------------------------------------------- feed
async function loadFeed() {
  const body = $("#feed-body"); const sub = $("#feed-sub");
  try {
    const f = await api(`/api/v1/feed?team=${state.team}&limit=20`);
    sub.textContent = f.count ? `${f.count} newest · seq ${f.seq}` : "";
    renderLeaderboard();
    body.innerHTML = f.count ? "" : `<div class="empty">No takes yet for ${esc(state.team)}. Pick the next game or post one.</div>`;
    for (const i of f.items) {
      const item = el(`<div class="fi"><img src="/api/v1/identicon/${i.fan_id}.svg?size=32" alt="" /><div><div class="h">${esc(i.handle)}<small>#${i.chain_index} · ${esc(new Date(i.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</small></div>${i.kind === "post" ? `<div class="t">${esc(i.text)}</div><div class="rx"><button data-r="like">👍 ${i.reactions?.like ?? 0}</button><button data-r="agree">agree ${i.reactions?.agree ?? 0}</button><button data-r="disagree">disagree ${i.reactions?.disagree ?? 0}</button><button data-prov>provenance</button></div>` : i.kind === "pick" ? `<div class="t">picked <span class="pk">${esc(i.pick)}</span> · ${esc(i.away_team)} @ ${esc(i.home_team)}${i.week ? ` · wk ${i.week}` : ""}</div>` : `<div class="t">rated ${esc(i.team)} ${esc(i.subject.replace(/_/g, " "))}${i.chalk_score !== null && i.chalk_score !== undefined ? ` · CHALK said ${i.chalk_score}` : ""}</div>`}</div>${i.kind === "rating" ? `<div class="sc">${i.score}<small>fan</small></div>` : ""}</div>`);
      item.querySelectorAll("[data-r]").forEach((b) => { b.onclick = async () => { try { await fanPost("/api/v1/fans/reactions", { target_coll: "sr_posts", target_id: i.id, reaction: b.dataset.r }); loadFeed(); } catch (e) { alert(e.message); } }; });
      item.querySelector("[data-prov]")?.addEventListener("click", async () => { const p = await api(`/api/v1/provenance/sr_posts/${encodeURIComponent(i.id)}`); alert(`${p.node_count} records behind this take · ${Object.entries(p.collections).map(([k, v]) => `${k}: ${v}`).join(", ")}`); });
      body.append(item);
    }
  } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ------------------------------------------------------------------- ask
async function ask(question, opts = {}) {
  const card = $("#tpl-answer").content.firstElementChild.cloneNode(true);
  card.classList.toggle("coach-on", state.coach);
  $(".q", card).textContent = question;
  const badges = $(".badges", card), statements = $(".statements", card), prose = $(".prose", card), coach = $(".coach", card), drawer = $(".drawer", card);
  tele("ask");
  showCard(card);
  let evidence = null, planInfo = null, observation = null;
  prose.classList.add("streaming");
  badges.append(el(`<span class="badge working">planning</span>`));
  // Skeleton lines stand in for the deterministic statements until the evidence event lands.
  statements.innerHTML = `<div class="skeleton" style="width:78%"></div><div class="skeleton" style="width:62%"></div><div class="skeleton" style="width:70%"></div>`;
  const url = new URL(location.href);
  const body = { question, team: state.team, season: state.season, game_id: url.searchParams.get("game_id") || undefined, live: opts.live === true || undefined, mode: state.coach ? "coach" : "fan" };
  try {
    const res = await fetch("/api/v1/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (.+)$/m.exec(chunk)?.[1]; const data = /^data: (.+)$/m.exec(chunk)?.[1]; if (ev && data) handle(ev, JSON.parse(data)); }
    }
  } catch (e) { prose.classList.remove("streaming"); statements.querySelectorAll(".skeleton").forEach((x) => x.remove()); statements.append(el(`<div class="err">${esc(e.message)}</div>`)); }
  function handle(ev, d) {
    if (ev === "plan") { planInfo = d; badges.innerHTML = ""; if (d.plan) badges.append(el(`<span class="badge lime">${esc(d.plan.intent)}</span>`), el(`<span class="badge">${d.plan.source === "model" ? esc(d.plan.model) : "rules"}</span>`)); if (d.fallback_used) badges.append(el(`<span class="badge amber" title="${esc(d.errors.join("; "))}">fallback</span>`)); }
    else if (ev === "evidence") {
      evidence = d;
      statements.innerHTML = "";
      for (const s of d.deterministic_statements) statements.append(el(`<div class="statement">${esc(s)}</div>`));
      const sample = d.summary?.rating?.sample_size ?? d.summary?.profile?.snaps;
      badges.append(el(`<span class="badge">${d.evidence_count ? `${d.evidence_count} plays` : sample ? `${sample} snaps · aggregate` : "no play list"}</span>`));
      const conf = d.summary?.analysis?.confidence || d.summary?.confidence; if (conf === "insufficient" || conf === "low") badges.append(el(`<span class="badge red">${esc(conf)} sample</span>`));
      coach.innerHTML = "";
      // A coach-view render bug must never abandon the SSE stream (it did once: subject ratings have no `analysis`).
      try { coach.append(renderCoach(d)); } catch (e) { console.error("renderCoach failed", d.kind, e); coach.append(el(`<div class="err">coach view failed to render this ${esc(d.kind)} package: ${esc(e.message)} — the statements above are unaffected.</div>`)); }
    }
    else if (ev === "token") prose.textContent += d.text;
    else if (ev === "observation") { observation = d; prose.classList.remove("streaming");
      if (d.register === "coach" || (state.coach && !d.from_record)) badges.append(el(`<span class="badge">coach read</span>`));
      if (d.from_record) { card.dataset.obs = d.id; badges.append(el(`<span class="badge lime" title="Same inputs as when this was answered on ${esc(d.recorded_at)} — served from the record, no model call">from the record · ${esc(ago(d.recorded_at))}</span>`)); const re = el(`<button class="chip">Re-ask live</button>`); re.onclick = () => ask(question, { live: true }); $(".card-foot", card).prepend(re); }
      else if (d.id) { card.dataset.obs = d.id; badges.append(el(`<span class="badge" title="observation ${esc(d.id)}">${esc(d.model)} · ${(d.latency_ms / 1000).toFixed(1)}s</span>`)); loadRecord(); } if (d.answer_truncated) badges.append(el(`<span class="badge red">truncated</span>`)); if (d.skipped) badges.append(el(`<span class="badge amber">${esc(d.skipped)}</span>`)); }
    else if (ev === "error") { prose.classList.remove("streaming"); statements.querySelectorAll(".skeleton").forEach((x) => x.remove()); statements.append(el(`<div class="err">${esc(d.error)}${d.errors ? ` — ${esc(d.errors.join("; "))}` : ""}</div>`)); }
    else if (ev === "done") prose.classList.remove("streaming");
  }
  $(".act-evidence", card).onclick = async () => {
    if (!evidence) return;
    if (!evidence.evidence_ids?.length) { const n = evidence.summary?.rating?.sample_size ?? evidence.summary?.profile?.snaps; drawer.innerHTML = `<div class="muted">This is an aggregate over ${n ?? "the season's"} snaps — no single play list. The component table is in Coach view; Provenance shows the stored rating and its lineage.</div>`; return; }
    const total = Math.min(evidence.evidence_ids.length, 300);
    drawer.innerHTML = `<div class="h">Evidence · <span id="ev-count">0</span> of ${evidence.evidence_count} plays${evidence.calculation_ids.length ? ` · calc ${esc(evidence.calculation_ids.join(", "))}` : ""}</div><div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="0"><i style="width:0%"></i></div><div class="muted" id="ev-status">fetching plays by game…</div>`;
    const bar = $(".progress i", drawer), status = $("#ev-status", drawer), count = $("#ev-count", drawer);
    try {
      const plays = await loadPlays(evidence.evidence_ids, (pr) => { bar.style.width = `${Math.round((pr.plays_loaded / Math.max(1, total)) * 100)}%`; bar.parentElement.setAttribute("aria-valuenow", pr.plays_loaded); count.textContent = pr.plays_loaded; status.textContent = `game ${pr.games_done} of ${pr.games_total} · ${pr.plays_loaded} plays`; });
      count.textContent = plays.length; status.remove(); bar.parentElement.remove();
      for (const p of plays) drawer.append(playRow(p));
    } catch (e) { drawer.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  $(".act-coach", card).onclick = () => card.classList.toggle("coach-on");
  card.querySelectorAll(".act-react").forEach((b) => { b.onclick = async () => {
    const coll = observation?.id ? "football_observations" : evidence?.calculation_ids?.[0] ? (evidence.kind === "tendency" ? "football_tendencies" : evidence.kind === "comparison" ? "football_comparisons" : evidence.kind === "rating" ? "football_ratings" : "football_analyses") : null;
    const id = observation?.id || evidence?.calculation_ids?.[0];
    if (!coll || !id) { b.textContent = "nothing stored to react to"; return; }
    try { const r = await fanPost("/api/v1/fans/reactions", { target_coll: coll, target_id: id, reaction: b.dataset.kind }); if (r) { b.classList.add("on"); b.textContent = `${b.dataset.kind === "agree" ? "👍" : "👎"} ${r.replaced ? "changed" : "saved"} · #${r.chain_index}`; } } catch (e) { b.textContent = e.message; }
  }; });
  $(".act-plan", card).onclick = () => { drawer.innerHTML = `<div class="h">Query plan</div><pre class="code">${esc(JSON.stringify(planInfo, null, 2))}</pre>`; };
  $(".act-provenance", card).onclick = async () => {
    if (!evidence) return;
    const coll = observation?.id ? "football_observations" : evidence.kind === "tendency" ? "football_tendencies" : evidence.kind === "comparison" ? "football_comparisons" : evidence.kind === "rating" ? "football_ratings" : "football_analyses";
    const id = observation?.id || evidence.calculation_ids[0];
    if (!id) { drawer.innerHTML = `<div class="muted">nothing stored for this answer</div>`; return; }
    drawer.innerHTML = `<div class="muted">tracing ${esc(coll)}/${esc(id)}…</div>`;
    try {
      const p = await api(`/api/v1/provenance/${coll}/${encodeURIComponent(id)}`);
      drawer.innerHTML = ""; drawer.append(renderProvenance(p, coll, id));
    } catch (e) { drawer.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

// Evidence plays are fetched per game (one request per game_id), four games in
// flight at a time, reporting progress after each game so the drawer can show
// a real bar instead of a static "loading…" line.
async function loadPlays(ids, onProgress) {
  const wanted = ids.slice(0, 300);
  const byGame = new Map(); for (const id of wanted) { const g = id.split(":")[0]; if (!byGame.has(g)) byGame.set(g, new Set()); byGame.get(g).add(id); }
  const games = [...byGame.entries()];
  const out = []; let done = 0, loaded = 0;
  const worker = async () => {
    while (games.length) {
      const [g, want] = games.shift();
      const r = await api(`/api/v1/games/${encodeURIComponent(g)}/plays`);
      const got = r.plays.filter((p) => want.has(p.id));
      out.push(...got); done++; loaded += got.length;
      onProgress?.({ games_done: done, games_total: byGame.size, plays_loaded: loaded, plays_total: wanted.length, plays: got });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, games.length) }, worker));
  const order = new Map(wanted.map((id, i) => [id, i]));
  return out.sort((a, b) => order.get(a.id) - order.get(b.id));
}
function playRow(p) {
  const good = p.converted || (p.epa ?? 0) > 0;
  const spot = p.yardline_100 === null ? "" : p.yardline_100 > 50 ? `own ${100 - p.yardline_100}` : `opp ${p.yardline_100}`;
  const row = el(`<div class="play tap" title="${esc(p.id)}"><div class="dd">${p.down ?? "–"}&amp;${p.ydstogo ?? "–"}</div><div><div>${esc(p.posteam)} ${esc(p.play_type)} · Q${p.quarter} · ${esc(spot)} · ${p.posteam_score}-${p.defteam_score}</div><div class="meta">${esc(p.game_id)} · play ${p.play_id}${p.touchdown ? " · TD" : ""}${p.turnover ? " · TURNOVER" : ""}${p.penalty ? " · penalty" : ""}${p.garbage_time ? " · garbage time" : ""}</div></div><div class="yd ${good ? "good" : "bad"}">${p.yards_gained ?? "–"} yd<br><span class="muted">${fmtNum(p.epa, 2)} EPA</span></div></div>`);
  row.onclick = () => ask(`Explain play ${p.id}`);
  return row;
}

function renderCoach(d) {
  const box = el(`<div></div>`); const s = d.summary;
  const kv = (obj) => { const w = el(`<div class="kv"></div>`); for (const [k, v] of Object.entries(obj)) { if (v === null || v === undefined || typeof v === "object") continue; w.append(el(`<div><div class="k">${esc(k.replace(/_/g, " "))}</div><div class="v">${esc(String(v))}</div></div>`)); } return w; };
  const table = (rows, cols) => { if (!rows?.length) return el(`<div class="muted">none</div>`); const t = el(`<div class="tbl"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.h)}</th>`).join("")}</tr></thead><tbody></tbody></table></div>`); const tb = $("tbody", t); for (const r of rows) tb.append(el(`<tr>${cols.map((c) => `<td class="${c.num ? "num" : ""}">${esc(c.f ? c.f(r) : r[c.k] ?? "—")}</td>`).join("")}</tr>`)); return t; };
  const patterns = (p, title) => { if (!p) return el(`<div class="muted">no formation/personnel context</div>`); const w = el(`<div></div>`); w.append(el(`<div class="h">${esc(title)} · coverage ${fmtPct(p.coverage_pct)} (${p.covered} plays)</div>`)); w.append(kv({ shotgun_pct: fmtPct(p.shotgun_pct), pass_pct_from_shotgun: fmtPct(p.pass_pct_from_shotgun), pass_pct_under_center: fmtPct(p.pass_pct_under_center), motion_pct: fmtPct(p.motion_pct), play_action_pct_of_dropbacks: fmtPct(p.play_action_pct_of_dropbacks), pressure_pct_of_dropbacks: fmtPct(p.pressure_pct_of_dropbacks), success_pct_under_pressure: fmtPct(p.success_pct_under_pressure), success_pct_clean: fmtPct(p.success_pct_clean), avg_defenders_in_box: fmtNum(p.avg_defenders_in_box, 2), no_huddle_pct: fmtPct(p.no_huddle_pct) })); if (p.personnel?.length) w.append(el(`<div class="muted" style="margin-top:6px">personnel: ${esc(p.personnel.map((x) => `${x.group} ${x.pct}%`).join(" · "))}</div>`)); return w; };
  if (d.kind === "third_down" || d.kind === "rating") {
    const a = s.analysis;
    if (a) {
      // Third-down shaped: a situation analysis sits under the rating.
      box.append(el(`<div class="h">Definition</div><div class="muted">${esc(a.definition)}</div>`));
      box.append(el(`<div class="h">Totals</div>`), kv({ attempts: a.attempts, conversions: a.conversions, conversion_pct: fmtPct(a.conversion_pct), pass_pct: fmtPct(a.pass_pct), epa_per_play: fmtNum(a.epa_per_play, 3), success_pct: fmtPct(a.success_pct), yards_per_play: fmtNum(a.yards_per_play), turnovers: a.turnovers, confidence: a.confidence, games: a.games }));
      box.append(el(`<div class="h">By distance</div>`), table(a.by_distance, [{ h: "to go", k: "distance" }, { h: "att", k: "attempts", num: 1 }, { h: "conv", k: "conversions", num: 1 }, { h: "conv%", f: (r) => fmtPct(r.conversion_pct), num: 1 }, { h: "epa/p", f: (r) => fmtNum(r.epa_per_play, 3), num: 1 }, { h: "pass%", f: (r) => fmtPct(r.pass_pct), num: 1 }]));
      if (a.excluded && Object.keys(a.excluded).length) box.append(el(`<div class="h">Excluded</div>`), kv(a.excluded));
    } else if (s.profile) {
      // Subject rating (offense / defense / red zone / ...): the season profile is the substrate.
      const p = s.profile;
      box.append(el(`<div class="h">Season profile · ${p.snaps} snaps · ${p.games} games</div>`), kv({ epa_per_play: fmtNum(p.epa_per_play, 3), success_pct: fmtPct(p.success_pct), explosive_pct: fmtPct(p.explosive_pct), turnover_pct: fmtPct(p.turnover_pct), third_down_pct: fmtPct(p.third_down_pct), red_zone_td_pct: fmtPct(p.red_zone_td_pct), red_zone_snaps: p.red_zone_snaps, points_per_game: fmtNum(p.points_per_game, 1) }));
    }
    if (s.formula_notes) box.append(el(`<div class="muted">${esc(s.formula_notes)}</div>`));
    const r = s.rating;
    if (r) box.append(el(`<div class="h">Rating · ${esc(r.definition)} · ${r.score}/100 · #${r.rank} of ${r.of} · ${esc(r.normalization)}</div>`), table(r.components, [{ h: "metric", k: "metric" }, { h: "w", f: (c) => `${c.weight_pct}%`, num: 1 }, { h: "raw", f: (c) => (c.raw_unit === "%" ? fmtPct(c.raw) : fmtNum(c.raw, 3)), num: 1 }, { h: "lg med", f: (c) => (c.raw_unit === "%" ? fmtPct(c.league_median) : fmtNum(c.league_median, 3)), num: 1 }, { h: "pct", f: (c) => (c.percentile === null ? "—" : `${c.percentile}`), num: 1 }, { h: "rank", k: "rank", num: 1 }, { h: "pts", f: (c) => fmtNum(c.points, 1), num: 1 }]));
    if (s.league_top5) box.append(el(`<div class="h">League top 5</div>`), table(s.league_top5, [{ h: "team", k: "team" }, { h: "score", k: "score", num: 1 }, { h: "n", f: (x) => x.attempts ?? x.sample_size ?? x.snaps ?? "—", num: 1 }]));
    if (s.league_bottom3) box.append(el(`<div class="h">League bottom 3</div>`), table(s.league_bottom3, [{ h: "team", k: "team" }, { h: "score", k: "score", num: 1 }, { h: "n", f: (x) => x.attempts ?? x.sample_size ?? x.snaps ?? "—", num: 1 }]));
  } else if (d.kind === "game_rank") {
    box.append(el(`<div class="h">${esc(s.team)} ${s.season} · ranked by ${esc(s.metric_label)} · ${s.record.wins}-${s.record.losses}${s.record.ties ? `-${s.record.ties}` : ""}</div>`));
    box.append(table(s.games, [{ h: "#", k: "rank", num: 1 }, { h: "wk", k: "week", num: 1 }, { h: "opp", f: (g) => `${g.home ? "vs" : "@"} ${g.opponent}` }, { h: "res", f: (g) => `${g.result} ${g.score ?? ""}` }, { h: "epa/p", f: (g) => fmtNum(g.epa_per_play, 3), num: 1 }, { h: "succ%", f: (g) => fmtPct(g.success_pct), num: 1 }, { h: "expl%", f: (g) => fmtPct(g.explosive_pct), num: 1 }, { h: "TO", k: "turnovers", num: 1 }, { h: "def epa", f: (g) => fmtNum(g.def_epa_allowed, 3), num: 1 }]));
    box.append(el(`<div class="muted" style="margin-top:6px">Tap a row's game id via "Why did … win/lose GAME_ID" for the game summary.</div>`));
  } else if (d.kind === "tendency") {
    box.append(el(`<div class="h">${esc(s.situation)}</div><div class="muted">baseline: ${esc(s.baseline)} · n=${s.sample} vs ${s.baseline_sample} · ${esc(s.confidence)}</div>`));
    const rows = Object.keys(s.situation_metrics).map((k) => ({ metric: k, situation: s.situation_metrics[k], baseline: s.baseline_metrics[k] }));
    box.append(table(rows, [{ h: "metric", k: "metric" }, { h: "situation", f: (r) => String(r.situation ?? "—"), num: 1 }, { h: "baseline", f: (r) => String(r.baseline ?? "—"), num: 1 }]));
    box.append(patterns(s.patterns, "How they line up here"));
    if (s.baseline_patterns) box.append(patterns(s.baseline_patterns, "Baseline"));
    if (d.unsupported?.length) box.append(el(`<div class="h">Not visible to CHALK</div><div class="muted">${esc(d.unsupported.join(" · "))}</div>`));
  } else if (d.kind === "opponent_report") {
    box.append(el(`<div class="h">${esc(s.opponent)} ${esc(s.opponent_side)} · ${s.baseline.snaps} snaps · ${fmtNum(s.baseline.epa_per_play, 3)} EPA/play · ${fmtPct(s.baseline.pass_pct)} pass</div>`));
    box.append(table(s.sections, [{ h: "situation", k: "situation" }, { h: "n", k: "snaps", num: 1 }, { h: "pass%", f: (r) => fmtPct(r.pass_pct), num: 1 }, { h: "Δ base", f: (r) => (r.pass_pct_vs_baseline_pp === null ? "—" : signed(r.pass_pct_vs_baseline_pp, 1)), num: 1 }, { h: "epa/p", f: (r) => fmtNum(r.epa_per_play, 3), num: 1 }, { h: "succ%", f: (r) => fmtPct(r.success_pct), num: 1 }, { h: "shotgun%", f: (r) => fmtPct(r.patterns?.shotgun_pct), num: 1 }, { h: "top pers", f: (r) => (r.patterns?.personnel?.[0] ? `${r.patterns.personnel[0].group} ${r.patterns.personnel[0].pct}%` : "—") }, { h: "conf", k: "confidence" }]));
    box.append(patterns(s.baseline_patterns, "Overall look"));
    box.append(el(`<div class="h">Their weak spots</div>`), table(s.weakest, [{ h: "situation", k: "situation" }, { h: "n", k: "snaps", num: 1 }, { h: "epa/p", f: (r) => fmtNum(r.epa_per_play, 3), num: 1 }, { h: "Δ team", f: (r) => signed(r.epa_vs_team, 3), num: 1 }]));
    box.append(el(`<div class="h">Their strengths</div>`), table(s.strongest, [{ h: "situation", k: "situation" }, { h: "n", k: "snaps", num: 1 }, { h: "epa/p", f: (r) => fmtNum(r.epa_per_play, 3), num: 1 }, { h: "Δ team", f: (r) => signed(r.epa_vs_team, 3), num: 1 }]));
  } else if (d.kind === "comparison") {
    box.append(el(`<div class="h">A · ${esc(s.a.definition)} (${esc(s.a.confidence)})</div><div class="h">B · ${esc(s.b.definition)} (${esc(s.b.confidence)})</div>`));
    box.append(table(s.lines, [{ h: "metric", k: "metric" }, { h: "A", f: (r) => String(r.a ?? "—"), num: 1 }, { h: "B", f: (r) => String(r.b ?? "—"), num: 1 }, { h: "Δ", f: (r) => (r.delta === null ? "—" : `${r.delta > 0 ? "+" : ""}${r.delta} ${r.unit}`), num: 1 }]));
  } else if (d.kind === "situation_scan") {
    box.append(el(`<div class="h">Baseline · ${s.baseline.snaps} snaps · ${fmtNum(s.baseline.epa_per_play, 3)} EPA/play · ${fmtPct(s.baseline.success_pct)} success</div>`));
    box.append(el(`<div class="h">Weakest (n ≥ ${s.min_sample})</div>`), table(s.weakest, [{ h: "situation", k: "situation" }, { h: "n", k: "snaps", num: 1 }, { h: "epa/p", f: (r) => fmtNum(r.epa_per_play, 3), num: 1 }, { h: "Δ team", f: (r) => fmtNum(r.epa_vs_team, 3), num: 1 }, { h: "succ%", f: (r) => fmtPct(r.success_pct), num: 1 }, { h: "conf", k: "confidence" }]));
    box.append(el(`<div class="h">Strongest</div>`), table(s.strongest, [{ h: "situation", k: "situation" }, { h: "n", k: "snaps", num: 1 }, { h: "epa/p", f: (r) => fmtNum(r.epa_per_play, 3), num: 1 }, { h: "Δ team", f: (r) => fmtNum(r.epa_vs_team, 3), num: 1 }]));
    if (s.excluded_small_samples?.length) box.append(el(`<div class="muted">too few snaps: ${esc(s.excluded_small_samples.join(", "))}</div>`));
  } else if (d.kind === "game_summary") {
    box.append(el(`<div class="h">${esc(s.game.away)} ${s.game.away_score} @ ${esc(s.game.home)} ${s.game.home_score} · ${s.game.season} wk ${s.game.week}${s.game.overtime ? " · OT" : ""}</div>`));
    box.append(table(s.teams, [{ h: "team", k: "team" }, { h: "snaps", k: "snaps", num: 1 }, { h: "epa/p", f: (r) => fmtNum(r.epa_per_play, 3), num: 1 }, { h: "succ%", f: (r) => fmtPct(r.success_pct), num: 1 }, { h: "y/p", f: (r) => fmtNum(r.yards_per_play), num: 1 }, { h: "expl", k: "explosive_plays", num: 1 }, { h: "TO", k: "turnovers", num: 1 }, { h: "3rd", f: (r) => `${r.third_down.conversions}/${r.third_down.attempts}`, num: 1 }]));
    if (s.deviation) box.append(el(`<div class="h">Deviation vs season · ${esc(s.deviation.level)} · driver ${esc(s.deviation.driver ?? "—")}</div>`), table(s.deviation.lines, [{ h: "metric", k: "metric" }, { h: "season", f: (r) => String(r.baseline ?? "—"), num: 1 }, { h: "game", f: (r) => String(r.game ?? "—"), num: 1 }, { h: "z", f: (r) => fmtNum(r.z, 2), num: 1 }, { h: "n", k: "n_game", num: 1 }]));
  } else if (d.kind === "play_explain") {
    box.append(kv(s.play));
    if (s.team_context_same_situation) box.append(el(`<div class="h">Team in this situation</div>`), kv(s.team_context_same_situation));
  } else if (d.kind === "rating_compare") {
    box.append(el(`<div class="h">${esc(s.a.name)} ${s.a.score} (#${s.a.rank}) vs ${esc(s.b.name)} ${s.b.score} (#${s.b.rank}) · Δ ${s.delta}</div>`));
    box.append(table(s.drivers, [{ h: "metric", k: "metric" }, { h: "w A", f: (r) => `${r.weight_a_pct}%`, num: 1 }, { h: "w B", f: (r) => `${r.weight_b_pct}%`, num: 1 }, { h: "pct", f: (r) => (r.percentile === null ? "—" : String(r.percentile)), num: 1 }, { h: "Δ pts", f: (r) => fmtNum(r.points_delta, 1), num: 1 }]));
  } else box.append(el(`<pre class="code">${esc(JSON.stringify(s, null, 2))}</pre>`));
  box.append(el(`<div class="muted" style="margin-top:8px">calc ${esc(d.calculation_ids.join(", ") || "—")} · exec ${d.exec_ms}ms</div>`));
  return box;
}

// -------------------------------------------------------- rate differently
async function rateDifferently() {
  const sj = state.headline || "third_down";
  const card = el(`<article class="card"><header class="card-head"><div class="q">Rate ${esc(headlineLabel(sj).toLowerCase())} differently</div></header><div class="muted">Pick a saved ${esc(headlineLabel(sj).toLowerCase())} formula or build your own. Only formulas for this subject are offered — an offense formula scored over third downs would be a plausible-looking wrong number. Weights are normalized; every score exposes its formula.</div><div class="drawer"></div></article>`);
  showCard(card);
  const drawer = $(".drawer", card);
  const defs = await api(`/api/v1/rating-definitions?subject=${sj}`);
  // Apply a formula to the headline: third down rebuilds Home (trend follows the formula); other subjects re-rate in place.
  const applyDef = async (defId) => {
    if (sj === "third_down") { loadHome(defId); return; }
    const full = await api(`/api/v1/ratings/${subjectPath(sj)}?team=${state.team}&season=${state.season}&definition=${encodeURIComponent(defId)}`);
    const snap = full.snapshot;
    renderHeadline(state.home, { subject: sj, score: snap.score, rank: full.rank, of: full.population, provisional: snap.provisional, sample: snap.sample_size, definition_id: snap.definition_id, definition_name: snap.definition_name ?? full.definition?.name ?? defId, snapshot_id: snap.id, components: snap.components });
    showTrendFor(sj, defId);
  };
  const sel = el(`<div class="suggest" style="padding:6px 0"></div>`);
  const showCompare = async (a, b, anchor) => { const c = await api(`/api/v1/ratings/compare?team=${state.team}&season=${state.season}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`); const out = el(`<div></div>`); out.append(el(`<div class="h">${esc(c.a.summary.definition)} ${c.a.summary.score} → ${esc(c.b.summary.definition)} ${c.b.summary.score} (Δ ${c.disagreement.delta})</div><div class="statement">${esc(c.disagreement.headline)}</div>`)); for (const l of c.disagreement.lines.slice(0, 4)) out.append(el(`<div class="statement">${esc(l.sentence)}</div>`)); anchor.after(out); };
  for (const d of defs.definitions) {
    const b = el(`<button class="chip ${d.id === state.rating?.snapshot?.definition_id ? "on" : ""}">${esc(d.name)} v${esc(d.version)}</button>`);
    b.onclick = async () => { try { const cur = state.rating?.snapshot?.definition_id; if (sj === "third_down" && cur && cur !== d.id) await showCompare(cur, d.id, sel); await applyDef(d.id); sel.querySelectorAll(".chip").forEach((x) => x.classList.remove("on")); b.classList.add("on"); } catch (err) { sel.after(el(`<div class="err">${esc(err.message)}</div>`)); } };
    sel.append(b);
  }
  drawer.append(sel);
  const metrics = Object.entries(defs.rateable_metrics).filter(([, m]) => !m.subjects || m.subjects.includes(sj));
  const form = el(`<form class="rd"><div class="h">Build your own</div><input name="name" placeholder="Name it (e.g. Dad Rating)" required maxlength="80" />${metrics.map(([k, m]) => `<div class="row"><label>${esc(m.label)} <span class="muted">(${m.default_direction === "lower_is_better" ? "lower is better" : "higher is better"})</span></label><input name="w_${k}" type="number" min="0" step="5" placeholder="0" /></div>`).join("")}<button class="chip go" type="submit">Save & rate</button><div class="err out"></div></form>`);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const components = metrics.map(([k]) => ({ metric: k, weight: Number(fd.get(`w_${k}`) || 0) })).filter((c) => c.weight > 0);
    try { const r = await api("/api/v1/rating-definitions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: fd.get("name"), subject: sj, components, author: "fan" }) }); $(".out", form).textContent = ""; const cur = state.rating?.snapshot?.definition_id; if (sj === "third_down" && cur) await showCompare(cur, r.definition.id, form); await applyDef(r.definition.id); }
    catch (err) { $(".out", form).textContent = `${err.message}${err.detail ? ` — ${JSON.stringify(err.detail)}` : ""}`; }
  };
  drawer.append(form);
}

async function showLeague() {
  const sj = state.headline || "third_down";
  const card = el(`<article class="card"><header class="card-head"><div class="q">${esc(headlineLabel(sj))} · League</div></header><div class="drawer"><div class="muted">loading…</div></div></article>`);
  showCard(card);
  const drawer = $(".drawer", card);
  try {
    const def = state.rating?.snapshot?.definition_id;
    if (sj !== "third_down") {
      const l = await api(`/api/v1/ratings/${subjectPath(sj)}/league?season=${state.season}${def ? `&definition=${encodeURIComponent(def)}` : ""}`);
      drawer.innerHTML = `<div class="muted">${esc(l.definition.name)} v${esc(l.definition.version)} · ${l.population} teams${l.through_week ? ` · through week ${l.through_week}` : ""} · seq ${l.seq}</div>`;
      const t = el(`<div class="tbl"><table><thead><tr><th class="num">#</th><th>team</th><th class="num">score</th><th class="num">n</th><th class="num">Δ wk</th></tr></thead><tbody></tbody></table></div>`);
      const tb = $("tbody", t);
      for (const r of l.table) { const tr = el(`<tr style="${r.team === state.team ? "color:var(--accent)" : ""}"><td class="num">${r.rank}</td><td>${esc(r.team)}</td><td class="num">${r.score ?? "—"}${r.provisional ? "*" : ""}</td><td class="num">${r.sample}</td><td class="num">${r.movement === null || r.movement === undefined ? "—" : signed(r.movement, 0)}</td></tr>`); tr.style.cursor = "pointer"; tr.onclick = () => { state.team = r.team; $("#team").value = r.team; syncUrl(); loadHome(); renderSuggest(); window.scrollTo({ top: 0, behavior: "smooth" }); }; tb.append(tr); }
      drawer.append(t);
      return;
    }
    const l = await api(`/api/v1/ratings/third-down/league?season=${state.season}${def ? `&definition=${encodeURIComponent(def)}` : ""}`);
    drawer.innerHTML = `<div class="muted">${esc(l.definition.name)} v${esc(l.definition.version)} · ${l.population} teams · seq ${l.seq}</div>`;
    const t = el(`<div class="tbl"><table><thead><tr><th class="num">#</th><th>team</th><th class="num">score</th><th class="num">n</th><th class="num">conv%</th><th class="num">epa/p</th><th class="num">succ%</th></tr></thead><tbody></tbody></table></div>`);
    const tb = $("tbody", t);
    for (const r of l.table) { const tr = el(`<tr style="${r.team === state.team ? "color:var(--accent)" : ""}"><td class="num">${r.rank}</td><td>${esc(r.team)}</td><td class="num">${r.score ?? "—"}${r.provisional ? "*" : ""}</td><td class="num">${r.attempts}</td><td class="num">${fmtPct(r.conversion_pct)}</td><td class="num">${fmtNum(r.epa_per_play, 3)}</td><td class="num">${fmtPct(r.success_pct)}</td></tr>`); tr.style.cursor = "pointer"; tr.onclick = () => { state.team = r.team; $("#team").value = r.team; syncUrl(); loadHome(); renderSuggest(); window.scrollTo({ top: 0, behavior: "smooth" }); }; tb.append(tr); }
    drawer.append(t);
  } catch (e) { drawer.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// A failure during boot must be visible on the page — a dark shell with nothing on it is indistinguishable from a network outage.
boot().catch((e) => {
  console.error("boot failed", e);
  const main = document.querySelector("main") ?? document.body;
  main.prepend(el(`<div class="card"><div class="err">Sports-Rater failed to start: ${esc(e && e.message ? e.message : String(e))}. Reload; if it persists, the server log has the rest.</div></div>`));
});
