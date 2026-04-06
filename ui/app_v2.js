const TASK_CONFIGS = {
  easy: {
    budget_multiplier: 1.2,
    price_bias: 0.0,
    deny_base: 0.05,
    deny_variance: 0.05,
    noise: 0.05,
    coop_bonus: 0.15,
    description: "Most vendors active, prices near expected. Clear optimal vendor exists.",
  },
  medium: {
    budget_multiplier: 1.12,
    price_bias: 0.06,
    deny_base: 0.18,
    deny_variance: 0.12,
    noise: 0.12,
    coop_bonus: 0.0,
    description: "Several denials. Trade-offs between price, delivery and quality. No obvious pick.",
  },
  hard: {
    budget_multiplier: 1.04,
    price_bias: 0.14,
    deny_base: 0.38,
    deny_variance: 0.18,
    noise: 0.18,
    coop_bonus: -0.15,
    description: "Most vendors deny. Quotes near/over budget. Quality vs cost conflict. No perfect answer.",
  },
};

const VENDOR_CATALOGUE = [
  // Keep in sync with my_env_v4.py VENDOR_CATALOGUE.
  { id: "V1", name: "AgriFirst", base_price: 182, delivery_days: 4, quality: 0.88, reliability: 0.86, margin: 0.2, archetype: "balanced" },
  { id: "V2", name: "CropKing", base_price: 165, delivery_days: 3, quality: 0.79, reliability: 0.76, margin: 0.18, archetype: "cheap-fast" },
  { id: "V3", name: "HarvestPro", base_price: 205, delivery_days: 5, quality: 0.93, reliability: 0.91, margin: 0.15, archetype: "premium" },
  { id: "V4", name: "GrainCo", base_price: 198, delivery_days: 2, quality: 0.85, reliability: 0.83, margin: 0.13, archetype: "fast" },
  { id: "V5", name: "PrimeFarm", base_price: 168, delivery_days: 5, quality: 0.77, reliability: 0.74, margin: 0.12, archetype: "cheap" },
  { id: "V6", name: "SeedTech", base_price: 158, delivery_days: 3, quality: 0.72, reliability: 0.68, margin: 0.1, archetype: "cheap-fast" },
  { id: "V7", name: "BulkAgri", base_price: 150, delivery_days: 6, quality: 0.67, reliability: 0.62, margin: 0.09, archetype: "bulk" },
  { id: "V8", name: "NatFoods", base_price: 208, delivery_days: 3, quality: 0.89, reliability: 0.85, margin: 0.08, archetype: "premium-fast" },
  { id: "V9", name: "EcoGrain", base_price: 172, delivery_days: 4, quality: 0.82, reliability: 0.79, margin: 0.07, archetype: "balanced" },
  { id: "V10", name: "QuickCrop", base_price: 155, delivery_days: 5, quality: 0.71, reliability: 0.67, margin: 0.06, archetype: "cheap" },
];

const MAX_STEPS = 24;
const API_BASE = window.location.origin;

const R = () => Math.random();
const rng = (a, b) => a + R() * (b - a);
const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchJson = async (path, options = {}) => {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
};

const mapVendorFromObs = (v) => {
  const quality = Number(v.quality_score ?? 0);
  const reliability = Number(v.reliability_score ?? 0);
  return {
    id: v.vendor_id,
    vendor_id: v.vendor_id,
    name: v.name,
    quote_price: Number(v.quote_price ?? 0),
    accepted_price: v.accepted_price,
    base_price: Number(v.base_price ?? 0),
    delivery_days: Number(v.delivery_days ?? 0),
    quality,
    reliability,
    quality_score: quality,
    reliability_score: reliability,
    negotiation_margin: Number(v.negotiation_margin ?? 0),
    margin: Number(v.negotiation_margin ?? 0),
    status: v.status,
    deal: v.status === "deal_closed",
    negotiation_attempts: Number(v.negotiation_attempts ?? 0),
    rank_score: Number(v.rank_score ?? 0),
    archetype: v.archetype || "unknown",
    rating: parseFloat(cl(quality * 0.5 + reliability * 0.5, 0.1, 1).toFixed(2)),
    rating_hist: [],
    stubborn: 0.5,
  };
};

