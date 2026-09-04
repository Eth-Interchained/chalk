// CHALK client — thin, dependency-free. Every number on screen comes from the
// API; this file never calculates football metrics (V3 §23).
const $ = (s, el = document) => el.querySelector(s);
const state = { team: "TB", season: null, teams: [], seasons: [], coach: false, defs: [], rating: null, meta: null };

const fmtPct = (v) => (v === null || v === undefined ? "—" : `${v}%`);
const fmtNum = (v, d = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `${res.status} ${path}`), { status: res.status, detail: body.detail });
  return body;
}

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    state.meta = await api("/api/v1/meta");
  } catch (e) {
    $("#feed").prepend(el(`<div class="card"><div class="err">CHALK API unreachable: ${esc(e.message)}</div></div>`));
    return;
  }
  state.teams = state.meta.teams;
  state.seasons = state.meta.seasons;
  state.defs = state.meta.rating_definitions;
  const url = new URL(location.href);
  state.team = (url.searchParams.get("team") || state.meta.defaults.team || "TB").toUpperCase();
  state.season = Number(url.searchParams.get("season") || state.meta.defaults.season || state.seasons[0]);
  state.coach = url.searchParams.get("mode") === "coach";
  const ts = $("#team"); ts.innerHTML = state.teams.map((t) => `<option ${t === state.team ? "selected" : ""}>${t}</option>`).join("");
  const ss = $("#season"); ss.innerHTML = state.seasons.map((s) => `<option ${s === state.season ? "selected" : ""}>${s}</option>`).join("");
  ts.onchange = () => { state.team = ts.value; syncUrl(); loadRating(); loadPulse(); renderSuggest(); };
  ss.onchange = () => { state.season = Number(ss.value); syncUrl(); loadRating(); };
  const mode = $("#mode");
  const applyMode = () => { mode.textContent = state.coach ? "Coach" : "Fan"; mode.setAttribute("aria-pressed", String(state.coach)); document.body.classList.toggle("coach", state.coach); document.querySelectorAll(".card.answer").forEach((c) => c.classList.toggle("coach-on", state.coach)); };
  mode.onclick = () => { state.coach = !state.coach; syncUrl(); applyMode(); };
  applyMode();
  renderSuggest();
  loadRating();
  loadPulse();
  $("#ask").onsubmit = (e) => { e.preventDefault(); const q = $("#q").value.trim(); if (!q) return; $("#q").value = ""; ask(q); };
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-ask]"); if (b) ask(b.dataset.ask.replaceAll("Tampa", teamName(state.team))); });
  $("#rate-differently").onclick = rateDifferently;
  $("#show-league").onclick = showLeague;
  const q0 = url.searchParams.get("q"); if (q0) ask(q0);
}
function syncUrl() { const u = new URL(location.href); u.searchParams.set("team", state.team); u.searchParams.set("season", state.season); u.searchParams.set("mode", state.coach ? "coach" : "fan"); history.replaceState(null, "", u); }
const NAMES = { TB: "Tampa", KC: "Kansas City", PHI: "Philadelphia", DAL: "Dallas", DET: "Detroit", GB: "Green Bay", BUF: "Buffalo", BAL: "Baltimore", SF: "San Francisco", LA: "the Rams", LAC: "the Chargers", SEA: "Seattle", MIN: "Minnesota", CHI: "Chicago", WAS: "Washington", NYG: "the Giants", NYJ: "the Jets", NE: "New England", MIA: "Miami", PIT: "Pittsburgh", CLE: "Cleveland", CIN: "Cincinnati", HOU: "Houston", IND: "Indianapolis", JAX: "Jacksonville", TEN: "Tennessee", DEN: "Denver", LV: "Las Vegas", ARI: "Arizona", ATL: "Atlanta", NO: "New Orleans", CAR: "Carolina" };
const teamName = (t) => NAMES[t] || t;

