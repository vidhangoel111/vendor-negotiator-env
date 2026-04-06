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

## Observation Space
`VendorNegotiationObservation` contains:
- `vendors` (list of all vendor states)
- `step_number`, `budget_per_kg`, `expected_price`, `quantity_kg`, `item_name`
- `task_difficulty`
- `last_action_vendor_id`, `last_action_result`
- `cumulative_reward`, `episode_done`
- `current_ranked_deals`

## Action Space
`MyEnvV4Action` fields:
- `action_type`: `negotiate | accept | skip | finalize`
- `vendor_id`: optional (`V1..V10`)
- `offer_price`: optional
- `reasoning`: optional

## Reward Design
Dense reward is emitted each step:
- Positive for accepted deals and efficient progress
- Negative for invalid/low-value behavior (invalid vendor, over-budget acceptance, wasteful flow)
- Terminal reward on `finalize` reflects best deal quality and efficiency bonus
- Reward value is clamped to `[-1.0, 1.0]`

## Tasks and Difficulty
- `easy`: low denial rate, clearer optimal vendors
- `medium`: stronger trade-offs between price and service quality
- `hard`: higher denial rate, tighter budget pressure

Each task has deterministic final score logic in `[0.0, 1.0]` from `env.state()["final_score"]`.

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
. .venv/Scripts/activate  # Windows PowerShell: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Local Usage
### 1) Run API server
```bash
uvicorn app:app --host 127.0.0.1 --port 8000
```

### 2) Run baseline inference
```bash
set MY_ENV_V4_TASK=easy
set OPENAI_API_KEY=your_key
python inference.py
```

`inference.py` emits only:
- `[START] ...`
- `[STEP] ...`
- `[END] ...`

### 3) Run all three tasks (manual)
```bash
set MY_ENV_V4_TASK=easy
python inference.py
set MY_ENV_V4_TASK=medium
python inference.py
set MY_ENV_V4_TASK=hard
python inference.py
```

## Baseline Score Notes
- Baseline score is reported per run in `[END] score=<value>`.
- Final score is deterministic for the same environment state.
- For reproducibility testing, set a fixed seed when constructing the env in custom scripts.

## Required Environment Variables
- `API_BASE_URL` (default: `https://router.huggingface.co/v1`)
- `MODEL_NAME` (default: `Qwen/Qwen2.5-72B-Instruct`)
- `OPENAI_API_KEY` (preferred)
- `HF_TOKEN` (optional alternative)
- `LOCAL_IMAGE_NAME` (optional, for `from_docker_image()`)
- `MY_ENV_V4_TASK` (`easy|medium|hard`)

## Docker / HF Space
Build and run locally:
```bash
docker build -t vendor-negotiation-env .
docker run -p 8000:8000 vendor-negotiation-env
```

Container default entrypoint serves FastAPI on port `8000`, suitable for HF Space validator ping checks (`/health`) and reset/step/state API calls.

## OpenEnv Validation
If `openenv` CLI is available in your environment:
```bash
openenv validate .
```

## Notes
This submission is API-first for deployment and includes an inference script for baseline reproducibility.