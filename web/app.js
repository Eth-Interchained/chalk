// Sports-Rater client — thin, dependency-free. Every number on screen comes
// from the CHALK API; this file never calculates football metrics (V3 §23).
const $ = (s, el = document) => el.querySelector(s);
const state = { team: "TB", season: null, teams: [], seasons: [], coach: false, defs: [], rating: null, meta: null, home: null };

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
  SF: ["San Francisco 49ers", "#B3995D"], SEA: ["Seattle Seahawks", "#69BE28"], TB: ["Tampa Bay Buccaneers", "#FF4B3E"], TEN: ["Tennessee Titans", "#4B92DB"], WAS: ["Washington Commanders", "#FFB612"],
};
const teamName = (t) => (TEAMS[t]?.[0] ?? t).split(" ").slice(0, -1).join(" ") || t;
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
  try { state.meta = await api("/api/v1/meta"); } catch (e) { $("#feed").prepend(el(`<div class="card"><div class="err">CHALK API unreachable: ${esc(e.message)}</div></div>`)); return; }
  state.teams = state.meta.teams; state.seasons = state.meta.seasons; state.defs = state.meta.rating_definitions;
  const url = new URL(location.href);
  state.team = (url.searchParams.get("team") || state.meta.defaults.team || "TB").toUpperCase();
  state.season = Number(url.searchParams.get("season") || state.meta.defaults.season || state.seasons[0]);
  state.coach = url.searchParams.get("mode") === "coach";
  const ts = $("#team"); ts.innerHTML = state.teams.map((t) => `<option ${t === state.team ? "selected" : ""}>${t}</option>`).join("");
  const ss = $("#season"); ss.innerHTML = state.seasons.map((s) => `<option ${s === state.season ? "selected" : ""}>${s}</option>`).join("");
  ts.onchange = () => { state.team = ts.value; syncUrl(); loadHome(); renderSuggest(); loadFeed(); };
  ss.onchange = () => { state.season = Number(ss.value); syncUrl(); loadHome(); };
  const mode = $("#mode");
  const applyMode = () => { mode.textContent = state.coach ? "Coach" : "Fan"; mode.setAttribute("aria-pressed", String(state.coach)); document.body.classList.toggle("coach", state.coach); document.querySelectorAll(".card.answer").forEach((c) => c.classList.toggle("coach-on", state.coach)); };
  mode.onclick = () => { state.coach = !state.coach; syncUrl(); applyMode(); };
  applyMode(); renderSuggest(); loadHome(); renderWho(); loadFeed();
  $("#take").onsubmit = async (e) => { e.preventDefault(); const text = $("#take-text").value.trim(); if (!text) return; try { const r = await fanPost("/api/v1/fans/posts", { text, team: state.team }); if (r) { $("#take-text").value = ""; loadFeed(); } } catch (err) { alert(err.message + (err.detail ? ` — ${err.detail.join("; ")}` : "")); } };
  $("#ask").onsubmit = (e) => { e.preventDefault(); const q = $("#q").value.trim(); if (!q) return; $("#q").value = ""; ask(q); };
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-ask]"); if (b) ask(b.dataset.ask.replaceAll("Tampa", teamName(state.team))); });
  $("#rate-differently").onclick = rateDifferently;
  $("#show-league").onclick = showLeague;
  const q0 = url.searchParams.get("q"); if (q0) ask(q0);
}
function syncUrl() { const u = new URL(location.href); u.searchParams.set("team", state.team); u.searchParams.set("season", state.season); u.searchParams.set("mode", state.coach ? "coach" : "fan"); history.replaceState(null, "", u); }
function renderSuggest() { const s = $("#suggest"); s.innerHTML = ""; for (const q of state.meta.suggested_questions) s.append(el(`<button class="chip" data-ask="${esc(q)}">${esc(q.replaceAll("Tampa", teamName(state.team)))}</button>`)); }

