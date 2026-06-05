"""Operator JWT verification (PyJWT HS256, `operator` claim)."""

from __future__ import annotations

import jwt as pyjwt
import pytest

from scorer.jwt_auth import AuthError, verify_operator

SECRET = "test-secret"


def _token(**claims: object) -> str:
    return pyjwt.encode(claims, SECRET, algorithm="HS256")


def test_accepts_operator_token() -> None:
    ctx = verify_operator(f"Bearer {_token(sub='u1', operator=True, steward=False)}", SECRET)
    assert ctx.user_id == "u1"
    assert ctx.is_operator is True


def test_rejects_non_operator() -> None:
    with pytest.raises(AuthError):
        verify_operator(f"Bearer {_token(sub='u1', operator=False)}", SECRET)


def test_rejects_missing_or_malformed_header() -> None:
    with pytest.raises(AuthError):
        verify_operator(None, SECRET)
    with pytest.raises(AuthError):
        verify_operator("Token abc", SECRET)


def test_rejects_bad_signature() -> None:
    with pytest.raises(AuthError):
        verify_operator(f"Bearer {_token(sub='u1', operator=True)}", "wrong-secret")


def test_rejects_when_secret_unset() -> None:
    with pytest.raises(AuthError):
        verify_operator("Bearer whatever", None)
