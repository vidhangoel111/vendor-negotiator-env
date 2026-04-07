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
  { id: "V1", name: "AgriFirst", base_price: 182, delivery_days: 4, quality: 0.88, reliability: 0.86, margin: 0.2 },
  { id: "V2", name: "CropKing", base_price: 165, delivery_days: 3, quality: 0.79, reliability: 0.76, margin: 0.18 },
  { id: "V3", name: "HarvestPro", base_price: 205, delivery_days: 5, quality: 0.93, reliability: 0.91, margin: 0.15 },
  { id: "V4", name: "GrainCo", base_price: 198, delivery_days: 2, quality: 0.85, reliability: 0.83, margin: 0.13 },
  { id: "V5", name: "PrimeFarm", base_price: 168, delivery_days: 5, quality: 0.77, reliability: 0.74, margin: 0.12 },
  { id: "V6", name: "SeedTech", base_price: 158, delivery_days: 3, quality: 0.72, reliability: 0.68, margin: 0.1 },
  { id: "V7", name: "BulkAgri", base_price: 150, delivery_days: 6, quality: 0.67, reliability: 0.62, margin: 0.09 },
  { id: "V8", name: "NatFoods", base_price: 208, delivery_days: 3, quality: 0.89, reliability: 0.85, margin: 0.08 },
  { id: "V9", name: "EcoGrain", base_price: 172, delivery_days: 4, quality: 0.82, reliability: 0.79, margin: 0.07 },
  { id: "V10", name: "QuickCrop", base_price: 155, delivery_days: 5, quality: 0.71, reliability: 0.67, margin: 0.06 },
];

const MAX_STEPS = 24;
const BASE_EXPECTED_PRICE = 180;
const BASE_QTY = 1000;
const API_BASE = window.location.origin;

const ui = {
  taskSelect: document.getElementById("taskSelect"),
  vendorSelect: document.getElementById("vendorSelect"),
  offerInput: document.getElementById("offerInput"),
  resetBtn: document.getElementById("resetBtn"),
  autoStepBtn: document.getElementById("autoStepBtn"),
  autoRunBtn: document.getElementById("autoRunBtn"),
  negotiateBtn: document.getElementById("negotiateBtn"),
  acceptBtn: document.getElementById("acceptBtn"),
  skipBtn: document.getElementById("skipBtn"),
  finalizeBtn: document.getElementById("finalizeBtn"),
  facts: document.getElementById("facts"),
  dealsList: document.getElementById("dealsList"),
  logList: document.getElementById("logList"),
  vendorsGrid: document.getElementById("vendorsGrid"),
  taskBadge: document.getElementById("taskBadge"),
  stepBadge: document.getElementById("stepBadge"),
  scoreBadge: document.getElementById("scoreBadge"),
};

const state = {
  task: "easy",
  budgetPerKg: 216,
  expectedPrice: BASE_EXPECTED_PRICE,
  quantityKg: BASE_QTY,
  item: "Rice",
  vendors: [],
  step: 0,
  cumulativeReward: 0,
  done: false,
  lastActionVendorId: null,
  lastActionResult: "none",
  finalScore: 0,
  logs: [],
};

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

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

const mapVendorFromObs = (v) => ({
  vendor_id: v.vendor_id,
  name: v.name,
  quote_price: Number(v.quote_price ?? 0),
  accepted_price: v.accepted_price,
  base_price: Number(v.base_price ?? 0),
  delivery_days: Number(v.delivery_days ?? 0),
  quality_score: Number(v.quality_score ?? 0),
  reliability_score: Number(v.reliability_score ?? 0),
  negotiation_margin: Number(v.negotiation_margin ?? 0),
  status: v.status,
  negotiation_attempts: Number(v.negotiation_attempts ?? 0),
  rank_score: Number(v.rank_score ?? 0),
});

function syncFromResult(result) {
  const obs = result.observation || result || {};
  state.vendors = (obs.vendors || []).map(mapVendorFromObs);
  state.step = Number(obs.step_number ?? state.step);
  state.budgetPerKg = Number(obs.budget_per_kg ?? state.budgetPerKg);
  state.expectedPrice = Number(obs.expected_price ?? state.expectedPrice);
  state.quantityKg = Number(obs.quantity_kg ?? state.quantityKg);
  state.item = obs.item_name || state.item;
  state.task = obs.task_difficulty || state.task;
  state.lastActionVendorId = obs.last_action_vendor_id ?? state.lastActionVendorId;
  state.lastActionResult = obs.last_action_result || state.lastActionResult;
  state.cumulativeReward = Number(obs.cumulative_reward ?? state.cumulativeReward);
  state.done = Boolean(result.done ?? state.done);
  state.finalScore = Number(result?.info?.final_score ?? result.score ?? state.finalScore);
}