function renderSuggest() {
  const s = $("#suggest");
  s.innerHTML = "";
  for (const q of state.meta.suggested_questions) s.append(el(`<button class="chip" data-ask="${esc(q)}">${esc(q.replaceAll("Tampa", teamName(state.team)))}</button>`));
}

// ---------------------------------------------------------------- rating
async function loadRating(defId) {
  const card = $("#rating-card");
  $("#rc-team").textContent = state.team;
  $("#rc-score").textContent = "…";
  try {
    const r = await api(`/api/v1/ratings/third-down?team=${state.team}&season=${state.season}${defId ? `&definition=${encodeURIComponent(defId)}` : ""}`);
    state.rating = r;
    const s = r.summary;
    const score = s.score ?? 0;
    $("#rc-score").innerHTML = `${s.score ?? "–"}<small>/100</small>`;
    const fg = $("#ring-fg"); fg.style.strokeDashoffset = 326.7 * (1 - score / 100); fg.style.stroke = score >= 67 ? "var(--lime)" : score >= 40 ? "var(--amber)" : "var(--red)";
    $("#rc-rank").innerHTML = `<b>#${s.rank}</b> of ${s.of}`;
    const a = r.snapshot;
    $("#rc-line1").innerHTML = `<b>${esc(s.definition)}</b> v${esc(a.definition_version)}${s.provisional ? ' · <span class="badge amber">provisional</span>' : ""}`;
    $("#rc-line2").innerHTML = `${state.season} · ${a.sample_size} third downs · percentile vs ${s.of} teams`;
    $("#rc-line3").textContent = `${a.id} · ${r._hash.slice(0, 16)}…`;
    $("#rc-components").innerHTML = s.components.map((c) => `<div class="comp"><div class="k">${esc(c.metric.replace(/_/g, " "))} · ${c.weight_pct}%</div><div class="v">${c.raw_unit === "%" ? fmtPct(c.raw) : fmtNum(c.raw, 3)}</div><div class="p">${c.percentile === null ? "—" : `${c.percentile}th pct`} · rank ${c.rank ?? "—"} · +${fmtNum(c.points, 1)} pts</div><div class="bar"><i style="width:${c.percentile ?? 0}%"></i></div></div>`).join("");
    card.dataset.def = a.definition_id;
  } catch (e) {
    $("#rc-score").textContent = "–";
    $("#rc-line1").innerHTML = `<span class="err">${esc(e.message)}</span>`;
    $("#rc-line2").textContent = e.status === 404 ? `No ${state.season} third-down data for ${state.team}. Run: chalk ingest --season ${state.season}` : "";
    $("#rc-components").innerHTML = "";
  }
}

async function loadPulse() {
  const box = $("#pulse");
  box.innerHTML = "";
  try {
    const p = await api(`/api/v1/pulse/games?team=${state.team}`);
    const now = Date.now();
    const soon = p.states.filter((s) => s.phase === "live" || (s.kickoff && Math.abs(Date.parse(s.kickoff) - now) < 8 * 86400e3)).slice(0, 3);
    for (const s of soon) {
      const score = s.home_score !== null && s.away_score !== null ? `${s.away_score}–${s.home_score}` : "";
      const when = s.kickoff ? new Date(s.kickoff).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      box.append(el(`<div class="gs ${s.phase}"><span>${esc(s.away_team)} @ ${esc(s.home_team)} <span class="muted">${esc(score)}</span></span><span class="st">${s.phase === "live" ? esc(s.progress || s.status || "live") : s.phase === "final" ? "final" : esc(when)}</span></div>`));
    }
  } catch (e) {
    box.append(el(`<div class="muted">pulse unavailable: ${esc(e.message)}</div>`));
  }
}

