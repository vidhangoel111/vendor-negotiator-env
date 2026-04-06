---
title: Vendor Negotiator Env
emoji: "🤝"
colorFrom: blue
colorTo: green
sdk: docker
pinned: false
tags:
  - openenv
short_description: AI vendor negotiation for real procurement tasks.
---

# Autonomous Vendor Negotiation Environment

Meta PyTorch Hackathon 2026 submission candidate for OpenEnv.

## Motivation
This environment simulates a real procurement workflow: an autonomous agent must negotiate with multiple vendors and choose the best deal under budget, quality, reliability, and delivery constraints.

## OpenEnv Compliance Summary
- Interface implemented: `reset()`, `step(action)`, `state()`, `close()`
- Typed Pydantic models:
  - Observation: `VendorNegotiationObservation`
  - Action: `MyEnvV4Action`
  - Reward: `MyEnvV4Reward`
- Three difficulty tasks: `easy`, `medium`, `hard`
- Deterministic final grader in `[0.0, 1.0]`
- Trajectory reward signal in `[-1.0, 1.0]`

## Environment API
- `await env.reset() -> VendorNegotiationObservation`
- `await env.step(action: MyEnvV4Action) -> StepResult`
  - `StepResult = {observation, reward, done, info}`
  - `reward` is typed as `MyEnvV4Reward(value, event)`
- `env.state() -> dict`
- `await env.close() -> None`

## Project Structure
- `my_env_v4.py`: core environment + typed models
- `inference.py`: baseline agent runner (OpenAI client + heuristic fallback)
- `app.py`: FastAPI wrapper (`/api/reset`, `/api/step`, `/api/state`, `/health`)
- `openenv.yaml`: task/spec metadata
- `Dockerfile`: containerized deployment (HF Space API-first)
- `ui/`: optional browser visualization

## Setup
```bash
python -m venv .venv
. .venv/Scripts/activate
pip install -r requirements.txt
```

## Run
```bash
uvicorn app:app --host 127.0.0.1 --port 8000
python inference.py
```

## Docker / HF Space
```bash
docker build -t vendor-negotiation-env .
docker run -p 8000:8000 vendor-negotiation-env
```
