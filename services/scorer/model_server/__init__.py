"""model_server — the shared RoBERTa HTTP server.

ONE image serves BOTH the toxicity and the relationship-quality classifiers; which model it
loads is chosen by ``SCORER_MODEL`` / ``SCORER_MODEL_KIND`` env (see compose). The HF model is
loaded warm into RAM at startup so every ``POST /score`` is a fast in-process inference.
"""
