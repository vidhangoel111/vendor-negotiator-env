"""
grader.py - VendorOS OpenEnv Grader

Supports:
- heuristic policy (baseline)
- qlearn policy (reward-driven, trains from penalties/rewards)
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
from typing import List, Optional

from my_env_v4 import MyEnvV4Action, MyEnvV4Env, VendorNegotiationObservation
from rl_policy import QLearningPolicy


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
        reasoning=f"heuristic: best utility = {best.vendor_id}",
    )


async def run_episode(
    task: str,
    seed: int | None = None,
    verbose: bool = False,
    stochastic_vendors: bool = True,
    policy: Optional[QLearningPolicy] = None,
    training: bool = False,
) -> dict:
    env = MyEnvV4Env(task=task, seed=seed, stochastic_vendors=stochastic_vendors)
    obs = await env.reset()

    steps = 0
    rewards = []
    done = False

    while not done and steps < env.MAX_STEPS:
        if policy is not None:
            action, s, a = policy.select_action(obs, training=training)
        else:
            action = heuristic_action(obs)
            s, a = "", ""

        result = await env.step(action)

        steps += 1
        rewards.append(round(result.reward.value, 4))
        obs_next = result.observation
        if policy is not None and s:
            policy.update(s, a, float(result.reward.value), obs_next, result.done)
        obs = obs_next
        done = result.done

        if verbose:
            print(
                f"  step={steps:2d} action={action.action_type}(vendor={action.vendor_id}, offer={action.offer_price}) "
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
        "stochastic_vendors": stochastic_vendors,
    }


async def grade_task(
    task: str,
    runs: int = 3,
    verbose: bool = False,
    stochastic_vendors: bool = True,
    policy: Optional[QLearningPolicy] = None,
) -> dict:
    scores = []
    results = []

    for i in range(runs):
        r = await run_episode(
            task=task,
            seed=i * 42,
            verbose=verbose,
            stochastic_vendors=stochastic_vendors,
            policy=policy,
            training=False,
        )
        scores.append(r["score"])
        results.append(r)

        status = "OK" if r["success"] else "X"
        print(f"  [{status}] run {i+1}/{runs} - score={r['score']:.4f} steps={r['steps']} cumrew={r['cumulative_reward']:+.4f}")

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


async def main(
    tasks: List[str],
    runs: int,
    verbose: bool,
    stochastic_vendors: bool,
    agent: str,
    train_episodes: int,
    policy_path: str,
):
    print("=" * 60)
    print("  VendorOS - OpenEnv Grader")
    print(f"  Agent: {agent}")
    print(f"  Vendor mode: {'stochastic' if stochastic_vendors else 'deterministic'}")
    print("=" * 60)

    policy = QLearningPolicy.load(policy_path) if agent == "qlearn" else None

    if policy is not None and train_episodes > 0:
        print(f"\n> Training Q-policy for {train_episodes} episodes...")
        for i in range(train_episodes):
            t = tasks[i % len(tasks)]
            await run_episode(
                task=t,
                seed=10_000 + i,
                verbose=False,
                stochastic_vendors=stochastic_vendors,
                policy=policy,
                training=True,
            )
            policy.decay()
        policy.save(policy_path)
        print("  Training complete.")

    all_results = {}
    for task in tasks:
        print(f"\nTask: {task.upper()}")
        result = await grade_task(
            task=task,
            runs=runs,
            verbose=verbose,
            stochastic_vendors=stochastic_vendors,
            policy=policy,
        )
        all_results[task] = result
        print(
            f"  avg={result['avg_score']:.4f} best={result['best_score']:.4f} "
            f"worst={result['worst_score']:.4f} success_rate={result['success_rate']:.0%}"
        )

    print("\n" + "=" * 60)
    print("  GRADER SUMMARY")
    print("=" * 60)
    print(f"  {'Task':<10} {'Avg Score':<12} {'Best':<10} {'Success Rate'}")
    print(f"  {'-'*10} {'-'*12} {'-'*10} {'-'*12}")

    all_avgs = []
    for task, r in all_results.items():
        status = "OK" if r["avg_score"] >= 0.40 else "X"
        print(f"  [{status}] {task:<8} {r['avg_score']:<12.4f} {r['best_score']:<10.4f} {r['success_rate']:.0%}")
        all_avgs.append(r["avg_score"])

    overall = round(statistics.mean(all_avgs), 4)
    print(f"\n  Overall average score: {overall:.4f}")
    print("  Pass threshold:        0.4000")
    print(f"  Status: {'PASS' if overall >= 0.40 else 'FAIL'}")
    print("=" * 60)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="VendorOS OpenEnv Grader")
    parser.add_argument("--task", choices=["easy", "medium", "hard", "all"], default="all")
    parser.add_argument("--runs", type=int, default=3, help="Number of eval runs per task")
    parser.add_argument("--verbose", action="store_true", help="Print every step")
    parser.add_argument("--deterministic-vendors", action="store_true", help="Disable stochastic vendor dynamics")
    parser.add_argument("--agent", choices=["heuristic", "qlearn"], default="qlearn")
    parser.add_argument("--train-episodes", type=int, default=60, help="Q-learning training episodes before evaluation")
    parser.add_argument("--policy-path", default="q_policy.json", help="Path to save/load Q-policy table")
    args = parser.parse_args()

    tasks_to_run = ["easy", "medium", "hard"] if args.task == "all" else [args.task]

    asyncio.run(
        main(
            tasks=tasks_to_run,
            runs=args.runs,
            verbose=args.verbose,
            stochastic_vendors=not args.deterministic_vendors,
            agent=args.agent,
            train_episodes=args.train_episodes,
            policy_path=args.policy_path,
        )
    )
