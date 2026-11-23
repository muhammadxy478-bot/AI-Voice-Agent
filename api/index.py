"""Vercel Serverless Function entrypoint exporting the FastAPI ASGI application."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT_DIR = str(Path(__file__).resolve().parent.parent)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from backend.main import app  # noqa: E402

__all__ = ["app"]
