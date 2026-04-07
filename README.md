---
title: Vendor Negotiator Env
emoji: 🤝
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
tags:
  - openenv
short_description: AI vendor negotiation for real procurement tasks.
---

# Autonomous Vendor Negotiation RL Environment

**Scaler × Meta PyTorch OpenEnv Hackathon 2026** — submission by [vidhangoel01](https://huggingface.co/vidhangoel01)

## What This Is

An OpenEnv-compatible Reinforcement Learning environment where an AI agent autonomously negotiates with 10 ranked vendors to secure the best procurement deal under budget, quality, and delivery constraints. Real-world supply chain problem — when primary vendors go offline, the agent must find a replacement before backup stock runs out.

This is an **RL environment** (not an agent). Bring your own agent and train it here.

## Live Demo

**UI:** https://vidhangoel01-vendor-negotiator-env.hf.space/ui  
**Health:** https://vidhangoel01-vendor-negotiator-env.hf.space/health

## OpenEnv Compliance

- Interface: `reset()`, `step(action)`, `state()`, `close()`
- Typed Pydantic models: `VendorNegotiationObservation`, `MyEnvV4Action`, `MyEnvV4Reward`
- 3 difficulty tasks: `easy`, `medium`, `hard`
- Deterministic final grader in `[0.0, 1.0]`
- Trajectory reward signal in `[-1.0, 1.0]`
- Success threshold: score >= 0.40

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/health` | Server health check — returns name, version, tasks |
| POST | `/reset` | Start a new episode — returns initial observation |
| POST | `/step` | Execute one action — returns obs, reward, done, info |
| GET | `/state` | Get current environment state snapshot |
| POST | `/agent-step` | Heuristic agent takes one step (used by UI demo) |

### Reset Request
```json
{
  "task": "easy",
  "item": "Rice",
  "expected_price": 180.0,
  "quantity_kg": 1000
}
```

### Step Request
```json
{
  "action_type": "negotiate",
  "vendor_id": "V1",
  "offer_price": 174.6,
  "reasoning": "best utility vendor"
}
```

## Tasks

| Task | Budget Multiplier | Deny Rate | Expected Score |
|------|-------------------|-----------|----------------|
| easy | 1.20x | ~5% | 0.85 – 0.95 |
| medium | 1.12x | ~18% | 0.65 – 0.82 |
| hard | 1.04x | ~38% | 0.42 – 0.68 |

## Action Space

- `negotiate` — send offer price to vendor (they may accept, counter, or reject)
- `accept` — accept vendor's current quote directly
- `skip` — mark vendor as denied, move on
- `finalize` — end episode, lock in best deal found

## Reward Signal

- `+0.18` — deal accepted within budget
- `+0.10` — accepted quote directly (in budget)
- `+0.12` — efficiency bonus (done in ≤10 steps)
- `-0.01` — counter offer received
- `-0.03` — vendor skipped
- `-0.30` — no deal at all (worst outcome)

## Project Structure

```
vendor-negotiator-env/
├── ui/                  # Navy+Gold dashboard UI
│   └── index_v2.html
├── my_env_v4.py         # Core RL environment (reset/step/state)
├── app.py               # FastAPI server — all API routes
├── inference.py         # Official test runner ([START]/[STEP]/[END] logs)
├── grader.py            # Auto scorer for all 3 tasks
├── openenv.yaml         # OpenEnv spec documentation
├── Dockerfile           # Container definition (port 7860)
└── requirements.txt     # Python dependencies
```

## Local Setup

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
```

## Run Locally

```bash
# Start the server (visit http://localhost:7860/ui)
uvicorn app:app --host 0.0.0.0 --port 7860

# Run the grader (tests all 3 tasks, no LLM needed)
python grader.py

# Run inference (official [START]/[STEP]/[END] format)
python inference.py

# Run inference for a specific task
set MY_ENV_V4_TASK=hard && python inference.py
```

## Docker

```bash
docker build -t vendor-negotiation-env .
docker run -p 7860:7860 vendor-negotiation-env
```

## Tech Stack

- Python 3.11 · FastAPI · Uvicorn · Pydantic v2
- OpenAI client (pointing to HF router or Groq)
- Docker · Hugging Face Spaces