function findVendor(vendorId) {
  return state.vendors.find((v) => v.vendor_id === vendorId) || null;
}

function scoreVendor(vendor) {
  const deals = state.vendors.filter((v) => v.status === "deal_closed" && Number.isFinite(v.accepted_price));
  const prices = deals.map((v) => v.accepted_price);
  const minP = prices.length ? Math.min(...prices) : vendor.accepted_price;
  const priceScore = minP / Math.max(vendor.accepted_price, 1);
  const deliveryScore = 1 / (1 + vendor.delivery_days * 0.15);
  let score =
    0.35 * priceScore +
    0.2 * deliveryScore +
    0.25 * vendor.quality_score +
    0.2 * vendor.reliability_score;

  if (vendor.quality_score < 0.75) {
    score -= 0.1;
  }
  return round4(clamp(score, 0, 1));
}

function computeFinalScore() {
  const deals = state.vendors.filter((v) => v.status === "deal_closed" && Number.isFinite(v.accepted_price));
  if (!deals.length) {
    return 0;
  }
  const inBudget = deals.filter((v) => v.accepted_price <= state.budgetPerKg);
  const pool = inBudget.length ? inBudget : deals;
  const best = pool.reduce((acc, cur) => (cur.rank_score > acc.rank_score ? cur : acc), pool[0]);
  const eff = state.step <= 10 ? 0.1 : state.step <= 16 ? 0.05 : 0;
  return round4(clamp(best.rank_score * 0.9 + eff, 0, 1));
}

function buildRankedDeals() {
  return state.vendors
    .filter((v) => v.status === "deal_closed")
    .sort((a, b) => b.rank_score - a.rank_score)
    .map((v) => ({
      vendor_id: v.vendor_id,
      name: v.name,
      accepted_price: v.accepted_price,
      delivery_days: v.delivery_days,
      quality_score: v.quality_score,
      reliability_score: v.reliability_score,
      rank_score: v.rank_score,
      within_budget: v.accepted_price <= state.budgetPerKg,
    }));
}

function addLog(text, isDebug = false) {
  state.logs.unshift({ text, isDebug, ts: Date.now() });
  state.logs = state.logs.slice(0, 120);
}

function generateVendorPool() {
  const cfg = TASK_CONFIGS[state.task];
  return VENDOR_CATALOGUE.map((cat) => {
    const noise = rand(-cfg.noise, cfg.noise);
    const bias = cfg.price_bias * rand(0.5, 1.0);
    const quote = Number((cat.base_price * (1 + noise + bias)).toFixed(2));

    const denyP = Math.min(
      0.85,
      cfg.deny_base + (1 - cat.reliability) * cfg.deny_variance + (Math.random() < 0.15 ? 0.12 : 0)
    );
    const denied = Math.random() < denyP;

    return {
      vendor_id: cat.id,
      name: cat.name,
      quote_price: quote,
      base_price: Number((cat.base_price * (1 - cat.margin * 0.6)).toFixed(2)),
      delivery_days: cat.delivery_days,
      quality_score: cat.quality,
      reliability_score: cat.reliability,
      negotiation_margin: cat.margin,
      status: denied ? "denied" : "active",
      accepted_price: null,
      negotiation_attempts: 0,
      rank_score: 0,
    };
  });
}

async function initEpisode(task = state.task) {
  state.task = task;
  const cfg = TASK_CONFIGS[task];
  state.expectedPrice = BASE_EXPECTED_PRICE;
  state.quantityKg = BASE_QTY;
  state.budgetPerKg = Number((state.expectedPrice * cfg.budget_multiplier).toFixed(2));
  state.logs = [];

  try {
    const resetResult = await fetchJson("/api/reset", {
      method: "POST",
      body: JSON.stringify({
        task: state.task,
        item: state.item,
        expected_price: state.expectedPrice,
        quantity_kg: state.quantityKg,
      }),
    });
    syncFromResult(resetResult);
    addLog(`[START] task=${state.task} expected=Rs${state.expectedPrice} budget=Rs${state.budgetPerKg}`);
  } catch (err) {
    addLog(`[DEBUG] Backend unavailable: ${err.message}`, true);
    alert("Backend API not reachable. Start it with: uvicorn app:app --host 127.0.0.1 --port 8000");
  }

  render();
}

