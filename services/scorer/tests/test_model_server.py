"""Model server: classifier label-mapping + the /score & /health endpoints (fake pipe, no torch)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from model_server.app import create_app
from model_server.classifier import Classifier
from model_server.config import ModelServerConfig


def _toxic_pipe(text: str) -> list:
    return [{"label": "toxic", "score": 0.9}, {"label": "neutral", "score": 0.1}]


def _nested_pipe(text: str) -> list:
    # Some transformers versions nest the single-input result one level deeper.
    return [[{"label": "POSITIVE", "score": 0.7}, {"label": "NEGATIVE", "score": 0.3}]]


def test_classifier_maps_and_lowercases_labels() -> None:
    clf = Classifier(ModelServerConfig(), pipe=_toxic_pipe)
    scores = clf.score("you are awful")
    assert scores == {"toxic": 0.9, "neutral": 0.1}
    assert Classifier.top(scores) == ("toxic", 0.9)


def test_classifier_handles_nested_output() -> None:
    clf = Classifier(ModelServerConfig(), pipe=_nested_pipe)
    scores = clf.score("nice")
    assert scores == {"positive": 0.7, "negative": 0.3}
    assert Classifier.top(scores)[0] == "positive"


def test_score_endpoint_returns_top_and_distribution() -> None:
    clf = Classifier(ModelServerConfig(), pipe=_toxic_pipe)
    with TestClient(create_app(classifier=clf)) as client:
        r = client.post("/score", json={"text": "x"})
        assert r.status_code == 200
        body = r.json()
        assert body["label"] == "toxic"
        assert body["score"] == 0.9
        assert body["scores"] == {"toxic": 0.9, "neutral": 0.1}
        assert r.json()["kind"] == clf.config.kind

        health = client.get("/health").json()
        assert health["status"] == "ok"
        assert health["loaded"] is True
