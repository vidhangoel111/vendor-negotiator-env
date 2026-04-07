from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from my_env_v4 import MyEnvV4Action, MyEnvV4Env

app = FastAPI(title="Vendor Negotiation RL Environment", version="1.4.0")

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


_ENV: Optional[MyEnvV4Env] = None
_VENDOR_PREF: Dict[str, Dict[str, float]] = {}


def _load_pref() -> None:
    global _VENDOR_PREF
    if not PREF_PATH.exists():
        _VENDOR_PREF = {}
        return
    try:
        raw = json.loads(PREF_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            _VENDOR_PREF = {
                str(task): {str(vid): float(val) for vid, val in vals.items()}
                for task, vals in raw.items()
                if isinstance(vals, dict)
            }
        else:
            _VENDOR_PREF = {}
    except Exception:
        _VENDOR_PREF = {}


def _save_pref() -> None:
    PREF_PATH.write_text(json.dumps(_VENDOR_PREF, indent=2), encoding="utf-8")


def _pref(task: str, vendor_id: str) -> float:
    return float(_VENDOR_PREF.get(task, {}).get(vendor_id, 0.0))


def _update_pref(task: str, vendor_id: str, reward_signal: float, alpha: float = 0.20) -> float:
    task_map = _VENDOR_PREF.setdefault(task, {})
    old = float(task_map.get(vendor_id, 0.0))
    new = old + alpha * (reward_signal - old)
    new = max(-1.0, min(1.0, round(new, 4)))
    task_map[vendor_id] = new
    return new


_load_pref()


@app.get("/")
async def root() -> RedirectResponse:
    return RedirectResponse(url="/ui/index.html", status_code=307)


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "name": "vendor-negotiation-env",
        "version": "1.4.0",
        "tasks": ["easy", "medium", "hard"],
    }


@app.post("/reset")
async def reset(payload: ResetRequest) -> Dict[str, Any]:
    global _ENV

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
                + learned_bias * 0.12
            )
            return utility

        under_explored = [v for v in active if v.negotiation_attempts == 0]
        pool = under_explored if under_explored else active
        best = max(pool, key=score)
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

    # Online backend learning signal from env rewards.
    if action.vendor_id:
        _update_pref(obs.task_difficulty, action.vendor_id, float(result.reward.value), alpha=0.12)
        _save_pref()

    action_str = f"{action.action_type}(vendor={action.vendor_id},offer={action.offer_price})"

    return {
        "action": action_str,
        "reward": result.reward.value,
        "done": result.done,
        "state": _ENV.state(),
        "observation": result.observation.model_dump(),
    }


@app.post("/feedback")
async def feedback(payload: FeedbackRequest) -> Dict[str, Any]:
    task = payload.task if payload.task in ("easy", "medium", "hard") else "easy"
    same_pick = payload.chosen_vendor_id == payload.agent_vendor_id

    if same_pick:
        agent_signal = 0.12
        chosen_signal = 0.08
    else:
        base_pen = max(0.05, float(payload.penalty))
        agent_signal = -base_pen
        chosen_signal = 0.05

    if payload.chosen_over_budget:
        chosen_signal -= 0.03

    agent_q = _update_pref(task, payload.agent_vendor_id, agent_signal, alpha=0.25)
    chosen_q = _update_pref(task, payload.chosen_vendor_id, chosen_signal, alpha=0.25)
    _save_pref()

    return {
        "ok": True,
        "task": task,
        "same_pick": same_pick,
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
async def api_reset_alias(payload: ResetRequest) -> Dict[str, Any]:
    return await reset(payload)


@app.post("/api/step")
async def api_step_alias(payload: StepRequest) -> Dict[str, Any]:
    return await step(payload)


@app.get("/api/state")
async def api_state_alias() -> Dict[str, Any]:
    return await state()


@app.post("/api/feedback")
async def api_feedback_alias(payload: FeedbackRequest) -> Dict[str, Any]:
    return await feedback(payload)