function doNegotiate(vendorId, offerPrice) {
  const vendor = findVendor(vendorId);
  if (!vendor) {
    return { reward: -0.02, err: `Vendor ${vendorId} not found` };
  }
  if (vendor.status === "denied") {
    return { reward: -0.05, err: `Vendor ${vendor.vendor_id} already denied` };
  }
  if (vendor.status === "deal_closed") {
    return { reward: -0.02, err: `Vendor ${vendor.vendor_id} already closed` };
  }

  vendor.status = "negotiating";
  vendor.negotiation_attempts += 1;
  state.lastActionVendorId = vendor.vendor_id;

  const cfg = TASK_CONFIGS[state.task];
  const offer = Number.isFinite(offerPrice) ? offerPrice : state.expectedPrice;
  const floor = vendor.base_price * (1 - vendor.negotiation_margin);
  const coop = vendor.reliability_score * (0.6 + cfg.coop_bonus * 0.4);
  const acceptP = clamp(
    coop * (1 - Math.max(0, (floor - offer) / Math.max(floor, 1)) * 1.8),
    0.05,
    0.9
  );

  if (offer >= floor && Math.random() < acceptP) {
    const finalPrice = Number(Math.min(offer, vendor.quote_price).toFixed(2));
    vendor.accepted_price = finalPrice;
    vendor.status = "deal_closed";
    vendor.rank_score = scoreVendor(vendor);
    state.lastActionResult = "accepted";

    const overBudget = finalPrice > state.budgetPerKg;
    const baseReward = overBudget ? -0.04 : 0.18;
    const negPenalty = -0.025 * Math.max(0, vendor.negotiation_attempts - 1);
    return { reward: round4(baseReward + negPenalty), err: null };
  }

  vendor.quote_price = Number((vendor.quote_price * rand(0.94, 0.99)).toFixed(2));
  vendor.status = "active";
  state.lastActionResult = "counter";
  return { reward: -0.01, err: null };
}

function doAccept(vendorId) {
  const vendor = findVendor(vendorId);
  if (!vendor) {
    return { reward: -0.02, err: `Vendor ${vendorId} not found` };
  }
  if (!(vendor.status === "active" || vendor.status === "negotiating")) {
    return { reward: -0.02, err: `Vendor ${vendor.vendor_id} not in negotiable state` };
  }

  vendor.accepted_price = vendor.quote_price;
  vendor.status = "deal_closed";
  vendor.rank_score = scoreVendor(vendor);
  state.lastActionVendorId = vendor.vendor_id;
  state.lastActionResult = "accepted";

  return { reward: vendor.accepted_price > state.budgetPerKg ? -0.08 : 0.1, err: null };
}

function doSkip(vendorId) {
  const vendor = findVendor(vendorId);
  if (!vendor) {
    return -0.01;
  }
  vendor.status = "denied";
  state.lastActionVendorId = vendor.vendor_id;
  state.lastActionResult = "denied";
  return -0.03;
}

function finalizeReward() {
  const deals = state.vendors.filter((v) => v.status === "deal_closed");
  if (!deals.length) {
    return -0.3;
  }

  const best = deals.reduce((acc, cur) => (cur.rank_score > acc.rank_score ? cur : acc), deals[0]);
  const effBonus = state.step <= 10 ? 0.12 : state.step <= 16 ? 0.06 : 0;

  let reward;
  if (best.accepted_price <= state.budgetPerKg) {
    const savingFrac = (state.budgetPerKg - best.accepted_price) / state.budgetPerKg;
    reward = best.rank_score * 0.7 + savingFrac * 0.3 + effBonus;
  } else {
    const overFrac = (best.accepted_price - state.budgetPerKg) / state.budgetPerKg;
    reward = best.rank_score * 0.5 - overFrac * 0.4 + effBonus * 0.5;
  }
  return clamp(round4(reward), -1, 1);
}

