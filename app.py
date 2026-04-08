from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from my_env_v4 import MyEnvV4Action, MyEnvV4Env

try:
    from tasks import GRADERS, PASS_THRESHOLD, TASKS, has_required_graders, task_ids
except Exception:
    # Fallback for deployment snapshots where tasks.py is missing.
    PASS_THRESHOLD = 0.40

    def _fallback_score_from_state(state: Dict[str, Any]) -> float:
        raw = float(state.get("final_score", 0.0))
        return max(0.0, min(1.0, round(raw, 4)))

    def _grade_easy(state: Dict[str, Any]) -> float:
        return _fallback_score_from_state(state)

    def _grade_medium(state: Dict[str, Any]) -> float:
        return _fallback_score_from_state(state)

    def _grade_hard(state: Dict[str, Any]) -> float:
        return _fallback_score_from_state(state)

    GRADERS = {"easy": _grade_easy, "medium": _grade_medium, "hard": _grade_hard}
    TASKS = [
        {"id": "easy", "name": "Easy Negotiation Task", "difficulty": "easy", "max_steps": 24, "grader": True},
        {"id": "medium", "name": "Medium Negotiation Task", "difficulty": "medium", "max_steps": 24, "grader": True},
        {"id": "hard", "name": "Hard Negotiation Task", "difficulty": "hard", "max_steps": 24, "grader": True},
    ]

    def task_ids() -> list[str]:
        return [str(t["id"]) for t in TASKS]

    def has_required_graders() -> bool:
        ids = task_ids()
        return len(ids) >= 3 and all(t.get("grader") for t in TASKS) and all(tid in GRADERS for tid in ids)

app = FastAPI(title="Vendor Negotiation RL Environment", version="1.6.0")

BASE_DIR = Path(__file__).resolve().parent
UI_DIR = BASE_DIR / "ui"
PREF_PATH = BASE_DIR / "vendor_feedback_q.json"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if UI_DIR.exists():
    app.mount("/ui", StaticFiles(directory=str(UI_DIR), html=True), name="ui")


class ResetRequest(BaseModel):
    task: str = Field(default="easy")
    item: str = Field(default="Rice")
    expected_price: float = Field(default=180.0)
    quantity_kg: int = Field(default=1000)
    seed: Optional[int] = None
    stochastic_vendors: bool = Field(default=True)


class StepRequest(BaseModel):
    action_type: str
    vendor_id: Optional[str] = None
    offer_price: Optional[float] = None
    reasoning: Optional[str] = None


class FeedbackRequest(BaseModel):
    task: str = Field(default="easy")
    agent_vendor_id: str
    chosen_vendor_id: str
    penalty: float = Field(default=0.0, ge=0.0, le=1.0)
    chosen_over_budget: bool = Field(default=False)


class GraderRequest(BaseModel):
    task: str = Field(default="easy")
    runs: int = Field(default=3, ge=1, le=20)
    seed: Optional[int] = None
    stochastic_vendors: bool = Field(default=True)


class BaselineRequest(BaseModel):
    runs: int = Field(default=3, ge=1, le=20)
    seed: Optional[int] = None
    stochastic_vendors: bool = Field(default=True)


_ENV: Optional[MyEnvV4Env] = None
_VENDOR_PREF: Dict[str, Dict[str, float]] = {}
_LEARN_STATS: Dict[str, Dict[str, float]] = {}


def _blank_stats() -> Dict[str, float]:
    return {
        "reward_total": 0.0,
        "penalty_total": 0.0,
        "net_signal": 0.0,
        "updates": 0.0,
        "reputation": 0.70,
    }