const syncFromResult = (result) => {
  const obs = result.observation || result;
  G.step = Number(obs.step_number ?? G.step);
  G.cumRew = Number(obs.cumulative_reward ?? G.cumRew);
  G.bud = Number(obs.budget_per_kg ?? G.bud);
  G.exp = Number(obs.expected_price ?? G.exp);
  G.qty = Number(obs.quantity_kg ?? G.qty);
  G.item = obs.item_name || G.item;
  G.task = obs.task_difficulty || G.task;
  G.vendors = (obs.vendors || []).map(mapVendorFromObs);
  return {
    reward: Number(result?.reward?.value ?? result.reward ?? 0),
    done: Boolean(result.done),
    score: Number(result?.info?.final_score ?? result.score ?? 0),
    error: result?.info?.last_action_error || null,
  };
};

let G = {
  task: "easy",
  item: "Rice",
  exp: 180,
  bud: 216,
  qty: 1000,
  spd: 380,
  step: 0,
  cumRew: 0,
  vendors: [],
  results: [],
  trace: [],
  running: false,
  paused: false,
  confirmed: false,
  pauseRes: null,
  agent: {
    r: 0.7,
    deals: 0,
    over: 0,
    runs: 0,
    rewHistory: [],
    hist: [0.7],
  },
};

function selectTask(t) {
  G.task = t;
  ["easy", "medium", "hard"].forEach((k) => {
    const el = document.getElementById("tc-" + k);
    el.className = "tc" + (k === t ? " sel" : "");
  });
  updateBudget();
}

function updateBudget() {
  const exp = parseFloat(document.getElementById("f-exp").value) || 180;
  G.exp = exp;
  G.bud = Math.round(exp * TASK_CONFIGS[G.task].budget_multiplier);
  document.getElementById("f-bud").value = G.bud;
}

function mkVendors() {
  const t = TASK_CONFIGS[G.task];
  return VENDOR_CATALOGUE.map((cat, i) => {
    const noise = rng(-t.noise, t.noise);
    const bias = t.price_bias * (0.5 + R() * 0.5);
    const quote = Math.round(cat.base_price * (1 + noise + bias));
    const denyP = cl(
      t.deny_base + (1 - cat.reliability) * t.deny_variance + (R() < 0.15 ? 0.12 : 0),
      0,
      0.85
    );
    const denied = R() < denyP;
    const baseRating = cl(cat.quality * 0.45 + cat.reliability * 0.35 + rng(-0.05, 0.05), 0.1, 1.0);
    const stubborn = rng(0.3 + t.deny_base * 0.5, 0.7 + t.deny_base * 0.5);
    return {
      ...cat,
      quote_price: quote,
      accepted_price: null,
      status: denied ? "denied" : "active",
      deal: false,
      rating: parseFloat(baseRating.toFixed(2)),
      rating_hist: [parseFloat(baseRating.toFixed(2))],
      stubborn,
      negotiation_attempts: 0,
    };
  });
}

function calcScore(v) {
  const done = G.vendors.filter((x) => x.deal);
  if (!done.length) return 0;
  const minP = Math.min(...done.map((x) => x.accepted_price));
  const minD = Math.min(...G.vendors.filter((x) => x.status !== "denied").map((x) => x.delivery_days), 99);
  const p = v.accepted_price;
  const priceFrac = Math.abs(p - G.exp) / Math.max(G.exp, 1);
  let sc = 0.35 * (minP / p) + 0.2 * (minD / v.delivery_days) + 0.25 * v.quality + 0.2 * v.reliability;
  if (v.quality < 0.75) sc -= 0.15;
  if (v.archetype === "bulk") sc -= 0.05;
  sc -= 0.04 * (Math.min(G.step, 14) * 0.06);
  sc -= 0.08 * priceFrac;
  sc += rng(-0.018, 0.018);
  return parseFloat(cl(sc, 0, 1).toFixed(3));
}

function agentPolicy() {
  const avail = G.vendors.filter((v) => v.status === "active" && !v.deal);
  if (!avail.length) return { action: "done", target: null, reason: "All vendors processed" };

  avail.sort((a, b) => {
    const ua = 0.38 * (G.bud / Math.max(a.quote_price, 1)) + 0.28 * a.reliability + 0.22 * a.quality + 0.12 * (6 / (a.delivery_days + 1));
    const ub = 0.38 * (G.bud / Math.max(b.quote_price, 1)) + 0.28 * b.reliability + 0.22 * b.quality + 0.12 * (6 / (b.delivery_days + 1));
    return ub - ua;
  });

  const target = avail[0];
  const bpRatio = target.quote_price / G.bud;
  let reason = "";
  if (bpRatio <= 0.92) reason = `Quote ₹${target.quote_price} well within budget — standard negotiation`;
  else if (bpRatio <= 1.0) reason = `Quote ₹${target.quote_price} near budget — firm counter-offer strategy`;
  else reason = `Quote ₹${target.quote_price} exceeds budget ₹${G.bud} — margin-cap required`;

  const t = TASK_CONFIGS[G.task];
  const conflictSignals = G.task === "easy" ? 0 : G.task === "medium" ? 1 : 2;
  if (conflictSignals > 0 && target.quality < 0.75 && target.reliability < 0.75)
    reason += " [quality-cost conflict detected]";

  return { action: "negotiate", target, reason };
}

