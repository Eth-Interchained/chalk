/* CHALK admin — reads /api/v1/admin/overview with the env token; renders KPIs, heatmaps, lists. */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const el = (h) => { const t = document.createElement("template"); t.innerHTML = h.trim(); return t.content.firstElementChild; };
const fmt = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString());
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const token = () => sessionStorage.getItem("chalk_admin_token") || "";

async function api(path, body) {
  const res = await fetch(path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token()}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  if (res.status === 401 || res.status === 404) { sessionStorage.removeItem("chalk_admin_token"); throw Object.assign(new Error(res.status === 404 ? "admin is not enabled on this server (CHALK_ADMIN_TOKEN unset)" : "token rejected"), { status: res.status }); }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function bars(rows, keyLabel = (k) => k) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  const w = el(`<div class="bars"></div>`);
  if (!rows.length) return el(`<div class="muted">none yet</div>`);
  for (const r of rows.slice(0, 14)) w.append(el(`<div class="bar-row"><div>${esc(keyLabel(r.key))}</div><div class="b"><i style="width:${Math.round((r.n / max) * 100)}%"></i></div><div class="n">${fmt(r.n)}</div></div>`));
  return w;
}
function heatmap(cells, box) {
  box.innerHTML = "";
  const max = Math.max(1, ...cells.map((c) => c.n));
  const grid = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c.n]));
  box.append(el(`<div></div>`));
  for (let h = 0; h < 24; h++) box.append(el(`<div class="hh">${h % 3 === 0 ? h : ""}</div>`));
  for (let d = 0; d < 7; d++) {
    box.append(el(`<div class="lbl">${DOW[d]}</div>`));
    for (let h = 0; h < 24; h++) { const n = grid.get(`${d}:${h}`) ?? 0; const a = n ? 0.15 + 0.85 * (n / max) : 0; box.append(el(`<div class="c" title="${DOW[d]} ${h}:00 UTC · ${n}" style="${n ? `background: color-mix(in srgb, var(--accent) ${Math.round(a * 100)}%, var(--bg-3))` : ""}"></div>`)); }
  }
}
function spark(svg, series) {
  svg.innerHTML = "";
  if (!series.length) return;
  const max = Math.max(1, ...series.map((s) => s.n));
  const step = 320 / Math.max(1, series.length - 1);
  const pts = series.map((s, i) => `${(i * step).toFixed(1)},${(78 - (s.n / max) * 70).toFixed(1)}`);
  svg.innerHTML = `<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${pts.join(" ")}"/>` + series.map((s, i) => `<circle cx="${(i * step).toFixed(1)}" cy="${(78 - (s.n / max) * 70).toFixed(1)}" r="2.5" fill="var(--accent)"><title>${s.day}: ${s.n}</title></circle>`).join("");
}
function kv(obj) { const w = el(`<div class="kv2"></div>`); for (const [k, v] of Object.entries(obj)) w.append(el(`<div><div class="k">${esc(k.replace(/_/g, " "))}</div><div class="v">${esc(v)}</div></div>`)); return w; }
function qlist(items, meta, reason) {
  if (!items.length) return el(`<div class="muted">none in this window</div>`);
  const w = el(`<div class="qlist"></div>`);
  for (const it of items) w.append(el(`<div class="q"><div>${esc(it.question ?? it.key)}</div><div class="m">${esc(meta(it))}</div>${reason && reason(it) ? `<div class="r">${esc(reason(it))}</div>` : ""}</div>`));
  return w;
}