function activeCount() {
  return state.vendors.filter((v) => v.status === "active").length;
}

async function applyAction(actionType, vendorId, offerPrice) {
  if (state.done) {
    addLog("[DEBUG] Episode already done. Start a new episode.", true);
    render();
    return;
  }

  try {
    const result = await fetchJson("/api/step", {
      method: "POST",
      body: JSON.stringify({
        action_type: actionType,
        vendor_id: vendorId,
        offer_price: offerPrice,
        reasoning: "UI action",
      }),
    });

    syncFromResult(result);
    const reward = Number(result?.reward?.value ?? result.reward ?? 0);
    const error = result?.info?.last_action_error || null;
    const safeOffer = Number.isFinite(offerPrice) ? offerPrice : "None";
    const line = `[STEP] step=${state.step} action=${actionType}(vendor=${vendorId || "None"},offer=${safeOffer}) reward=${reward.toFixed(
      2
    )} done=${String(state.done)} error=${error || "null"}`;
    addLog(line);

    if (error) {
      addLog(`[DEBUG] ${error}`, true);
    }

    if (state.done) {
      addLog(
        `[END] success=${String(state.finalScore >= 0.4)} steps=${state.step} score=${state.finalScore.toFixed(3)}`
      );
    }
  } catch (err) {
    addLog(`[DEBUG] API call failed: ${err.message}`, true);
  }

  render();
}

function heuristicDecision() {
  const active = state.vendors.filter((v) => v.status === "active");
  if (!active.length) {
    return { actionType: "finalize", vendorId: null, offerPrice: null };
  }
  const best = active.reduce((acc, cur) => {
    const priceOk = cur.quote_price <= state.budgetPerKg ? 1 : 0.5;
    const sc = priceOk * 0.4 + cur.quality_score * 0.35 + cur.reliability_score * 0.25;
    if (!acc || sc > acc.sc) {
      return { vendor: cur, sc };
    }
    return acc;
  }, null).vendor;

  const offer = Math.min(state.expectedPrice, best.quote_price * 0.97);
  return {
    actionType: "negotiate",
    vendorId: best.vendor_id,
    offerPrice: Number(offer.toFixed(2)),
  };
}

function renderFacts() {
  const rankedDeals = buildRankedDeals();
  ui.facts.innerHTML = "";

  const facts = [
    ["Budget", `Rs${state.budgetPerKg}/kg`],
    ["Expected", `Rs${state.expectedPrice}/kg`],
    ["Quantity", `${state.quantityKg.toLocaleString()} kg`],
    ["Cumulative Reward", state.cumulativeReward.toFixed(4)],
    ["Active Vendors", String(activeCount())],
    ["Closed Deals", String(rankedDeals.length)],
    ["Last Vendor", state.lastActionVendorId || "N/A"],
    ["Last Result", state.lastActionResult],
  ];

  facts.forEach(([k, v]) => {
    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = k;
    dd.textContent = v;
    wrap.appendChild(dt);
    wrap.appendChild(dd);
    ui.facts.appendChild(wrap);
  });
}

function renderDeals() {
  const rankedDeals = buildRankedDeals();
  ui.dealsList.innerHTML = "";
  if (!rankedDeals.length) {
    const empty = document.createElement("div");
    empty.className = "deal-item";
    empty.textContent = "No deals closed yet.";
    ui.dealsList.appendChild(empty);
    return;
  }

  rankedDeals.forEach((d, idx) => {
    const item = document.createElement("div");
    item.className = "deal-item";
    item.innerHTML = `
      <strong>#${idx + 1} ${d.vendor_id} (${d.name})</strong><br>
      Price: Rs${d.accepted_price} | Score: ${d.rank_score.toFixed(3)} | Budget: ${d.within_budget ? "in" : "over"}
    `;
    ui.dealsList.appendChild(item);
  });
}

function renderLog() {
  ui.logList.innerHTML = "";
  state.logs.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "log-item";
    if (entry.isDebug) {
      item.style.borderColor = "rgba(169, 94, 34, 0.45)";
      item.style.background = "rgba(255, 180, 112, 0.17)";
    }
    item.textContent = entry.text;
    ui.logList.appendChild(item);
  });
}

