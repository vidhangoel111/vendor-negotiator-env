"""
inference.py â€” VendorOS OpenEnv Inference Runner
Runs a full episode for each task and logs in the exact
[START] / [STEP] / [END] format required by the hackathon.

Usage:
    python inference.py                  # runs all 3 tasks
    MY_ENV_V4_TASK=hard python inference.py

Environment variables:
    MY_ENV_V4_TASK          easy | medium | hard | all (default: all)
    API_BASE_URL            LLM base URL          (default: HF router)
    HF_TOKEN                LLM key               (optional)
    OPENAI_API_KEY          LLM key               (optional)
    LOCAL_IMAGE_NAME        optional for from_docker_image() integration
    MODEL_NAME              LLM model id          (default: Qwen/Qwen2.5-72B-Instruct)
    MY_ENV_V4_MAX_STEPS     max steps per episode (default: 20)
"""

from __future__ import annotations

import asyncio
import json
import os
import textwrap
from typing import Any, Dict, List, Optional

from my_env_v4 import MyEnvV4Action, MyEnvV4Env, VendorNegotiationObservation
from rl_policy import QLearningPolicy

# â”€â”€ Config from env â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

API_BASE_URL = os.getenv("API_BASE_URL", "https://router.huggingface.co/v1")
MODEL_NAME = os.getenv("MODEL_NAME", "Qwen/Qwen2.5-72B-Instruct")
HF_TOKEN = os.getenv("HF_TOKEN")
LOCAL_IMAGE_NAME = os.getenv("LOCAL_IMAGE_NAME")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
API_KEY = OPENAI_API_KEY or HF_TOKEN
TASK_NAME = os.getenv("MY_ENV_V4_TASK", "all")
BENCHMARK = os.getenv("MY_ENV_V4_BENCHMARK", "vendor_negotiation_v4")
MAX_STEPS = int(os.getenv("MY_ENV_V4_MAX_STEPS", "20"))
TEMPERATURE = float(os.getenv("MY_ENV_V4_TEMPERATURE", "0.3"))
STOCHASTIC_VENDORS = os.getenv("MY_ENV_V4_STOCHASTIC_VENDORS", "true").strip().lower() in ("1", "true", "yes", "on")
MAX_TOKENS = 512
SUCCESS_SCORE_THRESHOLD = 0.40
RL_POLICY_PATH = os.getenv("RL_POLICY_PATH", "q_policy.json")
RL_TRAIN_EPISODES = int(os.getenv("RL_TRAIN_EPISODES", "0"))

# â”€â”€ System prompt for LLM agent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

SYSTEM_PROMPT = textwrap.dedent("""
You are an autonomous procurement agent negotiating with vendors to purchase items.

Return ONLY valid JSON â€” no markdown, no explanation:
{
  "action_type": "negotiate" | "accept" | "skip" | "finalize",
  "vendor_id": "<V1..V10 or null>",
  "offer_price": <float or null>,
  "reasoning": "<one short sentence>"
}

Strategy:
1. Negotiate with highest-utility vendor first (balance price, quality, reliability)
2. Offer slightly below their quote but above their floor
3. Accept if deal is within budget and quality is acceptable
4. Finalize when no active vendors remain or you have a good deal
5. Skip only if a vendor is clearly unacceptable
""").strip()


# â”€â”€ Logging (exact hackathon format) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def log_start(task: str, env: str, model: str) -> None:
    print(f"[START] task={task} env={env} model={model}", flush=True)


def log_step(step: int, action: str, reward: float, done: bool, error: Optional[str]) -> None:
    safe_action = action.replace("\n", " ").replace("\r", "")[:120]
    error_val = error if error else "null"
    print(
        f"[STEP] step={step} action={safe_action} reward={reward:.2f} "
        f"done={str(done).lower()} error={error_val}",
        flush=True,
    )


def log_end(success: bool, steps: int, score: float, rewards: List[float]) -> None:
    rewards_csv = ",".join(f"{r:.2f}" for r in rewards)
    print(
        f"[END] success={str(success).lower()} steps={steps} "
        f"score={score:.3f} rewards={rewards_csv}",
        flush=True,
    )


# â”€â”€ Prompt builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def fmt_vendor(v) -> str:
    current_price = v.accepted_price if v.accepted_price is not None else v.quote_price
    return (
        f"{v.vendor_id} {v.name} price={current_price} delivery={v.delivery_days}d "
        f"quality={v.quality_score:.2f} reliability={v.reliability_score:.2f} status={v.status}"
    )


def build_user_prompt(obs: VendorNegotiationObservation, step: int) -> str:
    vendors_str = "\n".join(fmt_vendor(v) for v in obs.vendors)
    deals = obs.current_ranked_deals
    deals_str = "None yet"
    if deals:
        deals_str = "\n".join(
            f"  #{i+1} {d['vendor_id']} price={d['accepted_price']} "
            f"score={d['rank_score']:.3f} in_budget={d['within_budget']}"
            for i, d in enumerate(deals)
        )

    return textwrap.dedent(f"""
        Task={obs.task_difficulty}  Step={step}/{MAX_STEPS}
        Item={obs.item_name}  Quantity={obs.quantity_kg}kg
        Budget={obs.budget_per_kg}/kg  Expected={obs.expected_price}/kg
        LastVendor={obs.last_action_vendor_id or 'N/A'}  LastResult={obs.last_action_result}
        CumulativeReward={obs.cumulative_reward:.4f}

        Vendors:
        {vendors_str}

        RankedDeals:
        {deals_str}
    """).strip()