// ------------------------------------------------------------------ home
async function loadHome(defId) {
  applyTeamTheme(state.team);
  $("#h-abbr").textContent = state.team;
  $("#h-name").textContent = TEAMS[state.team]?.[0] ?? "";
  $("#rc-score").textContent = "…";
  ["#h-badges", "#form-body", "#last-body", "#next-body", "#weak-body", "#rc-components", "#trend-headline", "#ratings", "#scout-body"].forEach((s) => { $(s).innerHTML = ""; });
  $("#trend-svg").innerHTML = "";
  try {
    const h = await api(`/api/v1/teams/${state.team}/home?season=${state.season}${defId ? `&definition=${encodeURIComponent(defId)}` : ""}`);
    state.home = h; state.rating = h.rating ? { summary: h.rating, snapshot: { definition_id: h.rating.definition_id, id: h.rating_snapshot_id } } : null;
    renderRating(h);
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
  } catch (e) {
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
function renderTrend(t) {
  const svg = $("#trend-svg"); const sub = $("#trend-sub"); const head = $("#trend-headline");
  if (!t || !t.points.length) { head.textContent = "No trend yet."; return; }
  const pts = t.points; const W = 320, H = 96, padL = 8, padR = 26, padT = 14, padB = 16;
  const xs = pts.map((_, i) => padL + (i * (W - padL - padR)) / Math.max(1, pts.length - 1));
  const ys = pts.map((p) => H - padB - ((p.score ?? 0) / 100) * (H - padT - padB));
  const line = pts.map((_, i) => `${i ? "L" : "M"}${xs[i].toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const area = `${line} L${xs[xs.length - 1].toFixed(1)},${H - padB} L${xs[0].toFixed(1)},${H - padB} Z`;
  const last = pts[pts.length - 1];
  svg.innerHTML = `<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    <path class="area" d="${area}"/><path class="line" d="${line}"/>
    ${pts.map((p, i) => `<circle class="dot ${p.provisional ? "prov" : ""}" cx="${xs[i].toFixed(1)}" cy="${ys[i].toFixed(1)}" r="3"><title>Week ${p.week}: ${p.score}/100 · rank ${p.rank} · ${p.attempts} third downs${p.provisional ? " (provisional)" : ""}</title></circle>`).join("")}
    ${pts.filter((_, i) => i % Math.ceil(pts.length / 6) === 0 || i === pts.length - 1).map((p) => `<text class="lbl" x="${xs[pts.indexOf(p)].toFixed(1)}" y="${H - 3}" text-anchor="middle">W${p.week}</text>`).join("")}
    <text class="val" x="${(xs[xs.length - 1] + 5).toFixed(1)}" y="${(ys[ys.length - 1] + 4).toFixed(1)}">${last.score}</text>`;
  sub.textContent = `wk ${pts[0].week}–${last.week} · as known then`;
  head.textContent = t.headline;
}
function renderTrendChips(ratings) {
  const box = $("#trend-chips"); box.innerHTML = "";
  for (const r of ratings) {
    const b = el(`<button class="chip ${r.subject === "third_down" ? "on" : ""}">${esc(r.label)}</button>`);
    b.onclick = async () => {
      box.querySelectorAll(".chip").forEach((x) => x.classList.remove("on")); b.classList.add("on");
      $("#trend-headline").textContent = "…";
      try {
        if (r.subject === "third_down") { renderTrend(state.home.trend); return; }
        const t = await api(`/api/v1/ratings/${r.subject.replace("_", "-")}/trend?team=${state.team}&season=${state.season}`);
        renderTrend({ points: t.points.map((p) => ({ ...p, attempts: p.sample })), headline: t.headline });
      } catch (e) { $("#trend-headline").textContent = e.message; }
    };
    box.append(b);
  }
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
  b.innerHTML = `<div class="opp"><div><div class="abbr">${home ? "vs" : "@"} ${esc(n.opponent)}</div><div class="kick">${esc(TEAMS[n.opponent]?.[0] ?? "")}${when ? ` · ${esc(when)}` : ""}${g?.week ? ` · Wk ${g.week}` : ""}${p?.phase === "live" ? ` · <b style="color:var(--red)">LIVE</b>` : ""}</div></div>
    ${n.opponent_rating ? `<div class="oscore">${n.opponent_rating.score}<small>their 3rd down · #${n.opponent_rating.rank}</small></div>` : ""}</div>
    <div style="margin-top:10px"><button class="chip" data-ask="What should I know about the ${esc(n.opponent)} offense?">Scout them</button></div>`;
}
function renderWeak(h) {
  const b = $("#weak-body");
  if (!h.weakest.length) { b.innerHTML = `<div class="empty">Not enough snaps to rank situations.</div>`; return; }
  b.innerHTML = "";
  for (const w of h.weakest) b.append(el(`<div class="weak-row" data-ask="What does Tampa do in this situation: ${esc(w.situation)}"><div>${esc(w.situation)}<div class="n">${w.snaps} snaps</div></div><div class="epa">${signed(w.epa_vs_team, 2)} EPA</div></div>`));
  for (const s of h.strongest.slice(0, 1)) b.append(el(`<div class="weak-row" data-ask="What does Tampa do in this situation: ${esc(s.situation)}"><div>${esc(s.situation)}<div class="n">${s.snaps} snaps · strongest</div></div><div class="epa good">${signed(s.epa_vs_team, 2)} EPA</div></div>`));
}
const SUBJECT_Q = { offense: "How is the Tampa offense rated overall?", defense: "Grade the Tampa defense", third_down: "How does Tampa's third-down rating break down?", red_zone: "What is Tampa's red zone rating?", explosiveness: "How explosive is Tampa's offense rated?", ball_security: "What is Tampa's ball security rating?" };
function renderRatings(list) {
  const box = $("#ratings"); box.innerHTML = "";
  for (const r of list) {
    const card = el(`<div class="rt ${r.provisional ? "prov" : ""}" data-subject="${esc(r.subject)}" title="${esc(r.definition_name)} · ${r.sample} sample"><div class="k">${esc(r.label)}</div><div class="v">${r.score ?? "–"}<small>/100</small></div><div class="r">#${r.rank} of ${r.of}${r.top_component ? ` · ${esc(r.top_component.label.toLowerCase())} ${r.top_component.percentile}th` : ""}${r.provisional ? " · provisional" : ""}</div><div class="rx" style="margin-top:6px;display:flex;gap:4px"><button class="chip" data-why style="padding:4px 8px;font-size:12px">Why?</button><button class="chip" data-rate style="padding:4px 8px;font-size:12px">Rate it</button></div><div class="bar"><i style="width:${r.score ?? 0}%"></i></div></div>`);
    card.querySelector("[data-why]").onclick = () => ask((SUBJECT_Q[r.subject] || `How is Tampa rated on ${r.label.toLowerCase()}?`).replaceAll("Tampa", teamName(state.team)));
    card.querySelector("[data-rate]").onclick = () => rateTile(r);
    box.append(card);
  }
  loadConsensus();
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
  for (const x of badges) b.append(el(`<button class="badge-pill ${x.tone}" title="${esc(x.qualification_rule)} · ${x.percentile}th pct · #${x.rank} of ${x.of} · n=${x.sample}" data-ask="Why does Tampa have the ${esc(x.name.toLowerCase())} badge?">${esc(x.emoji)} ${esc(x.name)}</button>`));
  if (!badges.length) b.append(el(`<span class="muted">No badges earned — top/bottom 10% of the league on a metric earns one.</span>`));
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
  $("#feed").prepend(card); card.scrollIntoView({ behavior: "smooth" });
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
    body.innerHTML = f.count ? "" : `<div class="empty">No takes yet for ${esc(state.team)}. Rate a tile or post one.</div>`;
    for (const i of f.items) {
      const item = el(`<div class="fi"><img src="/api/v1/identicon/${i.fan_id}.svg?size=32" alt="" /><div><div class="h">${esc(i.handle)}<small>#${i.chain_index} · ${esc(new Date(i.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</small></div>${i.kind === "post" ? `<div class="t">${esc(i.text)}</div><div class="rx"><button data-r="like">👍 ${i.reactions?.like ?? 0}</button><button data-r="agree">agree ${i.reactions?.agree ?? 0}</button><button data-r="disagree">disagree ${i.reactions?.disagree ?? 0}</button><button data-prov>provenance</button></div>` : `<div class="t">rated ${esc(i.team)} ${esc(i.subject.replace(/_/g, " "))}${i.chalk_score !== null && i.chalk_score !== undefined ? ` · CHALK said ${i.chalk_score}` : ""}</div>`}</div>${i.kind === "rating" ? `<div class="sc">${i.score}<small>fan</small></div>` : ""}</div>`);
      item.querySelectorAll("[data-r]").forEach((b) => { b.onclick = async () => { try { await fanPost("/api/v1/fans/reactions", { target_coll: "sr_posts", target_id: i.id, reaction: b.dataset.r }); loadFeed(); } catch (e) { alert(e.message); } }; });
      item.querySelector("[data-prov]")?.addEventListener("click", async () => { const p = await api(`/api/v1/provenance/sr_posts/${encodeURIComponent(i.id)}`); alert(`${p.node_count} records behind this take · ${Object.entries(p.collections).map(([k, v]) => `${k}: ${v}`).join(", ")}`); });
      body.append(item);
    }
  } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
async function loadConsensus() {
  try {
    const c = await api(`/api/v1/fans/consensus?team=${state.team}&season=${state.season}`);
    for (const x of c.consensus) { const tile = document.querySelector(`.rt[data-subject="${x.subject}"]`); if (!tile) continue; tile.querySelector(".fan")?.remove(); if (x.fans) tile.append(el(`<div class="fan">fans <b>${x.mean}</b> · ${x.fans}</div>`)); }
  } catch (e) { console.warn("consensus", e.message); }
}
function rateTile(r) {
  const card = el(`<article class="card"><header class="card-head"><div class="q">Rate ${esc(teamName(state.team))} · ${esc(r.label)}</div><div class="badges"><span class="badge lime">CHALK ${r.score}</span></div></header><div class="muted">CHALK says ${r.score}/100 (#${r.rank} of ${r.of}). Where would you put them? Your number is stored next to CHALK's snapshot — the disagreement is the point.</div><div class="drawer"><div class="rater"><div class="big" id="rv">${r.score ?? 50}</div><input type="range" min="0" max="100" value="${r.score ?? 50}" /><div><button class="chip go">Save my rating</button> <span class="muted out"></span></div></div></div></article>`);
  const range = card.querySelector("input[type=range]"); const big = $("#rv", card);
  range.oninput = () => { big.textContent = range.value; };
  $(".go", card).onclick = async () => { try { const res = await fanPost("/api/v1/fans/ratings", { team: state.team, season: state.season, subject: r.subject, score: Number(range.value), snapshot_id: r.snapshot_id, chalk_score: r.score }); if (!res) return; const c = res.consensus; $(".out", card).textContent = `saved (#${res.chain_index} in your chain) · fans ${c.mean} vs CHALK ${c.chalk_score} (${c.delta >= 0 ? "+" : ""}${c.delta}) over ${c.fans} fan${c.fans === 1 ? "" : "s"}`; loadConsensus(); loadFeed(); } catch (e) { $(".out", card).textContent = e.message; } };
  $("#feed").prepend(card); card.scrollIntoView({ behavior: "smooth" });
}

// ------------------------------------------------------------------- ask
async function ask(question) {
  const card = $("#tpl-answer").content.firstElementChild.cloneNode(true);
  card.classList.toggle("coach-on", state.coach);
  $(".q", card).textContent = question;
  const badges = $(".badges", card), statements = $(".statements", card), prose = $(".prose", card), coach = $(".coach", card), drawer = $(".drawer", card);
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
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (.+)$/m.exec(chunk)?.[1]; const data = /^data: (.+)$/m.exec(chunk)?.[1]; if (ev && data) handle(ev, JSON.parse(data)); }
    }
  } catch (e) { prose.classList.remove("streaming"); statements.append(el(`<div class="err">${esc(e.message)}</div>`)); }
  function handle(ev, d) {
    if (ev === "plan") { planInfo = d; badges.innerHTML = ""; if (d.plan) badges.append(el(`<span class="badge lime">${esc(d.plan.intent)}</span>`), el(`<span class="badge">${d.plan.source === "model" ? esc(d.plan.model) : "rules"}</span>`)); if (d.fallback_used) badges.append(el(`<span class="badge amber" title="${esc(d.errors.join("; "))}">fallback</span>`)); }
    else if (ev === "evidence") { evidence = d; for (const s of d.deterministic_statements) statements.append(el(`<div class="statement">${esc(s)}</div>`)); badges.append(el(`<span class="badge">${d.evidence_count} plays</span>`)); const conf = d.summary?.analysis?.confidence || d.summary?.confidence; if (conf === "insufficient" || conf === "low") badges.append(el(`<span class="badge red">${esc(conf)} sample</span>`)); coach.innerHTML = ""; coach.append(renderCoach(d)); }
    else if (ev === "token") prose.textContent += d.text;
    else if (ev === "observation") { observation = d; prose.classList.remove("streaming"); if (d.id) badges.append(el(`<span class="badge" title="observation ${esc(d.id)}">${esc(d.model)} · ${(d.latency_ms / 1000).toFixed(1)}s</span>`)); if (d.answer_truncated) badges.append(el(`<span class="badge red">truncated</span>`)); if (d.skipped) badges.append(el(`<span class="badge amber">${esc(d.skipped)}</span>`)); }
    else if (ev === "error") { prose.classList.remove("streaming"); statements.append(el(`<div class="err">${esc(d.error)}${d.errors ? ` — ${esc(d.errors.join("; "))}` : ""}</div>`)); }
    else if (ev === "done") prose.classList.remove("streaming");
  }
  $(".act-evidence", card).onclick = async () => {
    if (!evidence) return;
    drawer.innerHTML = `<div class="muted">loading ${Math.min(evidence.evidence_ids.length, 300)} of ${evidence.evidence_count} plays…</div>`;
    try { const plays = await loadPlays(evidence.evidence_ids); drawer.innerHTML = `<div class="h">Evidence · ${plays.length} of ${evidence.evidence_count} plays${evidence.calculation_ids.length ? ` · calc ${esc(evidence.calculation_ids.join(", "))}` : ""}</div>`; for (const p of plays) drawer.append(playRow(p)); }
    catch (e) { drawer.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
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
      drawer.innerHTML = `<div class="h">Provenance · ${p.node_count} records · ${p.edge_count} edges · depth ${p.depth}</div><div class="muted">${esc(Object.entries(p.collections).map(([k, v]) => `${k.replace("football_", "")}: ${v}`).join(" · "))}</div>`;
      const prov = el(`<div class="prov"></div>`); for (const n of p.nodes.slice(0, 60)) prov.append(el(`<div><span class="c">${esc(n._coll.replace("football_", ""))}</span><span>${esc(n.label)}</span><span class="hsh">${esc(n._hash.slice(0, 12))}</span></div>`)); drawer.append(prov);
      if (p.node_count > 60) drawer.append(el(`<div class="muted">… ${p.node_count - 60} more · <code>GET /api/v1/provenance/${esc(coll)}/${esc(id)}</code></div>`));
    } catch (e) { drawer.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

async function loadPlays(ids) {
  const wanted = ids.slice(0, 300);
  const byGame = new Map(); for (const id of wanted) { const g = id.split(":")[0]; if (!byGame.has(g)) byGame.set(g, new Set()); byGame.get(g).add(id); }
  const out = [];
  for (const [g, want] of byGame) { const r = await api(`/api/v1/games/${encodeURIComponent(g)}/plays`); for (const p of r.plays) if (want.has(p.id)) out.push(p); }
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
  const card = el(`<article class="card"><header class="card-head"><div class="q">Rate differently</div></header><div class="muted">Pick a saved formula or build your own. Weights are normalized; every score exposes its formula.</div><div class="drawer"></div></article>`);
  $("#feed").prepend(card);
  const drawer = $(".drawer", card);
  const defs = await api("/api/v1/rating-definitions");
  const sel = el(`<div class="suggest" style="padding:6px 0"></div>`);
  const showCompare = async (a, b, anchor) => { const c = await api(`/api/v1/ratings/compare?team=${state.team}&season=${state.season}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`); const out = el(`<div></div>`); out.append(el(`<div class="h">${esc(c.a.summary.definition)} ${c.a.summary.score} → ${esc(c.b.summary.definition)} ${c.b.summary.score} (Δ ${c.disagreement.delta})</div><div class="statement">${esc(c.disagreement.headline)}</div>`)); for (const l of c.disagreement.lines.slice(0, 4)) out.append(el(`<div class="statement">${esc(l.sentence)}</div>`)); anchor.after(out); };
  for (const d of defs.definitions) {
    const b = el(`<button class="chip ${d.id === state.rating?.snapshot?.definition_id ? "on" : ""}">${esc(d.name)} v${esc(d.version)}</button>`);
    b.onclick = async () => { const cur = state.rating?.snapshot?.definition_id; if (cur && cur !== d.id) await showCompare(cur, d.id, sel); loadHome(d.id); sel.querySelectorAll(".chip").forEach((x) => x.classList.remove("on")); b.classList.add("on"); };
    sel.append(b);
  }
  drawer.append(sel);
  const metrics = Object.entries(defs.rateable_metrics);
  const form = el(`<form class="rd"><div class="h">Build your own</div><input name="name" placeholder="Name it (e.g. Dad Rating)" required maxlength="80" />${metrics.map(([k, m]) => `<div class="row"><label>${esc(m.label)} <span class="muted">(${m.default_direction === "lower_is_better" ? "lower is better" : "higher is better"})</span></label><input name="w_${k}" type="number" min="0" step="5" placeholder="0" /></div>`).join("")}<button class="chip go" type="submit">Save & rate</button><div class="err out"></div></form>`);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const components = metrics.map(([k]) => ({ metric: k, weight: Number(fd.get(`w_${k}`) || 0) })).filter((c) => c.weight > 0);
    try { const r = await api("/api/v1/rating-definitions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: fd.get("name"), components, author: "fan" }) }); $(".out", form).textContent = ""; const cur = state.rating?.snapshot?.definition_id; if (cur) await showCompare(cur, r.definition.id, form); loadHome(r.definition.id); }
    catch (err) { $(".out", form).textContent = `${err.message}${err.detail ? ` — ${JSON.stringify(err.detail)}` : ""}`; }
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
    for (const r of l.table) { const tr = el(`<tr style="${r.team === state.team ? "color:var(--accent)" : ""}"><td class="num">${r.rank}</td><td>${esc(r.team)}</td><td class="num">${r.score ?? "—"}${r.provisional ? "*" : ""}</td><td class="num">${r.attempts}</td><td class="num">${fmtPct(r.conversion_pct)}</td><td class="num">${fmtNum(r.epa_per_play, 3)}</td><td class="num">${fmtPct(r.success_pct)}</td></tr>`); tr.style.cursor = "pointer"; tr.onclick = () => { state.team = r.team; $("#team").value = r.team; syncUrl(); loadHome(); renderSuggest(); window.scrollTo({ top: 0, behavior: "smooth" }); }; tb.append(tr); }
    drawer.append(t);
  } catch (e) { drawer.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  card.scrollIntoView({ behavior: "smooth" });
}

boot();
