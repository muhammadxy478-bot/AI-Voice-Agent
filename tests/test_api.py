"""Automated API, SQLite persistence, SSE streaming, and 3-tier voice tests."""

from __future__ import annotations

import io
import json
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from backend.database import ChatDatabase
from backend.main import create_app
from backend.services import AIService, chunk_text_for_orpheus, clean_text_for_speech


def _make_wav_bytes(duration_frames: int = 800, sample_rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * duration_frames)
    return buf.getvalue()


def _parse_sse(raw_body: str) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    for block in raw_body.strip().split("\n\n"):
        if not block.strip():
            continue
        event_name = "message"
        data_parts: list[str] = []
        for line in block.splitlines():
            if line.startswith("event:"):
                event_name = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data_parts.append(line.split(":", 1)[1].strip())
        if data_parts:
            events.append((event_name, json.loads("\n".join(data_parts))))
    return events


def test_root_docs_health_and_config(tmp_path):
    app = create_app(db_path=tmp_path / "test.db")
    with TestClient(app) as client:
        root_resp = client.get("/")
        assert root_resp.status_code == 200
        assert "NexusVoice AI" in root_resp.text

        docs_resp = client.get("/docs")
        assert docs_resp.status_code == 200

        health = client.get("/api/health").json()
        assert health["status"] == "ok"
        assert health["llm_model"] == "openai/gpt-oss-120b"
        assert health["stt_model"] == "whisper-large-v3-turbo"

        cfg = client.get("/api/config").json()
        persona_names = [p["name"] for p in cfg["personas"]]
        assert persona_names == [
            "Senior AI Architect",
            "Executive Assistant",
            "Technical Interviewer",
        ]
        orpheus_ids = [v["id"] for v in cfg["voices"]["orpheus"]]
        assert "troy" in orpheus_ids


def test_session_crud_and_sqlite_persistence(tmp_path):
    db_file = tmp_path / "persistent.db"
    app = create_app(db_path=db_file)
    with TestClient(app) as client:
        s1 = client.post(
            "/api/sessions",
            json={"title": "Kubernetes Sizing", "persona": "Senior AI Architect"},
        )
        assert s1.status_code == 201
        s1_data = s1.json()
        assert s1_data["title"] == "Kubernetes Sizing"

        s2 = client.post(
            "/api/sessions",
            json={"title": "Board Memo Prep", "persona": "Executive Assistant"},
        )
        assert s2.status_code == 201
        s2_data = s2.json()

        all_sessions = client.get("/api/sessions").json()["sessions"]
        assert len(all_sessions) == 2

        filtered = client.get("/api/sessions", params={"q": "board"}).json()["sessions"]
        assert len(filtered) == 1
        assert filtered[0]["id"] == s2_data["id"]

        patched = client.patch(
            f"/api/sessions/{s1_data['id']}",
            json={"title": "EKS Cluster Sizing"},
        )
        assert patched.status_code == 200
        assert patched.json()["title"] == "EKS Cluster Sizing"

        deleted = client.delete(f"/api/sessions/{s2_data['id']}")
        assert deleted.status_code == 200
        assert deleted.json()["deleted"] is True

        missing = client.get(f"/api/sessions/{s2_data['id']}/messages")
        assert missing.status_code == 404

    # Re-open SQLite directly to prove durability across instances
    reloaded = ChatDatabase(db_file)
    sessions_after = reloaded.list_sessions()
    assert len(sessions_after) == 1
    assert sessions_after[0]["title"] == "EKS Cluster Sizing"


def test_chat_stream_sse_and_message_persistence(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "gsk_test_mock_key")

    class _FakeStream:
        def __init__(self, chunks):
            self._iter = iter(chunks)

        def __aiter__(self):
            return self

        async def __anext__(self):
            try:
                return next(self._iter)
            except StopIteration as exc:
                raise StopAsyncIteration from exc

    fake_chunks = [
        # Reasoning/empty content chunk (must be skipped cleanly)
        SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=None))], usage=None),
        SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="Hello "))], usage=None),
        SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="world!"))], usage=None),
        # Usage-only final chunk with empty choices
        SimpleNamespace(choices=[], usage=SimpleNamespace(completion_tokens=42)),
    ]

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=AsyncMock(return_value=_FakeStream(fake_chunks))
            )
        )
    )
    service = AIService(client=fake_client)
    db_file = tmp_path / "chat.db"
    app = create_app(db_path=db_file, ai_service=service)

    with TestClient(app) as client:
        resp = client.post(
            "/api/chat/stream",
            json={
                "message": "Design a resilient queue worker in Python",
                "persona": "Senior AI Architect",
            },
        )
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers["content-type"]

        events = _parse_sse(resp.text)
        event_names = [e[0] for e in events]
        assert event_names == ["meta", "token", "token", "done"]

        meta_payload = events[0][1]
        done_payload = events[-1][1]
        session_id = meta_payload["session_id"]

        assert done_payload["content"] == "Hello world!"
        assert done_payload["metrics"]["tokens"] == 42
        assert done_payload["metrics"]["tokens_per_sec"] > 0

        hist = client.get(f"/api/sessions/{session_id}/messages")
        assert hist.status_code == 200
        msgs = hist.json()["messages"]
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"
        assert msgs[0]["content"] == "Design a resilient queue worker in Python"
        assert msgs[1]["role"] == "assistant"
        assert msgs[1]["content"] == "Hello world!"
        assert msgs[1]["tokens"] == 42