def _load_pref() -> None:
    global _VENDOR_PREF, _LEARN_STATS
    if not PREF_PATH.exists():
        _VENDOR_PREF = {}
        _LEARN_STATS = {}
        return
    try:
        raw = json.loads(PREF_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            _VENDOR_PREF = {}
            _LEARN_STATS = {}
            return

        if "prefs" in raw:
            raw_prefs = raw.get("prefs", {})
            raw_stats = raw.get("stats", {})
        else:
            # Backward compatibility with old flat schema.
            raw_prefs = raw
            raw_stats = {}

        _VENDOR_PREF = {
            str(task): {str(vid): float(val) for vid, val in vals.items()}
            for task, vals in raw_prefs.items()
            if isinstance(vals, dict)
        }

        _LEARN_STATS = {}
        for task in ("easy", "medium", "hard"):
            base = _blank_stats()
            src = raw_stats.get(task, {}) if isinstance(raw_stats, dict) else {}
            if isinstance(src, dict):
                base["reward_total"] = float(src.get("reward_total", 0.0))
                base["penalty_total"] = float(src.get("penalty_total", 0.0))
                base["net_signal"] = float(src.get("net_signal", base["reward_total"] - base["penalty_total"]))
                base["updates"] = float(src.get("updates", 0.0))
                base["reputation"] = float(src.get("reputation", 0.70))
            _LEARN_STATS[task] = base
    except Exception:
        _VENDOR_PREF = {}
        _LEARN_STATS = {}


def _save_pref() -> None:
    payload = {"prefs": _VENDOR_PREF, "stats": _LEARN_STATS}
    PREF_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _pref(task: str, vendor_id: str) -> float:
    return float(_VENDOR_PREF.get(task, {}).get(vendor_id, 0.0))


def _update_pref(task: str, vendor_id: str, reward_signal: float, alpha: float = 0.20) -> float:
    task_map = _VENDOR_PREF.setdefault(task, {})
    old = float(task_map.get(vendor_id, 0.0))
    new = old + alpha * (reward_signal - old)
    new = max(-1.0, min(1.0, round(new, 4)))
    task_map[vendor_id] = new
    return new


def _task_stats(task: str) -> Dict[str, float]:
    if task not in _LEARN_STATS:
        _LEARN_STATS[task] = _blank_stats()
    return _LEARN_STATS[task]


def _apply_signal(task: str, signal: float) -> Dict[str, float]:
    s = _task_stats(task)
    if signal >= 0:
        s["reward_total"] = round(s["reward_total"] + float(signal), 4)
    else:
        s["penalty_total"] = round(s["penalty_total"] + abs(float(signal)), 4)

    s["updates"] = round(s["updates"] + 1.0, 4)
    s["net_signal"] = round(s["reward_total"] - s["penalty_total"], 4)

    # Strong mapping for visible reputation response.
    norm = s["net_signal"] / max(1.0, s["updates"] * 0.45)
    s["reputation"] = round(max(0.10, min(1.00, 0.55 + norm * 0.35)), 4)
    return s


def _task_reputation(task: str) -> float:
    stat = _LEARN_STATS.get(task)
    if stat and stat.get("updates", 0.0) > 0:
        return round(float(stat.get("reputation", 0.70)), 3)

    vals = list(_VENDOR_PREF.get(task, {}).values())
    if not vals:
        return 0.70
    avg = sum(vals) / max(1, len(vals))
    return round(max(0.10, min(1.00, 0.55 + avg * 0.40)), 3)


def _policy_metrics(task: str, stochastic: bool) -> Dict[str, float]:
    s = _task_stats(task)
    return {
        "task_reputation": _task_reputation(task),
        "explore_rate": 0.30 if stochastic else 0.0,
        "reward_total": round(float(s.get("reward_total", 0.0)), 4),
        "penalty_total": round(float(s.get("penalty_total", 0.0)), 4),
        "net_signal": round(float(s.get("net_signal", 0.0)), 4),
        "updates": int(float(s.get("updates", 0.0))),
    }


def _normalize_task(task: str) -> str:
    raw = (task or "").strip().lower()
    alias_map = {
        "1": "easy",
        "2": "medium",
        "3": "hard",
        "task_1": "easy",
        "task_2": "medium",
        "task_3": "hard",
    }
    normalized = alias_map.get(raw, raw)
    return normalized if normalized in set(task_ids()) else "easy"


def _heuristic_action(obs: Any) -> MyEnvV4Action:
    active = [v for v in obs.vendors if v.status == "active"]
    if not active:
        return MyEnvV4Action(action_type="finalize", vendor_id=None, reasoning="no active vendors")

    def utility(v: Any) -> float:
        price_ok = 1.0 if v.quote_price <= obs.budget_per_kg else 0.6
        return price_ok * 0.40 + v.quality_score * 0.35 + v.reliability_score * 0.25

    best = max(active, key=utility)
    offer = round(min(obs.expected_price, best.quote_price * 0.97), 2)
    return MyEnvV4Action(
        action_type="negotiate",
        vendor_id=best.vendor_id,
        offer_price=offer,
        reasoning=f"heuristic best utility {best.vendor_id}",
    )


async def _run_heuristic_episode(task: str, seed: Optional[int], stochastic_vendors: bool) -> Dict[str, Any]:
    env = MyEnvV4Env(task=task, seed=seed, stochastic_vendors=stochastic_vendors)
    obs = await env.reset()
    steps = 0
    done = False
    cumulative_reward = 0.0

    while not done and steps < env.MAX_STEPS:
        action = _heuristic_action(obs)
        result = await env.step(action)
        obs = result.observation
        done = result.done
        steps += 1
        cumulative_reward += float(result.reward.value)

    final_state = env.state()
    score = float(final_state.get("final_score", 0.0))
    await env.close()
    return {
        "task": task,
        "steps": steps,
        "score": round(score, 4),
        "success": score >= 0.40,
        "cumulative_reward": round(cumulative_reward, 4),
        "stochastic_vendors": stochastic_vendors,
    }


async def _grade_task(task: str, runs: int, seed: Optional[int], stochastic_vendors: bool) -> Dict[str, Any]:
    normalized_task = _normalize_task(task)
    episodes = []
    for idx in range(runs):
        run_seed = (seed if seed is not None else 0) + idx if seed is not None else idx * 42
        ep = await _run_heuristic_episode(
            task=normalized_task,
            seed=run_seed,
            stochastic_vendors=stochastic_vendors,
        )
        episodes.append(ep)

    scores = [float(ep["score"]) for ep in episodes]
    avg_score = round(sum(scores) / len(scores), 4)
    best_score = round(max(scores), 4)
    worst_score = round(min(scores), 4)
    success_rate = round(sum(1 for ep in episodes if ep["success"]) / len(episodes), 4)
    return {
        "task": normalized_task,
        "runs": runs,
        "avg_score": avg_score,
        "best_score": best_score,
        "worst_score": worst_score,
        "success_rate": success_rate,
        "pass_threshold": PASS_THRESHOLD,
        "score": avg_score,
        "pass": avg_score >= PASS_THRESHOLD,
        "episodes": episodes,
    }


def _task_catalog() -> list[Dict[str, Any]]:
    catalog: list[Dict[str, Any]] = []
    for t in TASKS:
        tid = str(t["id"])
        endpoint = f"/grade/{tid}"
        catalog.append(
            {
                "id": tid,
                "task_id": tid,
                "name": t.get("name", tid),
                "description": t.get("description", f"Task {tid}"),
                "difficulty": t.get("difficulty", tid),
                "max_steps": int(t.get("max_steps", 24)),
                "grader": bool(t.get("grader", True)),
                "grader_id": tid,
                "grader_endpoint": endpoint,
                "grader": {
    "type": "endpoint",
    "id": tid,
    "method": "POST",
    "endpoint": endpoint,
    "success_threshold": PASS_THRESHOLD,
},
            }
        )
    return catalog


_load_pref()


@app.get("/")
async def root() -> RedirectResponse:
    return RedirectResponse(url="/ui/index.html", status_code=307)


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "name": "vendor-negotiation-env",
        "version": "1.6.0",
        "tasks": task_ids(),
        "tasks_with_graders": len(task_ids()),
        "tasks_endpoint": "/tasks",
        "grader_endpoint": "/grade/{task_id}",
        "baseline_endpoint": "/baseline",
    }


