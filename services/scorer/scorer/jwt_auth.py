"""Operator JWT verification — port of ``apps/moderator/src/middleware/auth.ts`` (jose → PyJWT).

Verifies an HS256 Bearer token against the shared ``ACCESS_TOKEN_SECRET`` and extracts the
``operator`` claim. The admin AI-flag endpoints are operator-gated, so this guards them
identically to the old moderator.
"""

from __future__ import annotations

from dataclasses import dataclass

import jwt  # PyJWT


class AuthError(Exception):
    """Raised when a token is missing/invalid or the caller is not an operator."""


@dataclass(frozen=True)
class AuthContext:
    user_id: str
    is_operator: bool
    is_steward: bool = False


def verify_operator(authorization_header: str | None, secret: str | None) -> AuthContext:
    """Verify a ``Authorization: Bearer <jwt>`` header and require the operator claim.

    Raises ``AuthError`` on any failure (unauthenticated, bad signature, non-operator).
    """
    if not secret:
        raise AuthError("ACCESS_TOKEN_SECRET not configured")
    if not authorization_header or not authorization_header.lower().startswith("bearer "):
        raise AuthError("missing bearer token")
    token = authorization_header.split(" ", 1)[1].strip()
    try:
        claims = jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:  # invalid/expired/forged
        raise AuthError("invalid token") from exc
    if not claims.get("operator"):
        raise AuthError("operator privilege required")
    return AuthContext(
        user_id=str(claims.get("sub", "")),
        is_operator=bool(claims.get("operator")),
        is_steward=bool(claims.get("steward")),
    )
