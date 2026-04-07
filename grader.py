"""
grader.py — VendorOS OpenEnv Grader
Runs all 3 tasks (easy, medium, hard) with a heuristic agent
and reports scores in OpenEnv format.

Usage:
    python grader.py
    python grader.py --task easy
    python grader.py --runs 5
"""

import argparse
import asyncio
import statistics
import sys
from typing import List

from my_env_v4 import MyEnvV4Action, MyEnvV4Env, VendorNegotiationObservation


# ── Heuristic agent ──────────────────────────────────────────────────────────

def heuristic_action(obs: VendorNegotiationObservation) -> MyEnvV4Action:
    """
    Greedy heuristic: score each active vendor by
    price fitness, quality, and reliability. Negotiate
    with the best one. Finalize when no active vendors remain.
    """
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
        reasoning=f"heuristic: best utility = {best.vendor_id}",
    )


# ── Single episode runner ─────────────────────────────────────────────────────

async def run_episode(task: str, seed: int = None, verbose: bool = False) -> dict:
    env = MyEnvV4Env(task=task, seed=seed)
    obs = await env.reset()

    steps = 0
    rewards = []
    done = False

    while not done and steps < env.MAX_STEPS:
        action = heuristic_action(obs)
        result = await env.step(action)

        steps += 1
        rewards.append(round(result.reward.value, 4))
        obs = result.observation
        done = result.done

        if verbose:
            print(
                f"  step={steps:2d} action={action.action_type}("
                f"vendor={action.vendor_id}, offer={action.offer_price}) "
                f"reward={result.reward.value:+.4f} event={result.reward.event}"
            )

    final = env.state()
    score = final.get("final_score", 0.0)
    await env.close()

    return {
        "task": task,
        "seed": seed,
        "steps": steps,
        "score": round(score, 4),
        "cumulative_reward": round(sum(rewards), 4),
        "rewards": rewards,
        "success": score >= 0.40,
    }


# ── Multi-run grader ──────────────────────────────────────────────────────────

async def grade_task(task: str, runs: int = 3, verbose: bool = False) -> dict:
    scores = []
    results = []

    for i in range(runs):
        r = await run_episode(task=task, seed=i * 42, verbose=verbose)
        scores.append(r["score"])
        results.append(r)

        status = "✓" if r["success"] else "✗"
        print(f"  [{status}] run {i+1}/{runs} — score={r['score']:.4f}  steps={r['steps']}  cumrew={r['cumulative_reward']:+.4f}")

    avg = round(statistics.mean(scores), 4)
    best = round(max(scores), 4)
    worst = round(min(scores), 4)
    success_rate = sum(1 for r in results if r["success"]) / runs

    return {
        "task": task,
        "runs": runs,
        "avg_score": avg,
        "best_score": best,
        "worst_score": worst,
        "success_rate": success_rate,
        "all_scores": scores,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

async def main(tasks: List[str], runs: int, verbose: bool):
    print("=" * 60)
    print("  VendorOS — OpenEnv Grader")
    print("  Heuristic agent · No LLM required")
    print("=" * 60)

    all_results = {}

    for task in tasks:
        print(f"\n▶ Task: {task.upper()}")
        result = await grade_task(task=task, runs=runs, verbose=verbose)
        all_results[task] = result

        print(f"  avg={result['avg_score']:.4f}  best={result['best_score']:.4f}  "
              f"worst={result['worst_score']:.4f}  success_rate={result['success_rate']:.0%}")

    # ── Summary ──────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("  GRADER SUMMARY")
    print("=" * 60)
    print(f"  {'Task':<10} {'Avg Score':<12} {'Best':<10} {'Success Rate'}")
    print(f"  {'-'*10} {'-'*12} {'-'*10} {'-'*12}")

    all_avgs = []
    for task, r in all_results.items():
        status = "✓" if r["avg_score"] >= 0.40 else "✗"
        print(f"  [{status}] {task:<8} {r['avg_score']:<12.4f} {r['best_score']:<10.4f} {r['success_rate']:.0%}")
        all_avgs.append(r["avg_score"])

    overall = round(statistics.mean(all_avgs), 4)
    print(f"\n  Overall average score: {overall:.4f}")
    print(f"  Pass threshold:        0.4000")
    print(f"  Status: {'✓ PASS' if overall >= 0.40 else '✗ FAIL'}")
    print("=" * 60)

    # ── OpenEnv format output ─────────────────────────────────────────────
    print("\n[GRADER OUTPUT — OpenEnv format]")
    for task, r in all_results.items():
        print(f"task={task} avg_score={r['avg_score']:.4f} best={r['best_score']:.4f} success_rate={r['success_rate']:.2f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="VendorOS OpenEnv Grader")
    parser.add_argument("--task", choices=["easy", "medium", "hard", "all"], default="all")
    parser.add_argument("--runs", type=int, default=3, help="Number of runs per task")
    parser.add_argument("--verbose", action="store_true", help="Print every step")
    args = parser.parse_args()

    tasks_to_run = ["easy", "medium", "hard"] if args.task == "all" else [args.task]

    asyncio.run(main(tasks=tasks_to_run, runs=args.runs, verbose=args.verbose))