// ------------------------------------------------------------------- ask
async function ask(question) {
  const tpl = $("#tpl-answer").content.firstElementChild.cloneNode(true);
  const card = tpl;
  card.classList.toggle("coach-on", state.coach);
  $(".q", card).textContent = question;
  const badges = $(".badges", card);
  const statements = $(".statements", card);
  const prose = $(".prose", card);
  const coach = $(".coach", card);
  const drawer = $(".drawer", card);
  $("#feed").prepend(card);
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  let evidence = null, planInfo = null, observation = null;
  prose.classList.add("streaming");
  badges.append(el(`<span class="badge">planning…</span>`));
  const url = new URL(location.href);
  const body = { question, team: state.team, season: state.season, game_id: url.searchParams.get("game_id") || undefined };
  try {
    const res = await fetch("/api/v1/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (!ev || !data) continue;
        handle(ev, JSON.parse(data));
      }
    }
  } catch (e) {
    prose.classList.remove("streaming");
    statements.append(el(`<div class="err">${esc(e.message)}</div>`));
  }
  function handle(ev, d) {
    if (ev === "plan") {
      planInfo = d;
      badges.innerHTML = "";
      if (d.plan) badges.append(el(`<span class="badge lime">${esc(d.plan.intent)}</span>`), el(`<span class="badge">${d.plan.source === "model" ? esc(d.plan.model) : "rules"}</span>`));
      if (d.fallback_used) badges.append(el(`<span class="badge amber" title="${esc(d.errors.join("; "))}">fallback</span>`));
    } else if (ev === "evidence") {
      evidence = d;
      for (const s of d.deterministic_statements) statements.append(el(`<div class="statement">${esc(s)}</div>`));
      badges.append(el(`<span class="badge">${d.evidence_count} plays</span>`));
      const conf = d.summary?.analysis?.confidence || d.summary?.confidence || d.summary?.rating?.provisional;
      if (conf === "insufficient" || conf === "low") badges.append(el(`<span class="badge red">${esc(conf)} sample</span>`));
      coach.innerHTML = "";
      coach.append(renderCoach(d));
    } else if (ev === "token") {
      prose.textContent += d.text;
    } else if (ev === "observation") {
      observation = d;
      prose.classList.remove("streaming");
      if (d.id) badges.append(el(`<span class="badge" title="observation ${esc(d.id)}">${esc(d.model)} · ${(d.latency_ms / 1000).toFixed(1)}s</span>`));
      if (d.answer_truncated) badges.append(el(`<span class="badge red">truncated</span>`));
      if (d.skipped) badges.append(el(`<span class="badge amber">${esc(d.skipped)}</span>`));
    } else if (ev === "error") {
      prose.classList.remove("streaming");
      statements.append(el(`<div class="err">${esc(d.error)}${d.errors ? ` — ${esc(d.errors.join("; "))}` : ""}</div>`));
    } else if (ev === "done") {
      prose.classList.remove("streaming");
    }
  }
  $(".act-evidence", card).onclick = async () => {
    if (!evidence) return;
    drawer.innerHTML = `<div class="muted">loading ${evidence.evidence_count} plays…</div>`;
    try {
      const ids = evidence.evidence_ids;
      const plays = await loadPlays(ids);
      drawer.innerHTML = `<div class="h">Evidence · ${plays.length} of ${evidence.evidence_count} plays${evidence.calculation_ids.length ? ` · calc ${esc(evidence.calculation_ids.join(", "))}` : ""}</div>`;
      for (const p of plays) drawer.append(playRow(p));
    } catch (e) { drawer.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  $(".act-coach", card).onclick = () => card.classList.toggle("coach-on");
  $(".act-plan", card).onclick = () => { drawer.innerHTML = `<div class="h">Query plan</div><pre class="code">${esc(JSON.stringify(planInfo, null, 2))}</pre>`; };
  $(".act-provenance", card).onclick = async () => {
    if (!evidence) return;
    const coll = observation?.id ? "football_observations" : evidence.kind === "tendency" ? "football_tendencies" : evidence.kind === "comparison" ? "football_comparisons" : evidence.kind === "rating" ? "football_ratings" : "football_analyses";
    const id = observation?.id || evidence.calculation_ids[0];
    if (!id) { drawer.innerHTML = `<div class="muted">nothing stored for this answer</div>`; return; }
    drawer.innerHTML = `<div class="muted">tracing ${esc(coll)}/${esc(id)}…</div>`;
    try {
      const p = await api(`/api/v1/provenance/${coll}/${encodeURIComponent(id)}`);
      drawer.innerHTML = `<div class="h">Provenance · ${p.node_count} records · ${p.edge_count} edges · depth ${p.depth}</div><div class="muted">${esc(Object.entries(p.collections).map(([k, v]) => `${k.replace("football_", "")}: ${v}`).join(" · "))}</div>`;
      const prov = el(`<div class="prov"></div>`);
      for (const n of p.nodes.slice(0, 60)) prov.append(el(`<div><span class="c">${esc(n._coll.replace("football_", ""))}</span><span>${esc(n.label)}</span><span class="hsh">${esc(n._hash.slice(0, 12))}</span></div>`));
      drawer.append(prov);
      if (p.node_count > 60) drawer.append(el(`<div class="muted">… ${p.node_count - 60} more. Full graph: <code>GET /api/v1/provenance/${esc(coll)}/${esc(id)}</code></div>`));
    } catch (e) { drawer.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

async function loadPlays(ids) {
  // Group by game; one request per game.
  const byGame = new Map();
  for (const id of ids) { const g = id.split(":")[0]; if (!byGame.has(g)) byGame.set(g, new Set()); byGame.get(g).add(id); }
  const out = [];
  for (const [g, want] of byGame) {
    const r = await api(`/api/v1/games/${encodeURIComponent(g)}/plays`);
    for (const p of r.plays) if (want.has(p.id)) out.push(p);
  }
  const order = new Map(ids.map((id, i) => [id, i]));
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
  const box = el(`<div></div>`);
  const s = d.summary;
  const kv = (obj) => { const w = el(`<div class="kv"></div>`); for (const [k, v] of Object.entries(obj)) { if (v === null || typeof v === "object") continue; w.append(el(`<div><div class="k">${esc(k.replace(/_/g, " "))}</div><div class="v">${esc(String(v))}</div></div>`)); } return w; };
  const table = (rows, cols) => { if (!rows?.length) return el(`<div class="muted">none</div>`); const t = el(`<div class="tbl"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.h)}</th>`).join("")}</tr></thead><tbody></tbody></table></div>`); const tb = $("tbody", t); for (const r of rows) tb.append(el(`<tr>${cols.map((c) => `<td class="${c.num ? "num" : ""}">${esc(c.f ? c.f(r) : r[c.k] ?? "—")}</td>`).join("")}</tr>`)); return t; };
  if (d.kind === "third_down" || d.kind === "rating") {
    const a = s.analysis;
    box.append(el(`<div class="h">Definition</div><div class="muted">${esc(a.definition)}</div>`));
    box.append(el(`<div class="h">Totals</div>`), kv({ attempts: a.attempts, conversions: a.conversions, conversion_pct: fmtPct(a.conversion_pct), pass_pct: fmtPct(a.pass_pct), epa_per_play: fmtNum(a.epa_per_play, 3), success_pct: fmtPct(a.success_pct), yards_per_play: fmtNum(a.yards_per_play), turnovers: a.turnovers, confidence: a.confidence, games: a.games }));
    box.append(el(`<div class="h">By distance</div>`), table(a.by_distance, [{ h: "to go", k: "distance" }, { h: "att", k: "attempts", num: 1 }, { h: "conv", k: "conversions", num: 1 }, { h: "conv%", f: (r) => fmtPct(r.conversion_pct), num: 1 }, { h: "epa/p", f: (r) => fmtNum(r.epa_per_play, 3), num: 1 }, { h: "pass%", f: (r) => fmtPct(r.pass_pct), num: 1 }]));
    if (a.excluded && Object.keys(a.excluded).length) box.append(el(`<div class="h">Excluded</div>`), kv(a.excluded));
    const r = s.rating;
    if (r) box.append(el(`<div class="h">Rating · ${esc(r.definition)} · ${r.score}/100 · #${r.rank} of ${r.of} · ${esc(r.normalization)}</div>`), table(r.components, [{ h: "metric", k: "metric" }, { h: "w", f: (c) => `${c.weight_pct}%`, num: 1 }, { h: "raw", f: (c) => (c.raw_unit === "%" ? fmtPct(c.raw) : fmtNum(c.raw, 3)), num: 1 }, { h: "lg med", f: (c) => (c.raw_unit === "%" ? fmtPct(c.league_median) : fmtNum(c.league_median, 3)), num: 1 }, { h: "pct", f: (c) => (c.percentile === null ? "—" : `${c.percentile}`), num: 1 }, { h: "rank", k: "rank", num: 1 }, { h: "pts", f: (c) => fmtNum(c.points, 1), num: 1 }]));
    if (s.league_top5) box.append(el(`<div class="h">League top 5</div>`), table(s.league_top5, [{ h: "team", k: "team" }, { h: "score", k: "score", num: 1 }, { h: "n", k: "attempts", num: 1 }]));
  } else if (d.kind === "tendency") {
    box.append(el(`<div class="h">${esc(s.situation)}</div><div class="muted">baseline: ${esc(s.baseline)} · n=${s.sample} vs ${s.baseline_sample} · ${esc(s.confidence)}</div>`));
    const rows = Object.keys(s.situation_metrics).map((k) => ({ metric: k, situation: s.situation_metrics[k], baseline: s.baseline_metrics[k] }));
    box.append(table(rows, [{ h: "metric", k: "metric" }, { h: "situation", f: (r) => String(r.situation ?? "—"), num: 1 }, { h: "baseline", f: (r) => String(r.baseline ?? "—"), num: 1 }]));
    if (d.unsupported?.length) box.append(el(`<div class="h">Not visible to CHALK</div><div class="muted">${esc(d.unsupported.join(" · "))}</div>`));
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
  } else {
    box.append(el(`<pre class="code">${esc(JSON.stringify(s, null, 2))}</pre>`));
  }
  box.append(el(`<div class="muted" style="margin-top:8px">calc ${esc(d.calculation_ids.join(", ") || "—")} · exec ${d.exec_ms}ms</div>`));
  return box;
}

// -------------------------------------------------------- rate differently
async function rateDifferently() {
  const card = el(`<article class="card"><header class="card-head"><div class="q">Rate differently</div></header><div class="muted">Pick a saved formula or build your own. Weights are normalized; every score exposes its formula.</div><div class="drawer"></div></article>`);
  $("#feed").prepend(card);
  const drawer = $(".drawer", card);
  const defs = (await api("/api/v1/rating-definitions"));
  const sel = el(`<div class="suggest" style="padding:6px 0"></div>`);
  for (const d of defs.definitions) {
    const b = el(`<button class="chip ${d.id === state.rating?.snapshot?.definition_id ? "on" : ""}">${esc(d.name)} v${esc(d.version)}</button>`);
    b.onclick = async () => {
      const cur = state.rating?.snapshot?.definition_id;
      if (cur && cur !== d.id) {
        const c = await api(`/api/v1/ratings/compare?team=${state.team}&season=${state.season}&a=${encodeURIComponent(cur)}&b=${encodeURIComponent(d.id)}`);
        const out = el(`<div></div>`);
        out.append(el(`<div class="h">${esc(c.a.summary.definition)} ${c.a.summary.score} → ${esc(c.b.summary.definition)} ${c.b.summary.score} (Δ ${c.disagreement.delta})</div><div class="statement">${esc(c.disagreement.headline)}</div>`));
        for (const l of c.disagreement.lines.slice(0, 4)) out.append(el(`<div class="statement">${esc(l.sentence)}</div>`));
        drawer.innerHTML = ""; drawer.append(sel, out);
      }
      loadRating(d.id);
      sel.querySelectorAll(".chip").forEach((x) => x.classList.remove("on")); b.classList.add("on");
    };
    sel.append(b);
  }
  drawer.append(sel);
  const metrics = Object.entries(defs.rateable_metrics);
  const form = el(`<form class="rd"><div class="h">Build your own</div><input name="name" placeholder="Name it (e.g. Dad Rating)" required maxlength="80" />${metrics.map(([k, m]) => `<div class="row"><label>${esc(m.label)} <span class="muted">(${m.default_direction === "lower_is_better" ? "lower is better" : "higher is better"})</span></label><input name="w_${k}" type="number" min="0" step="5" placeholder="0" /></div>`).join("")}<button class="chip go" type="submit">Save & rate</button><div class="err out"></div></form>`);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const components = metrics.map(([k]) => ({ metric: k, weight: Number(fd.get(`w_${k}`) || 0) })).filter((c) => c.weight > 0);
    try {
      const r = await api("/api/v1/rating-definitions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: fd.get("name"), components, author: "fan" }) });
      $(".out", form).textContent = "";
      const cur = state.rating?.snapshot?.definition_id;
      if (cur) {
        const c = await api(`/api/v1/ratings/compare?team=${state.team}&season=${state.season}&a=${encodeURIComponent(cur)}&b=${encodeURIComponent(r.definition.id)}`);
        const out = el(`<div></div>`);
        out.append(el(`<div class="h">${esc(c.a.summary.definition)} ${c.a.summary.score} → ${esc(c.b.summary.definition)} ${c.b.summary.score} (Δ ${c.disagreement.delta})</div><div class="statement">${esc(c.disagreement.headline)}</div>`));
        for (const l of c.disagreement.lines.slice(0, 4)) out.append(el(`<div class="statement">${esc(l.sentence)}</div>`));
        form.after(out);
      }
      loadRating(r.definition.id);
    } catch (err) { $(".out", form).textContent = `${err.message}${err.detail ? ` — ${JSON.stringify(err.detail)}` : ""}`; }
  };
  drawer.append(form);
  card.scrollIntoView({ behavior: "smooth" });
}

async function showLeague() {
  const card = el(`<article class="card"><header class="card-head"><div class="q">Third Down · League</div></header><div class="drawer"><div class="muted">loading…</div></div></article>`);
  $("#feed").prepend(card);
  const drawer = $(".drawer", card);
  try {
    const def = state.rating?.snapshot?.definition_id;
    const l = await api(`/api/v1/ratings/third-down/league?season=${state.season}${def ? `&definition=${encodeURIComponent(def)}` : ""}`);
    drawer.innerHTML = `<div class="muted">${esc(l.definition.name)} v${esc(l.definition.version)} · ${l.population} teams · seq ${l.seq}</div>`;
    const t = el(`<div class="tbl"><table><thead><tr><th class="num">#</th><th>team</th><th class="num">score</th><th class="num">n</th><th class="num">conv%</th><th class="num">epa/p</th><th class="num">succ%</th></tr></thead><tbody></tbody></table></div>`);
    const tb = $("tbody", t);
    for (const r of l.table) tb.append(el(`<tr style="${r.team === state.team ? "color:var(--lime)" : ""}"><td class="num">${r.rank}</td><td>${esc(r.team)}</td><td class="num">${r.score ?? "—"}${r.provisional ? "*" : ""}</td><td class="num">${r.attempts}</td><td class="num">${fmtPct(r.conversion_pct)}</td><td class="num">${fmtNum(r.epa_per_play, 3)}</td><td class="num">${fmtPct(r.success_pct)}</td></tr>`));
    drawer.append(t);
  } catch (e) { drawer.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  card.scrollIntoView({ behavior: "smooth" });
}

boot();