@app.get("/tasks")
async def tasks() -> list[Dict[str, Any]]:
    return _task_catalog()


@app.get("/graders")
@app.get("/graders")
async def graders() -> list[Dict[str, Any]]:
    return [
        {
            "id": tid,
            "task_id": tid,
            "type": "endpoint",
            "method": "POST",
            "endpoint": f"/grade/{tid}",
        }
        for tid in task_ids()
    ]
    # return out


@app.get("/validate")
async def validate() -> Dict[str, Any]:
    catalog = _task_catalog()
    all_with_graders = all(bool(t.get("grader")) for t in catalog)
    checks = {
        "min_3_tasks": len(catalog) >= 3,
        "tasks_have_graders": all_with_graders,
        "all_tasks_have_graders": all_with_graders,
        "grader_endpoint_present": all(bool(t.get("grader_endpoint")) for t in catalog),
        "grader_registry_valid": has_required_graders(),
    }
    return {
        "valid": all(checks.values()),
        "checks": checks,
        "task_count": len(catalog),
    }


@app.post("/reset")
async def reset(request: Request) -> Dict[str, Any]:
    global _ENV

    payload: Optional[Dict[str, Any]]
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            payload = None
    except Exception:
        payload = None

    try:
        cfg = ResetRequest.model_validate(payload or {})
    except Exception:
        # Be permissive for external validators that may send malformed/empty body.
        cfg = ResetRequest()

    if _ENV is not None:
        await _ENV.close()

    _ENV = MyEnvV4Env(
        task=cfg.task,
        item=cfg.item,
        expected_price=cfg.expected_price,
        quantity_kg=cfg.quantity_kg,
        seed=cfg.seed,
        stochastic_vendors=cfg.stochastic_vendors,
    )
    obs = await _ENV.reset()
    return {"observation": obs.model_dump(), "state": _ENV.state()}


