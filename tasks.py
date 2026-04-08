from __future__ import annotations

from typing import Any, Dict, List

PASS_THRESHOLD = 0.40


def _score_from_state(state: Dict[str, Any]) -> float:
    raw = float(state.get("final_score", 0.0))
    return max(0.0, min(1.0, round(raw, 4)))


def grade_easy(state: Dict[str, Any]) -> float:
    return _score_from_state(state)


def grade_medium(state: Dict[str, Any]) -> float:
    return _score_from_state(state)


def grade_hard(state: Dict[str, Any]) -> float:
    return _score_from_state(state)


GRADERS = {
    "easy": grade_easy,
    "medium": grade_medium,
    "hard": grade_hard,
}


TASKS: List[Dict[str, Any]] = [
    {
        "id": "easy",
        "name": "Easy Negotiation Task",
        "difficulty": "easy",
        "max_steps": 24,
        "grader": True,
        "grader_id": "easy",
        "grader_endpoint": "/grade/easy",
    },
    {
        "id": "medium",
        "name": "Medium Negotiation Task",
        "difficulty": "medium",
        "max_steps": 24,
        "grader": True,
        "grader_id": "medium",
        "grader_endpoint": "/grade/medium",
    },
    {
        "id": "hard",
        "name": "Hard Negotiation Task",
        "difficulty": "hard",
        "max_steps": 24,
        "grader": True,
        "grader_id": "hard",
        "grader_endpoint": "/grade/hard",
    },
]


def task_ids() -> List[str]:
    return [t["id"] for t in TASKS]


def has_required_graders() -> bool:
    ids = task_ids()
    return len(ids) >= 3 and all(t.get("grader") for t in TASKS) and all(tid in GRADERS for tid in ids)