async function load() {
  const season = $("#season").value, win = $("#window").value;
  const d = await api(`/api/v1/admin/overview?window=${win}${season ? `&season=${season}` : ""}`);
  const a = d.asks;
  $("#kpis").innerHTML = "";
  const kpi = (k, v, s = "") => $("#kpis").append(el(`<div class="kpi"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`));
  kpi("asks", fmt(a.in_window), `${fmt(a.total)} all time`);
  kpi("from the record", a.from_record_rate === null ? "—" : `${a.from_record_rate}%`, `${fmt(a.from_record)} served without a model call`);
  kpi("fallbacks", fmt(a.plan_fallback), `${fmt(a.plan_failed)} could not plan · ${fmt(a.errors)} errors`);
  kpi("llm p50 / p95", `${fmt(a.latency_ms.llm_p50)} / ${fmt(a.latency_ms.llm_p95)}`, `end-to-end p50 ${fmt(a.latency_ms.p50)} ms`);
  kpi("answers", fmt(d.answers.complete), `${fmt(d.answers.truncated)} truncated · ${fmt(d.answers.errored)} errored`);
  kpi("fans", fmt(d.fans.total), `${fmt(d.fans.active_7d)} active 7d`);
  kpi("fan writes", fmt(d.fans.ratings + d.fans.posts + d.fans.reactions), `${fmt(d.fans.ratings)} ratings · ${fmt(d.fans.posts)} takes · ${fmt(d.fans.reactions)} reactions`);
  kpi("page views", fmt(d.preferences.views), `${fmt(d.preferences.returning_handles)} with a handle`);

  spark($("#asks-spark"), a.per_day); $("#asks-foot").textContent = a.per_day.length ? `${a.per_day[0].day} → ${a.per_day.at(-1).day}` : "no asks in window";
  heatmap(a.heat, $("#heat-asks"));
  $("#intents").replaceChildren(bars(a.intents));
  $("#teams").replaceChildren(bars(a.teams));
  const ti = $("#team-intent"); ti.innerHTML = "";
  if (a.team_intent.length) { const teams = [...new Set(a.team_intent.map((x) => x.team))], intents = [...new Set(a.team_intent.map((x) => x.intent))]; const m = new Map(a.team_intent.map((x) => [`${x.team}|${x.intent}`, x.n])); const max = Math.max(...a.team_intent.map((x) => x.n)); ti.append(el(`<table><thead><tr><th>team</th>${intents.map((i) => `<th class="num">${esc(i)}</th>`).join("")}</tr></thead><tbody>${teams.map((t) => `<tr><td>${esc(t)}</td>${intents.map((i) => { const n = m.get(`${t}|${i}`) ?? 0; return `<td class="num" style="${n ? `background: color-mix(in srgb, var(--accent) ${Math.round(10 + 60 * n / max)}%, transparent)` : ""}">${n || ""}</td>`; }).join("")}</tr>`).join("")}</tbody></table>`)); } else ti.append(el(`<div class="muted">none yet</div>`));
  $("#top-q").replaceChildren(qlist(d.questions.top, (it) => `${it.n}×`));
  $("#unanswered").replaceChildren(qlist(d.questions.unanswered, (it) => it.created_at.slice(0, 16).replace("T", " "), (it) => it.reason));
  $("#fallbacks").replaceChildren(qlist(d.questions.fallbacks, (it) => `${it.intent ?? "?"} · ${it.created_at.slice(0, 16).replace("T", " ")}`, (it) => it.errors.join("; ")));
  $("#latency").replaceChildren(kv({ end_to_end_p50: fmt(a.latency_ms.p50), end_to_end_p95: fmt(a.latency_ms.p95), llm_p50: fmt(a.latency_ms.llm_p50), llm_p95: fmt(a.latency_ms.llm_p95), engine_exec_p50: fmt(a.latency_ms.exec_p50), llm_skipped: fmt(a.llm_skipped) }));
  $("#answers").replaceChildren(kv({ total: fmt(d.answers.total), complete: fmt(d.answers.complete), truncated: fmt(d.answers.truncated), errored: fmt(d.answers.errored), agree: fmt(d.answers.reactions.agree), disagree: fmt(d.answers.reactions.disagree), like: fmt(d.answers.reactions.like) }), bars(d.answers.models));
  $("#most-reacted").replaceChildren(qlist(d.answers.most_reacted, (it) => `👍 ${it.agree + it.like} · 👎 ${it.disagree}`));
  $("#fans").replaceChildren(kv({ fans: fmt(d.fans.total), active_7d: fmt(d.fans.active_7d), ratings: fmt(d.fans.ratings), takes: fmt(d.fans.posts), reactions: fmt(d.fans.reactions) }));
  $("#consensus").replaceChildren(bars(d.fans.consensus.filter((c) => c.fans).map((c) => ({ key: `${c.subject} · mean ${c.mean}`, n: c.fans }))));
  $("#handles").replaceChildren(bars(d.fans.top_handles.map((h) => ({ key: h.handle, n: h.chain_length }))));
  $("#dist").replaceChildren(bars(d.fans.rating_distribution.map((b) => ({ key: b.bucket, n: b.n }))));
  const p = d.preferences;
  $("#prefs").replaceChildren(kv({ page_views: fmt(p.views), with_handle: fmt(p.returning_handles) }), el(`<div class="h" style="margin-top:8px">Teams</div>`), bars(p.teams), el(`<div class="h" style="margin-top:8px">Mode</div>`), bars(p.modes), el(`<div class="h" style="margin-top:8px">Tab</div>`), bars(p.tabs), el(`<div class="h" style="margin-top:8px">Viewport</div>`), bars(p.viewports), el(`<div class="h" style="margin-top:8px">Seasons</div>`), bars(p.seasons), el(`<div class="h" style="margin-top:8px">Events</div>`), bars(p.events));
  heatmap(p.heat, $("#heat-views"));
  const h = d.health;
  $("#health").replaceChildren(kv({ nedb_seq: fmt(h.seq), head: h.head.slice(0, 12) + "…", pulse_ticks: fmt(h.pulse_ticks), home_snapshots: fmt(h.home_snapshots.length), audit: h.audit ? (h.audit.ok ? "ok" : "NOT OK") : "pick a season" }), el(`<div class="h" style="margin-top:8px">${h.audit ? esc(h.audit.summary) : ""}</div>`), el(`<div class="h" style="margin-top:8px">Recent ingest runs</div>`), qlist(h.ingest_runs.map((r) => ({ question: JSON.stringify(r.scope), finished_at: r.finished_at, games: r.games, plays: r.plays, errors: r.errors })), (r) => `${r.finished_at.slice(0, 16).replace("T", " ")} · games ${r.games} · plays ${r.plays} · errors ${r.errors}`), el(`<div class="h" style="margin-top:8px">Home snapshots</div>`), qlist(h.home_snapshots.map((s) => ({ question: s.id, m: s })), (s) => `stamp ${s.m.data_stamp} · built ${s.m.built_ms} ms · ${s.m.created_at.slice(0, 16).replace("T", " ")}`));
  $("#gen").textContent = `generated ${d.generated_at} · window ${d.window_days}d`;
  await loadModeration();
}

