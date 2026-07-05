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

    # Neo4j — social-graph write side. NEO4J_AUTH="user/password" (same var Neo4j container uses).
    neo4j_uri: str | None = field(default_factory=lambda: _env_str("NEO4J_URI"))
    neo4j_auth: str | None = field(default_factory=lambda: _env_str("NEO4J_AUTH"))
    # Which DozerDB database to write to (DozerDB re-enables Neo4j multi-database on Community). Unset
    # → "neo4j" (server default); created on startup if missing. MUST match the API's NEO4J_DATABASE.
    neo4j_database: str = field(default_factory=lambda: _env_str("NEO4J_DATABASE") or "neo4j")

    # CO_PARTICIPATES — undirected co-commenter edges (docs/SOCIAL-GRAPH.md §7). Neutral: feeds the
    # Neighborhood neighbor-set only, no warmth/friction. Lookback bounds recency; cap bounds fan-out
    # per comment event; weight ceiling bounds edge growth under repeated co-participation.
    co_participates_lookback_days: int = field(default_factory=lambda: _env_int("SCORER_CO_PARTICIPATES_LOOKBACK_DAYS", 7))
    co_participates_max_participants: int = field(default_factory=lambda: _env_int("SCORER_CO_PARTICIPATES_MAX_PARTICIPANTS", 50))
    co_participates_max_weight: float = field(default_factory=lambda: _env_float("SCORER_CO_PARTICIPATES_MAX_WEIGHT", 10.0))

    def write_back_enabled(self) -> bool:
        return bool(self.api_base_url and self.moderation_service_secret)

    def haiku_enabled(self) -> bool:
        return bool(self.anthropic_api_key)

    def neo4j_credentials(self) -> tuple[str, str] | None:
        """Parse NEO4J_AUTH='user/password' → (user, password), or None if unset."""
        if not self.neo4j_auth:
            return None
        user, _, password = self.neo4j_auth.partition("/")
        return (user, password)

    def neo4j_enabled(self) -> bool:
        return bool(self.neo4j_uri and self.neo4j_credentials())

    def notify_enabled(self) -> bool:
        return bool(self.listen_database_url)


@dataclass(frozen=True)
class ResolvedModeratorConfig:
    block_auto_action_threshold: float
    review_auto_action_threshold: float
    categories: list[str]
    # Runtime-tunable cascade + graph knobs (defaults mirror the env defaults so test/fake
    # constructors that omit them stay valid).
    grayzone_low: float = 0.30
    grayzone_high: float = 0.80
    co_participates_lookback_days: int = 7
    co_participates_max_participants: int = 50
    co_participates_max_weight: float = 10.0
    # Per-project LLM adjudication (corporate). llm_api_key is a SECRET — never log it.
    llm_provider: str = "anthropic"
    llm_model: str = "claude-haiku-4-5"
    llm_max_tokens: int = 512
    llm_api_key: str | None = None

    def llm_enabled(self) -> bool:
        return bool(self.llm_api_key)


def _clamp01(v: object, fallback: float) -> float:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return min(1.0, max(0.0, float(v)))
    return fallback


def _clamp_int(v: object, fallback: int, lo: int, hi: int) -> int:
    if isinstance(v, bool):
        return fallback
    if isinstance(v, (int, float)):
        return max(lo, min(hi, int(v)))
    return fallback


def _clamp_float(v: object, fallback: float, lo: float, hi: float) -> float:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return max(lo, min(hi, float(v)))
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
    gl = _clamp01(cfg.get("grayzoneLow"), settings.grayzone_low)
    gh = _clamp01(cfg.get("grayzoneHigh"), settings.grayzone_high)
    if gl > gh:  # inverted/empty band → fail safe to env defaults, never an empty escalation band
        gl, gh = settings.grayzone_low, settings.grayzone_high
    # Per-project LLM: provider decides the key fallback. The Anthropic env key is ONLY inherited by an
    # anthropic project — never handed to an openai project (which is simply disabled without its own key).
    provider_raw = cfg.get("llmProvider")
    provider: str = provider_raw if provider_raw in ("anthropic", "openai") else "anthropic"
    cfg_key_raw = cfg.get("llmApiKey")
    cfg_key: str | None = cfg_key_raw if isinstance(cfg_key_raw, str) and cfg_key_raw else None
    env_key: str | None = settings.anthropic_api_key if provider == "anthropic" else None
    api_key: str | None = cfg_key or env_key
    model_raw = cfg.get("llmModel")
    model: str = model_raw if isinstance(model_raw, str) and model_raw else settings.haiku_model
    max_tokens = _clamp_int(cfg.get("llmMaxTokens"), settings.haiku_max_tokens, 1, 8192)
    return ResolvedModeratorConfig(
        block_auto_action_threshold=_clamp01(cfg.get("blockAutoActionThreshold"), settings.block_auto_action_threshold),
        review_auto_action_threshold=_clamp01(cfg.get("reviewAutoActionThreshold"), settings.review_auto_action_threshold),
        categories=_resolve_categories(cfg.get("categories")),
        grayzone_low=gl,
        grayzone_high=gh,
        co_participates_lookback_days=_clamp_int(cfg.get("coParticipatesLookbackDays"), settings.co_participates_lookback_days, 0, 365),
        co_participates_max_participants=_clamp_int(cfg.get("coParticipatesMaxParticipants"), settings.co_participates_max_participants, 1, 500),
        co_participates_max_weight=_clamp_float(cfg.get("coParticipatesMaxWeight"), settings.co_participates_max_weight, 1.0, 1000.0),
        llm_provider=provider,
        llm_model=model,
        llm_max_tokens=max_tokens,
        llm_api_key=api_key,
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
