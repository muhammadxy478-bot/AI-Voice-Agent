"""Application configuration and voice/model metadata."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = (
    BASE_DIR / "frontend"
    if (BASE_DIR / "frontend").exists()
    else Path.cwd() / "frontend"
)

load_dotenv(BASE_DIR / ".env", override=False)

PLACEHOLDER_API_KEYS = {
    "",
    "your_groq_api_key_here",
    "your_api_key_here",
    "replace_me",
    "changeme",
}

ORPHEUS_VOICES: list[dict[str, str]] = [
    {"id": "troy", "label": "Troy (Groq Orpheus)", "provider": "groq-orpheus"},
    {"id": "diana", "label": "Diana (Groq Orpheus)", "provider": "groq-orpheus"},
    {"id": "hannah", "label": "Hannah (Groq Orpheus)", "provider": "groq-orpheus"},
    {"id": "autumn", "label": "Autumn (Groq Orpheus)", "provider": "groq-orpheus"},
    {"id": "austin", "label": "Austin (Groq Orpheus)", "provider": "groq-orpheus"},
    {"id": "daniel", "label": "Daniel (Groq Orpheus)", "provider": "groq-orpheus"},
]

ORPHEUS_VOICE_IDS: set[str] = {v["id"] for v in ORPHEUS_VOICES}

EDGE_VOICES: list[dict[str, str]] = [
    {"id": "en-US-AriaNeural", "label": "Aria (Edge Neural US)", "provider": "edge-tts"},
    {"id": "en-US-GuyNeural", "label": "Guy (Edge Neural US)", "provider": "edge-tts"},
    {"id": "en-GB-SoniaNeural", "label": "Sonia (Edge Neural UK)", "provider": "edge-tts"},
    {"id": "en-US-JennyNeural", "label": "Jenny (Edge Neural US)", "provider": "edge-tts"},
]

NATIVE_VOICES: list[dict[str, str]] = [
    {"id": "web_speech", "label": "Browser Native (Web Speech)", "provider": "web_speech"},
]


class Settings:
    """Dynamic environment-backed settings so `.env` and test overrides both work cleanly."""

    @property
    def OPENAI_API_KEY(self) -> str:
        return os.getenv("OPENAI_API_KEY", "").strip()

    @property
    def OPENAI_BASE_URL(self) -> str:
        return os.getenv("OPENAI_BASE_URL", "https://api.groq.com/openai/v1").strip()

    @property
    def LLM_MODEL(self) -> str:
        return os.getenv("LLM_MODEL", "openai/gpt-oss-120b").strip()

    @property
    def STT_MODEL(self) -> str:
        return os.getenv("STT_MODEL", "whisper-large-v3-turbo").strip()

    @property
    def TTS_MODEL(self) -> str:
        return os.getenv("TTS_MODEL", "canopylabs/orpheus-v1-english").strip()

    @property
    def TTS_VOICE(self) -> str:
        return os.getenv("TTS_VOICE", "troy").strip()

    @property
    def EDGE_TTS_VOICE(self) -> str:
        return os.getenv("EDGE_TTS_VOICE", "en-US-AriaNeural").strip()

    @property
    def DATABASE_PATH(self) -> Path:
        raw = Path(os.getenv("DATABASE_PATH", "data/chat_history.db"))
        if raw.is_absolute():
            return raw
        if os.getenv("VERCEL"):
            return Path("/tmp") / raw.name
        return BASE_DIR / raw

    @property
    def HOST(self) -> str:
        return os.getenv("HOST", "127.0.0.1").strip()

    @property
    def PORT(self) -> int:
        return int(os.getenv("PORT", "8000"))


settings = Settings()


def is_api_key_configured(api_key: Optional[str] = None) -> bool:
    """Return True when a non-placeholder Groq/OpenAI API key is configured."""
    value = (settings.OPENAI_API_KEY if api_key is None else api_key).strip()
    return value.lower() not in PLACEHOLDER_API_KEYS