function addAF(cls, msg) {
  const el = document.getElementById("af");
  const d = document.createElement("div");
  d.className = "afl " + cls;
  d.textContent = "[s" + G.step + "] " + msg;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}

function addRew(delta, why) {
  G.cumRew = parseFloat(cl(G.cumRew + delta, -3, 3).toFixed(3));
  addAF("c-if", "REWARD " + (delta >= 0 ? "+" : "") + delta.toFixed(3) + " → " + G.cumRew.toFixed(3) + " (" + why + ")");
  updSG();
}

function addTrace(v, action, reason, score) {
  G.trace.push({ step: G.step, vid: v.id, action, reason, score });
}

function bumpAgent(d) {
  G.agent.r = parseFloat(cl(G.agent.r + d, 0.1, 1.0).toFixed(2));
  G.agent.hist.push(G.agent.r);
  updAgentPanel();
}

function bumpVendor(v, ok) {
  v.rating = parseFloat(cl(v.rating + (ok ? 0.025 : -0.035), 0.1, 1).toFixed(2));
  v.rating_hist.push(v.rating);
  v.quality = parseFloat(cl(v.quality + (ok ? 0.003 : -0.003), 0.1, 1).toFixed(3));
  v.reliability = parseFloat(cl(v.reliability + (ok ? 0.003 : -0.006), 0.1, 1).toFixed(3));
}

async function negotiateV(v) {
  G.step++;
  v.status = "negotiating";
  v.negotiation_attempts++;
  renderVendors();
  updMetrics();
  updSG();

  const t = TASK_CONFIGS[G.task];
  const maxCap = Math.round(G.exp * (1 + v.margin));
  const agBonus = G.agent.r >= 0.8 ? 0.1 : G.agent.r <= 0.55 ? -0.1 : 0;

  addAF("c-ag", `ACTION negotiate(${v.id}) arch:${v.archetype} quote:₹${v.quote_price} stub:${v.stubborn.toFixed(2)}`);
  await delay(G.spd);

  if (v.quote_price <= G.exp) {
    v.accepted_price = v.quote_price;
    v.deal = true;
    v.status = "active";
    bumpVendor(v, true);
    bumpAgent(0.03);
    G.agent.deals++;
    addRew(0.22, "immediate accept — quote ≤ expected");
    addAF("c-ok", `DEAL ${v.id} ₹${v.quote_price} — immediate close`);
    addTrace(v, "immediate_accept", "Quote ≤ expected price", calcScore(v));
    renderVendors();
    updMetrics();
    return;
  }

  // Multi-step counter-offer loop
  const offers = [
    G.exp,
    Math.round((G.exp + v.quote_price) / 2),
    Math.round(v.quote_price * 0.97),
    v.quote_price,
  ];

  for (let i = 0; i < offers.length; i++) {
    if (G.paused) await new Promise((r) => {
      G.pauseRes = r;
    });

    G.step++;
    const offer = offers[i];
    addAF("c-ag", `ACTION counter_offer(${v.id}, ₹${offer}) step ${i + 1}/4`);
    await delay(G.spd * 0.85);
    updSG();

    const floor = Math.round(v.quote_price * (0.87 - v.margin * 0.28 * v.stubborn));
    const nfloor = Math.round(floor * (1 + rng(-0.05, 0.05)));

    if (offer >= nfloor) {
      v.accepted_price = offer;
      v.deal = true;
      v.status = "active";
      bumpVendor(v, true);
      bumpAgent(0.025);
      G.agent.deals++;
      const rw = parseFloat((0.16 - i * 0.025 + agBonus * 0.04 + t.coop_bonus * 0.3).toFixed(3));
      addRew(rw, "deal at step " + (i + 1));
      addAF("c-ok", `DEAL ${v.id} ₹${offer} step ${i + 1}`);
      addTrace(v, "negotiated", "Offer ≥ floor ₹" + nfloor, calcScore(v));
      renderVendors();
      updMetrics();
      return;
    }

    addAF("c-fl", `${v.id} rejects ₹${offer} — floor ₹${nfloor}`);
    await delay(G.spd * 0.6);
  }

  // Settled at quote if all offers rejected
  v.accepted_price = v.quote_price;
  v.deal = true;
  v.status = "active";
  bumpVendor(v, true);
  bumpAgent(0.01);
  G.agent.deals++;
  addRew(0.06, "settled at quote");
  addAF("c-ok", `DEAL ${v.id} settled ₹${v.quote_price}`);
  addTrace(v, "quote_settle", "Negotiation exhausted → quote price", calcScore(v));
  renderVendors();
  updMetrics();
}

