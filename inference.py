import asyncio
import json
import os
import textwrap
from typing import List, Optional

from openai import OpenAI

from my_env_v4 import MyEnvV4Action, MyEnvV4Env, VendorNegotiationObservation


LOCAL_IMAGE_NAME = os.getenv("LOCAL_IMAGE_NAME") or os.getenv("IMAGE_NAME")
API_KEY = os.getenv("OPENAI_API_KEY") or os.getenv("HF_TOKEN") or os.getenv("API_KEY")
API_BASE_URL = os.getenv("API_BASE_URL", "https://router.huggingface.co/v1")
MODEL_NAME = os.getenv("MODEL_NAME", "Qwen/Qwen2.5-72B-Instruct")
TASK_NAME = os.getenv("MY_ENV_V4_TASK", "easy")
BENCHMARK = os.getenv("MY_ENV_V4_BENCHMARK", "vendor_negotiation_v4")
MAX_STEPS = int(os.getenv("MY_ENV_V4_MAX_STEPS", "20"))
TEMPERATURE = float(os.getenv("MY_ENV_V4_TEMPERATURE", "0.3"))
MAX_TOKENS = 512
SUCCESS_SCORE_THRESHOLD = 0.40


SYSTEM_PROMPT = textwrap.dedent(
    """
    You are an autonomous procurement agent negotiating with vendors to purchase items.

    Return ONLY valid JSON:
    {
      "action_type": "negotiate" | "accept" | "skip" | "finalize",
      "vendor_id": "<V1..V10 or null>",
      "offer_price": <float or null>,
      "reasoning": "<one short sentence>"
    }

    Prioritize in order:
    1) In-budget prices
    2) Quality and reliability
    3) Faster delivery
    4) Fewer steps
    """
).strip()


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


def _fmt_vendor(v) -> str:
    current_price = v.accepted_price if v.accepted_price is not None else v.quote_price
    return (
        f"{v.vendor_id} {v.name} price={current_price} delivery={v.delivery_days} "
        f"quality={v.quality_score:.2f} reliability={v.reliability_score:.2f} status={v.status}"
    )


def build_user_prompt(obs: VendorNegotiationObservation, step: int) -> str:
    vendors = "\n".join(_fmt_vendor(v) for v in obs.vendors)
    deals = obs.current_ranked_deals
    deals_text = "None"
    if deals:
        deals_text = "\n".join(
            f"#{i+1} {d['vendor_id']} price={d['accepted_price']} score={d['rank_score']:.3f} in_budget={d['within_budget']}"
            for i, d in enumerate(deals)
        )

    return textwrap.dedent(
        f"""
        Task={obs.task_difficulty} Step={step}/{MAX_STEPS}
        Item={obs.item_name} Quantity={obs.quantity_kg}
        Budget={obs.budget_per_kg} Expected={obs.expected_price}
        LastActionVendor={obs.last_action_vendor_id or 'N/A'} LastResult={obs.last_action_result}
        CumulativeReward={obs.cumulative_reward:.4f}

        Vendors:
        {vendors}

        RankedDeals:
        {deals_text}
        """
    ).strip()


def _parse_action(raw: str) -> Optional[MyEnvV4Action]:
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```")[1]
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
    try:
        data = json.loads(cleaned.strip())
        return MyEnvV4Action(
            action_type=data.get("action_type", "negotiate"),
            vendor_id=data.get("vendor_id"),
            offer_price=data.get("offer_price"),
            reasoning=data.get("reasoning", ""),
        )
    except Exception:
        return None


def _heuristic(obs: VendorNegotiationObservation) -> MyEnvV4Action:
    active = [v for v in obs.vendors if v.status == "active"]
    if not active:
        return MyEnvV4Action(action_type="finalize", vendor_id=None)

    def score(v):
        price_ok = 1.0 if v.quote_price <= obs.budget_per_kg else 0.5
        return price_ok * 0.4 + v.quality_score * 0.35 + v.reliability_score * 0.25

    best = max(active, key=score)
    offer = round(min(obs.expected_price, best.quote_price * 0.97), 2)
    return MyEnvV4Action(
        action_type="negotiate",
        vendor_id=best.vendor_id,
        offer_price=offer,
        reasoning="heuristic fallback",
    )


def get_agent_action(client: Optional[OpenAI], obs: VendorNegotiationObservation, step: int) -> MyEnvV4Action:
    if client is None:
        return _heuristic(obs)

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
        parsed = _parse_action(text)
        return parsed if parsed is not None else _heuristic(obs)
    except Exception:
        return _heuristic(obs)


async def main() -> None:
    client: Optional[OpenAI] = None
    if API_KEY:
        client = OpenAI(base_url=API_BASE_URL, api_key=API_KEY)

    env = await MyEnvV4Env.from_docker_image(LOCAL_IMAGE_NAME)

    rewards: List[float] = []
    steps_taken = 0
    score = 0.0
    success = False

    log_start(task=TASK_NAME, env=BENCHMARK, model=MODEL_NAME)

    try:
        obs = await env.reset()

        for step in range(1, MAX_STEPS + 1):
            action = get_agent_action(client, obs, step)

            active_count = sum(1 for v in obs.vendors if v.status == "active")
            if active_count == 0 and action.action_type != "finalize":
                action = MyEnvV4Action(action_type="finalize", vendor_id=None, reasoning="auto-finalize")

            result = await env.step(action)
            obs = result.observation

            reward_val = float(result.reward.value)
            done = result.done
            error = result.info.get("last_action_error")

            rewards.append(reward_val)
            steps_taken = step

            action_str = f"{action.action_type}(vendor={action.vendor_id},offer={action.offer_price})"
            log_step(step=step, action=action_str, reward=reward_val, done=done, error=error)

            if done:
                break

        score = float(env.state().get("final_score", 0.0))
        score = max(0.0, min(1.0, score))
        success = score >= SUCCESS_SCORE_THRESHOLD

    except Exception:
        success = False
    finally:
        try:
            await env.close()
        except Exception:
            pass

        log_end(success=success, steps=steps_taken, score=score, rewards=rewards)


if __name__ == "__main__":
    asyncio.run(main())