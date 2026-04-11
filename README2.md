# Vendor Negotiation RL Environment - Complete Project Guide

## 1) Problem Statement
This project simulates a real procurement problem: a company needs to buy goods (for example, rice) from multiple vendors while balancing:
- price,
- quality,
- delivery speed,
- reliability,
- and budget limits.

The agent has to decide step by step whether to negotiate, accept, skip, or finalize. There is no single fixed rule that always works, especially in medium and hard tasks where vendors may deny negotiation or stay above budget.

In simple words: this is a decision-making training ground where the system learns how to make better vendor choices over time.

---

## 2) What This Project Is
This is an OpenEnv-style Reinforcement Learning environment with:
- a Python backend (FastAPI),
- a simulation environment (vendor negotiation logic),
- grading endpoints,
- an optional Q-learning policy,
- an inference runner,
- and a browser UI.

It supports three difficulty levels:
- easy,
- medium,
- hard.

---

## 3) Quick Introduction to RL (Reinforcement Learning)
Reinforcement Learning means learning by trying actions and getting feedback.

At each step:
1. Agent reads the current state (vendor quotes, quality, budget, etc.).
2. Agent picks an action (negotiate/accept/skip/finalize).
3. Environment returns a reward (good or bad signal) and next state.
4. Agent keeps repeating until episode ends.

Goal: maximize long-term reward and final score, not just one-step profit.

In this project, RL is useful because vendor decisions are sequential and trade-off heavy. A choice now affects future options.

---

## 4) Why Use This RL Environment
Benefits:
- Realistic workflow: models a common business problem (procurement negotiation).
- Safe experimentation: you can test strategies without real financial risk.
- Deterministic grading option: helps debugging and fair comparisons.
- Stochastic mode: helps test robustness under changing vendor behavior.
- Multi-objective decisions: balances cost, quality, reliability, and speed.
- API-first design: easy to integrate with web apps, agents, and validators.
- Task tiers: easy -> medium -> hard helps progressive learning.

---

## 5) Tech Stack (Frontend, Backend, RL, Deployment)

### Frontend
- HTML (ui/index.html)
  Used to define the dashboard structure, controls, and result panels.
  Why used: simple, lightweight, easy to host.

- CSS (ui/style.css)
  Used to style cards, tables, tabs, badges, and responsive layout.
  Why used: custom visual design with mobile-friendly behavior.

- JavaScript (ui/app.js)
  Used for UI interactions, API calls, state updates, and live step rendering.
  Why used: direct browser-side control over the simulation loop and visuals.

### Backend
- Python 3.11
  Main language for environment logic, API, and policy utilities.
  Why used: strong ecosystem for RL and data modeling.

- FastAPI
  Used to expose endpoints like /reset, /step, /state, /grade, /baseline.
  Why used: fast API development with clear request/response models.

- Pydantic
  Used for typed models (observation, action, reward, request schemas).
  Why used: input validation and predictable data contracts.

- Uvicorn
  ASGI server used to run FastAPI app in local/dev/deployment runtime.
  Why used: simple production-ready app serving.

### RL / Agent Components
- Custom environment (my_env_v4.py)
  Contains the simulation world and reward logic.

- Tabular Q-learning policy (rl_policy.py)
  Optional policy that can run/train without LLM.

- Inference runner (inference.py)
  Runs full episodes and prints strict logs in required format.

### Config / Packaging / Deployment
- openenv.yaml
  Manifest-style file describing tasks, rewards, endpoints, env vars, and deployment metadata.

- Dockerfile
  Container build file for deployment on Hugging Face Spaces (Docker SDK).

- requirements.txt + pyproject.toml
  Dependency and package metadata.

- Hugging Face routing support
  API base default includes Hugging Face router URL for model calls.

---

## 6) How Logic and Data Move (Simple View)

### Frontend to Backend
Browser sends JSON requests:
- POST /reset -> start new episode
- POST /agent-step or /step -> perform next action
- GET /state -> inspect current state
- POST /feedback -> apply human override feedback

### Backend to Environment
app.py creates/uses MyEnvV4Env and calls:
- reset()
- step(action)
- state()
- close()

### Environment to Backend
Environment returns:
- observation (vendor list, step, reward context),
- reward (value + event),
- done flag,
- info (errors/final score hints).

### Backend to Frontend
Backend serializes model data to JSON.
UI renders vendor table, action feed, reward progression, and result summary.

### Grading Path
/grade and /grader endpoints run episodes and return:
- avg score,
- best/worst score,
- pass/fail against threshold.

---

## 7) Core Logic Building Blocks

### A) Task difficulty setup
Each task (easy/medium/hard) changes:
- budget tightness,
- denial probability,
- pricing noise,
- negotiation cooperativeness.

### B) Vendor generation
At reset, vendor pool is generated from catalogue + task settings.
In stochastic mode, random noise/denials are applied.