let agentRunning = false;

async function runEpisode() {
  agentRunning = true;
  G.running = true;
  document.getElementById("pause-btn").disabled = false;
  updTopbar();

  addAF("c-if", `=== Episode start · task:${G.task} · budget ₹${G.bud} · vendors:${G.vendors.filter((v) => v.status !== "denied").length} active ===`);

  while (true) {
    if (G.paused)
      await new Promise((r) => {
        G.pauseRes = r;
      });

    const pol = agentPolicy();
    if (pol.action === "done") break;

    addAF("c-sy", "POLICY: " + pol.reason);
    const action = {
      action_type: "negotiate",
      vendor_id: pol.target.id,
      offer_price: G.exp,
      reasoning: pol.reason,
    };
    const stepResult = await fetchJson("/api/step", {
      method: "POST",
      body: JSON.stringify(action),
    });
    const meta = syncFromResult(stepResult);
    addAF("c-ag", `ACTION negotiate(${pol.target.id}) offer:₹${G.exp}`);
    addAF("c-if", `STEP reward ${meta.reward >= 0 ? "+" : ""}${meta.reward.toFixed(3)} · cum ${G.cumRew.toFixed(3)}`);
    if (meta.error) addAF("c-fl", `ERROR ${meta.error}`);

    renderVendors();
    updMetrics();
    updSG();
    updAgentPanel();

    await delay(G.spd * 0.3);

    if (meta.done) break;
  }

  if (G.vendors.some((x) => x.deal) && G.vendors.some((x) => x.status === "active" && !x.deal)) {
    const fin = await fetchJson("/api/step", {
      method: "POST",
      body: JSON.stringify({ action_type: "finalize", vendor_id: null, offer_price: null, reasoning: "Finalize from UI" }),
    });
    syncFromResult(fin);
  }

  agentRunning = false;
  G.running = false;
  document.getElementById("pause-btn").disabled = true;
  addAF("c-if", `=== Episode done · steps:${G.step} · cumulative reward:${G.cumRew.toFixed(3)} ===`);

  computeResults();
  document.getElementById("tab-results-btn").classList.add("notify");
  gTab("results", document.getElementById("tab-results-btn"));
  updTopbar();
}

async function runAgent() {
  if (agentRunning) return;

  G.item = document.getElementById("f-item").value || "Item";
  G.exp = parseFloat(document.getElementById("f-exp").value) || 180;
  G.bud = parseFloat(document.getElementById("f-bud").value) || 216;
  G.qty = parseInt(document.getElementById("f-qty").value) || 1000;
  G.spd = parseInt(document.getElementById("f-spd").value) || 380;

  G.step = 0;
  G.cumRew = 0;
  G.results = [];
  G.trace = [];
  G.confirmed = false;
  G.paused = false;
  G.agent.runs++;
  G.agent.deals = 0;
  G.agent.over = 0;

  try {
    const resetResult = await fetchJson("/api/reset", {
      method: "POST",
      body: JSON.stringify({
        task: G.task,
        item: G.item,
        expected_price: G.exp,
        quantity_kg: G.qty,
      }),
    });
    syncFromResult(resetResult);
  } catch (err) {
    addAF("c-fl", `Backend unavailable: ${err.message}`);
    alert("Backend API not reachable. Start it with: uvicorn app:app --host 127.0.0.1 --port 8000");
    return;
  }

  document.getElementById("af").innerHTML = "";
  document.getElementById("ptrace").innerHTML = "";
  document.getElementById("res-main").style.display = "none";
  document.getElementById("res-ph").style.display = "block";
  document.getElementById("conf-area").innerHTML = "";
  document.getElementById("human-loop").style.display = "none";
  document.getElementById("conf-btn").disabled = false;
  document.getElementById("conf-btn").textContent = "Accept agent recommendation";

  renderVendors();
  updMetrics();
  updAgentPanel();
  updSG();

  gTab("agent", document.querySelectorAll(".tab")[1]);
  await runEpisode();
}

