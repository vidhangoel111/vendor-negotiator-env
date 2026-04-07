from __future__ import annotations

import os
import random
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class VendorState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vendor_id: str
    name: str
    quote_price: float
    base_price: float
    delivery_days: int
    quality_score: float
    reliability_score: float
    negotiation_margin: float
    status: Literal["active", "denied", "negotiating", "deal_closed"]
    accepted_price: Optional[float] = None
    negotiation_attempts: int = 0
    rank_score: float = 0.0


class VendorNegotiationObservation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vendors: List[VendorState]
    step_number: int
    budget_per_kg: float
    expected_price: float
    quantity_kg: int
    item_name: str
    task_difficulty: Literal["easy", "medium", "hard"]
    last_action_vendor_id: Optional[str]
    last_action_result: Literal["accepted", "rejected", "counter", "denied", "none"]
    cumulative_reward: float
    episode_done: bool
    current_ranked_deals: List[Dict[str, Any]]
    stochastic_vendors: bool = True


class MyEnvV4Action(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action_type: Literal["negotiate", "accept", "skip", "finalize"]
    vendor_id: Optional[str] = None
    offer_price: Optional[float] = None
    reasoning: Optional[str] = None


class MyEnvV4Reward(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: float = Field(..., ge=-1.0, le=1.0)
    event: str


class StepResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    observation: VendorNegotiationObservation
    reward: MyEnvV4Reward
    done: bool
    info: Dict[str, Any] = Field(default_factory=dict)


TASK_CONFIGS = {
    "easy": {
        "budget_multiplier": 1.20,
        "price_bias": 0.00,
        "deny_base": 0.05,
        "deny_variance": 0.05,
        "noise": 0.05,
        "coop_bonus": 0.15,
        "description": "Most vendors active, prices near expected. Clear optimal vendor exists.",
    },
    "medium": {
        "budget_multiplier": 1.12,
        "price_bias": 0.06,
        "deny_base": 0.18,
        "deny_variance": 0.12,
        "noise": 0.12,
        "coop_bonus": 0.0,
        "description": "Several denials. Trade-offs between price, delivery and quality. No obvious pick.",
    },
    "hard": {
        "budget_multiplier": 1.04,
        "price_bias": 0.14,
        "deny_base": 0.38,
        "deny_variance": 0.18,
        "noise": 0.18,
        "coop_bonus": -0.15,
        "description": "Most vendors deny. Quotes near/over budget. Quality vs cost conflict. No perfect answer.",
    },
}

VENDOR_CATALOGUE = [
    {"id": "V1", "name": "AgriFirst", "base_price": 182, "delivery_days": 4, "quality": 0.88, "reliability": 0.86, "margin": 0.20},
    {"id": "V2", "name": "CropKing", "base_price": 165, "delivery_days": 3, "quality": 0.79, "reliability": 0.76, "margin": 0.18},
    {"id": "V3", "name": "HarvestPro", "base_price": 205, "delivery_days": 5, "quality": 0.93, "reliability": 0.91, "margin": 0.15},
    {"id": "V4", "name": "GrainCo", "base_price": 198, "delivery_days": 2, "quality": 0.85, "reliability": 0.83, "margin": 0.13},
    {"id": "V5", "name": "PrimeFarm", "base_price": 168, "delivery_days": 5, "quality": 0.77, "reliability": 0.74, "margin": 0.12},
    {"id": "V6", "name": "SeedTech", "base_price": 158, "delivery_days": 3, "quality": 0.72, "reliability": 0.68, "margin": 0.10},
    {"id": "V7", "name": "BulkAgri", "base_price": 150, "delivery_days": 6, "quality": 0.67, "reliability": 0.62, "margin": 0.09},
    {"id": "V8", "name": "NatFoods", "base_price": 208, "delivery_days": 3, "quality": 0.89, "reliability": 0.85, "margin": 0.08},
    {"id": "V9", "name": "EcoGrain", "base_price": 172, "delivery_days": 4, "quality": 0.82, "reliability": 0.79, "margin": 0.07},
    {"id": "V10", "name": "QuickCrop", "base_price": 155, "delivery_days": 5, "quality": 0.71, "reliability": 0.67, "margin": 0.06},
]


class MyEnvV4Env:
    MAX_STEPS = 24

    def __init__(
        self,
        task: str = "easy",
        item: str = "Rice",
        expected_price: float = 180.0,
        quantity_kg: int = 1000,
        seed: Optional[int] = None,
        stochastic_vendors: bool = True,
    ):
        self.task = task if task in TASK_CONFIGS else "easy"
        self.item = item
        self.expected_price = expected_price
        self.quantity_kg = quantity_kg
        self._rng = random.Random(seed)
        self.stochastic_vendors = stochastic_vendors
        self._cfg = TASK_CONFIGS[self.task]
        self.budget_per_kg = round(expected_price * self._cfg["budget_multiplier"], 2)

        self._vendors: List[VendorState] = []
        self._step: int = 0
        self._cum_reward: float = 0.0
        self._done: bool = False
        self._last_vendor_id: Optional[str] = None
        self._last_action_result: Literal["accepted", "rejected", "counter", "denied", "none"] = "none"
        self._last_action_error: Optional[str] = None

    @classmethod
    async def from_docker_image(cls, image_name: Optional[str] = None) -> "MyEnvV4Env":
        del image_name
        task = os.getenv("MY_ENV_V4_TASK", "easy")
        expected = float(os.getenv("MY_ENV_V4_EXPECTED_PRICE", "180"))
        qty = int(os.getenv("MY_ENV_V4_QTY", "1000"))
        item = os.getenv("MY_ENV_V4_ITEM", "Rice")
        stochastic = os.getenv("MY_ENV_V4_STOCHASTIC_VENDORS", "true").strip().lower() in ("1", "true", "yes", "on")
        return cls(task=task, item=item, expected_price=expected, quantity_kg=qty, stochastic_vendors=stochastic)

    async def reset(self) -> VendorNegotiationObservation:
        self._step = 0
        self._cum_reward = 0.0
        self._done = False
        self._last_vendor_id = None
        self._last_action_result = "none"
        self._last_action_error = None
        self._vendors = self._generate_vendor_pool()
        return self._make_observation()

    async def step(self, action: MyEnvV4Action) -> StepResult:
        if self._done:
            return StepResult(
                observation=self._make_observation(),
                reward=MyEnvV4Reward(value=0.0, event="episode_done"),
                done=True,
                info={"last_action_error": "Episode already done", "final_score": self._compute_final_score()},
            )

        self._step += 1
        self._last_action_error = None
        reward = 0.0
        reward_event = "none"

        if action.action_type == "finalize":
            reward = self._finalize()
            reward_event = "finalize"
            self._done = True
        elif action.action_type == "negotiate":
            reward, reward_event, err = await self._do_negotiate(action)
            if err:
                self._last_action_error = err
        elif action.action_type == "accept":
            reward, reward_event, err = self._do_accept(action)
            if err:
                self._last_action_error = err
        elif action.action_type == "skip":
            reward = self._do_skip(action)
            reward_event = "skip"

        if self._step >= self.MAX_STEPS:
            self._done = True

        active = [v for v in self._vendors if v.status == "active"]
        if not active:
            self._done = True

        self._cum_reward = round(self._cum_reward + reward, 4)
        return StepResult(
            observation=self._make_observation(),
            reward=MyEnvV4Reward(value=round(reward, 4), event=reward_event),
            done=self._done,
            info={
                "step": self._step,
                "last_action_error": self._last_action_error,
                "final_score": self._compute_final_score() if self._done else 0.0,
            },
        )

    def state(self) -> Dict[str, Any]:
        return {
            "task": self.task,
            "step": self._step,
            "done": self._done,
            "stochastic_vendors": self.stochastic_vendors,
            "budget_per_kg": self.budget_per_kg,
            "expected_price": self.expected_price,
            "quantity_kg": self.quantity_kg,
            "cumulative_reward": self._cum_reward,
            "vendors": [
                {
                    "id": v.vendor_id,
                    "name": v.name,
                    "status": v.status,
                    "quote_price": v.quote_price,
                    "accepted_price": v.accepted_price,
                    "delivery_days": v.delivery_days,
                    "quality_score": v.quality_score,
                    "reliability_score": v.reliability_score,
                    "rank_score": v.rank_score,
                    "negotiation_attempts": v.negotiation_attempts,
                }
                for v in self._vendors
            ],
            "final_score": self._compute_final_score(),
        }

    async def close(self) -> None:
        self._done = True

    async def _do_negotiate(self, action: MyEnvV4Action):
        vendor = self._find_vendor(action.vendor_id)
        if vendor is None:
            return -0.02, "invalid_vendor", f"Vendor {action.vendor_id} not found"
        if vendor.status == "denied":
            return -0.05, "already_denied", f"Vendor {vendor.vendor_id} already denied"
        if vendor.status == "deal_closed":
            return -0.02, "already_closed", f"Vendor {vendor.vendor_id} already closed"

        vendor.status = "negotiating"
        vendor.negotiation_attempts += 1
        self._last_vendor_id = vendor.vendor_id

        offer = action.offer_price if action.offer_price is not None else self.expected_price
        floor = vendor.base_price * (1 - vendor.negotiation_margin)
        coop = vendor.reliability_score * (0.6 + self._cfg["coop_bonus"] * 0.4)
        accept_p = min(
            0.90,
            max(0.05, coop * (1.0 - max(0, (floor - offer) / max(floor, 1)) * 1.8)),
        )

        accepted = offer >= floor and (
            self._rng.random() < accept_p if self.stochastic_vendors else accept_p >= 0.5
        )
        if accepted:
            final_price = round(min(offer, vendor.quote_price), 2)
            vendor.accepted_price = final_price
            vendor.status = "deal_closed"
            vendor.rank_score = self._score_vendor(vendor)
            self._last_action_result = "accepted"
            over_budget = final_price > self.budget_per_kg
            base_rew = 0.18 if not over_budget else -0.04
            neg_penalty = -0.025 * max(0, vendor.negotiation_attempts - 1)
            return round(base_rew + neg_penalty, 4), "deal_accepted", None

        shrink = self._rng.uniform(0.94, 0.99) if self.stochastic_vendors else 0.97
        vendor.quote_price = round(vendor.quote_price * shrink, 2)
        vendor.status = "active"
        self._last_action_result = "counter"
        return -0.01, "counter_offer", None

    def _do_accept(self, action: MyEnvV4Action):
        vendor = self._find_vendor(action.vendor_id)
        if vendor is None:
            return -0.02, "invalid_vendor", f"Vendor {action.vendor_id} not found"
        if vendor.status not in ("active", "negotiating"):
            return -0.02, "invalid_state", f"Vendor {vendor.vendor_id} not in negotiable state"

        vendor.accepted_price = vendor.quote_price
        vendor.status = "deal_closed"
        vendor.rank_score = self._score_vendor(vendor)
        self._last_vendor_id = vendor.vendor_id
        self._last_action_result = "accepted"
        over = vendor.accepted_price > self.budget_per_kg
        return (-0.08 if over else 0.10), "accept_quote", None

    def _do_skip(self, action: MyEnvV4Action):
        vendor = self._find_vendor(action.vendor_id)
        if vendor is None:
            self._last_action_result = "rejected"
            return -0.01
        vendor.status = "denied"
        self._last_vendor_id = vendor.vendor_id
        self._last_action_result = "denied"
        return -0.03

    def _finalize(self) -> float:
        deals = [v for v in self._vendors if v.status == "deal_closed"]
        if not deals:
            return -0.30

        best = max(deals, key=lambda v: v.rank_score)
        eff_bonus = 0.12 if self._step <= 10 else (0.06 if self._step <= 16 else 0.0)

        if best.accepted_price is not None and best.accepted_price <= self.budget_per_kg:
            saving_frac = (self.budget_per_kg - best.accepted_price) / self.budget_per_kg
            reward = best.rank_score * 0.70 + saving_frac * 0.30 + eff_bonus
        else:
            ap = best.accepted_price if best.accepted_price is not None else self.budget_per_kg
            over_frac = (ap - self.budget_per_kg) / self.budget_per_kg
            reward = best.rank_score * 0.50 - over_frac * 0.40 + eff_bonus * 0.5

        return max(-1.0, min(1.0, round(reward, 4)))

    def _score_vendor(self, vendor: VendorState) -> float:
        deals = [v for v in self._vendors if v.status == "deal_closed" and v.accepted_price is not None]
        min_p = min((v.accepted_price for v in deals), default=vendor.accepted_price or vendor.quote_price)
        ap = vendor.accepted_price if vendor.accepted_price is not None else vendor.quote_price
        price_score = min_p / max(ap, 1.0)
        del_score = 1.0 / (1 + vendor.delivery_days * 0.15)
        sc = 0.35 * price_score + 0.20 * del_score + 0.25 * vendor.quality_score + 0.20 * vendor.reliability_score
        if vendor.quality_score < 0.75:
            sc -= 0.10
        return round(max(0.0, min(1.0, sc)), 4)

    def _compute_final_score(self) -> float:
        deals = [v for v in self._vendors if v.status == "deal_closed" and v.accepted_price is not None]
        if not deals:
            return 0.0
        in_budget = [v for v in deals if v.accepted_price <= self.budget_per_kg]
        pool = in_budget if in_budget else deals
        best = max(pool, key=lambda v: v.rank_score)
        eff = 0.10 if self._step <= 10 else (0.05 if self._step <= 16 else 0.0)
        return round(max(0.0, min(1.0, best.rank_score * 0.90 + eff)), 4)

    def _find_vendor(self, vendor_id: Optional[str]) -> Optional[VendorState]:
        if vendor_id is None:
            return None
        for v in self._vendors:
            if v.vendor_id == vendor_id:
                return v
        return None

    def _generate_vendor_pool(self) -> List[VendorState]:
        vendors: List[VendorState] = []
        for cat in VENDOR_CATALOGUE:
            if self.stochastic_vendors:
                noise = self._rng.uniform(-self._cfg["noise"], self._cfg["noise"])
                bias = self._cfg["price_bias"] * self._rng.uniform(0.5, 1.0)
                deny_random_bonus = 0.12 if self._rng.random() < 0.15 else 0.0
            else:
                noise = 0.0
                bias = self._cfg["price_bias"] * 0.75
                deny_random_bonus = 0.0

            quote = round(cat["base_price"] * (1 + noise + bias), 2)

            deny_p = min(
                0.85,
                self._cfg["deny_base"]
                + (1 - cat["reliability"]) * self._cfg["deny_variance"]
                + deny_random_bonus,
            )
            denied = (self._rng.random() < deny_p) if self.stochastic_vendors else (deny_p >= 0.50)

            vendors.append(
                VendorState(
                    vendor_id=cat["id"],
                    name=cat["name"],
                    quote_price=quote,
                    base_price=round(cat["base_price"] * (1 - cat["margin"] * 0.6), 2),
                    delivery_days=cat["delivery_days"],
                    quality_score=cat["quality"],
                    reliability_score=cat["reliability"],
                    negotiation_margin=cat["margin"],
                    status="denied" if denied else "active",
                )
            )
        return vendors

    def _make_observation(self) -> VendorNegotiationObservation:
        deals = [v for v in self._vendors if v.status == "deal_closed"]
        ranked = sorted(deals, key=lambda v: v.rank_score, reverse=True)
        ranked_summary = [
            {
                "vendor_id": v.vendor_id,
                "name": v.name,
                "accepted_price": v.accepted_price,
                "delivery_days": v.delivery_days,
                "quality_score": v.quality_score,
                "reliability_score": v.reliability_score,
                "rank_score": v.rank_score,
                "within_budget": bool(v.accepted_price is not None and v.accepted_price <= self.budget_per_kg),
            }
            for v in ranked
        ]
        return VendorNegotiationObservation(
            vendors=list(self._vendors),
            step_number=self._step,
            budget_per_kg=self.budget_per_kg,
            expected_price=self.expected_price,
            quantity_kg=self.quantity_kg,
            item_name=self.item,
            task_difficulty=self.task,
            last_action_vendor_id=self._last_vendor_id,
            last_action_result=self._last_action_result,
            cumulative_reward=self._cum_reward,
            episode_done=self._done,
            current_ranked_deals=ranked_summary,
            stochastic_vendors=self.stochastic_vendors,
        )