def test_chat_stream_missing_api_key_emits_sse_error(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "your_groq_api_key_here")
    app = create_app(db_path=tmp_path / "nokey.db")
    with TestClient(app) as client:
        resp = client.post(
            "/api/chat/stream",
            json={"message": "Ping"},
        )
        assert resp.status_code == 200
        events = _parse_sse(resp.text)
        assert [e[0] for e in events] == ["meta", "error"]
        assert events[1][1]["code"] == "api_key_missing"


def test_voice_transcribe_endpoint(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "gsk_test_mock_key")
    fake_client = SimpleNamespace(
        audio=SimpleNamespace(
            transcriptions=SimpleNamespace(
                create=AsyncMock(return_value=SimpleNamespace(text=" Deploy to production now. "))
            )
        )
    )
    app = create_app(db_path=tmp_path / "stt.db", ai_service=AIService(client=fake_client))
    with TestClient(app) as client:
        empty_resp = client.post(
            "/api/voice/transcribe",
            files={"file": ("empty.webm", b"", "audio/webm")},
        )
        assert empty_resp.status_code == 400

        ok_resp = client.post(
            "/api/voice/transcribe",
            files={"file": ("clip.webm", b"WEBM_FAKE_BYTES", "audio/webm")},
        )
        assert ok_resp.status_code == 200
        payload = ok_resp.json()
        assert payload["text"] == "Deploy to production now."
        assert payload["model"] == "whisper-large-v3-turbo"
        assert payload["latency_ms"] >= 0


def test_voice_speak_orpheus_chunking_and_fallback_chain(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "gsk_test_mock_key")
    wav_sample = _make_wav_bytes(400)

    # 1) Tier 1: Orpheus succeeds with >200-char text chunked & merged into valid WAV
    speech_create = AsyncMock(return_value=SimpleNamespace(content=wav_sample))
    fake_client = SimpleNamespace(
        audio=SimpleNamespace(speech=SimpleNamespace(create=speech_create))
    )
    service = AIService(client=fake_client)
    app = create_app(db_path=tmp_path / "tts.db", ai_service=service)

    long_sentence = (
        "Distributed systems scale horizontally through partitioning. "
        "Asynchronous event loops minimize thread contention across network calls. "
        "Consistent hashing balances stateful caches cleanly across nodes. "
        "Observability closes the loop on production reliability."
    )
    assert len(long_sentence) > 200
    assert all(len(c) <= 190 for c in chunk_text_for_orpheus(long_sentence))

    with TestClient(app) as client:
        resp = client.post("/api/voice/speak", json={"text": long_sentence, "voice": "troy"})
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/wav"
        assert resp.headers["x-tts-provider"] == "groq-orpheus"
        assert speech_create.await_count >= 2
        with wave.open(io.BytesIO(resp.content), "rb") as wf:
            assert wf.getnframes() == 400 * speech_create.await_count

    # 2) Tier 2: Orpheus rate-limits -> Edge TTS succeeds
    failing_client = SimpleNamespace(
        audio=SimpleNamespace(
            speech=SimpleNamespace(create=AsyncMock(side_effect=RuntimeError("429 Rate limit")))
        )
    )
    service_edge = AIService(client=failing_client)
    monkeypatch.setattr(service_edge, "_synthesize_edge_tts", AsyncMock(return_value=b"ID3_FAKE_MP3"))
    app_edge = create_app(db_path=tmp_path / "tts_edge.db", ai_service=service_edge)

    with TestClient(app_edge) as client:
        resp = client.post("/api/voice/speak", json={"text": "Fallback to Edge neural voice", "voice": "troy"})
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/mpeg"
        assert resp.headers["x-tts-provider"] == "edge-tts"
        assert resp.content == b"ID3_FAKE_MP3"

    # 3) Tier 3: Orpheus + Edge both fail -> clean JSON fallback for Web Speech API
    service_web = AIService(client=failing_client)
    monkeypatch.setattr(
        service_web,
        "_synthesize_edge_tts",
        AsyncMock(side_effect=RuntimeError("Edge network timeout")),
    )
    app_web = create_app(db_path=tmp_path / "tts_web.db", ai_service=service_web)

    with TestClient(app_web) as client:
        resp = client.post(
            "/api/voice/speak",
            json={"text": "**Hello** `architect`! [Docs](https://example.com)", "voice": "troy"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["fallback"] is True
        assert data["provider"] == "web_speech"
        assert data["text"] == "Hello architect! Docs"


def test_clean_text_for_speech():
    md = "# Title\nHere is **bold** text and [a link](https://example.com).\n```python\nprint('hi')\n```"
    cleaned = clean_text_for_speech(md)
    assert "Title" in cleaned
    assert "bold" in cleaned
    assert "a link" in cleaned
    assert "https://example.com" not in cleaned
    assert "print" not in cleaned