function pauseResume() {
  G.paused = !G.paused;
  document.getElementById("pause-btn").textContent = G.paused ? "Resume" : "Pause";
  if (!G.paused && G.pauseRes) {
    G.pauseRes();
    G.pauseRes = null;
  }
}

function computeResults() {
  const done = G.vendors
    .filter((v) => v.deal)
    .map((v) => ({ ...v, sc: Number(v.rank_score || 0), ok: v.accepted_price <= G.bud }));
  const denied = G.vendors.filter((v) => !v.deal && v.status === "denied").map((v) => ({ ...v, sc: 0, ok: false }));
  G.results = [...done.sort((a, b) => b.sc - a.sc), ...denied];

  const best = G.results.find((v) => v.ok && v.deal);
  const eff = G.step <= 10 ? 0.12 : G.step <= 16 ? 0.06 : 0;
  const finalRew = best ? parseFloat(cl(best.sc + eff, 0, 1).toFixed(3)) : -0.25;

  G.agent.reward = finalRew;
  G.agent.rewHistory.push(finalRew);

  const avg = G.agent.rewHistory.length
    ? parseFloat((G.agent.rewHistory.reduce((a, b) => a + b, 0) / G.agent.rewHistory.length).toFixed(3))
    : null;
  document.getElementById("ag-avg").textContent = avg !== null ? avg.toFixed(3) : "—";

  renderResults();
}