@app.post("/step")
async def step(payload: StepRequest) -> Dict[str, Any]:
    global _ENV

    if _ENV is None:
        raise HTTPException(status_code=400, detail="Episode not initialised. Call /reset first.")

    action = MyEnvV4Action(
        action_type=payload.action_type,
        vendor_id=payload.vendor_id,
        offer_price=payload.offer_price,
        reasoning=payload.reasoning,
    )
    result = await _ENV.step(action)
    return result.model_dump()


@app.get("/state")
async def state() -> Dict[str, Any]:
    global _ENV

    if _ENV is None:
        raise HTTPException(status_code=400, detail="Episode not initialised. Call /reset first.")

    return _ENV.state()


@app.post("/agent-step")
async def agent_step(payload: ResetRequest) -> Dict[str, Any]:
    global _ENV

    if _ENV is None or _ENV.task != payload.task:
        if _ENV is not None:
            await _ENV.close()
        _ENV = MyEnvV4Env(
            task=payload.task,
            item=payload.item,
            expected_price=payload.expected_price,
            quantity_kg=payload.quantity_kg,
            seed=payload.seed,
            stochastic_vendors=payload.stochastic_vendors,
        )
        await _ENV.reset()

    obs = _ENV._make_observation()
    active = [v for v in obs.vendors if v.status == "active"]
    deals = [v for v in obs.vendors if v.status == "deal_closed"]

    min_deals_target = 3
    if not active or (len(deals) >= min_deals_target and obs.step_number >= 8):
        action = MyEnvV4Action(
            action_type="finalize",
            vendor_id=None,
            reasoning="enough deals collected or no active vendors",
        )
    else:

        def score(v):
            price_term = 1.0 - max(0.0, (v.quote_price - obs.budget_per_kg) / max(obs.budget_per_kg, 1.0))
            learned_bias = _pref(obs.task_difficulty, v.vendor_id)
            utility = (
                price_term * 0.34
                + v.quality_score * 0.33
                + v.reliability_score * 0.23
                + max(0.0, 1.0 - 0.25 * float(v.negotiation_attempts)) * 0.10
                + learned_bias * 0.20
            )
            return utility

        under_explored = [v for v in active if v.negotiation_attempts == 0]
        pool = under_explored if under_explored else active
        ranked = sorted(pool, key=score, reverse=True)

        explore_rate = 0.30 if payload.stochastic_vendors else 0.0
        if payload.stochastic_vendors and len(ranked) >= 2 and random.random() < explore_rate:
            best = random.choice(ranked[: min(3, len(ranked))])
        else:
            best = ranked[0]

        floor_est = best.base_price * (1 - best.negotiation_margin)

        if best.negotiation_attempts >= 3:
            if best.quote_price <= obs.budget_per_kg * 1.05:
                action = MyEnvV4Action(
                    action_type="accept",
                    vendor_id=best.vendor_id,
                    reasoning=f"accept quote after retries for {best.vendor_id}",
                )
            else:
                if best.negotiation_attempts >= 5:
                    action = MyEnvV4Action(
                        action_type="skip",
                        vendor_id=best.vendor_id,
                        reasoning=f"skip stalled over-budget vendor {best.vendor_id}",
                    )
                else:
                    offer = round(max(floor_est * 1.015, min(obs.expected_price, best.quote_price * 0.985)), 2)
                    action = MyEnvV4Action(
                        action_type="negotiate",
                        vendor_id=best.vendor_id,
                        offer_price=offer,
                        reasoning=f"continue negotiate {best.vendor_id}",
                    )
        else:
            offer = round(max(floor_est * 1.01, min(obs.expected_price, best.quote_price * 0.975)), 2)
            action = MyEnvV4Action(
                action_type="negotiate",
                vendor_id=best.vendor_id,
                offer_price=offer,
                reasoning=f"adaptive negotiate {best.vendor_id}",
            )

    result = await _ENV.step(action)

    if action.vendor_id:
        _update_pref(obs.task_difficulty, action.vendor_id, float(result.reward.value), alpha=0.16)
    _apply_signal(obs.task_difficulty, float(result.reward.value))
    _save_pref()

    action_str = f"{action.action_type}(vendor={action.vendor_id},offer={action.offer_price})"

    return {
        "action": action_str,
        "reward": result.reward.value,
        "done": result.done,
        "policy_metrics": _policy_metrics(obs.task_difficulty, payload.stochastic_vendors),
        "state": _ENV.state(),
        "observation": result.observation.model_dump(),
    }


