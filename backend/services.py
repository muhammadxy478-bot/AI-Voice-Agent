"""AI integration services: Groq streaming LLM, Whisper STT, and 3-tier Orpheus/Edge/WebSpeech TTS."""

from __future__ import annotations

import asyncio
import io
import logging
import mimetypes
import re
import time
import wave
from typing import Any, AsyncIterator, Optional

import edge_tts
from openai import AsyncOpenAI, BadRequestError

from backend.config import ORPHEUS_VOICE_IDS, is_api_key_configured, settings

logger = logging.getLogger(__name__)

_FENCED_CODE_RE = re.compile(r"```[\s\S]*?```", re.MULTILINE)
_INLINE_CODE_RE = re.compile(r"`([^`]+)`")
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]+\)")
_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE)
_BLOCKQUOTE_RE = re.compile(r"^\s*>\s?", re.MULTILINE)
_BULLET_RE = re.compile(r"^\s*[-*+]\s+", re.MULTILINE)
_ORDERED_RE = re.compile(r"^\s*\d+\.\s+", re.MULTILINE)
_EMPHASIS_RE = re.compile(r"(\*\*|__|\*|_|~~)")
_WHITESPACE_RE = re.compile(r"\s+")

_CONTENT_TYPE_EXT = {
    "audio/webm": ".webm",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
    "audio/ogg": ".ogg",
    "audio/mp4": ".mp4",
    "audio/m4a": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
}


def clean_text_for_speech(text: str) -> str:
    """Convert rich Markdown assistant output into natural spoken prose."""
    if not text or not text.strip():
        return ""

    cleaned = _FENCED_CODE_RE.sub(" code snippet provided in chat. ", text)
    cleaned = _IMAGE_RE.sub(r"\1", cleaned)
    cleaned = _LINK_RE.sub(r"\1", cleaned)
    cleaned = _INLINE_CODE_RE.sub(r"\1", cleaned)
    cleaned = _HEADING_RE.sub("", cleaned)
    cleaned = _BLOCKQUOTE_RE.sub("", cleaned)
    cleaned = _BULLET_RE.sub("", cleaned)
    cleaned = _ORDERED_RE.sub("", cleaned)
    cleaned = _EMPHASIS_RE.sub("", cleaned)
    cleaned = _HTML_TAG_RE.sub(" ", cleaned)
    cleaned = cleaned.replace("|", " ")
    cleaned = _WHITESPACE_RE.sub(" ", cleaned).strip()

    if not cleaned:
        return "I have shared a code snippet in the chat."
    return cleaned


def _split_long_segment(segment: str, max_chars: int) -> list[str]:
    """Split a segment exceeding max_chars along comma/semicolon or word boundaries."""
    words = segment.split()
    chunks: list[str] = []
    current = ""
    for word in words:
        if len(word) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            for i in range(0, len(word), max_chars):
                chunks.append(word[i : i + max_chars])
            continue
        candidate = f"{current} {word}".strip() if current else word
        if len(candidate) <= max_chars:
            current = candidate
        else:
            if current:
                chunks.append(current)
            current = word
    if current:
        chunks.append(current)
    return chunks


def chunk_text_for_orpheus(text: str, max_chars: int = 190) -> list[str]:
    """Split text into <=190-char chunks respecting Groq Orpheus's 200-char limit."""
    normalized = _WHITESPACE_RE.sub(" ", text).strip()
    if not normalized:
        return []
    if len(normalized) <= max_chars:
        return [normalized]

    sentences = re.split(r"(?<=[.!?])\s+", normalized)
    chunks: list[str] = []
    current = ""

    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_split_long_segment(sentence, max_chars))
            continue

        candidate = f"{current} {sentence}".strip() if current else sentence
        if len(candidate) <= max_chars:
            current = candidate
        else:
            if current:
                chunks.append(current)
            current = sentence

    if current:
        chunks.append(current)
    return chunks


def concat_wav_chunks(wav_list: list[bytes]) -> bytes:
    """Concatenate one or more mono/stereo PCM WAV byte payloads into a single WAV."""
    if not wav_list:
        return b""
    if len(wav_list) == 1:
        return wav_list[0]

    params = None
    frames: list[bytes] = []
    for raw in wav_list:
        with wave.open(io.BytesIO(raw), "rb") as reader:
            if params is None:
                params = reader.getparams()
            frames.append(reader.readframes(reader.getnframes()))

    out_buf = io.BytesIO()
    with wave.open(out_buf, "wb") as writer:
        assert params is not None
        writer.setparams(params)
        for frame_block in frames:
            writer.writeframes(frame_block)
    return out_buf.getvalue()


