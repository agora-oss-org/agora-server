"""worker — the orchestrator.

Polls pgmq, fans each job to both RoBERTa model servers in parallel, runs the toxicity →
gray-zone → Haiku cascade, decides + applies auto-action through the API trust boundary,
upserts the ``moderation_analyses`` audit row, MERGEs the relationship edge into Neo4j, and
ALSO serves the operator-gated admin endpoints ``/v1/:projectId/moderation/*`` (identical
shapes to the retired @agora/moderator). See ``docs/SCORER.md``.
"""
