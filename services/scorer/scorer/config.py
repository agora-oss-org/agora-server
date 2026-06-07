"""Env defaults + per-project config merge.

Port of ``apps/moderator/src/lib/env.ts`` + ``lib/project-config.ts``: the env-only defaults,
plus ``resolve()`` which overlays a project's ``projects.moderator_config`` jsonb over those
defaults (the same override-or-env precedence + 0..1 clamping). ``resolve()`` is a PURE
function (unit-testable); ``get_moderator_config()`` is the async wrapper that fetches the
jsonb by project id and caches it 30s — its DB read is a STUB until ``scorer/db.py`` is wired.

New scorer-only knobs (gray-zone cascade thresholds, Haiku model, queue/poll, Neo4j) live on
``Settings`` alongside the reused moderator vars.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from .policy import DEFAULT_MODERATION_CATEGORIES


def _env_str(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    # Empty strings are treated as unset (matches the moderator's zod preprocess).
    return v if (v is not None and v != "") else default


def _env_float(name: str, default: float) -> float:
    raw = _env_str(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = _env_str(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    """Process-wide settings loaded from the environment (see .env.example)."""

    # Reused from the moderator contract.
    database_url: str | None = field(default_factory=lambda: _env_str("DATABASE_URL"))
    # A DIRECT/session DSN (:5432) for the LISTEN/NOTIFY wake-up — LISTEN doesn't work over the
    # transaction pooler (:6543). Unset → no wake-up, the consumer just polls.
    listen_database_url: str | None = field(default_factory=lambda: _env_str("SCORER_LISTEN_DATABASE_URL"))
    access_token_secret: str | None = field(default_factory=lambda: _env_str("ACCESS_TOKEN_SECRET"))
    api_base_url: str | None = field(default_factory=lambda: _env_str("API_BASE_URL"))
    moderation_service_secret: str | None = field(default_factory=lambda: _env_str("MODERATION_SERVICE_SECRET"))
    block_auto_action_threshold: float = field(default_factory=lambda: _env_float("MODERATION_BLOCK_AUTO_ACTION_THRESHOLD", 0.85))
    review_auto_action_threshold: float = field(default_factory=lambda: _env_float("MODERATION_REVIEW_AUTO_ACTION_THRESHOLD", 0.0))

    # Cascade — toxicity scores within [low, high] escalate to Claude Haiku.
    grayzone_low: float = field(default_factory=lambda: _env_float("SCORER_GRAYZONE_LOW", 0.30))
    grayzone_high: float = field(default_factory=lambda: _env_float("SCORER_GRAYZONE_HIGH", 0.80))

    # Haiku escalation (Anthropic). Unset key → escalation disabled (record RoBERTa score only).
    anthropic_api_key: str | None = field(default_factory=lambda: _env_str("ANTHROPIC_API_KEY"))
    haiku_model: str = field(default_factory=lambda: _env_str("SCORER_HAIKU_MODEL", "claude-haiku-4-5") or "claude-haiku-4-5")
    haiku_max_tokens: int = field(default_factory=lambda: _env_int("SCORER_HAIKU_MAX_TOKENS", 512))

    # Model servers (worker → RoBERTa servers, compose DNS).
    toxicity_url: str = field(default_factory=lambda: _env_str("SCORER_TOXICITY_URL", "http://scorer-toxicity:8001") or "http://scorer-toxicity:8001")
    relationship_url: str = field(default_factory=lambda: _env_str("SCORER_RELATIONSHIP_URL", "http://scorer-relationship:8002") or "http://scorer-relationship:8002")
    admin_port: int = field(default_factory=lambda: _env_int("SCORER_ADMIN_PORT", 4001))

    # pgmq.
    queue: str = field(default_factory=lambda: _env_str("SCORER_QUEUE", "scorer_jobs") or "scorer_jobs")
    poll_interval_ms: int = field(default_factory=lambda: _env_int("SCORER_POLL_INTERVAL_MS", 1000))
    visibility_timeout_s: int = field(default_factory=lambda: _env_int("SCORER_VISIBILITY_TIMEOUT_S", 60))

    # Neo4j (foundation — graph schema out of scope). Unset → relationship-edge write is a no-op.
    neo4j_uri: str | None = field(default_factory=lambda: _env_str("NEO4J_URI"))
    neo4j_user: str | None = field(default_factory=lambda: _env_str("NEO4J_USER"))
    neo4j_password: str | None = field(default_factory=lambda: _env_str("NEO4J_PASSWORD"))

    def write_back_enabled(self) -> bool:
        return bool(self.api_base_url and self.moderation_service_secret)

    def haiku_enabled(self) -> bool:
        return bool(self.anthropic_api_key)

    def neo4j_enabled(self) -> bool:
        return bool(self.neo4j_uri and self.neo4j_user and self.neo4j_password)

    def notify_enabled(self) -> bool:
        return bool(self.listen_database_url)


@dataclass(frozen=True)
class ResolvedModeratorConfig:
    block_auto_action_threshold: float
    review_auto_action_threshold: float
    categories: list[str]


def _clamp01(v: object, fallback: float) -> float:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return min(1.0, max(0.0, float(v)))
    return fallback


def _resolve_categories(raw: object) -> list[str]:
    if isinstance(raw, list):
        items = [s.strip() for s in raw if isinstance(s, str) and s.strip()]
        if items:
            return items
    return list(DEFAULT_MODERATION_CATEGORIES)


def resolve(raw: object, settings: Settings) -> ResolvedModeratorConfig:
    """PURE: overlay a project's moderator_config jsonb over env defaults (override-or-env)."""
    cfg = raw if isinstance(raw, dict) else {}
    return ResolvedModeratorConfig(
        block_auto_action_threshold=_clamp01(cfg.get("blockAutoActionThreshold"), settings.block_auto_action_threshold),
        review_auto_action_threshold=_clamp01(cfg.get("reviewAutoActionThreshold"), settings.review_auto_action_threshold),
        categories=_resolve_categories(cfg.get("categories")),
    )


# NOTE: the DB-backed, cached ``get_moderator_config(settings, project_id)`` lives in ``scorer/db.py``
# (it needs the pool); ``resolve()`` above is the pure merge it builds on.


# A single, lazily-instantiated Settings for convenience imports.
_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