// ---- Feed moderation: Answers | Fan takes | Log. Hide (with reason) / Unhide / Regenerate.
let modTab = "answers";
async function loadModeration() {
  const box = $("#moderation");
  let d;
  try { d = await api("/api/v1/admin/feed?limit=60"); } catch (e) { box.replaceChildren(el(`<div class="err">${esc(e.message)}</div>`)); return; }
  const showHidden = $("#mod-show-hidden").checked;
  const w = el(`<div class="mod"></div>`);
  const act = async (btn, out, fn) => { btn.disabled = true; const t = btn.textContent; btn.textContent = "…"; try { const r = await fn(); out.textContent = r; await loadModeration(); } catch (e) { out.textContent = e.message; btn.disabled = false; btn.textContent = t; } };
  if (modTab === "answers") {
    const rows = d.answers.filter((a) => showHidden || !a.hidden);
    if (!rows.length) w.append(el(`<div class="muted">no answers</div>`));
    for (const a of rows) {
      const it = el(`<div class="item ${a.hidden ? "hidden" : ""}"><div class="top"><div class="q">${esc(a.question)}</div><div class="meta">${esc(a.intent)} · ${esc(a.team ?? "?")} · ${esc(a.model)} · ${esc(a.created_at.slice(0, 16).replace("T", " "))}${a.hidden ? " · HIDDEN" : ""}${a.error ? " · ERROR" : ""}${a.truncated ? " · TRUNCATED" : ""}</div></div>${a.statements.slice(0, 2).map((s) => `<div class="st">${esc(s)}</div>`).join("")}<div class="ans">${esc(a.answer)}</div><div class="acts"><input placeholder="reason (kept in the moderation row)" /><button class="chip ${a.hidden ? "" : "danger"} act-hide">${a.hidden ? "Unhide" : "Hide"}</button><button class="chip act-regen" title="re-plan, re-execute, re-explain live; hides this one with the new id as the reason">Regenerate</button><a class="chip" target="_blank" rel="noopener" href="/api/v1/observations/${encodeURIComponent(a.id)}">raw</a><span class="out"></span></div></div>`);
      const out = $(".out", it), reason = $("input", it);
      $(".act-hide", it).onclick = (e) => act(e.target, out, async () => { const r = await api(a.hidden ? "/api/v1/admin/unhide" : "/api/v1/admin/hide", { coll: a.coll, id: a.id, reason: reason.value }); return `${r.hidden ? "hidden" : "restored"} · ${r.moderation_hash.slice(0, 12)}`; });
      $(".act-regen", it).onclick = (e) => act(e.target, out, async () => { const r = await api("/api/v1/admin/regenerate", { id: a.id, reason: reason.value }); return `regenerated → ${r.new_id} (${r.intent}${r.plan_fallback ? ", rules fallback" : ""}, ${(r.latency_ms / 1000).toFixed(1)}s)`; });
      w.append(it);
    }
  } else if (modTab === "takes") {
    const rows = d.takes.filter((a) => showHidden || !a.hidden);
    if (!rows.length) w.append(el(`<div class="muted">no fan takes</div>`));
    for (const a of rows) {
      const it = el(`<div class="item ${a.hidden ? "hidden" : ""}"><div class="top"><div class="q">${esc(a.handle)}</div><div class="meta">${esc(a.team ?? "")} · ${esc(a.created_at.slice(0, 16).replace("T", " "))}${a.hidden ? " · HIDDEN" : ""}</div></div><div class="ans">${esc(a.text)}</div><div class="acts"><input placeholder="reason" /><button class="chip ${a.hidden ? "" : "danger"} act-hide">${a.hidden ? "Unhide" : "Hide"}</button><span class="out"></span></div></div>`);
      const out = $(".out", it), reason = $("input", it);
      $(".act-hide", it).onclick = (e) => act(e.target, out, async () => { const r = await api(a.hidden ? "/api/v1/admin/unhide" : "/api/v1/admin/hide", { coll: a.coll, id: a.id, reason: reason.value }); return r.hidden ? "hidden" : "restored"; });
      w.append(it);
    }
  } else {
    if (!d.moderation.length) w.append(el(`<div class="muted">nothing moderated yet</div>`));
    for (const m of d.moderation) w.append(el(`<div class="item"><div class="top"><div class="q">${m.hidden ? "HIDE" : "UNHIDE"} · ${esc(m.coll)}/${esc(m.id)}</div><div class="meta">${esc(m.by)} · ${esc(m.created_at.slice(0, 16).replace("T", " "))} · ${esc(m.hash.slice(0, 12))}</div></div><div class="ans">${esc(m.reason)}</div></div>`));
  }
  box.replaceChildren(w);
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-mod]"); if (!b) return; modTab = b.dataset.mod; document.querySelectorAll("[data-mod]").forEach((x) => x.classList.toggle("on", x === b)); loadModeration(); });
document.addEventListener("change", (e) => { if (e.target.id === "mod-show-hidden") loadModeration(); });

async function boot() {
  const meta = await fetch("/api/v1/meta").then((r) => r.json()).catch(() => ({ seasons: [] }));
  $("#season").innerHTML = `<option value="">all seasons</option>` + (meta.seasons ?? []).map((s) => `<option value="${s}">${s}</option>`).join("");
  if (meta.defaults?.season) $("#season").value = String(meta.defaults.season);
  const show = async () => {
    try { await load(); $("#gate").hidden = true; $("#panel").hidden = false; }
    catch (e) { $("#gate").hidden = false; $("#panel").hidden = true; $("#gate-err").textContent = e.message; }
  };
  $("#gate-form").onsubmit = (e) => { e.preventDefault(); sessionStorage.setItem("chalk_admin_token", $("#token").value.trim()); $("#token").value = ""; show(); };
  $("#refresh").onclick = show; $("#season").onchange = show; $("#window").onchange = show;
  $("#logout").onclick = () => { sessionStorage.removeItem("chalk_admin_token"); $("#panel").hidden = true; $("#gate").hidden = false; };
  if (token()) show();
}
boot().catch((e) => { $("#gate-err").textContent = `admin failed to start: ${e.message}`; });
