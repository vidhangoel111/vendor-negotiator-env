from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from my_env_v4 import MyEnvV4Action, MyEnvV4Env


app = FastAPI(title="Vendor Negotiation API", version="1.1.0")
BASE_DIR = Path(__file__).resolve().parent
UI_DIR = BASE_DIR / "ui"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if UI_DIR.exists():
    app.mount("/ui", StaticFiles(directory=str(UI_DIR)), name="ui")


class ResetRequest(BaseModel):
    task: str = Field(default="easy")
    item: str = Field(default="Rice")
    expected_price: float = Field(default=180.0)
    quantity_kg: int = Field(default=1000)
    seed: Optional[int] = None


class StepRequest(BaseModel):
    action_type: str
    vendor_id: Optional[str] = None
    offer_price: Optional[float] = None
    reasoning: Optional[str] = None


_ENV: Optional[MyEnvV4Env] = None


@app.get("/")
async def ui_index() -> RedirectResponse:
    return RedirectResponse(url="/ui/index_v2.html", status_code=307)


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/api/reset")
async def api_reset(payload: ResetRequest) -> Dict[str, Any]:
    global _ENV

    if _ENV is not None:
        await _ENV.close()

    _ENV = MyEnvV4Env(
        task=payload.task,
        item=payload.item,
        expected_price=payload.expected_price,
        quantity_kg=payload.quantity_kg,
        seed=payload.seed,
    )
    obs = await _ENV.reset()
    return {"observation": obs.model_dump()}


@app.post("/api/step")
async def api_step(payload: StepRequest) -> Dict[str, Any]:
    global _ENV

    if _ENV is None:
        raise HTTPException(status_code=400, detail="Episode not initialized. Call /api/reset first.")

    action = MyEnvV4Action(
        action_type=payload.action_type,
        vendor_id=payload.vendor_id,
        offer_price=payload.offer_price,
        reasoning=payload.reasoning,
    )
    result = await _ENV.step(action)
    return result.model_dump()


@app.get("/api/state")
async def api_state() -> Dict[str, Any]:
    global _ENV

    if _ENV is None:
        raise HTTPException(status_code=400, detail="Episode not initialized. Call /api/reset first.")

    return _ENV.state()