# â”€â”€ Action parser â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def parse_action(raw: str) -> Optional[MyEnvV4Action]:
    cleaned = raw.strip()
    # Strip markdown code fences if present
    if "```" in cleaned:
        parts = cleaned.split("```")
        for part in parts:
            if "{" in part:
                cleaned = part.replace("json", "").strip()
                break
    try:
        data = json.loads(cleaned)
        return MyEnvV4Action(
            action_type=data.get("action_type", "negotiate"),
            vendor_id=data.get("vendor_id"),
            offer_price=data.get("offer_price"),
            reasoning=data.get("reasoning", ""),
        )
    except Exception:
        return None


# â”€â”€ Heuristic fallback (no LLM needed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def heuristic_action(obs: VendorNegotiationObservation) -> MyEnvV4Action:
    active = [v for v in obs.vendors if v.status == "active"]

    if not active:
        return MyEnvV4Action(action_type="finalize", vendor_id=None, reasoning="no active vendors")

    def utility(v):
        price_ok = 1.0 if v.quote_price <= obs.budget_per_kg else 0.6
        return price_ok * 0.40 + v.quality_score * 0.35 + v.reliability_score * 0.25

    best = max(active, key=utility)
    offer = round(min(obs.expected_price, best.quote_price * 0.97), 2)

    return MyEnvV4Action(
        action_type="negotiate",
        vendor_id=best.vendor_id,
        offer_price=offer,
        reasoning=f"heuristic: best utility vendor {best.vendor_id}",
    )


# â”€â”€ LLM agent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def get_agent_action(client: Any, obs: VendorNegotiationObservation, step: int, policy: Optional[QLearningPolicy]) -> MyEnvV4Action:
    if client is None:
        if policy is not None:
            action, _s, _a = policy.select_action(obs, training=True)
            return action
        return heuristic_action(obs)

    prompt = build_user_prompt(obs, step)
    try:
        response = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            temperature=TEMPERATURE,
            max_tokens=MAX_TOKENS,
            stream=False,
        )
        text = (response.choices[0].message.content or "").strip()
        parsed = parse_action(text)
        return parsed if parsed is not None else (policy.select_action(obs, training=True)[0] if policy else heuristic_action(obs))
    except Exception:
        return policy.select_action(obs, training=True)[0] if policy else heuristic_action(obs)


# â”€â”€ Episode runner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async def run_episode(task: str, client: Any, policy: Optional[QLearningPolicy] = None, training: bool = True) -> None:
    env = MyEnvV4Env(task=task, stochastic_vendors=STOCHASTIC_VENDORS)
    rewards: List[float] = []
    steps_taken = 0
    score = 0.0
    success = False

    log_start(task=task, env=BENCHMARK, model=MODEL_NAME)

    try:
        obs = await env.reset()

        for step in range(1, MAX_STEPS + 1):
            # Auto-finalize if no active vendors
            active_count = sum(1 for v in obs.vendors if v.status == "active")
            if client is None and policy is not None:
                action, s, a = policy.select_action(obs, training=training)
            else:
                action = get_agent_action(client, obs, step, policy=None)
                s, a = "", ""

            if active_count == 0 and action.action_type != "finalize":
                action = MyEnvV4Action(
                    action_type="finalize",
                    vendor_id=None,
                    reasoning="auto-finalize: no active vendors",
                )

            result = await env.step(action)
            obs_next = result.observation

            reward_val = float(result.reward.value)
            done = result.done
            error = result.info.get("last_action_error")
            if client is None and policy is not None and s:
                policy.update(s, a, reward_val, obs_next, done)
            obs = obs_next

            rewards.append(reward_val)
            steps_taken = step

            action_str = (
                f"{action.action_type}("
                f"vendor={action.vendor_id},"
                f"offer={action.offer_price})"
            )
            log_step(step=step, action=action_str, reward=reward_val, done=done, error=error)

            if done:
                break

        final_state = env.state()
        score = float(final_state.get("final_score", 0.0))
        score = max(0.0, min(1.0, score))
        success = score >= SUCCESS_SCORE_THRESHOLD

    except Exception as e:
        log_step(
            step=steps_taken + 1,
            action="error",
            reward=0.0,
            done=True,
            error=str(e),
        )
        success = False

    finally:
        try:
            await env.close()
        except Exception:
            pass

    log_end(success=success, steps=steps_taken, score=score, rewards=rewards)


# â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async def main() -> None:
    # Try to initialise LLM client â€” fall back to heuristic if no key
    client = None
    if API_KEY:
        try:
            from openai import OpenAI
            client = OpenAI(base_url=API_BASE_URL, api_key=API_KEY)
        except Exception:
            client = None

    policy: Optional[QLearningPolicy] = None
    if client is None:
        policy = QLearningPolicy.load(RL_POLICY_PATH)
        if RL_TRAIN_EPISODES > 0:
            for _ in range(RL_TRAIN_EPISODES):
                await run_episode(task=TASK_NAME if TASK_NAME != "all" else "medium", client=None, policy=policy, training=True)
                policy.decay()
            policy.save(RL_POLICY_PATH)

    # If TASK_NAME is "all", run all three tasks
    tasks = ["easy", "medium", "hard"] if TASK_NAME == "all" else [TASK_NAME]

    for task in tasks:
        await run_episode(task=task, client=client, policy=policy, training=(client is None))
        if policy is not None:
            policy.decay()
        if len(tasks) > 1:
            print()  # blank line between tasks
    if policy is not None:
        policy.save(RL_POLICY_PATH)


if __name__ == "__main__":
    asyncio.run(main())

