from fastapi import FastAPI
from pydantic import BaseModel
from my_env_v4 import MyEnvV4Env, MyEnvV4Action
import asyncio

app = FastAPI()

env = None


class ActionInput(BaseModel):
    action_type: str
    vendor_id: str | None = None
    offer_price: float | None = None


@app.on_event("startup")
async def startup():
    global env
    env = MyEnvV4Env(task="medium")
    await env.reset()
    print("✅ ENV INITIALIZED")


@app.get("/state")
async def get_state():
    return env.state()


@app.post("/step")
async def step(action: ActionInput):
    global env

    act = MyEnvV4Action(
        action_type=action.action_type,
        vendor_id=action.vendor_id,
        offer_price=action.offer_price,
    )

    print("STEP ACTION:", act)  # 🔥 DEBUG

    result = await env.step(act)

    return {
        "reward": result.reward.value,
        "event": result.reward.event,
        "done": result.done,
        "state": env.state(),
    }

from fastapi.responses import HTMLResponse

@app.get("/", response_class=HTMLResponse)
def home():
    with open("index.html", "r") as f:
        return f.read()

# from __future__ import annotations

# import asyncio
# from pathlib import Path
# from typing import Any, Dict, Optional

# from fastapi import FastAPI, HTTPException
# from fastapi.middleware.cors import CORSMiddleware
# from fastapi.responses import FileResponse, RedirectResponse
# from fastapi.staticfiles import StaticFiles
# from pydantic import BaseModel, Field

# from my_env_v4 import MyEnvV4Action, MyEnvV4Env

# app = FastAPI(title="Vendor Negotiation RL Environment", version="1.2.0")

# BASE_DIR = Path(__file__).resolve().parent
# UI_DIR = BASE_DIR / "ui"

# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=["*"],
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
# )

# if UI_DIR.exists():
#     app.mount("/ui", StaticFiles(directory=str(UI_DIR), html=True), name="ui")

# # ── Request models ──────────────────────────────────────────────────────────

# class ResetRequest(BaseModel):
#     task: str = Field(default="easy")
#     item: str = Field(default="Rice")
#     expected_price: float = Field(default=180.0)
#     quantity_kg: int = Field(default=1000)
#     seed: Optional[int] = None
#     stochastic_vendors: bool = Field(default=True)


# class StepRequest(BaseModel):
#     action_type: str
#     vendor_id: Optional[str] = None
#     offer_price: Optional[float] = None
#     reasoning: Optional[str] = None


# # ── Global env (single session) ─────────────────────────────────────────────

# _ENV: Optional[MyEnvV4Env] = None


# # ── Routes ───────────────────────────────────────────────────────────────────

# @app.get("/")
# async def root() -> RedirectResponse:
#     return RedirectResponse(url="/ui/index.html", status_code=307)


# @app.get("/health")
# async def health() -> Dict[str, Any]:
#     return {
#         "status": "ok",
#         "name": "vendor-negotiation-env",
#         "version": "1.2.0",
#         "tasks": ["easy", "medium", "hard"],
#     }


# # ── OpenEnv required endpoints ───────────────────────────────────────────────

# @app.post("/reset")
# async def reset(payload: ResetRequest) -> Dict[str, Any]:
#     """OpenEnv: initialise a new episode."""
#     global _ENV

#     if _ENV is not None:
#         await _ENV.close()

#     _ENV = MyEnvV4Env(
#         task=payload.task,
#         item=payload.item,
#         expected_price=payload.expected_price,
#         quantity_kg=payload.quantity_kg,
#         seed=payload.seed,
#         stochastic_vendors=payload.stochastic_vendors,
#     )
#     obs = await _ENV.reset()
#     return {"observation": obs.model_dump(), "state": _ENV.state()}


# @app.post("/step")
# async def step(payload: StepRequest) -> Dict[str, Any]:
#     """OpenEnv: execute one action and return (obs, reward, done, info)."""
#     global _ENV

#     if _ENV is None:
#         raise HTTPException(status_code=400, detail="Episode not initialised. Call /reset first.")

#     action = MyEnvV4Action(
#         action_type=payload.action_type,
#         vendor_id=payload.vendor_id,
#         offer_price=payload.offer_price,
#         reasoning=payload.reasoning,
#     )
#     result = await _ENV.step(action)
#     return result.model_dump()


# @app.get("/state")
# async def state() -> Dict[str, Any]:
#     """OpenEnv: return current environment state."""
#     global _ENV

#     if _ENV is None:
#         raise HTTPException(status_code=400, detail="Episode not initialised. Call /reset first.")

#     return _ENV.state()


# # ── Agent-step: LLM-driven autonomous action ─────────────────────────────────

# @app.post("/agent-step")
# async def agent_step(payload: ResetRequest) -> Dict[str, Any]:
#     """
#     Convenience endpoint: reset env if needed, run one heuristic agent step,
#     return step result. Used by the UI to drive the autonomous demo.
#     """
#     global _ENV

#     # Auto-init if not started or task changed
#     if _ENV is None or _ENV.task != payload.task:
#         if _ENV is not None:
#             await _ENV.close()
#         _ENV = MyEnvV4Env(
#             task=payload.task,
#             item=payload.item,
#             expected_price=payload.expected_price,
#             quantity_kg=payload.quantity_kg,
#             seed=payload.seed,
#             stochastic_vendors=payload.stochastic_vendors,
#         )
#         await _ENV.reset()

#     obs = _ENV._make_observation()

#     # Heuristic policy — pick best active vendor
#     active = [v for v in obs.vendors if v.status == "active"]

#     if not active:
#         action = MyEnvV4Action(action_type="finalize", vendor_id=None, reasoning="no active vendors")
#     else:
#         def score(v):
#             price_ok = 1.0 if v.quote_price <= obs.budget_per_kg else 0.5
#             return price_ok * 0.40 + v.quality_score * 0.35 + v.reliability_score * 0.25

#         best = max(active, key=score)
#         offer = round(min(obs.expected_price, best.quote_price * 0.97), 2)
#         action = MyEnvV4Action(
#             action_type="negotiate",
#             vendor_id=best.vendor_id,
#             offer_price=offer,
#             reasoning=f"best utility vendor {best.vendor_id}",
#         )

#     result = await _ENV.step(action)
#     action_str = f"{action.action_type}(vendor={action.vendor_id},offer={action.offer_price})"

#     return {
#         "action": action_str,
#         "reward": result.reward.value,
#         "done": result.done,
#         "state": _ENV.state(),
#         "observation": result.observation.model_dump(),
#     }


# # ── Legacy /api/* aliases (backwards compat) ────────────────────────────────

# @app.post("/api/reset")
# async def api_reset_alias(payload: ResetRequest) -> Dict[str, Any]:
#     return await reset(payload)


# @app.post("/api/step")
# async def api_step_alias(payload: StepRequest) -> Dict[str, Any]:
#     return await step(payload)


# @app.get("/api/state")
# async def api_state_alias() -> Dict[str, Any]:
#     return await state()
