---
title: Vendor Negotiator
emoji: 🤖
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
short_description: AI vendor negotiation for real procurement tasks.
---

# Autonomous Vendor Negotiation RL Environment

**Scaler × Meta PyTorch OpenEnv Hackathon 2026** — submission by [vidhangoel01](https://huggingface.co/vidhangoel01)

## What This Is

An OpenEnv-compatible Reinforcement Learning environment where an AI agent autonomously negotiates with 10 ranked vendors to secure the best procurement deal under budget, quality, and delivery constraints. Real-world supply chain problem — when primary vendors go offline, the agent must find a replacement before backup stock runs out.

This is an **RL environment** with two policy modes for testing:
- `heuristic` baseline
- `qlearn` reward-driven policy (tabular Q-learning in Python)

## Live Demo

**UI:** https://vidhangoel01-vendor-negotiator-env.hf.space/ui  
**Health:** https://vidhangoel01-vendor-negotiator-env.hf.space/health  
**Tasks:** https://vidhangoel01-vendor-negotiator-env.hf.space/tasks  
**Graders:** https://vidhangoel01-vendor-negotiator-env.hf.space/graders  
**Manifest:** https://vidhangoel01-vendor-negotiator-env.hf.space/manifest  
**Space:** https://huggingface.co/spaces/vidhangoel01/vendor-negotiator-env

## OpenEnv Compliance

- Interface: `reset()`, `step(action)`, `state()`, `close()`
- Typed Pydantic models: `VendorNegotiationObservation`, `MyEnvV4Action`, `MyEnvV4Reward`
- 3 difficulty tasks: `easy`, `medium`, `hard`
- Validator discovery endpoints: `/tasks`, `/graders`, `/manifest`, `/openenv.yaml`
- Explicit grader routes: `/grade/easy`, `/grade/medium`, `/grade/hard`
- Deterministic final grader in `[0.0, 1.0]`
- Trajectory reward signal in `[-1.0, 1.0]`
- Success threshold: score >= 0.40

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/manifest` | JSON view of the OpenEnv manifest for validator tooling |
| GET | `/openenv.yaml` | Raw OpenEnv manifest file |
| GET | `/health` | Server health check — returns name, version, tasks |
| GET | `/tasks` | Task registry with grader metadata |
| GET | `/api/tasks` | Alias for task registry |
| GET | `/graders` | Explicit grader list for all tasks |
| GET | `/api/graders` | Alias for grader registry |
| POST | `/reset` | Start a new episode — returns initial observation |
| POST | `/step` | Execute one action — returns obs, reward, done, info |
| GET | `/state` | Get current environment state snapshot |
| POST | `/grader` | Grade a requested task over configurable runs |
| POST | `/grader/easy` | Explicit easy-task grader endpoint |
| POST | `/grader/medium` | Explicit medium-task grader endpoint |
| POST | `/grader/hard` | Explicit hard-task grader endpoint |
| POST | `/grader/{task_id}` | Task-specific grader route |
| POST | `/grade/easy` | Explicit easy-task score endpoint |
| POST | `/grade/medium` | Explicit medium-task score endpoint |
| POST | `/grade/hard` | Explicit hard-task score endpoint |
| POST | `/grade/{task_id}` | Primary grader endpoint for `easy`/`medium`/`hard` |
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
├── ui/                  # Browser simulation UI (visualization only)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── my_env_v4.py         # Core RL environment (reset/step/state)
├── tasks.py             # Task and grader registry (3 tasks with graders)
├── app.py               # FastAPI server — all API routes
├── rl_policy.py         # Tabular Q-learning policy (reward/penalty learning)
├── inference.py         # Episode runner ([START]/[STEP]/[END] logs)
├── grader.py            # Train/evaluate heuristic or qlearn policy
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

# Run grader with Q-learning training + evaluation (default)
python grader.py --agent qlearn --train-episodes 80 --runs 5

# Heuristic baseline (no learning)
python grader.py --agent heuristic --runs 5

# Run inference (official [START]/[STEP]/[END] format)
python inference.py

# Run inference for a specific task
set MY_ENV_V4_TASK=hard && python inference.py
```

## RL Training Notes

- Learning happens in Python via `rl_policy.py` from reward/penalty signals.
- Q-table is saved to `q_policy.json` (configurable with `--policy-path`).
- Use stochastic vendor mode for broader exploration:
```bash
python grader.py --agent qlearn --train-episodes 120 --runs 8
```
- Use deterministic mode for reproducible regression checks:
```bash
python grader.py --agent qlearn --deterministic-vendors --train-episodes 40 --runs 5
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
#
