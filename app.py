from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from typing import Any, Dict, Optional

from my_env_v4 import MyEnvV4Env, MyEnvV4Action
from tasks import TASKS, GRADERS, PASS_THRESHOLD, task_ids, has_required_graders

app = FastAPI(title="Vendor Negotiation RL Env")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_ENV: Optional[MyEnvV4Env] = None

# ---------------- TASK CATALOG (FIXED) ----------------
def _task_catalog():
    return [
        {
            "id": t["id"],
            "name": t["name"],
            "description": t.get("description", ""),
            "difficulty": t["difficulty"],
            "max_steps": t.get("max_steps", 24),

            # ✅ CRITICAL FIX
            "grader": {
                "type": "endpoint",
                "id": t["id"],
                "method": "POST",
                "endpoint": f"/grade/{t['id']}",
                "success_threshold": PASS_THRESHOLD,
            },
        }
        for t in TASKS
    ]

# ---------------- ROUTES ----------------
@app.get("/tasks")
async def tasks():
    return _task_catalog()

@app.get("/graders")
async def graders():
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

@app.get("/validate")
async def validate():
    return {
        "valid": has_required_graders(),
        "task_count": len(task_ids()),
        "tasks": task_ids(),
        "graders": list(GRADERS.keys()),
    }

# ---------------- ENV ----------------
@app.post("/reset")
async def reset(req: Request):
    global _ENV
    data = await req.json()

    _ENV = MyEnvV4Env(task=data.get("task", "easy"))
    obs = await _ENV.reset()

    return {"observation": obs.model_dump(), "state": _ENV.state()}

@app.post("/step")
async def step(req: Request):
    global _ENV
    data = await req.json()

    action = MyEnvV4Action(**data)
    result = await _ENV.step(action)

    return result.model_dump()

# ---------------- GRADER ----------------
@app.post("/grade/{task_id}")
async def grade(task_id: str, req: Request):
    global _ENV

    data = await req.json()
    runs = data.get("runs", 3)

    scores = []

    for i in range(runs):
        env = MyEnvV4Env(task=task_id, seed=i * 42)
        obs = await env.reset()

        done = False
        while not done:
            action = MyEnvV4Action(action_type="finalize")
            result = await env.step(action)
            done = result.done

        final = env.state()

        # ✅ USE CORRECT GRADER
        score = GRADERS[task_id](final)

        scores.append(score)
        await env.close()

    avg = sum(scores) / len(scores)

    return {
        "task": task_id,
        "avg_score": round(avg, 4),
        "pass": avg >= PASS_THRESHOLD,
    }