@app.post("/feedback")
async def feedback(payload: FeedbackRequest) -> Dict[str, Any]:
    task = payload.task if payload.task in ("easy", "medium", "hard") else "easy"
    same_pick = payload.chosen_vendor_id == payload.agent_vendor_id

    if same_pick:
        agent_signal = 0.18
        chosen_signal = 0.12
    else:
        base_pen = max(0.08, float(payload.penalty) * 2.0)
        agent_signal = -base_pen
        chosen_signal = 0.10

    if payload.chosen_over_budget:
        chosen_signal -= 0.08

    agent_q = _update_pref(task, payload.agent_vendor_id, agent_signal, alpha=0.28)
    chosen_q = _update_pref(task, payload.chosen_vendor_id, chosen_signal, alpha=0.28)
    _apply_signal(task, agent_signal)
    _apply_signal(task, chosen_signal)
    _save_pref()

    metrics = _policy_metrics(task, stochastic=False)
    return {
        "ok": True,
        "task": task,
        "same_pick": same_pick,
        "task_reputation": _task_reputation(task),
        "policy_metrics": metrics,
        "applied": {
            "agent_vendor": payload.agent_vendor_id,
            "agent_signal": round(agent_signal, 4),
            "agent_q": agent_q,
            "chosen_vendor": payload.chosen_vendor_id,
            "chosen_signal": round(chosen_signal, 4),
            "chosen_q": chosen_q,
        },
    }


@app.post("/api/reset")
async def api_reset_alias(request: Request) -> Dict[str, Any]:
    return await reset(request)


@app.post("/api/step")
async def api_step_alias(payload: StepRequest) -> Dict[str, Any]:
    return await step(payload)


@app.get("/api/state")
async def api_state_alias() -> Dict[str, Any]:
    return await state()


@app.post("/api/feedback")
async def api_feedback_alias(payload: FeedbackRequest) -> Dict[str, Any]:
    return await feedback(payload)


@app.get("/api/tasks")
async def api_tasks_alias() -> Dict[str, Any]:
    return await tasks()


@app.get("/api/graders")
async def api_graders_alias() -> Dict[str, Any]:
    return await graders()


@app.post("/grader")
async def grader(request: Request) -> Dict[str, Any]:
    payload: Optional[Dict[str, Any]]
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            payload = None
    except Exception:
        payload = None

    cfg = GraderRequest.model_validate(payload or {})
    return await _grade_task(
        task=cfg.task,
        runs=cfg.runs,
        seed=cfg.seed,
        stochastic_vendors=cfg.stochastic_vendors,
    )


@app.post("/grade")
async def grade_alias(request: Request) -> Dict[str, Any]:
    return await grader(request)


@app.get("/grader")
async def grader_get(task: str = "easy", runs: int = 3, seed: Optional[int] = None, stochastic_vendors: bool = True) -> Dict[str, Any]:
    safe_runs = min(max(int(runs), 1), 20)
    return await _grade_task(task=task, runs=safe_runs, seed=seed, stochastic_vendors=stochastic_vendors)


@app.post("/grader/{task_id}")
async def grader_by_task(task_id: str, request: Request) -> Dict[str, Any]:
    payload: Optional[Dict[str, Any]]
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            payload = {}
    except Exception:
        payload = {}

    payload["task"] = _normalize_task(task_id)
    cfg = GraderRequest.model_validate(payload)
    return await _grade_task(
        task=cfg.task,
        runs=cfg.runs,
        seed=cfg.seed,
        stochastic_vendors=cfg.stochastic_vendors,
    )


