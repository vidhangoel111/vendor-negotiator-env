const API_BASE = window.location.origin;

const TASKS = {
  easy: {
    label: "Easy task",
    budMult: 1.2,
    expectedScore: "0.85-0.95",
    scenario:
      "Most vendors are active and prices are close to expected. A clear best option usually exists.",
    tags: ["low denials", "stable pricing", "clear ranking"],
  },
  medium: {
    label: "Medium task",
    budMult: 1.12,
    expectedScore: "0.65-0.82",
    scenario:
      "Trade-offs appear between cost, delivery, and quality. Some vendors deny negotiation.",
    tags: ["mixed denials", "trade-offs", "no obvious pick"],
  },
  hard: {
    label: "Hard task",
    budMult: 1.04,
    expectedScore: "0.42-0.68",
    scenario:
      "Most vendors deny and quotes are tight or over budget. Best decision is usually a compromise.",
    tags: ["high denials", "budget pressure", "quality-cost conflict"],
  },
};

let G = {
  task: "easy",
  item: "Rice",
  exp: 180,
  bud: 216,
  qty: 1000,
  spd: 380,
  stochasticVendors: false,
  running: false,
  paused: false,
  pauseRes: null,
  steps: 0,
  cumRew: 0,
  done: false,
  finalScore: 0,
  vendors: [],
  trace: [],
  confirmed: false,
  agentPickVendor: null,
  agent: { r: 0.7, deals: 0, over: 0, runs: 0, rewHistory: [], hist: [0.7], rewardTotal: 0, penaltyTotal: 0, netSignal: 0, updates: 0 },
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asJson(res) {
  if (!res.ok) {
    return res.text().then((t) => {
      throw new Error(`HTTP ${res.status}: ${t}`);
    });
  }
  return res.json();
}

function postJson(path, payload) {
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(asJson);
}

async function postJsonWithFallback(primaryPath, fallbackPath, payload) {
  try {
    return await postJson(primaryPath, payload);
  } catch (e1) {
    if (!fallbackPath) throw e1;
    try {
      return await postJson(fallbackPath, payload);
    } catch (e2) {
      throw new Error(`${e1.message} | fallback failed: ${e2.message}`);
    }
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function setAgentReputation(v) {
  const next = Number(clamp(Number(v || 0.7), 0.1, 1).toFixed(2));
  const prev = Number.isFinite(G.agent.r) ? G.agent.r : next;
  G.agent.r = next;
  if (!G.agent.hist.length || G.agent.hist[G.agent.hist.length - 1] !== next) {
    G.agent.hist.push(next);
    if (G.agent.hist.length > 40) G.agent.hist.shift();
  }
  return next - prev;
}

function applyPolicyMetrics(metrics) {
  if (!metrics) {
    console.log("[APPLY-METRICS] No metrics provided");
    return;
  }
  console.log("[APPLY-METRICS] Received:", metrics);
  if (typeof metrics.task_reputation === "number") {
    const oldR = G.agent.r;
    setAgentReputation(metrics.task_reputation);
    console.log("[APPLY-METRICS] Reputation updated:", oldR, "→", G.agent.r);
  }
  if (typeof metrics.reward_total === "number") G.agent.rewardTotal = Number(metrics.reward_total);
  if (typeof metrics.penalty_total === "number") G.agent.penaltyTotal = Number(metrics.penalty_total);
  if (typeof metrics.net_signal === "number") G.agent.netSignal = Number(metrics.net_signal);
  if (typeof metrics.updates === "number") G.agent.updates = Number(metrics.updates);
}

function appendPolicyTrace(actionText, obs, reward) {
  const box = document.getElementById("ptrace");
  if (!box || !obs) return;
  const active = (obs.vendors || []).filter((v) => v.status === "active");
  const ranked = [...active]
    .map((v) => {
      const pterm = 1 - Math.max(0, (Number(v.quote_price) - Number(obs.budget_per_kg)) / Math.max(Number(obs.budget_per_kg), 1));
      const u = pterm * 0.40 + Number(v.quality_score) * 0.35 + Number(v.reliability_score) * 0.25;
      return { id: v.vendor_id, q: Number(v.quote_price), u };
    })
    .sort((a, b) => b.u - a.u)
    .slice(0, 3);
  const pref = ranked.length
    ? ranked.map((x, i) => `#${i + 1} ${x.id}(₹${x.q},u=${x.u.toFixed(3)})`).join(" | ")
    : "no active vendors";
  const row = document.createElement("div");
  row.className = "prow";
  row.innerHTML = `<div class="pnum">${G.steps}</div><div style="flex:1"><div style="font-weight:500;font-size:11px">${actionText}</div><div style="font-size:10px;color:var(--color-text-secondary)">Preference: ${pref}</div></div><div style="font-size:10px;color:${reward >= 0 ? "#1D9E75" : "#D85A30"}">r=${Number(reward).toFixed(3)}</div>`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function mapVendor(v) {
  const accepted = v.accepted_price ?? null;
  return {
    id: v.vendor_id,
    name: v.name,
    quote: Number(v.quote_price),
    accepted,
    deal: v.status === "deal_closed",
    status: v.status,
    del: Number(v.delivery_days),
    q: Number(v.quality_score),
    rel: Number(v.reliability_score),
    margin: Number(v.negotiation_margin || 0),
    arch: "backend",
    rating: Number((0.45 * Number(v.quality_score) + 0.35 * Number(v.reliability_score)).toFixed(2)),
    rHist: [Number((0.45 * Number(v.quality_score) + 0.35 * Number(v.reliability_score)).toFixed(2))],
    sc: Number(v.rank_score || 0),
  };
}

function syncFromObservation(obs, reward, done) {
  G.steps = Number(obs.step_number || 0);
  G.bud = Number(obs.budget_per_kg || G.bud);
  G.exp = Number(obs.expected_price || G.exp);
  G.qty = Number(obs.quantity_kg || G.qty);
  G.item = obs.item_name || G.item;
  G.task = obs.task_difficulty || G.task;
  G.cumRew = Number(obs.cumulative_reward || 0);
  G.done = Boolean(done || obs.episode_done);
  G.vendors = (obs.vendors || []).map(mapVendor);

  if (typeof reward === "number") {
    G.agent.rewHistory.push(reward);
    if (G.agent.rewHistory.length > 120) G.agent.rewHistory.shift();
    // Do NOT update reputation here - let backend /feedback endpoint handle reputation updates
    // via applyPolicyMetrics(). Updating here causes conflicts with backend stats.
  }

  const deals = G.vendors.filter((v) => v.deal);
  G.agent.deals = deals.length;
  const over = deals.filter((v) => Number(v.accepted) > G.bud).length;
  G.agent.over = over;

  const inBudget = deals.filter((v) => Number(v.accepted) <= G.bud && Number.isFinite(v.sc));
  const pool = inBudget.length ? inBudget : deals;
  if (!pool.length) {
    G.finalScore = 0;
  } else {
    const best = pool.reduce((a, b) => (b.sc > a.sc ? b : a), pool[0]);
    const eff = G.steps <= 10 ? 0.1 : G.steps <= 16 ? 0.05 : 0;
    G.finalScore = Number(clamp(best.sc * 0.9 + eff, 0, 1).toFixed(3));
  }
}

function addAF(cls, msg) {
  const el = document.getElementById("af");
  if (!el) return;
  const d = document.createElement("div");
  d.className = "afl " + cls;
  d.textContent = `[s${G.steps}] ${msg}`;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}

function setVendorMode(stochastic) {
  G.stochasticVendors = Boolean(stochastic);
  const det = document.getElementById("mode-deterministic");
  const sto = document.getElementById("mode-stochastic");
  if (!det || !sto) return;
  if (G.stochasticVendors) {
    det.classList.remove("active");
    sto.classList.add("active");
    det.textContent = "[ ] Deterministic vendors";
    sto.textContent = "✓ Stochastic vendors";
  } else {
    sto.classList.remove("active");
    det.classList.add("active");
    sto.textContent = "[ ] Stochastic vendors";
    det.textContent = "✓ Deterministic vendors";
  }
}

function selectTask(t) {
  G.task = t;
  ["easy", "medium", "hard"].forEach((k) => {
    const el = document.getElementById("tc-" + k);
    if (!el) return;
    el.className = "tc tc-" + (k === "medium" ? "med" : k) + (k === t ? " sel" : "");
  });
  updateBudget();
  renderScenarioBox();
}

function updateBudget() {
  const exp = parseFloat(document.getElementById("f-exp").value) || 180;
  G.exp = exp;
  G.bud = Math.round(exp * TASKS[G.task].budMult);
  document.getElementById("f-bud").value = G.bud;
}

function renderScenarioBox() {
  const t = TASKS[G.task];
  const cls = { easy: "sb-easy", medium: "sb-med", hard: "sb-hard" }[G.task];
  const tagCls = { easy: "tag-e", medium: "tag-m", hard: "tag-h" }[G.task];
  document.getElementById("scenario-box").innerHTML = `<div class="scenario-box ${cls}">
    <div class="sb-lbl">${t.label} - what the agent faces</div>
    <div style="margin-bottom:6px;line-height:1.5">${t.scenario}</div>
    <div>${t.tags.map((x) => `<span class="tc-tag ${tagCls}">${x}</span>`).join("")}</div>
    <div style="margin-top:6px;font-size:10px;opacity:0.8">Expected episode score: ${t.expectedScore}</div>
  </div>`;
}

function gTab(id, el) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  if (el) el.classList.add("active");
  const panel = document.getElementById("tab-" + id);
  if (panel) panel.classList.add("active");
}

async function resetEpisode() {
  G.item = document.getElementById("f-item").value || "Rice";
  G.exp = parseFloat(document.getElementById("f-exp").value) || 180;
  G.qty = parseInt(document.getElementById("f-qty").value, 10) || 1000;
  G.spd = parseInt(document.getElementById("f-spd").value, 10) || 380;
  updateBudget();

  const payload = {
    task: G.task,
    item: G.item,
    expected_price: G.exp,
    quantity_kg: G.qty,
    stochastic_vendors: G.stochasticVendors,
    seed: G.stochasticVendors ? null : 7,
  };

  const out = await postJsonWithFallback("/reset", "/api/reset", payload);
  syncFromObservation(out.observation, 0, false);

  G.running = false;
  G.paused = false;
  G.done = false;
  G.confirmed = false;
  G.agentPickVendor = null;
  G.trace = [];
  G.confirmed = false;

  document.getElementById("af").innerHTML = "";
  document.getElementById("ptrace").innerHTML = '<div style="color:var(--color-text-secondary);font-size:11px">Run the agent to see policy decisions.</div>';
  document.getElementById("res-main").style.display = "none";
  document.getElementById("res-ph").style.display = "block";
  document.getElementById("human-loop").style.display = "none";
  document.getElementById("conf-area").innerHTML = "";
  document.getElementById("conf-btn").disabled = false;
  document.getElementById("conf-btn").textContent = "Accept agent recommendation";
  
  // Re-enable human override button for new episode
  const overrideBtn = document.getElementById("toggle-human");
  if (overrideBtn) overrideBtn.disabled = false;
  
  document.getElementById("tab-results-btn").classList.remove("notify");
  document.getElementById("pause-btn").disabled = true;
  document.getElementById("pause-btn").textContent = "Pause";

  addAF("c-if", `Episode reset via backend | task=${G.task} | mode=${G.stochasticVendors ? "stochastic" : "deterministic"}`);
  renderAll();
}

async function backendAgentStep() {
  const payload = {
    task: G.task,
    item: G.item,
    expected_price: G.exp,
    quantity_kg: G.qty,
    stochastic_vendors: G.stochasticVendors,
    seed: G.stochasticVendors ? null : 7,
  };
  const out = await postJsonWithFallback("/agent-step", null, payload);
  const reward = Number(out.reward || 0);
  syncFromObservation(out.observation, reward, Boolean(out.done));
  applyPolicyMetrics(out.policy_metrics);
  
  // Extract agent's vendor recommendation from action string
  // Action format: "negotiate(vendor=V1,offer=160.5)" or similar
  if (out.action && typeof out.action === "string") {
    const vendorMatch = out.action.match(/vendor=([a-zA-Z0-9_]+)/);
    if (vendorMatch && vendorMatch[1]) {
      G.agentPickVendor = vendorMatch[1];
      console.log("[AGENT-STEP] Extracted agent vendor:", G.agentPickVendor, "from action:", out.action);
    }
  }
  
  appendPolicyTrace(out.action || "agent-step", out.observation, reward);
  addAF("c-sy", `ACTION ${out.action || "agent-step"} | reward=${reward.toFixed(3)} | done=${String(Boolean(out.done))} | R+ ${G.agent.rewardTotal.toFixed(3)} / P- ${G.agent.penaltyTotal.toFixed(3)}`);
}

async function runEpisode() {
  G.running = true;
  document.getElementById("pause-btn").disabled = false;
  updTopbar();

  try {
    while (G.running && !G.done) {
      if (G.paused) {
        await new Promise((r) => {
          G.pauseRes = r;
        });
      }
      await backendAgentStep();
      renderAll();
      await delay(Math.max(20, G.spd));
    }
  } catch (err) {
    console.error(err);
    addAF("c-fl", `Run failed: ${err.message}`);
  }

  G.running = false;
  document.getElementById("pause-btn").disabled = true;
  document.getElementById("pause-btn").textContent = "Pause";
  addAF("c-if", `Episode done | steps=${G.steps} | score=${G.finalScore.toFixed(3)} | cumrew=${G.cumRew.toFixed(3)}`);
  computeResults();
  document.getElementById("tab-results-btn").classList.add("notify");
  gTab("results", document.getElementById("tab-results-btn"));
  updTopbar();
}

async function runAgent() {
  if (G.running) return;
  try {
    G.agent.runs += 1;
    await resetEpisode();
    gTab("agent", document.querySelectorAll(".tab")[1]);
    await runEpisode();
  } catch (err) {
    console.error(err);
    addAF("c-fl", `Start failed: ${err.message}`);
  }
}

function pauseResume() {
  if (!G.running) return;
  G.paused = !G.paused;
  document.getElementById("pause-btn").textContent = G.paused ? "Resume" : "Pause";
  if (!G.paused && G.pauseRes) {
    G.pauseRes();
    G.pauseRes = null;
  }
}

function renderVendors() {
  const sorted = [...G.vendors].sort((a, b) => (b.q + b.rel) - (a.q + a.rel));
  document.getElementById("vtbody").innerHTML = sorted
    .map((v, i) => {
      const pc = v.accepted !== null ? `<span style="font-weight:500;color:#1D9E75">₹${v.accepted}</span>` : `₹${v.quote}`;
      const sc = v.deal ? "pk" : v.status === "denied" ? "pd" : v.status === "negotiating" ? "pn" : "pw";
      const sl = v.deal ? "deal done" : v.status;
      return `<tr class="${v.deal && Number(v.accepted) <= G.bud ? "vhl" : ""}">
        <td style="color:var(--color-text-secondary);font-size:10px">${i + 1}</td>
        <td><div style="font-weight:500;font-size:11px">${v.id}</div><div style="font-size:10px;color:var(--color-text-secondary)">${v.name}</div></td>
        <td style="font-size:11px">${pc}</td><td style="font-size:11px">${v.del}d</td>
        <td>${Math.round(v.q * 100)}%</td><td>${Math.round(v.rel * 100)}%</td>
        <td style="font-size:10px;color:var(--color-text-secondary)">+${Math.round(v.margin * 100)}%</td>
        <td><span class="pill ${sc}">${sl}</span></td>
        <td>${v.sc ? v.sc.toFixed(3) : "-"}</td>
      </tr>`;
    })
    .join("");
}

function updMetrics() {
  document.getElementById("mv-tot").textContent = G.vendors.length;
  document.getElementById("mv-act").textContent = G.vendors.filter((v) => v.status === "active" || v.deal).length;
  document.getElementById("mv-den").textContent = G.vendors.filter((v) => v.status === "denied").length;
  document.getElementById("mv-don").textContent = G.vendors.filter((v) => v.deal).length;
  updTopbar();
}

function updTopbar() {
  document.getElementById("sbadge").textContent = "step " + G.steps;
  const p = document.getElementById("epill");
  const s = G.confirmed ? "done" : G.running ? "run" : G.vendors.length ? "live" : "";
  const l = G.confirmed ? "Confirmed" : G.running ? "Running" : G.vendors.length ? "Ready" : "Idle";
  p.textContent = l;
  p.className = "ep" + (s ? " " + s : "");
}

function updSG() {
  const rem = G.vendors.filter((v) => v.status === "active" && !v.deal).length;
  const deals = G.vendors.filter((v) => v.deal).length;
  const bp = deals ? Math.min(...G.vendors.filter((v) => v.deal).map((v) => Number(v.accepted))) : null;
  const hd = bp !== null ? Math.round(((G.bud - bp) / Math.max(G.bud, 1)) * 100) : null;
  document.getElementById("sg-step").textContent = G.steps;
  document.getElementById("sg-rem").textContent = rem || "-";
  document.getElementById("sg-deals").textContent = deals || "-";
  document.getElementById("sg-bp").textContent = bp !== null ? "₹" + bp : "-";
  const hdEl = document.getElementById("sg-hd");
  hdEl.textContent = hd !== null ? hd + "%" : "-";
  hdEl.className = "sgv" + (hd === null ? "" : hd > 15 ? " ok" : hd > 0 ? " warn" : " bad");
  const crEl = document.getElementById("sg-cr");
  crEl.textContent = G.cumRew.toFixed(3);
  crEl.className = "sgv" + (G.cumRew > 0.2 ? " ok" : G.cumRew > -0.1 ? " warn" : " bad");
}

function updAgentPanel() {
  const box = document.getElementById("agbox");
  box.style.display = "block";
  document.getElementById("ag-bar").style.width = G.agent.r * 100 + "%";
  document.getElementById("ag-val").textContent = G.agent.r.toFixed(2);
  document.getElementById("ag-deals").textContent = G.agent.deals;
  document.getElementById("ag-over").textContent = G.agent.over;
  document.getElementById("ag-runs").textContent = G.agent.runs;
  const avg = G.agent.rewHistory.length
    ? G.agent.rewHistory.reduce((a, b) => a + b, 0) / G.agent.rewHistory.length
    : null;
  document.getElementById("ag-avg").textContent = avg !== null ? avg.toFixed(3) : "-";
  const h = G.agent.hist;
  const dEl = document.getElementById("ag-dlt");
  if (h.length >= 2) {
    const d = Number((h[h.length - 1] - h[h.length - 2]).toFixed(2));
    if (d > 0.005) {
      dEl.className = "dlt dup";
      dEl.textContent = "+" + d.toFixed(2);
    } else if (d < -0.005) {
      dEl.className = "dlt ddn";
      dEl.textContent = d.toFixed(2);
    } else {
      dEl.className = "dlt dnu";
      dEl.textContent = "±0";
    }
  } else {
    dEl.className = "dlt dnu";
    dEl.textContent = "—";
  }
  document.getElementById("ag-note").textContent =
    G.agent.r >= 0.82
      ? "High - vendors are highly cooperative"
      : G.agent.r >= 0.62
        ? "Moderate - standard vendor cooperation"
        : "Low - harder negotiations and more resistance";
  document.getElementById("ag-note").textContent += ` | R+ ${G.agent.rewardTotal.toFixed(2)} · P- ${G.agent.penaltyTotal.toFixed(2)} · net ${G.agent.netSignal.toFixed(2)} · updates ${G.agent.updates}`;
  document.getElementById("ag-dots").innerHTML = h
    .slice(-10)
    .map((rv) => `<span class="hdot" style="background:${rv >= 0.8 ? "#1D9E75" : rv >= 0.62 ? "#BA7517" : "#D85A30"};width:7px;height:7px"></span>`)
    .join("");
}

function computeResults() {
  renderResults();
}

function renderResults() {
  document.getElementById("res-ph").style.display = "none";
  document.getElementById("res-main").style.display = "block";
  document.getElementById("human-loop").style.display = "block";

  const res = [...G.vendors]
    .filter((v) => v.deal)
    .map((v) => ({ ...v, ok: Number(v.accepted) <= G.bud, sc: Number(v.sc || 0) }))
    .sort((a, b) => b.sc - a.sc);

  const taskLabel = { easy: "Easy task result", medium: "Medium task result", hard: "Hard task result" }[G.task];
  const scolor = G.task === "easy" ? "score-easy" : G.task === "medium" ? "score-med" : "score-hard";

  document.getElementById("score-banner").innerHTML = `<div class="score-banner">
    <div><div style="font-size:10px;color:var(--color-text-secondary)">${taskLabel}</div>
    <div class="score-num ${scolor}">${G.finalScore.toFixed(3)}</div></div>
    <div style="flex:1;margin:0 12px">
      <div style="height:10px;border-radius:5px;background:var(--color-border-tertiary);overflow:hidden">
        <div style="height:100%;border-radius:5px;background:${G.task === "easy" ? "#1D9E75" : G.task === "medium" ? "#534AB7" : "#D85A30"};width:${Math.round(
    G.finalScore * 100
  )}%"></div>
      </div>
      <div style="font-size:10px;color:var(--color-text-secondary);margin-top:3px">Cumulative reward: ${G.cumRew.toFixed(3)} · Steps: ${G.steps}</div>
    </div>
  </div>`;

  if (res.length >= 2) {
    const cheap = [...res].sort((a, b) => Number(a.accepted) - Number(b.accepted))[0];
    const premium = [...res].sort((a, b) => b.q - a.q)[0];
    if (cheap && premium && cheap.id !== premium.id) {
      document.getElementById("conflict-area").innerHTML = `<div class="conflict-box"><span style="font-weight:500">Trade-off detected:</span> Cost vs Quality -> resolved via weighted policy. Cheap option (${cheap.id} ₹${cheap.accepted}) vs premium option (${premium.id} ₹${premium.accepted}).</div>`;
    } else {
      document.getElementById("conflict-area").innerHTML = "";
    }
  } else {
    document.getElementById("conflict-area").innerHTML = "";
  }

  document.getElementById("ranked").innerHTML = res.length
    ? res
        .map(
          (v, i) => `<div class="rrow ${i === 0 ? "rk1" : i === 1 ? "rk2" : i === 2 ? "rk3" : ""}">
      <div class="rn">#${i + 1}</div>
      <div style="min-width:72px"><div style="font-weight:500;font-size:11px">${v.id}</div><div style="font-size:10px;color:var(--color-text-secondary)">${v.name}</div></div>
      <div style="flex:1;display:grid;grid-template-columns:repeat(4,1fr);gap:3px;font-size:11px">
        <div><div style="color:var(--color-text-secondary)">Price</div><div style="font-weight:500">₹${v.accepted}</div></div>
        <div><div style="color:var(--color-text-secondary)">Del.</div><div style="font-weight:500">${v.del}d</div></div>
        <div><div style="color:var(--color-text-secondary)">Quality</div><div style="font-weight:500">${Math.round(v.q * 100)}%</div></div>
        <div><div style="color:var(--color-text-secondary)">Rel.</div><div style="font-weight:500">${Math.round(v.rel * 100)}%</div></div>
      </div>
      <div style="text-align:right;min-width:50px"><div style="font-size:10px;color:var(--color-text-secondary)">Score</div><div style="font-weight:500;font-size:12px">${
        v.sc ? v.sc.toFixed(3) : "-"
      }</div></div>
    </div>`
        )
        .join("")
    : '<div style="font-size:11px;color:var(--color-text-secondary)">No closed deals.</div>';

  const inBudget = res.filter((v) => v.ok);
  const effB = G.steps <= 10 ? "+0.12" : G.steps <= 16 ? "+0.06" : "none";
  document.getElementById("reward-body").innerHTML = `
    <div class="irow"><span>Task difficulty</span><span style="font-weight:500">${TASKS[G.task].label}</span></div>
    <div class="irow"><span>Episode steps</span><span>${G.steps}</span></div>
    <div class="irow"><span>Deals / total vendors</span><span>${res.length} / ${G.vendors.length}</span></div>
    <div class="irow"><span>Within-budget deals</span><span>${inBudget.length}</span></div>
    <div class="irow"><span>Cumulative reward</span><span style="font-weight:500;color:${G.cumRew >= 0 ? "#1D9E75" : "#D85A30"}">${G.cumRew.toFixed(3)}</span></div>
    <div class="irow"><span>Efficiency bonus</span><span>${effB}</span></div>
    <div class="irow"><span>Final score</span><span style="font-weight:500;color:${G.finalScore >= 0.4 ? "#1D9E75" : "#D85A30"}">${G.finalScore.toFixed(3)}</span></div>`;

  renderPickList();
}

function renderPickList() {
  const closed = G.vendors
    .filter((v) => v.deal)
    .sort((a, b) => Number(b.sc || 0) - Number(a.sc || 0));

  if (!closed.length) {
    document.getElementById("pick-list").innerHTML =
      '<p style="font-size:11px;color:var(--color-text-secondary)">No eligible vendors.</p>';
    return;
  }

  // Strict top-3 recommendation guard for human override UX.
  const top = closed.slice(0, 3);
  // Don't override G.agentPickVendor here - it's set by backendAgentStep() from the actual agent action
  // Instead, check which vendor matches the agent's actual pick
  
  document.getElementById("pick-list").innerHTML = top
    .map((v, i) => {
      const isAgentPick = v.id === G.agentPickVendor;
      const overBudget = Number(v.accepted) > G.bud;
      // Agent pick gets 0 penalty, others get penalized based on rank
      const basePen = isAgentPick ? 0 : Number((0.04 + i * 0.03).toFixed(2));
      const pen = Number((basePen + (overBudget ? 0.03 : 0)).toFixed(2));
      return `<div class="vprow ${isAgentPick ? "vbest" : "vsub"}" onclick="pickV('${v.id}',${pen},${isAgentPick})">
      <div><span style="font-weight:500;font-size:12px">${v.id} - ${v.name}</span><span style="font-size:10px;color:var(--color-text-secondary);margin-left:7px">₹${v.accepted} · ${v.del}d · ${(v.sc || 0).toFixed(3)}${overBudget ? " · over budget" : ""}</span></div>
      <div>${
        isAgentPick
          ? '<span class="pill pk">agent pick</span>'
          : `<span style="font-size:10px;color:#D85A30;font-weight:500">-${pen.toFixed(2)} rating</span>`
      }</div>
    </div>`;
    })
    .join("");
}

function toggleHuman() {
  const h = document.getElementById("human-loop");
  h.style.display = h.style.display === "none" ? "block" : "none";
}

async function pickV(vid, pen, isBest) {
  if (G.confirmed) return;
  G.confirmed = true;
  const v = G.vendors.find((x) => x.id === vid && x.deal);
  if (!v) return;
  const total = Number(v.accepted) * G.qty;
  document.getElementById("conf-btn").disabled = true;
  document.getElementById("conf-btn").textContent = "Order placed";
  // Disable human override button after accept
  const overrideBtn = document.getElementById("toggle-human");
  if (overrideBtn) overrideBtn.disabled = true;
  const humanLoop = document.getElementById("human-loop");
  if (humanLoop) humanLoop.style.display = "none";
  
  document.getElementById("conf-area").innerHTML = `<div class="cbanner">
    <div style="font-weight:500;margin-bottom:3px">Order confirmed - ${v.id} (${v.name})</div>
    <div>₹${v.accepted}/kg x ${G.qty.toLocaleString()} kg = <strong>₹${total.toLocaleString()}</strong></div>
    <div style="font-size:10px;margin-top:3px">${isBest ? "Optimal selection" : "Suboptimal override"}</div>
  </div>`;

  if (!isBest) {
    G.finalScore = Number(clamp(G.finalScore - pen, 0, 1).toFixed(3));
  }
  try {
    const payload = {
      task: G.task,
      agent_vendor_id: G.agentPickVendor || vid,
      chosen_vendor_id: vid,
      penalty: Number(pen || 0),
      chosen_over_budget: Number(v.accepted) > G.bud,
    };
    console.log("[FEEDBACK] Sending payload:", payload);
    const fb = await postJsonWithFallback("/feedback", "/api/feedback", payload);
    console.log("[FEEDBACK] Received response:", fb);
    if (fb && fb.ok) {
      console.log("[FEEDBACK] Metrics before:", { r: G.agent.r, updates: G.agent.updates });
      applyPolicyMetrics(fb.policy_metrics);
      console.log("[FEEDBACK] Metrics after:", { r: G.agent.r, updates: G.agent.updates, metrics: fb.policy_metrics });
      addAF(
        "c-if",
        `Feedback learned | agent=${payload.agent_vendor_id} -> ${fb.applied.agent_q !== null ? fb.applied.agent_q.toFixed(3) : 'N/A'} | chosen=${payload.chosen_vendor_id} -> ${fb.applied.chosen_q !== null ? fb.applied.chosen_q.toFixed(3) : 'N/A'} | R+ ${G.agent.rewardTotal.toFixed(3)} / P- ${G.agent.penaltyTotal.toFixed(3)}`
      );
    } else {
      console.error("[FEEDBACK] Response not OK:", fb);
    }
  } catch (err) {
    console.error("[FEEDBACK] Error:", err);
    addAF("c-fl", `Feedback save failed: ${err.message}`);
  }
  updAgentPanel();
  updTopbar();
}

function confirmBest() {
  if (G.confirmed) return;
  
  // If agent made a recommendation, respect it
  if (G.agentPickVendor) {
    const agentPick = G.vendors.find((v) => v.id === G.agentPickVendor && v.deal);
    if (agentPick) {
      console.log("[CONFIRM-BEST] Using agent recommendation:", G.agentPickVendor);
      pickV(agentPick.id, 0, true);
      return;
    } else {
      console.log("[CONFIRM-BEST] Agent vendor not found in deals:", G.agentPickVendor);
    }
  } else {
    console.log("[CONFIRM-BEST] No agent vendor set (G.agentPickVendor is null/empty)");
  }
  
  // Fallback: pick best in-budget vendor if agent's pick is not available
  const best = G.vendors
    .filter((v) => v.deal && Number(v.accepted) <= G.bud)
    .sort((a, b) => Number(b.sc || 0) - Number(a.sc || 0))[0];
  if (!best) {
    console.log("[CONFIRM-BEST] No in-budget vendors available");
    return;
  }
  console.log("[CONFIRM-BEST] Falling back to best in-budget vendor:", best.id);
  pickV(best.id, 0, true);
}

function fullReset() {
  G.steps = 0;
  G.cumRew = 0;
  G.vendors = [];
  G.trace = [];
  G.running = false;
  G.paused = false;
  G.done = false;
  G.confirmed = false;
  G.agentPickVendor = null;
  G.pauseRes = null;

  document.getElementById("vtbody").innerHTML = "";
  document.getElementById("af").innerHTML = "";
  document.getElementById("ptrace").innerHTML =
    '<div style="color:var(--color-text-secondary);font-size:11px">Run the agent to see policy decisions.</div>';
  document.getElementById("res-main").style.display = "none";
  document.getElementById("res-ph").style.display = "block";
  document.getElementById("conf-area").innerHTML = "";
  document.getElementById("human-loop").style.display = "none";
  document.getElementById("score-banner").innerHTML = "";
  document.getElementById("conflict-area").innerHTML = "";
  document.getElementById("tab-results-btn").classList.remove("notify");
  document.getElementById("pause-btn").disabled = true;
  document.getElementById("pause-btn").textContent = "Pause";

  renderAll();
}

function renderAll() {
  renderVendors();
  updMetrics();
  updSG();
  updAgentPanel();
}

setVendorMode(true);
selectTask("easy");
renderScenarioBox();
renderAll();