function renderResults() {
  document.getElementById("res-ph").style.display = "none";
  document.getElementById("res-main").style.display = "block";

  const res = G.results;
  const best = res.find((v) => v.ok && v.deal);
  const t = TASK_CONFIGS[G.task];

  const allDenied = G.vendors.every((v) => v.status === "denied");
  const allOver = res.filter((v) => v.deal).length > 0 && res.filter((v) => v.deal).every((v) => !v.ok);

  const scoreVal = G.agent.reward || 0;
  const scolor = G.task === "easy" ? "score-easy" : G.task === "medium" ? "score-med" : "score-hard";
  const taskLabel = { easy: "Easy task result", medium: "Medium task result", hard: "Hard task result" }[G.task];

  document.getElementById("score-banner").innerHTML = `<div class="score-banner">
    <div>
      <div style="font-size: 10px; color: var(--color-text-secondary)">${taskLabel}</div>
      <div class="score-num ${scolor}">${scoreVal.toFixed(3)}</div>
    </div>
    <div style="flex: 1; margin: 0 12px">
      <div style="height: 10px; border-radius: 5px; background: var(--color-border-tertiary); overflow: hidden">
        <div style="height: 100%; border-radius: 5px; background: ${
          G.task === "easy" ? "#1d9e75" : G.task === "medium" ? "#534ab7" : "#d85a30"
        }; width: ${Math.round(scoreVal * 100)}%; transition: width 0.5s"></div>
      </div>
      <div style="font-size: 10px; color: var(--color-text-secondary); margin-top: 3px">
        Cumulative reward: ${G.cumRew.toFixed(3)} · Steps: ${G.step}
      </div>
    </div>
  </div>`;

  const conflictSignals = G.task === "easy" ? 0 : G.task === "medium" ? 1 : 2;
  if (conflictSignals > 0) {
    const cheapLowQ = G.vendors.filter((v) => v.deal && v.quality < 0.76 && v.accepted_price < G.exp * 1.05);
    const expHighQ = G.vendors.filter((v) => v.deal && v.quality > 0.85 && v.accepted_price > G.exp * 1.12);
    if (cheapLowQ.length && expHighQ.length) {
      document.getElementById("conflict-area").innerHTML = `<div class="conflict-box">
        <span style="font-weight: 600">Conflict detected:</span> Cheap (${cheapLowQ[0].id} ₹${cheapLowQ[0].accepted_price}, quality ${Math.round(cheapLowQ[0].quality * 100)}%) vs Premium (${expHighQ[0].id} ₹${expHighQ[0].accepted_price}, quality ${Math.round(expHighQ[0].quality * 100)}%).
      </div>`;
    } else {
      document.getElementById("conflict-area").innerHTML = "";
    }
  } else {
    document.getElementById("conflict-area").innerHTML = "";
  }

  const ra = document.getElementById("rec-area");
  if (allDenied) {
    ra.innerHTML = `<div class="recbox rb-fail"><div style="font-size: 13px; font-weight: 600; color: #ef9f27; margin-bottom: 3px">No suppliers — all denied</div><div style="font-size: 11px; color: #ef9f27">All vendors declined. Valid RL terminal state.</div></div>`;
  } else if (allOver) {
    const cl2 = [...res].filter((v) => v.deal).sort((a, b) => a.accepted_price - b.accepted_price)[0];
    ra.innerHTML = `<div class="recbox rb-warn"><div style="font-size: 13px; font-weight: 600; color: #ef9f27; margin-bottom: 3px">All deals exceed budget</div><div style="font-size: 11px; color: #ef9f27">Best-effort: <b>${cl2.id}</b> at ₹${cl2.accepted_price}/kg.</div></div>`;
  } else if (best) {
    const saving = (G.bud - best.accepted_price) * G.qty;
    ra.innerHTML = `<div class="recbox rb-ok">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; flex-wrap: wrap">
        <div>
          <div style="font-size: 13px; font-weight: 600; color: #5dcaa5; margin-bottom: 3px">Agent recommends: ${best.id} — ${best.name}</div>
          <div style="font-size: 11px; color: #5dcaa5; margin-bottom: 6px">Highest multi-factor score · archetype: ${best.archetype}</div>
          <div>${["₹" + best.accepted_price + "/kg", "Del. " + best.delivery_days + "d", "Quality " + Math.round(best.quality * 100) + "%", "Score " + best.sc.toFixed(3)]
            .map((c) => `<span class="chip" style="background: #053320; color: #5dcaa5; border-color: #1d9e75">${c}</span>`)
            .join("")}</div>
        </div>
        <div style="text-align: right">
          <div style="font-size: 10px; color: #5dcaa5; font-weight: 600">Savings</div>
          <div style="font-size: 20px; font-weight: 600; color: #1d9e75">₹${saving.toLocaleString()}</div>
          <div style="font-size: 10px; color: #5dcaa5">${G.qty.toLocaleString()} kg</div>
        </div>
      </div>
    </div>`;
  } else {
    ra.innerHTML = "";
  }

  const el = G.results.filter((v) => v.deal && v.ok);
  document.getElementById("ranked").innerHTML = res
    .map((v, i) => {
      if (!v.deal)
        return `<div class="rrow" style="opacity: 0.4"><div class="rn">—</div><div style="font-size: 11px; font-weight: 600; flex: 1">${v.id} — ${v.name}</div><span class="pill pd">denied</span></div>`;

      const ei = el.indexOf(v);
      const cls = ei === 0 ? "rk1" : ei === 1 ? "rk2" : ei === 2 ? "rk3" : "";

      return `<div class="rrow ${cls}">
        <div class="rn">#${i + 1}</div>
        <div style="min-width: 72px"><div style="font-weight: 600; font-size: 11px">${v.id}</div><div style="font-size: 10px; color: var(--color-text-secondary)">${v.name}</div></div>
        <div style="flex: 1; display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; font-size: 11px">
          <div><div style="color: var(--color-text-secondary)">Price</div><div style="font-weight: 600">₹${v.accepted_price}</div></div>
          <div><div style="color: var(--color-text-secondary)">Del.</div><div style="font-weight: 600">${v.delivery_days}d</div></div>
          <div><div style="color: var(--color-text-secondary)">Quality</div><div style="font-weight: 600">${Math.round(v.quality * 100)}%</div></div>
          <div><div style="color: var(--color-text-secondary)">Rel.</div><div style="font-weight: 600">${Math.round(v.reliability * 100)}%</div></div>
        </div>
        <div style="text-align: right; min-width: 50px">
          <div style="font-size: 10px; color: var(--color-text-secondary)">Score</div>
          <div style="font-weight: 600; font-size: 12px">${v.sc.toFixed(3)}</div>
        </div>
        ${!v.ok ? '<span class="pill pd" style="margin-left: 4px; flex-shrink: 0">over budget</span>' : ""}
      </div>`;
    })
    .join("");

  renderPickList();
}

