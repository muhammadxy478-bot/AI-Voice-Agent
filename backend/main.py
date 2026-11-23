"""FastAPI application entrypoint, REST APIs, SSE chat streaming, and voice endpoints."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.config import (
    EDGE_VOICES,
    FRONTEND_DIR,
    NATIVE_VOICES,
    ORPHEUS_VOICES,
    is_api_key_configured,
    settings,
)
from backend.database import ChatDatabase
from backend.personas import DEFAULT_PERSONA_NAME, get_persona, list_personas
from backend.services import AIService


class SessionCreate(BaseModel):
    title: Optional[str] = Field(default="New Conversation", max_length=120)
    persona: Optional[str] = Field(default=DEFAULT_PERSONA_NAME)


class SessionUpdate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=120)
    persona: Optional[str] = Field(default=None)


class ChatStreamRequest(BaseModel):
    session_id: Optional[str] = None
    message: str = Field(..., min_length=1)
    persona: Optional[str] = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    voice_mode: bool = False


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1)
    voice: Optional[str] = None


def _format_sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _derive_session_title(message: str) -> str:
    collapsed = " ".join(message.strip().split())
    if len(collapsed) <= 48:
        return collapsed
    return collapsed[:45].rstrip() + "..."


def create_app(
    db_path: Optional[Path | str] = None,
    ai_service: Optional[AIService] = None,
) -> FastAPI:
    """Create and configure the FastAPI application instance."""
    resolved_db_path = Path(db_path) if db_path is not None else settings.DATABASE_PATH
    db = ChatDatabase(resolved_db_path)
    service = ai_service or AIService()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await asyncio.to_thread(db.init_db)
        yield

    application = FastAPI(
        title="Enterprise Conversational AI & Voice Assistant",
        description="Async FastAPI backend with SQLite persistence, Groq LLM streaming, Whisper STT, and 3-tier TTS.",
        version="1.0.0",
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan,
    )

    application.state.db = db
    application.state.ai_service = service

    application.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    if FRONTEND_DIR.exists():
        application.mount(
            "/static",
            StaticFiles(directory=str(FRONTEND_DIR)),
            name="static",
        )

    @application.get("/", include_in_schema=False)
    async def serve_frontend() -> FileResponse:
        index_file = FRONTEND_DIR / "index.html"
        if not index_file.exists():
            raise HTTPException(status_code=404, detail="Frontend index.html not found.")
        return FileResponse(index_file)

    @application.get("/api/health")
    async def health_check() -> dict[str, Any]:
        return {
            "status": "ok",
            "api_configured": is_api_key_configured(),
            "llm_model": settings.LLM_MODEL,
            "stt_model": settings.STT_MODEL,
            "tts_model": settings.TTS_MODEL,
        }

    @application.get("/api/config")
    async def get_config() -> dict[str, Any]:
        return {
            "api_configured": is_api_key_configured(),
            "models": {
                "llm": settings.LLM_MODEL,
                "stt": settings.STT_MODEL,
                "tts": settings.TTS_MODEL,
            },
            "default_persona": DEFAULT_PERSONA_NAME,
            "default_voice": settings.TTS_VOICE,
            "personas": list_personas(),
            "voices": {
                "orpheus": ORPHEUS_VOICES,
                "edge": EDGE_VOICES,
                "native": NATIVE_VOICES,
            },
        }

    @application.get("/api/sessions")
    async def list_sessions(
        q: Optional[str] = Query(default=None, description="Optional search filter"),
    ) -> dict[str, Any]:
        sessions = await asyncio.to_thread(db.list_sessions, q)
        return {"sessions": sessions}

    @application.post("/api/sessions", status_code=201)
    async def create_session(payload: Optional[SessionCreate] = None) -> dict[str, Any]:
        data = payload or SessionCreate()
        session = await asyncio.to_thread(
            db.create_session,
            data.title or "New Conversation",
            data.persona or DEFAULT_PERSONA_NAME,
        )
        return session

    @application.patch("/api/sessions/{session_id}")
    async def update_session(session_id: str, payload: SessionUpdate) -> dict[str, Any]:
        updated = await asyncio.to_thread(
            db.update_session,
            session_id,
            payload.title,
            payload.persona,
        )
        if updated is None:
            raise HTTPException(status_code=404, detail="Session not found.")
        return updated

    @application.delete("/api/sessions/{session_id}")
    async def delete_session(session_id: str) -> dict[str, Any]:
        deleted = await asyncio.to_thread(db.delete_session, session_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Session not found.")
        return {"deleted": True, "id": session_id}

    @application.get("/api/sessions/{session_id}/messages")
    async def get_session_messages(session_id: str) -> dict[str, Any]:
        session = await asyncio.to_thread(db.get_session, session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found.")
        messages = await asyncio.to_thread(db.get_messages, session_id)
        return {"session": session, "messages": messages}

    @application.post("/api/chat/stream")
    async def stream_chat(payload: ChatStreamRequest) -> StreamingResponse:
        user_text = payload.message.strip()
        if not user_text:
            raise HTTPException(status_code=400, detail="Message cannot be empty.")

        if payload.session_id:
            session = await asyncio.to_thread(db.get_session, payload.session_id)
            if session is None:
                raise HTTPException(status_code=404, detail="Session not found.")
        else:
            session = await asyncio.to_thread(
                db.create_session,
                _derive_session_title(user_text),
                payload.persona or DEFAULT_PERSONA_NAME,
            )

        target_persona_name = get_persona(payload.persona or session["persona"])["name"]
        new_title: Optional[str] = None
        if session["title"] in {"New Conversation", "New Chat"}:
            new_title = _derive_session_title(user_text)

        if new_title or target_persona_name != session["persona"]:
            updated = await asyncio.to_thread(
                db.update_session,
                session["id"],
                new_title,
                target_persona_name,
            )
            if updated is not None:
                session = updated

        user_msg = await asyncio.to_thread(
            db.add_message,
            session["id"],
            "user",
            user_text,
        )

        history = await asyncio.to_thread(db.get_messages, session["id"], 24)
        persona_cfg = get_persona(target_persona_name)
        system_prompt = persona_cfg["system_prompt"]
        if payload.voice_mode:
            system_prompt += (
                " The user is in Live Voice Mode: keep your response clear, conversational, "
                "and concise (under 4 sentences unless detailed steps are explicitly requested) "
                "so it sounds natural when spoken aloud."
            )

        llm_messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
        for item in history:
            llm_messages.append({"role": item["role"], "content": item["content"]})

        async def event_generator():
            yield _format_sse(
                "meta",
                {
                    "session_id": session["id"],
                    "title": session["title"],
                    "persona": session["persona"],
                    "user_message_id": user_msg["id"],
                    "model": settings.LLM_MODEL,
                },
            )

            if service._explicit_client is None and not is_api_key_configured():
                yield _format_sse(
                    "error",
                    {
                        "code": "api_key_missing",
                        "error": (
                            "Groq API key is not configured. Open .env and set "
                            "OPENAI_API_KEY to your Groq API key, then restart or retry."
                        ),
                    },
                )
                return

            try:
                async for event in service.stream_chat(
                    messages=llm_messages,
                    model=settings.LLM_MODEL,
                    temperature=payload.temperature,
                ):
                    if event["type"] == "token":
                        yield _format_sse("token", {"content": event["content"]})
                    elif event["type"] == "done":
                        content = event["content"]
                        metrics = event["metrics"]
                        saved_msg = await asyncio.to_thread(
                            db.add_message,
                            session["id"],
                            "assistant",
                            content,
                            metrics.get("latency_ms"),
                            metrics.get("ttft_ms"),
                            metrics.get("tokens"),
                            metrics.get("tokens_per_sec"),
                            metrics.get("model"),
                        )
                        yield _format_sse(
                            "done",
                            {
                                "message_id": saved_msg["id"],
                                "session_id": session["id"],
                                "title": session["title"],
                                "content": content,
                                "metrics": metrics,
                            },
                        )
            except Exception as exc:
                yield _format_sse(
                    "error",
                    {
                        "code": "llm_stream_error",
                        "error": str(exc),
                    },
                )

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @application.post("/api/voice/transcribe")
    async def transcribe_voice(
        file: UploadFile = File(...),
        language: Optional[str] = Form(default=None),
    ) -> dict[str, Any]:
        audio_bytes = await file.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Uploaded audio file is empty.")

        if service._explicit_client is None and not is_api_key_configured():
            raise HTTPException(
                status_code=503,
                detail="Groq API key is not configured in .env (OPENAI_API_KEY).",
            )

        try:
            result = await service.transcribe_audio(
                audio_bytes=audio_bytes,
                filename=file.filename or "recording.webm",
                content_type=file.content_type or "audio/webm",
                language=language,
            )
            return result
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Transcription failed: {exc}") from exc

    @application.post("/api/voice/speak")
    async def speak_voice(payload: SpeakRequest):
        if not payload.text.strip():
            raise HTTPException(status_code=400, detail="Text cannot be empty.")

        result = await service.synthesize_speech(
            text=payload.text,
            voice=payload.voice,
        )
        if "audio_bytes" in result:
            return Response(
                content=result["audio_bytes"],
                media_type=result["media_type"],
                headers={
                    "X-TTS-Provider": str(result["provider"]),
                    "X-TTS-Voice": str(result["voice"]),
                    "X-TTS-Latency-Ms": str(result["latency_ms"]),
                    "Cache-Control": "no-store",
                },
            )
        return JSONResponse(status_code=200, content=result)

    return application


app = create_app()