### C) Actions
Supported actions:
- negotiate,
- accept,
- skip,
- finalize.

### D) Reward shaping
Rewards encourage:
- good in-budget deals,
- fewer wasted steps,
- better ranked vendor quality.
Penalties discourage:
- no-deal endings,
- over-budget closure,
- poor action choices.

### E) Final score
Final score uses best closed deal quality + efficiency bonus and is clamped to [0, 1].

### F) Preference memory loop
Backend stores simple vendor preference and task reputation signals in JSON.
This lets the agent-step policy slightly adapt over repeated runs.

---

## 8) Data Models Used
Main structured objects:
- VendorState
- VendorNegotiationObservation
- MyEnvV4Action
- MyEnvV4Reward
- StepResult

These keep API data consistent and reduce runtime ambiguity.

---

## 9) Project Structure and What Each File Contains

### Root files
- app.py
  Main FastAPI application. Contains API routes, episode lifecycle, grader endpoints, baseline endpoint, and preference feedback logic.

- my_env_v4.py
  Core environment. Defines vendor/task configs, action handling, reward logic, state transitions, and final scoring.

- rl_policy.py
  Tabular Q-learning policy implementation: state compression, action selection, Q-value update, save/load.

- inference.py
  Episode runner for autonomous execution. Can use LLM client or fallback RL/heuristics and logs [START]/[STEP]/[END].

- grader.py
  CLI grader utility. Runs episodes repeatedly and computes summary metrics for each task.

- tasks.py
  Task registry and grader mapping. Includes pass threshold and helper checks.

- openenv.yaml
  Open environment metadata: tasks, action/observation definitions, rewards, endpoints, env variables, deployment block.

- OPENENV_SUBMISSION.md
  Short compliance summary for OpenEnv-style submission checks.

- Dockerfile
  Container instructions for deploying API/UI in Docker (Hugging Face Spaces target).

- requirements.txt
  Python dependencies used at runtime.

- pyproject.toml
  Package metadata, dependencies, and script entry (server command).

- q_policy.json
  Saved Q-learning table/config snapshot.

- vendor_feedback_q.json
  Persisted preference and reputation stats from feedback loop.

- README.md
  Existing long handbook + project notes.

### server folder
- server/app.py
  Entry runner that starts Uvicorn using app module.

- server/__init__.py
  Package marker file.

### ui folder
- ui/index.html
  UI layout and controls.

- ui/style.css
  Visual design and responsive behavior.

- ui/app.js
  Frontend logic, API calls, run loop, rendering, and interaction handling.

---

## 10) API Endpoints (Practical List)
Commonly used endpoints:
- GET /health
- GET /tasks
- GET /graders
- POST /reset
- POST /step
- GET /state
- POST /agent-step
- POST /feedback
- POST /grader
- POST /grade
- POST /grade/easy
- POST /grade/medium
- POST /grade/hard
- GET/POST /baseline

Alias endpoints under /api/* are also available for reset/step/state/feedback/tasks/baseline.

---

## 11) How to Run Locally

### Prerequisites
- Python 3.11+
- pip

### Steps
1. Create and activate virtual environment:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

2. Install dependencies:

```powershell
pip install -r requirements.txt
```

3. Start API + UI server:

```powershell
uvicorn app:app --host 0.0.0.0 --port 7860
```

4. Open browser:
- http://localhost:7860/ui/index.html

### Run grading from CLI
```powershell
python grader.py
python grader.py --task all --runs 5 --deterministic-vendors
```

### Run inference runner
```powershell
python inference.py
```

Optional environment variables for inference:
- MY_ENV_V4_TASK=easy|medium|hard|all
- API_BASE_URL
- MODEL_NAME
- OPENAI_API_KEY or HF_TOKEN
- RL_POLICY_PATH
- RL_TRAIN_EPISODES

---

## 12) Deployment (Hugging Face)
This project is configured for deployment on Hugging Face Spaces using Docker.

Evidence in project config:
- openenv.yaml deployment.platform = Hugging Face Spaces
- openenv.yaml default_space_config.sdk = docker
- Dockerfile exposes port 7860 and runs uvicorn app:app
- OPENENV_SUBMISSION.md states Dockerized HF Space API deployment status as PASS

Note:
The repository does not include a public Space URL in tracked files. If you want, add the final Space link here after publishing.

Suggested section to fill later:
- Live Space URL: [(https://huggingface.co/spaces/vidhangoel01/vendor-negotiator-env)]

---

## 13) Important Design Notes
- Scores are normalized to 0..1.
- Reward per step is bounded to -1..1.
- Three difficulty levels are required and present.
- Supports both deterministic and stochastic vendor behavior.
- UI includes human override flow and feedback penalty simulation.
- Policy memory is persisted in local JSON files.

---

## 14) In One Line
This project is a full, practical RL-style procurement simulator with API, UI, grading, and deployment support, built to test and improve vendor negotiation decisions in a controlled environment.
