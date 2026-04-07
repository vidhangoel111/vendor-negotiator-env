from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from my_env_v4 import MyEnvV4Action, VendorNegotiationObservation


@dataclass
class QConfig:
    alpha: float = 0.25
    gamma: float = 0.92
    epsilon: float = 0.20
    epsilon_min: float = 0.03
    epsilon_decay: float = 0.995


class QLearningPolicy:
    """Simple tabular Q-learner over compressed procurement states.

    Action space: vendor_id (negotiate that vendor) or finalize.
    """

    def __init__(self, cfg: Optional[QConfig] = None):
        self.cfg = cfg or QConfig()
        self.q: Dict[str, Dict[str, float]] = {}

    @staticmethod
    def _state_key(obs: VendorNegotiationObservation) -> str:
        active = [v for v in obs.vendors if v.status == "active"]
        deals = [v for v in obs.vendors if v.status == "deal_closed"]
        active_n = min(len(active), 10)
        deals_n = min(len(deals), 10)
        step_bin = min(obs.step_number // 4, 6)
        if active:
            best_quote = min(v.quote_price for v in active)
            gap = (best_quote - obs.budget_per_kg) / max(obs.budget_per_kg, 1.0)
            if gap <= -0.08:
                budget_bin = "safe"
            elif gap <= 0.03:
                budget_bin = "tight"
            else:
                budget_bin = "over"
        else:
            budget_bin = "none"
        return f"t={obs.task_difficulty}|s={step_bin}|a={active_n}|d={deals_n}|b={budget_bin}"

    @staticmethod
    def _actions(obs: VendorNegotiationObservation) -> List[str]:
        actions: List[str] = [v.vendor_id for v in obs.vendors if v.status == "active"]
        actions.append("__finalize__")
        return actions

    def _ensure_state(self, s: str, actions: List[str]) -> None:
        if s not in self.q:
            self.q[s] = {a: 0.0 for a in actions}
            return
        for a in actions:
            self.q[s].setdefault(a, 0.0)

    def _greedy(self, s: str, actions: List[str]) -> str:
        self._ensure_state(s, actions)
        return max(actions, key=lambda a: self.q[s].get(a, 0.0))

    def select_action(self, obs: VendorNegotiationObservation, training: bool = True) -> Tuple[MyEnvV4Action, str, str]:
        s = self._state_key(obs)
        actions = self._actions(obs)
        self._ensure_state(s, actions)

        explore = training and (random.random() < self.cfg.epsilon)
        a = random.choice(actions) if explore else self._greedy(s, actions)

        if a == "__finalize__":
            return MyEnvV4Action(action_type="finalize", vendor_id=None, reasoning="q-policy finalize"), s, a

        vendor = next(v for v in obs.vendors if v.vendor_id == a)
        offer = round(min(obs.expected_price, vendor.quote_price * 0.97), 2)
        return (
            MyEnvV4Action(
                action_type="negotiate",
                vendor_id=a,
                offer_price=offer,
                reasoning="q-policy negotiate",
            ),
            s,
            a,
        )

    def update(self, s: str, a: str, r: float, obs_next: VendorNegotiationObservation, done: bool) -> None:
        next_actions = self._actions(obs_next)
        s2 = self._state_key(obs_next)
        self._ensure_state(s2, next_actions)

        q_sa = self.q[s].get(a, 0.0)
        target = r if done else (r + self.cfg.gamma * max(self.q[s2].get(x, 0.0) for x in next_actions))
        self.q[s][a] = q_sa + self.cfg.alpha * (target - q_sa)

    def decay(self) -> None:
        self.cfg.epsilon = max(self.cfg.epsilon_min, self.cfg.epsilon * self.cfg.epsilon_decay)

    def save(self, path: str) -> None:
        p = Path(path)
        payload = {
            "config": {
                "alpha": self.cfg.alpha,
                "gamma": self.cfg.gamma,
                "epsilon": self.cfg.epsilon,
                "epsilon_min": self.cfg.epsilon_min,
                "epsilon_decay": self.cfg.epsilon_decay,
            },
            "q": self.q,
        }
        p.write_text(json.dumps(payload), encoding="utf-8")

    @classmethod
    def load(cls, path: str) -> "QLearningPolicy":
        p = Path(path)
        if not p.exists():
            return cls()
        payload = json.loads(p.read_text(encoding="utf-8"))
        cfg_data = payload.get("config", {})
        cfg = QConfig(
            alpha=float(cfg_data.get("alpha", 0.25)),
            gamma=float(cfg_data.get("gamma", 0.92)),
            epsilon=float(cfg_data.get("epsilon", 0.20)),
            epsilon_min=float(cfg_data.get("epsilon_min", 0.03)),
            epsilon_decay=float(cfg_data.get("epsilon_decay", 0.995)),
        )
        obj = cls(cfg)
        obj.q = {k: {ak: float(av) for ak, av in v.items()} for k, v in payload.get("q", {}).items()}
        return obj
