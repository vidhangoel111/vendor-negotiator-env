from __future__ import annotations

import argparse
import asyncio
import statistics
from typing import Dict, List, Optional

from my_env_v4 import MyEnvV4Action, MyEnvV4Env
from tasks import GRADERS, PASS_THRESHOLD, TASKS


def _task_ids() -> List[str]:
    return [str(t["id"]) for t in TASKS]


def _heuristic_action() -> MyEnvV4Action:
    return MyEnvV4Action(action_type="finalize", vendor_id=None, reasoning="baseline finalize")


async def _run_once(task_id: str, seed: Optional[int], stochastic_vendors: bool) -> float:
    env = MyEnvV4Env(task=task_id, seed=seed, stochastic_vendors=stochastic_vendors)
    await env.reset()
    done = False
    while not done:
        step_result = await env.step(_heuristic_action())
        done = bool(step_result.done)
    final_state = env.state()
    await env.close()
    return float(GRADERS[task_id](final_state))


async def grade_task(task_id: str, runs: int, stochastic_vendors: bool) -> Dict[str, float]:
    scores: List[float] = []
    for i in range(runs):
        scores.append(await _run_once(task_id, seed=i * 42, stochastic_vendors=stochastic_vendors))

    avg_score = round(statistics.mean(scores), 4)
    return {
        "task": task_id,
        "runs": runs,
        "avg_score": avg_score,
        "best_score": round(max(scores), 4),
        "worst_score": round(min(scores), 4),
        "pass_threshold": PASS_THRESHOLD,
        "pass": avg_score >= PASS_THRESHOLD,
    }


async def main(task: str, runs: int, deterministic_vendors: bool) -> None:
    task_ids = _task_ids() if task == "all" else [task]
    out = {}
    for tid in task_ids:
        out[tid] = await grade_task(tid, runs=runs, stochastic_vendors=not deterministic_vendors)
        r = out[tid]
        print(
            f"{tid}: avg={r['avg_score']:.4f} best={r['best_score']:.4f} "
            f"worst={r['worst_score']:.4f} pass={r['pass']}"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Vendor Negotiation deterministic grader")
    parser.add_argument("--task", choices=["easy", "medium", "hard", "all"], default="all")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--deterministic-vendors", action="store_true")
    args = parser.parse_args()
    asyncio.run(main(task=args.task, runs=args.runs, deterministic_vendors=args.deterministic_vendors))