function renderVendors() {
  ui.vendorsGrid.innerHTML = "";
  const sorted = [...state.vendors].sort((a, b) => b.quality_score - a.quality_score);
  sorted.forEach((v) => {
    const card = document.createElement("article");
    card.className = "vendor-card";
    card.innerHTML = `
      <div class="vendor-top">
        <strong>${v.vendor_id} - ${v.name}</strong>
        <span class="chip ${v.status}">${v.status}</span>
      </div>
      <div class="vendor-meta">
        <div><span>Quote</span><br>Rs${v.quote_price}</div>
        <div><span>Accepted</span><br>${Number.isFinite(v.accepted_price) ? `Rs${v.accepted_price}` : "-"}</div>
        <div><span>Delivery</span><br>${v.delivery_days} days</div>
        <div><span>Attempts</span><br>${v.negotiation_attempts}</div>
        <div><span>Quality</span><br>${v.quality_score.toFixed(2)}</div>
        <div><span>Reliability</span><br>${v.reliability_score.toFixed(2)}</div>
      </div>
      <p class="footer-note">Rank score: ${v.rank_score.toFixed(3)}</p>
    `;
    ui.vendorsGrid.appendChild(card);
  });
}

function renderVendorSelect() {
  const existingValue = ui.vendorSelect.value;
  ui.vendorSelect.innerHTML = "";

  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "Select vendor";
  ui.vendorSelect.appendChild(defaultOpt);

  state.vendors
    .filter((v) => v.status !== "denied")
    .forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.vendor_id;
      opt.textContent = `${v.vendor_id} - ${v.name} (${v.status})`;
      ui.vendorSelect.appendChild(opt);
    });

  if (existingValue && [...ui.vendorSelect.options].some((o) => o.value === existingValue)) {
    ui.vendorSelect.value = existingValue;
  }
}

function renderBadges() {
  ui.taskBadge.textContent = state.task;
  ui.stepBadge.textContent = `${state.step} / ${MAX_STEPS}`;
  ui.scoreBadge.textContent = state.done ? state.finalScore.toFixed(3) : "0.000";
}

function setButtonsState() {
  const disabled = state.done;
  ui.negotiateBtn.disabled = disabled;
  ui.acceptBtn.disabled = disabled;
  ui.skipBtn.disabled = disabled;
  ui.finalizeBtn.disabled = disabled;
  ui.autoStepBtn.disabled = disabled;
  ui.autoRunBtn.disabled = disabled;
}

function render() {
  renderBadges();
  renderFacts();
  renderDeals();
  renderLog();
  renderVendors();
  renderVendorSelect();
  setButtonsState();
}

function readVendorAndOffer() {
  const vendorId = ui.vendorSelect.value || null;
  const offerValue = ui.offerInput.value.trim();
  const offerPrice = offerValue === "" ? null : Number(offerValue);
  return {
    vendorId,
    offerPrice: Number.isFinite(offerPrice) ? offerPrice : null,
  };
}

async function manualAction(actionType) {
  const { vendorId, offerPrice } = readVendorAndOffer();
  if (actionType !== "finalize" && !vendorId) {
    addLog("[DEBUG] Select a vendor first.", true);
    render();
    return;
  }
  await applyAction(actionType, vendorId, offerPrice);
}

async function autoRunToEnd() {
  let guard = 0;
  while (!state.done && guard < MAX_STEPS + 2) {
    const next = heuristicDecision();
    await applyAction(next.actionType, next.vendorId, next.offerPrice);
    guard += 1;
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
}

ui.taskSelect.addEventListener("change", async () => {
  await initEpisode(ui.taskSelect.value);
});

ui.resetBtn.addEventListener("click", async () => {
  await initEpisode(ui.taskSelect.value);
});

ui.negotiateBtn.addEventListener("click", async () => await manualAction("negotiate"));
ui.acceptBtn.addEventListener("click", async () => await manualAction("accept"));
ui.skipBtn.addEventListener("click", async () => await manualAction("skip"));
ui.finalizeBtn.addEventListener("click", async () => await manualAction("finalize"));

ui.autoStepBtn.addEventListener("click", async () => {
  const next = heuristicDecision();
  await applyAction(next.actionType, next.vendorId, next.offerPrice);
});

ui.autoRunBtn.addEventListener("click", async () => {
  ui.autoRunBtn.disabled = true;
  await autoRunToEnd();
  setButtonsState();
});

initEpisode("easy");
