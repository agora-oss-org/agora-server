"""uvicorn entrypoint for the model server (host 0.0.0.0, port from SCORER_PORT)."""

from __future__ import annotations

import uvicorn

from .config import get_config


def main() -> None:
    config = get_config()
    uvicorn.run("model_server.app:app", host="0.0.0.0", port=config.port, log_config=None)


if __name__ == "__main__":
    main()