@app.post("/grade/{task_id}")
async def grade_by_task_alias(task_id: str, request: Request) -> Dict[str, Any]:
    return await grader_by_task(task_id, request)


@app.get("/grade/{task_id}")
async def grade_by_task_get(task_id: str, runs: int = 3, seed: Optional[int] = None, stochastic_vendors: bool = True) -> Dict[str, Any]:
    safe_runs = min(max(int(runs), 1), 20)
    return await _grade_task(
        task=_normalize_task(task_id),
        runs=safe_runs,
        seed=seed,
        stochastic_vendors=stochastic_vendors,
    )


@app.get("/grader/{task_id}")
async def grader_by_task_get(task_id: str, runs: int = 3, seed: Optional[int] = None, stochastic_vendors: bool = True) -> Dict[str, Any]:
    safe_runs = min(max(int(runs), 1), 20)
    return await _grade_task(
        task=_normalize_task(task_id),
        runs=safe_runs,
        seed=seed,
        stochastic_vendors=stochastic_vendors,
    )


@app.post("/baseline")
async def baseline(request: Request) -> Dict[str, Any]:
    payload: Optional[Dict[str, Any]]
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            payload = None
    except Exception:
        payload = None

    cfg = BaselineRequest.model_validate(payload or {})
    task_scores: Dict[str, Dict[str, Any]] = {}
    for task in ("easy", "medium", "hard"):
        task_scores[task] = await _grade_task(
            task=task,
            runs=cfg.runs,
            seed=cfg.seed,
            stochastic_vendors=cfg.stochastic_vendors,
        )

    overall_avg = round(
        sum(float(task_scores[t]["avg_score"]) for t in ("easy", "medium", "hard")) / 3.0,
        4,
    )
    return {
        "runs_per_task": cfg.runs,
        "stochastic_vendors": cfg.stochastic_vendors,
        "tasks": task_scores,
        "overall_avg_score": overall_avg,
        "pass_threshold": PASS_THRESHOLD,
        "pass": overall_avg >= PASS_THRESHOLD,
    }


@app.get("/baseline")
async def baseline_get(runs: int = 3, seed: Optional[int] = None, stochastic_vendors: bool = True) -> Dict[str, Any]:
    safe_runs = min(max(int(runs), 1), 20)
    task_scores: Dict[str, Dict[str, Any]] = {}
    for task in ("easy", "medium", "hard"):
        task_scores[task] = await _grade_task(
            task=task,
            runs=safe_runs,
            seed=seed,
            stochastic_vendors=stochastic_vendors,
        )

    overall_avg = round(
        sum(float(task_scores[t]["avg_score"]) for t in ("easy", "medium", "hard")) / 3.0,
        4,
    )
    return {
        "runs_per_task": safe_runs,
        "stochastic_vendors": stochastic_vendors,
        "tasks": task_scores,
        "overall_avg_score": overall_avg,
        "pass_threshold": PASS_THRESHOLD,
        "pass": overall_avg >= PASS_THRESHOLD,
    }


@app.post("/api/grader")
async def api_grader_alias(request: Request) -> Dict[str, Any]:
    return await grader(request)


@app.post("/api/grade")
async def api_grade_alias(request: Request) -> Dict[str, Any]:
    return await grade_alias(request)


@app.post("/api/grader/{task_id}")
async def api_grader_by_task_alias(task_id: str, request: Request) -> Dict[str, Any]:
    return await grader_by_task(task_id, request)


@app.post("/api/grade/{task_id}")
async def api_grade_by_task_alias(task_id: str, request: Request) -> Dict[str, Any]:
    return await grade_by_task_alias(task_id, request)


@app.get("/api/grade/{task_id}")
async def api_grade_by_task_get_alias(task_id: str, runs: int = 3, seed: Optional[int] = None, stochastic_vendors: bool = True) -> Dict[str, Any]:
    return await grade_by_task_get(task_id, runs=runs, seed=seed, stochastic_vendors=stochastic_vendors)


@app.post("/api/baseline")
async def api_baseline_alias(request: Request) -> Dict[str, Any]:
    return await baseline(request)