def _extract_completion_tokens(chunk: Any) -> Optional[int]:
    usage = getattr(chunk, "usage", None)
    if usage is not None:
        val = getattr(usage, "completion_tokens", None)
        if val is not None:
            return int(val)
    x_groq = getattr(chunk, "x_groq", None)
    if x_groq is not None:
        x_usage = getattr(x_groq, "usage", None)
        if x_usage is not None:
            val = getattr(x_usage, "completion_tokens", None)
            if val is not None:
                return int(val)
    return None


class AIService:
    """Async wrapper around Groq's OpenAI-compatible API plus Edge TTS fallback."""

    def __init__(self, client: Optional[AsyncOpenAI] = None) -> None:
        self._explicit_client = client
        self._cached_client: Optional[AsyncOpenAI] = None
        self._cached_key_pair: Optional[tuple[str, str]] = None

    def get_client(self) -> AsyncOpenAI:
        if self._explicit_client is not None:
            return self._explicit_client
        pair = (settings.OPENAI_API_KEY, settings.OPENAI_BASE_URL)
        if self._cached_client is None or self._cached_key_pair != pair:
            self._cached_client = AsyncOpenAI(
                api_key=settings.OPENAI_API_KEY,
                base_url=settings.OPENAI_BASE_URL,
            )
            self._cached_key_pair = pair
        return self._cached_client

    async def stream_chat(
        self,
        messages: list[dict[str, str]],
        model: Optional[str] = None,
        temperature: float = 0.7,
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream LLM tokens from Groq and emit final latency/throughput metrics."""
        client = self.get_client()
        target_model = model or settings.LLM_MODEL
        start = time.perf_counter()
        first_token_at: Optional[float] = None
        parts: list[str] = []
        chunk_count = 0
        completion_tokens: Optional[int] = None

        request_kwargs: dict[str, Any] = {
            "model": target_model,
            "messages": messages,
            "temperature": temperature,
            "stream": True,
            "stream_options": {"include_usage": True},
        }

        try:
            stream = await client.chat.completions.create(**request_kwargs)
        except (BadRequestError, TypeError):
            request_kwargs.pop("stream_options", None)
            stream = await client.chat.completions.create(**request_kwargs)

        async for chunk in stream:
            usage_tokens = _extract_completion_tokens(chunk)
            if usage_tokens is not None:
                completion_tokens = usage_tokens

            choices = getattr(chunk, "choices", None)
            if not choices:
                continue

            delta = getattr(choices[0], "delta", None)
            content = getattr(delta, "content", None) if delta is not None else None
            if not content:
                continue

            if first_token_at is None:
                first_token_at = time.perf_counter()
            chunk_count += 1
            parts.append(content)
            yield {"type": "token", "content": content}

        end = time.perf_counter()
        full_text = "".join(parts)
        elapsed_sec = max(end - start, 0.001)
        latency_ms = round(elapsed_sec * 1000, 1)
        ttft_ms = round(((first_token_at - start) if first_token_at else elapsed_sec) * 1000, 1)

        if completion_tokens is None:
            word_est = round(len(full_text.split()) * 1.33)
            completion_tokens = max(chunk_count, word_est) if full_text.strip() else 0

        tokens_per_sec = round(completion_tokens / elapsed_sec, 1) if completion_tokens > 0 else 0.0

        yield {
            "type": "done",
            "content": full_text,
            "metrics": {
                "latency_ms": latency_ms,
                "ttft_ms": ttft_ms,
                "tokens": completion_tokens,
                "tokens_per_sec": tokens_per_sec,
                "model": target_model,
            },
        }

    async def transcribe_audio(
        self,
        audio_bytes: bytes,
        filename: str = "recording.webm",
        content_type: str = "audio/webm",
        language: Optional[str] = None,
    ) -> dict[str, Any]:
        """Transcribe browser audio via Groq Whisper (`whisper-large-v3-turbo`)."""
        client = self.get_client()
        start = time.perf_counter()

        clean_name = (filename or "recording").strip()
        if "." not in clean_name:
            base_ct = (content_type or "audio/webm").split(";")[0].strip().lower()
            ext = _CONTENT_TYPE_EXT.get(base_ct) or mimetypes.guess_extension(base_ct) or ".webm"
            clean_name = f"{clean_name}{ext}"

        kwargs: dict[str, Any] = {
            "model": settings.STT_MODEL,
            "file": (clean_name, audio_bytes, content_type or "audio/webm"),
            "response_format": "json",
        }
        if language:
            kwargs["language"] = language

        result = await client.audio.transcriptions.create(**kwargs)
        latency_ms = round((time.perf_counter() - start) * 1000, 1)
        text = getattr(result, "text", None)
        if text is None and isinstance(result, dict):
            text = result.get("text", "")

        return {
            "text": (text or "").strip(),
            "latency_ms": latency_ms,
            "model": settings.STT_MODEL,
        }

    async def _synthesize_orpheus(self, clean_text: str, voice: str) -> bytes:
        """Synthesize WAV audio with Groq's Orpheus model, chunking <=190 chars per call."""
        client = self.get_client()
        chunks = chunk_text_for_orpheus(clean_text, max_chars=190)
        if not chunks or len(chunks) > 4:
            raise ValueError("Text exceeds Orpheus inline chunk budget")

        wav_parts: list[bytes] = []
        for chunk in chunks:
            resp = await client.audio.speech.create(
                model=settings.TTS_MODEL,
                voice=voice,
                input=chunk,
                response_format="wav",
            )
            raw = getattr(resp, "content", None)
            if raw is None:
                if hasattr(resp, "aread"):
                    raw = await resp.aread()
                elif hasattr(resp, "read"):
                    raw = resp.read()
            if not raw:
                raise RuntimeError("Empty Orpheus audio response")
            wav_parts.append(bytes(raw))
        return concat_wav_chunks(wav_parts)

    async def _synthesize_edge_tts(self, clean_text: str, voice: str) -> bytes:
        """Synthesize MP3 audio via Microsoft Edge TTS."""
        async def _collect() -> bytes:
            communicate = edge_tts.Communicate(clean_text[:1500], voice)
            audio_buf = bytearray()
            async for chunk in communicate.stream():
                if chunk.get("type") == "audio" and chunk.get("data"):
                    audio_buf.extend(chunk["data"])
            return bytes(audio_buf)

        audio_bytes = await asyncio.wait_for(_collect(), timeout=15.0)
        if not audio_bytes:
            raise RuntimeError("Empty edge-tts audio response")
        return audio_bytes

    async def synthesize_speech(
        self,
        text: str,
        voice: Optional[str] = None,
    ) -> dict[str, Any]:
        """3-tier TTS: Groq Orpheus -> Edge TTS -> Web Speech JSON fallback."""
        start = time.perf_counter()
        requested_voice = (voice or settings.TTS_VOICE or "troy").strip()
        clean_text = clean_text_for_speech(text)
        last_reason = "No audio synthesized"

        if not clean_text:
            return {
                "fallback": True,
                "provider": "web_speech",
                "text": "",
                "voice": requested_voice,
                "latency_ms": 0.0,
                "reason": "Empty text",
            }

        if requested_voice == "web_speech":
            return {
                "fallback": True,
                "provider": "web_speech",
                "text": clean_text,
                "voice": requested_voice,
                "latency_ms": round((time.perf_counter() - start) * 1000, 1),
                "reason": "Browser native voice selected",
            }

        # Tier 1: Groq Orpheus (supports 6 English voices and WAV output)
        if requested_voice in ORPHEUS_VOICE_IDS and (
            self._explicit_client is not None or is_api_key_configured()
        ):
            try:
                wav_bytes = await self._synthesize_orpheus(clean_text, requested_voice)
                return {
                    "audio_bytes": wav_bytes,
                    "media_type": "audio/wav",
                    "provider": "groq-orpheus",
                    "voice": requested_voice,
                    "latency_ms": round((time.perf_counter() - start) * 1000, 1),
                }
            except Exception as exc:
                last_reason = f"Orpheus unavailable: {exc}"
                logger.warning("Tier 1 Orpheus TTS failed, falling back to edge-tts: %s", exc)
        else:
            last_reason = "Orpheus skipped (voice or API key)"

        # Tier 2: Edge TTS
        edge_voice = (
            requested_voice
            if requested_voice.endswith("Neural")
            else settings.EDGE_TTS_VOICE
        )
        try:
            mp3_bytes = await self._synthesize_edge_tts(clean_text, edge_voice)
            return {
                "audio_bytes": mp3_bytes,
                "media_type": "audio/mpeg",
                "provider": "edge-tts",
                "voice": edge_voice,
                "latency_ms": round((time.perf_counter() - start) * 1000, 1),
            }
        except Exception as exc:
            last_reason = f"Edge TTS unavailable: {exc}"
            logger.warning("Tier 2 edge-tts failed, returning Web Speech fallback: %s", exc)

        # Tier 3: Structured JSON fallback for frontend Web Speech API
        return {
            "fallback": True,
            "provider": "web_speech",
            "text": clean_text,
            "voice": requested_voice,
            "latency_ms": round((time.perf_counter() - start) * 1000, 1),
            "reason": last_reason,
        }