function renderPickList() {
  const el = G.results.filter((v) => v.deal && v.ok);
  if (!el.length) {
    document.getElementById("pick-list").innerHTML = '<p style="font-size: 11px; color: var(--color-text-secondary)">No eligible vendors.</p>';
    return;
  }

  const best = el[0];
  document.getElementById("pick-list").innerHTML = el
    .map((v, i) => {
      const isBest = i === 0;
      const pen = isBest ? 0 : parseFloat((0.04 + i * 0.03 + (v.sc < best.sc - 0.1 ? 0.05 : 0)).toFixed(2));

      return `<div class="vprow ${isBest ? "vbest" : ""}" onclick="pickV('${v.id}', ${pen}, ${isBest})">
        <div><span style="font-weight: 600; font-size: 12px">${v.id} — ${v.name}</span><span style="font-size: 10px; color: var(--color-text-secondary); margin-left: 7px">₹${v.accepted_price} · ${v.delivery_days}d · ${v.archetype}</span></div>
        <div>${isBest ? '<span class="pill pa">agent pick</span>' : `<span style="font-size: 10px; color: #d85a30; font-weight: 600">−${pen.toFixed(2)} rating</span>`}</div>
      </div>`;
    })
    .join("");
}

function toggleHuman() {
  const h = document.getElementById("human-loop");
  h.style.display = h.style.display === "none" ? "block" : "none";
}

function pickV(vid, pen, isBest) {
  if (G.confirmed) return;

  G.confirmed = true;
  const v = G.results.find((x) => x.id === vid);
  if (!v) return;

  const total = v.accepted_price * G.qty;
  document.getElementById("conf-btn").disabled = true;
  document.getElementById("conf-btn").textContent = "Order placed";
  document.getElementById("conf-area").innerHTML = `<div class="cbanner">
    <div style="font-weight: 600; margin-bottom: 3px">Order confirmed — ${v.id} (${v.name})</div>
    <div>₹${v.accepted_price}/kg × ${G.qty.toLocaleString()} kg = <strong>₹${total.toLocaleString()}</strong></div>
    <div style="font-size: 10px; margin-top: 3px">${isBest ? "Optimal selection → agent +0.04" : "Suboptimal override → agent −" + pen.toFixed(2)}</div>
  </div>`;

  if (isBest) {
    bumpAgent(0.04);
    G.agent.deals++;
  } else {
    bumpAgent(-pen);
    G.agent.over++;
    G.agent.reward = parseFloat(cl((G.agent.reward || 0) - pen, -1, 1).toFixed(3));
  }

  const src = G.vendors.find((x) => x.id === vid);
  if (src) bumpVendor(src, true);

  renderVendors();
  updAgentPanel();
  updTopbar();
}

function confirmBest() {
  if (G.confirmed) return;
  const best = G.results.find((v) => v.ok && v.deal);
  if (!best) return;
  pickV(best.id, 0, true);
}

function renderVendors() {
  const sorted = [...G.vendors].sort((a, b) => {
    const sa = a.quality * 0.4 + a.reliability * 0.3 + a.rating * 0.2 + (a.deal ? 0.1 : 0);
    const sb = b.quality * 0.4 + b.reliability * 0.3 + b.rating * 0.2 + (b.deal ? 0.1 : 0);
    return sb - sa;
  });

  document.getElementById("vtbody").innerHTML = sorted
    .map((v, i) => {
      const pc = v.accepted_price ? `<span style="font-weight: 600; color: #5dcaa5">₹${v.accepted_price}</span>` : `₹${v.quote_price}`;
      const sc = v.deal ? "pa" : v.status === "denied" ? "pd" : v.status === "negotiating" ? "pn" : "pw";
      const sl = v.deal ? "deal done" : v.status === "denied" ? "denied" : v.status === "negotiating" ? "negotiating" : "pending";

      return `<tr>
        <td style="color: var(--color-text-secondary); font-size: 10px">${i + 1}</td>
        <td><div style="font-weight: 600; font-size: 11px">${v.id}</div><div style="font-size: 10px; color: var(--color-text-secondary)">${v.name}</div></td>
        <td style="font-size: 11px">${pc}</td>
        <td style="font-size: 11px">${v.delivery_days}d</td>
        <td><div style="height: 5px; border-radius: 3px; background: var(--color-border-tertiary); overflow: hidden"><div style="height: 100%; border-radius: 3px; background: #1d9e75; width: ${Math.round(v.quality * 100)}%"></div></div></td>
        <td><div style="height: 5px; border-radius: 3px; background: var(--color-border-tertiary); overflow: hidden"><div style="height: 100%; border-radius: 3px; background: #378add; width: ${Math.round(v.reliability * 100)}%"></div></div></td>
        <td style="font-size: 10px; color: var(--color-text-secondary)">+${Math.round(v.margin * 100)}%</td>
        <td><span class="pill ${sc}">${sl}</span></td>
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
  document.getElementById("sbadge").textContent = "step " + G.step;
  const p = document.getElementById("epill");
  const s = G.confirmed ? "done" : G.running ? "run" : G.vendors.length ? "live" : "";
  const l = G.confirmed ? "Confirmed" : G.running ? "Running" : G.vendors.length ? "Ready" : "Idle";
  p.textContent = l;
  p.className = "ep" + (s ? " " + s : "");
}

function updSG() {
  document.getElementById("sg-step").textContent = G.step;
  const rem = G.vendors.filter((v) => v.status === "active" && !v.deal).length;
  const deals = G.vendors.filter((v) => v.deal).length;
  const bp = deals ? Math.min(...G.vendors.filter((v) => v.deal).map((v) => v.accepted_price)) : null;
  const hd = bp ? Math.round(((G.bud - bp) / G.bud) * 100) : null;

  document.getElementById("sg-rem").textContent = rem || "—";
  document.getElementById("sg-deals").textContent = deals || "—";
  document.getElementById("sg-bp").textContent = bp ? "₹" + bp : "—";

  const hdEl = document.getElementById("sg-hd");
  hdEl.textContent = hd !== null ? hd + "%" : "—";
  hdEl.className = "sgv" + (hd === null ? "" : hd > 15 ? " ok" : hd > 0 ? " warn" : " bad");

  const crEl = document.getElementById("sg-cr");
  crEl.textContent = G.cumRew.toFixed(3);
  crEl.className = "sgv" + (G.cumRew > 0.2 ? " ok" : G.cumRew > -0.1 ? " warn" : " bad");
}

function updAgentPanel() {
  const box = document.getElementById("agbox");
  box.style.display = "block";

  const r = G.agent.r;
  document.getElementById("ag-bar").style.width = r * 100 + "%";
  document.getElementById("ag-val").textContent = r.toFixed(2);
  document.getElementById("ag-deals").textContent = G.agent.deals;
  document.getElementById("ag-over").textContent = G.agent.over;
  document.getElementById("ag-runs").textContent = G.agent.runs;

  const h = G.agent.hist;
  if (h.length >= 2) {
    const d = parseFloat((h[h.length - 1] - h[h.length - 2]).toFixed(2));
    const dEl = document.getElementById("ag-dlt");
    if (d > 0.005) {
      dEl.className = "pill";
      dEl.style.background = "#053320";
      dEl.style.color = "#5dcaa5";
      dEl.textContent = "+" + d.toFixed(2);
    } else if (d < -0.005) {
      dEl.className = "pill";
      dEl.style.background = "#3d2315";
      dEl.style.color = "#f0997b";
      dEl.textContent = d.toFixed(2);
    } else {
      dEl.className = "pill";
      dEl.style.background = "#1a1a28";
      dEl.style.color = "#5a5a85";
      dEl.textContent = "±0";
    }
  }

  document.getElementById("ag-note").textContent =
    r >= 0.82 ? "High reputation — vendors more cooperative" : r >= 0.62 ? "Moderate reputation" : "Low reputation — vendors less flexible";
}

function gTab(id, el) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  el.classList.add("active");

  const panelId = id === "env" ? "tab-env" : id === "agent" ? "tab-agent" : id === "vendors" ? "tab-vendors" : id === "results" ? "tab-results" : null;
  if (panelId) document.getElementById(panelId).classList.add("active");
}

function fullReset() {
  G.step = 0;
  G.cumRew = 0;
  G.vendors = [];
  G.results = [];
  G.trace = [];
  G.running = false;
  G.paused = false;
  G.confirmed = false;
  G.pauseRes = null;

  document.getElementById("vtbody").innerHTML = "";
  document.getElementById("af").innerHTML = "";
  document.getElementById("ptrace").innerHTML = '<div style="color: var(--color-text-secondary); font-size: 11px">Run the agent to see policy decisions.</div>';
  document.getElementById("res-main").style.display = "none";
  document.getElementById("res-ph").style.display = "block";
  document.getElementById("conf-area").innerHTML = "";
  document.getElementById("human-loop").style.display = "none";
  document.getElementById("score-banner").innerHTML = "";
  document.getElementById("conflict-area").innerHTML = "";
  document.getElementById("pause-btn").disabled = true;

  updMetrics();
  updSG();
  updTopbar();
}

selectTask("easy");
updAgentPanel();
updMetrics();
updSG();
