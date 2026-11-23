"use strict";

(() => {
  const DEFAULT_PERSONAS = [
    {
      name: "Senior AI Architect",
      tagline: "Distributed systems, LLM pipelines, and production architecture trade-offs",
      starter_prompts: [
        "Design a low-latency voice AI pipeline with streaming STT, LLM, and TTS.",
        "Compare SQLite WAL mode vs. PostgreSQL for a single-node FastAPI microservice.",
        "Show how to prevent prompt injection and tool misuse in enterprise AI agents.",
        "Draft a zero-downtime deployment checklist for an async Python inference API.",
      ],
    },
    {
      name: "Executive Assistant",
      tagline: "Crisp executive briefs, meeting synthesis, prioritization, and action plans",
      starter_prompts: [
        "Turn rough engineering standup notes into an executive status brief.",
        "Draft a crisp board update email summarizing our Q4 AI reliability milestones.",
        "Create a 30-minute incident postmortem agenda with clear decision checkpoints.",
        "Help me prioritize five competing leadership requests using impact vs. urgency.",
      ],
    },
    {
      name: "Technical Interviewer",
      tagline: "Staff-level coding and system design evaluation with structured feedback",
      starter_prompts: [
        "Run a 20-minute system design interview: design a real-time collaborative doc editor.",
        "Give me a medium-hard Python async concurrency debugging problem to solve.",
        "Review my explanation of consistent hashing and probe for weak spots.",
        "Ask me three staff-level behavioral questions on cross-team technical alignment.",
      ],
    },
  ];

  const state = {
    config: null,
    personas: DEFAULT_PERSONAS,
    sessions: [],
    activeSessionId: null,
    messages: [],
    persona: localStorage.getItem("nexus_persona") || "Senior AI Architect",
    voice: localStorage.getItem("nexus_voice") || "troy",
    autoSpeak: localStorage.getItem("nexus_autospeak") === "true",
    isStreaming: false,
    abortController: null,
    isRecording: false,
    recordingOrigin: "dock", // "dock" | "modal"
    mediaRecorder: null,
    mediaStream: null,
    recordedChunks: [],
    recordingStartAt: 0,
    recordingTimerId: null,
    isSpeaking: false,
    voiceModalOpen: false,
    voiceState: "idle", // "idle" | "listening" | "transcribing" | "thinking" | "speaking"
    speakingSource: "none", // "none" | "audio" | "webspeech"
    currentAudioUrl: null,
    activeReplayMsgId: null,
    audioCtx: null,
    playbackAnalyser: null,
    mediaSourceConnected: false,
    micAnalyser: null,
    micSourceNode: null,
    waveformRafId: null,
    searchTimerId: null,
  };

  // DOM References
  const el = {
    sidebar: document.getElementById("sidebar"),
    sidebarBackdrop: document.getElementById("sidebar-backdrop"),
    mobileMenuBtn: document.getElementById("mobile-menu-btn"),
    apiStatusPill: document.getElementById("api-status-pill"),
    apiStatusDot: document.getElementById("api-status-dot"),
    apiStatusText: document.getElementById("api-status-text"),
    apiKeyBanner: document.getElementById("api-key-banner"),
    dismissBannerBtn: document.getElementById("dismiss-banner-btn"),
    newChatBtn: document.getElementById("new-chat-btn"),
    sessionSearch: document.getElementById("session-search"),
    clearSearchBtn: document.getElementById("clear-search-btn"),
    sessionList: document.getElementById("session-list"),
    personaSelect: document.getElementById("persona-select"),
    personaTagline: document.getElementById("persona-tagline"),
    voiceSelect: document.getElementById("voice-select"),
    autoSpeakToggle: document.getElementById("auto-speak-toggle"),
    chatTitle: document.getElementById("chat-title"),
    headerPersonaBadge: document.getElementById("header-persona-badge"),
    headerModelBadge: document.getElementById("header-model-badge"),
    stopAudioBtn: document.getElementById("stop-audio-btn"),
    openVoiceModalBtn: document.getElementById("open-voice-modal-btn"),
    dockVoiceBtn: document.getElementById("dock-voice-btn"),
    chatScroll: document.getElementById("chat-scroll"),
    emptyState: document.getElementById("empty-state"),
    starterPrompts: document.getElementById("starter-prompts"),
    messagesContainer: document.getElementById("messages-container"),
    scrollBottomBtn: document.getElementById("scroll-bottom-btn"),
    dockRecordingBar: document.getElementById("dock-recording-bar"),
    dockRecordingTimer: document.getElementById("dock-recording-timer"),
    micBtn: document.getElementById("mic-btn"),
    promptInput: document.getElementById("prompt-input"),
    sendBtn: document.getElementById("send-btn"),
    sendIcon: document.getElementById("send-icon"),
    stopStreamIcon: document.getElementById("stop-stream-icon"),
    voiceModal: document.getElementById("voice-modal"),
    closeVoiceModalBtn: document.getElementById("close-voice-modal-btn"),
    voiceModalMeta: document.getElementById("voice-modal-meta"),
    voiceStatusBadge: document.getElementById("voice-status-badge"),
    voiceStatusDot: document.getElementById("voice-status-dot"),
    voiceStatusText: document.getElementById("voice-status-text"),
    voiceWaveform: document.getElementById("voice-waveform"),
    voiceTranscriptBox: document.getElementById("voice-transcript-box"),
    voiceActionBtn: document.getElementById("voice-action-btn"),
    voiceOrbMic: document.getElementById("voice-orb-mic"),
    voiceOrbStop: document.getElementById("voice-orb-stop"),
    voiceActionLabel: document.getElementById("voice-action-label"),
    voiceInterruptBtn: document.getElementById("voice-interrupt-btn"),
    handsFreeToggle: document.getElementById("hands-free-toggle"),
    toastContainer: document.getElementById("toast-container"),
    ttsAudio: document.getElementById("tts-audio"),
  };

  // Configure Markdown Renderer
  if (window.marked) {
    window.marked.setOptions({
      breaks: true,
      gfm: true,
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderMarkdown(rawText) {
    const text = rawText || "";
    if (!window.marked) {
      return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
    }
    const parsed = window.marked.parse(text);
    if (window.DOMPurify) {
      return window.DOMPurify.sanitize(parsed);
    }
    return parsed;
  }

  function enhanceCodeBlocks(rootElement) {
    if (!rootElement) return;
    const preBlocks = rootElement.querySelectorAll("pre");
    preBlocks.forEach((pre) => {
      if (pre.parentElement && pre.parentElement.classList.contains("code-block-wrapper")) {
        return;
      }
      const codeEl = pre.querySelector("code");
      if (codeEl && window.hljs) {
        try {
          window.hljs.highlightElement(codeEl);
        } catch (_e) {
          // Ignore highlight failures for unknown languages
        }
      }

      let langLabel = "code";
      if (codeEl) {
        const langClass = Array.from(codeEl.classList).find((c) => c.startsWith("language-"));
        if (langClass) {
          langLabel = langClass.replace("language-", "");
        }
      }

      const wrapper = document.createElement("div");
      wrapper.className = "code-block-wrapper";

      const header = document.createElement("div");
      header.className = "code-block-header";
      header.innerHTML = `<span>${escapeHtml(langLabel)}</span>`;

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "code-copy-btn";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", async () => {
        const textToCopy = codeEl ? codeEl.innerText : pre.innerText;
        await copyToClipboard(textToCopy);
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy";
        }, 1600);
      });

      header.appendChild(copyBtn);
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
    });
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied to clipboard", "info");
    } catch (_err) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      showToast("Copied to clipboard", "info");
    }
  }

  function showToast(message, type = "info") {
    const toast = document.createElement("div");
    const colorMap = {
      info: "border-slate-700 bg-slate-900/95 text-slate-100",
      success: "border-emerald-500/40 bg-emerald-950/90 text-emerald-100",
      error: "border-rose-500/40 bg-rose-950/95 text-rose-100",
      warning: "border-amber-500/40 bg-amber-950/95 text-amber-100",
    };
    toast.className = `pointer-events-auto rounded-xl border px-3.5 py-2.5 text-xs font-medium shadow-xl backdrop-blur-md transition-opacity duration-200 ${colorMap[type] || colorMap.info}`;
    toast.textContent = message;
    el.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 220);
    }, 3200);
  }

  // =========================================================================
  // Audio Unlock & Playback Engine (Orpheus / Edge / Web Speech fallback)
  // =========================================================================
  async function ensureAudioUnlocked() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;

    if (!state.audioCtx) {
      state.audioCtx = new AudioContextCtor();
    }
    if (state.audioCtx.state === "suspended") {
      try {
        await state.audioCtx.resume();
      } catch (_err) {
        // Ignore until next user gesture
      }
    }

    if (!state.mediaSourceConnected && el.ttsAudio) {
      try {
        const source = state.audioCtx.createMediaElementSource(el.ttsAudio);
        const analyser = state.audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);
        analyser.connect(state.audioCtx.destination);
        state.playbackAnalyser = analyser;
        state.mediaSourceConnected = true;
      } catch (_err) {
        // Fallback: native <audio> playback still works directly
      }
    }
  }

  function updateSpeakingUi(active) {
    state.isSpeaking = active;
    if (active) {
      el.stopAudioBtn.classList.remove("hidden");
      el.stopAudioBtn.classList.add("inline-flex");
      el.voiceInterruptBtn.classList.remove("hidden");
    } else {
      el.stopAudioBtn.classList.add("hidden");
      el.stopAudioBtn.classList.remove("inline-flex");
      el.voiceInterruptBtn.classList.add("hidden");
      state.activeReplayMsgId = null;
      document.querySelectorAll(".replay-btn").forEach((btn) => {
        btn.classList.remove("text-cyan-300", "border-cyan-500/40", "bg-cyan-500/10");
      });
    }
  }

  function stopSpeaking(keepModalState = false) {
    if (el.ttsAudio) {
      el.ttsAudio.pause();
      el.ttsAudio.currentTime = 0;
      el.ttsAudio.removeAttribute("src");
      el.ttsAudio.load();
    }
    if (state.currentAudioUrl) {
      URL.revokeObjectURL(state.currentAudioUrl);
      state.currentAudioUrl = null;
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    state.speakingSource = "none";
    updateSpeakingUi(false);
    if (!keepModalState && state.voiceModalOpen && state.voiceState === "speaking") {
      setVoiceState("idle");
    }
  }

  function speakWithWebSpeech(text) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window) || !text.trim()) {
        resolve();
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices();
      const preferred =
        voices.find((v) => v.lang.startsWith("en") && /aria|natural|google|david|zira/i.test(v.name)) ||
        voices.find((v) => v.lang.startsWith("en"));
      if (preferred) {
        utterance.voice = preferred;
      }
      utterance.rate = 1.02;
      utterance.pitch = 1.0;

      state.speakingSource = "webspeech";
      updateSpeakingUi(true);
      if (state.voiceModalOpen) {
        setVoiceState("speaking");
      }

      utterance.onend = () => {
        state.speakingSource = "none";
        updateSpeakingUi(false);
        resolve();
      };
      utterance.onerror = () => {
        state.speakingSource = "none";
        updateSpeakingUi(false);
        resolve();
      };

      window.speechSynthesis.speak(utterance);
    });
  }

  async function speakText(text, messageId = null) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;

    await ensureAudioUnlocked();
    stopSpeaking(true);

    if (messageId !== null) {
      state.activeReplayMsgId = messageId;
      const btn = document.querySelector(`[data-replay-id="${messageId}"]`);
      if (btn) {
        btn.classList.add("text-cyan-300", "border-cyan-500/40", "bg-cyan-500/10");
      }
    }

    if (state.voice === "web_speech") {
      await speakWithWebSpeech(trimmed);
      await onSpeechFinished();
      return;
    }

    try {
      if (state.voiceModalOpen) {
        setVoiceState("speaking");
      }
      const resp = await fetch("/api/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed, voice: state.voice }),
      });

      if (!resp.ok) {
        throw new Error(`TTS HTTP ${resp.status}`);
      }

      const contentType = resp.headers.get("content-type") || "";
      if (contentType.startsWith("audio/")) {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        state.currentAudioUrl = url;
        state.speakingSource = "audio";
        updateSpeakingUi(true);

        await new Promise((resolve) => {
          el.ttsAudio.onended = () => {
            stopSpeaking(true);
            resolve();
          };
          el.ttsAudio.onerror = async () => {
            stopSpeaking(true);
            await speakWithWebSpeech(trimmed);
            resolve();
          };
          el.ttsAudio.src = url;
          el.ttsAudio.play().catch(async () => {
            stopSpeaking(true);
            await speakWithWebSpeech(trimmed);
            resolve();
          });
        });
      } else {
        const data = await resp.json();
        await speakWithWebSpeech(data.text || trimmed);
      }
    } catch (err) {
      console.warn("Speech synthesis failed, falling back to Web Speech:", err);
      await speakWithWebSpeech(trimmed);
    }

    await onSpeechFinished();
  }

  async function onSpeechFinished() {
    if (state.voiceModalOpen) {
      if (el.handsFreeToggle.checked && !state.isRecording && !state.isStreaming) {
        setVoiceState("idle");
        setTimeout(() => {
          if (state.voiceModalOpen && !state.isRecording && !state.isStreaming) {
            startRecording("modal");
          }
        }, 350);
      } else {
        setVoiceState("idle");
      }
    }
  }

  // =========================================================================
  // Sessions & Config APIs
  // =========================================================================
  function formatRelativeTime(isoString) {
    if (!isoString) return "";
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return "";
    const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diffSec < 60) return "just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return date.toLocaleDateString();
  }

  function getActivePersonaObj() {
    return state.personas.find((p) => p.name === state.persona) || state.personas[0];
  }

  function syncPersonaUi() {
    const pObj = getActivePersonaObj();
    if (pObj) {
      el.personaSelect.value = pObj.name;
      el.personaTagline.textContent = pObj.tagline;
      el.headerPersonaBadge.textContent = pObj.name;
      renderStarterPrompts(pObj.starter_prompts || []);
    }
    updateVoiceModalMeta();
  }

  function renderStarterPrompts(prompts) {
    el.starterPrompts.innerHTML = "";
    prompts.forEach((prompt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "group flex flex-col justify-between rounded-2xl border border-slate-800/90 bg-slate-900/60 p-4 text-left transition hover:border-indigo-500/50 hover:bg-slate-900";
      btn.innerHTML = `
        <span class="text-xs leading-relaxed text-slate-200 group-hover:text-white">${escapeHtml(prompt)}</span>
        <span class="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 opacity-80 group-hover:opacity-100">
          Use prompt →
        </span>
      `;
      btn.addEventListener("click", () => {
        sendChatMessage(prompt);
      });
      el.starterPrompts.appendChild(btn);
    });
  }

  function renderSessions() {
    el.sessionList.innerHTML = "";
    if (!state.sessions.length) {
      const empty = document.createElement("div");
      empty.className = "px-3 py-6 text-center text-xs text-slate-500";
      empty.textContent = el.sessionSearch.value.trim()
        ? "No matching conversations."
        : "No saved conversations yet.";
      el.sessionList.appendChild(empty);
      return;
    }

    state.sessions.forEach((session) => {
      const isActive = session.id === state.activeSessionId;
      const item = document.createElement("div");
      item.className = `group flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 cursor-pointer transition ${
        isActive
          ? "border border-indigo-500/35 bg-indigo-500/15 text-white"
          : "border border-transparent text-slate-300 hover:bg-slate-900/80 hover:text-white"
      }`;

      const info = document.createElement("div");
      info.className = "min-w-0 flex-1";
      info.innerHTML = `
        <div class="truncate text-xs font-medium">${escapeHtml(session.title)}</div>
        <div class="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-500">
          <span class="truncate">${escapeHtml(session.persona)}</span>
          <span>•</span>
          <span>${session.message_count || 0} msg</span>
          <span>•</span>
          <span>${escapeHtml(formatRelativeTime(session.updated_at))}</span>
        </div>
      `;

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.title = "Delete conversation";
      delBtn.className =
        "rounded-lg p-1.5 text-slate-500 opacity-0 transition hover:bg-rose-500/15 hover:text-rose-400 group-hover:opacity-100";
      delBtn.innerHTML = `
        <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
        </svg>
      `;
      delBtn.addEventListener("click", async (evt) => {
        evt.stopPropagation();
        await deleteSession(session.id);
      });

      item.addEventListener("click", async () => {
        await loadSession(session.id);
        closeMobileSidebar();
      });

      item.appendChild(info);
      item.appendChild(delBtn);
      el.sessionList.appendChild(item);
    });
  }

  async function fetchConfig() {
    try {
      const resp = await fetch("/api/config");
      if (!resp.ok) return;
      const data = await resp.json();
      state.config = data;
      if (Array.isArray(data.personas) && data.personas.length) {
        state.personas = data.personas;
      }
      if (data.models && data.models.llm) {
        el.headerModelBadge.textContent = data.models.llm;
      }

      if (data.api_configured) {
        el.apiStatusDot.className = "h-2 w-2 rounded-full bg-emerald-400";
        el.apiStatusText.textContent = "Groq Ready";
        el.apiKeyBanner.classList.add("hidden");
        el.apiKeyBanner.classList.remove("flex");
      } else {
        el.apiStatusDot.className = "h-2 w-2 rounded-full bg-amber-400";
        el.apiStatusText.textContent = "Key Needed";
        el.apiKeyBanner.classList.remove("hidden");
        el.apiKeyBanner.classList.add("flex");
      }
      syncPersonaUi();
    } catch (err) {
      console.error("Failed to load config:", err);
    }
  }

  async function fetchSessions(query = "") {
    const url = query.trim()
      ? `/api/sessions?q=${encodeURIComponent(query.trim())}`
      : "/api/sessions";
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      state.sessions = data.sessions || [];
      renderSessions();
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
    }
  }

  async function createNewSession() {
    try {
      const resp = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Conversation", persona: state.persona }),
      });
      if (!resp.ok) throw new Error("Unable to create session");
      const session = await resp.json();
      state.activeSessionId = session.id;
      state.messages = [];
      el.chatTitle.textContent = session.title;
      await fetchSessions(el.sessionSearch.value);
      renderMessages();
      el.promptInput.focus();
    } catch (err) {
      showToast(err.message || "Failed to create chat", "error");
    }
  }

  async function loadSession(sessionId) {
    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
      if (!resp.ok) throw new Error("Unable to load session");
      const data = await resp.json();
      state.activeSessionId = data.session.id;
      state.messages = data.messages || [];
      state.persona = data.session.persona;
      localStorage.setItem("nexus_persona", state.persona);
      el.chatTitle.textContent = data.session.title;
      syncPersonaUi();
      renderSessions();
      renderMessages();
      scrollToBottom(true);
    } catch (err) {
      showToast(err.message || "Failed to load conversation", "error");
    }
  }

  async function deleteSession(sessionId) {
    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      if (!resp.ok) throw new Error("Failed to delete conversation");
      if (state.activeSessionId === sessionId) {
        state.activeSessionId = null;
        state.messages = [];
        el.chatTitle.textContent = "New Conversation";
        renderMessages();
      }
      await fetchSessions(el.sessionSearch.value);
      showToast("Conversation deleted", "info");
    } catch (err) {
      showToast(err.message || "Delete failed", "error");
    }
  }

  // =========================================================================
  // Message Rendering
  // =========================================================================
  function buildMetricsBadge(msg) {
    const parts = [];
    if (msg.latency_ms !== null && msg.latency_ms !== undefined) {
      parts.push(`${Math.round(msg.latency_ms)} ms`);
    }
    if (msg.tokens_per_sec !== null && msg.tokens_per_sec !== undefined && msg.tokens_per_sec > 0) {
      parts.push(`${Number(msg.tokens_per_sec).toFixed(1)} tok/s`);
    }
    if (msg.tokens !== null && msg.tokens !== undefined && msg.tokens > 0) {
      parts.push(`${msg.tokens} tok`);
    }
    return parts.join(" • ");
  }

  function createMessageNode(msg, isStreamingPlaceholder = false) {
    const isUser = msg.role === "user";
    const row = document.createElement("div");
    row.className = `flex w-full gap-3 ${isUser ? "justify-end" : "justify-start"}`;
    row.dataset.messageId = msg.id || "";

    if (isUser) {
      row.innerHTML = `
        <div class="max-w-[82%] rounded-2xl rounded-br-sm bg-indigo-600/90 px-4 py-3 text-sm leading-relaxed text-white shadow-md shadow-indigo-950/40">
          <div class="whitespace-pre-wrap break-words">${escapeHtml(msg.content)}</div>
        </div>
      `;
      return row;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "flex max-w-[92%] gap-3 sm:max-w-[86%]";

    const avatar = document.createElement("div");
    avatar.className =
      "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-500/15 text-xs font-semibold text-indigo-300";
    avatar.textContent = "AI";

    const bubble = document.createElement("div");
    bubble.className =
      "min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-slate-800/90 bg-slate-900/75 px-4 py-3.5 shadow-sm";

    const bodyEl = document.createElement("div");
    bodyEl.className = `markdown-body ${isStreamingPlaceholder ? "streaming-cursor" : ""}`;
    bodyEl.innerHTML = renderMarkdown(msg.content);
    enhanceCodeBlocks(bodyEl);

    const footer = document.createElement("div");
    footer.className = "mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-2 text-[11px] text-slate-400";

    const actions = document.createElement("div");
    actions.className = "flex items-center gap-1.5";

    const replayBtn = document.createElement("button");
    replayBtn.type = "button";
    replayBtn.dataset.replayId = String(msg.id || "stream");
    replayBtn.className =
      "replay-btn inline-flex items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-800/70 px-2 py-1 text-[11px] text-slate-300 transition hover:border-cyan-500/40 hover:text-cyan-300";
    replayBtn.innerHTML = `
      <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
      </svg>
      Speak
    `;
    replayBtn.addEventListener("click", () => {
      speakText(msg.content, msg.id || "stream");
    });

    const copyMsgBtn = document.createElement("button");
    copyMsgBtn.type = "button";
    copyMsgBtn.className =
      "inline-flex items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-800/70 px-2 py-1 text-[11px] text-slate-300 transition hover:border-slate-600 hover:text-white";
    copyMsgBtn.textContent = "Copy";
    copyMsgBtn.addEventListener("click", async () => {
      await copyToClipboard(msg.content);
      copyMsgBtn.textContent = "Copied";
      setTimeout(() => {
        copyMsgBtn.textContent = "Copy";
      }, 1500);
    });

    actions.appendChild(replayBtn);
    actions.appendChild(copyMsgBtn);

    const metricsSpan = document.createElement("span");
    metricsSpan.className = "metrics-badge font-mono text-[11px] text-slate-400";
    metricsSpan.textContent = buildMetricsBadge(msg);

    footer.appendChild(actions);
    footer.appendChild(metricsSpan);

    bubble.appendChild(bodyEl);
    bubble.appendChild(footer);
    wrapper.appendChild(avatar);
    wrapper.appendChild(bubble);
    row.appendChild(wrapper);

    row._bodyEl = bodyEl;
    row._metricsEl = metricsSpan;
    row._replayBtn = replayBtn;
    row._copyBtn = copyMsgBtn;
    return row;
  }

  function renderMessages() {
    el.messagesContainer.innerHTML = "";
    if (!state.messages.length) {
      el.emptyState.classList.remove("hidden");
      return;
    }
    el.emptyState.classList.add("hidden");
    state.messages.forEach((msg) => {
      el.messagesContainer.appendChild(createMessageNode(msg, false));
    });
  }

  function scrollToBottom(force = false) {
    const container = el.chatScroll;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (force || distanceFromBottom < 140) {
      container.scrollTop = container.scrollHeight;
    }
  }

  // =========================================================================
  // Streaming SSE Chat Client
  // =========================================================================
  function setStreamingUi(streaming) {
    state.isStreaming = streaming;
    if (streaming) {
      el.sendIcon.classList.add("hidden");
      el.stopStreamIcon.classList.remove("hidden");
      el.sendBtn.title = "Stop generating";
      el.sendBtn.classList.remove("bg-indigo-600", "hover:bg-indigo-500");
      el.sendBtn.classList.add("bg-rose-600", "hover:bg-rose-500");
    } else {
      el.sendIcon.classList.remove("hidden");
      el.stopStreamIcon.classList.add("hidden");
      el.sendBtn.title = "Send message";
      el.sendBtn.classList.add("bg-indigo-600", "hover:bg-indigo-500");
      el.sendBtn.classList.remove("bg-rose-600", "hover:bg-rose-500");
    }
  }

  function parseSseBlock(block) {
    const lines = block.split(/\r?\n/);
    let eventName = "message";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (!dataLines.length) return null;
    try {
      return { event: eventName, data: JSON.parse(dataLines.join("\n")) };
    } catch (_err) {
      return null;
    }
  }

  async function sendChatMessage(rawText, options = { voiceMode: false }) {
    const messageText = (rawText || "").trim();
    if (!messageText || state.isStreaming) return;

    await ensureAudioUnlocked();
    stopSpeaking(true);

    el.emptyState.classList.add("hidden");
    if (!options.voiceMode) {
      el.promptInput.value = "";
      autoResizeTextarea();
    }

    const userMsg = {
      id: `local-user-${Date.now()}`,
      role: "user",
      content: messageText,
    };
    state.messages.push(userMsg);
    el.messagesContainer.appendChild(createMessageNode(userMsg, false));

    const assistantMsg = {
      id: `local-ai-${Date.now()}`,
      role: "assistant",
      content: "",
    };
    state.messages.push(assistantMsg);
    const assistantNode = createMessageNode(assistantMsg, true);
    el.messagesContainer.appendChild(assistantNode);
    scrollToBottom(true);

    const abortController = new AbortController();
    state.abortController = abortController;
    setStreamingUi(true);
    if (state.voiceModalOpen) {
      setVoiceState("thinking");
      updateVoiceSubtitle(messageText, "Thinking...");
    }

    let finalReplyText = "";
    let receivedError = false;
    let lastRenderAt = 0;

    try {
      const resp = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          session_id: state.activeSessionId,
          message: messageText,
          persona: state.persona,
          voice_mode: Boolean(options.voiceMode || state.voiceModalOpen),
        }),
      });

      if (!resp.ok || !resp.body) {
        const errBody = await resp.text();
        throw new Error(errBody || `HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";

        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed) continue;

          if (parsed.event === "meta") {
            state.activeSessionId = parsed.data.session_id;
            el.chatTitle.textContent = parsed.data.title || "Conversation";
            fetchSessions(el.sessionSearch.value);
          } else if (parsed.event === "token") {
            assistantMsg.content += parsed.data.content || "";
            finalReplyText = assistantMsg.content;
            const now = performance.now();
            if (now - lastRenderAt > 45) {
              assistantNode._bodyEl.innerHTML = renderMarkdown(assistantMsg.content);
              scrollToBottom(false);
              lastRenderAt = now;
              if (state.voiceModalOpen) {
                updateVoiceSubtitle(messageText, assistantMsg.content);
              }
            }
          } else if (parsed.event === "done") {
            finalReplyText = parsed.data.content || assistantMsg.content;
            assistantMsg.id = parsed.data.message_id || assistantMsg.id;
            assistantMsg.content = finalReplyText;
            Object.assign(assistantMsg, parsed.data.metrics || {});
            assistantNode.dataset.messageId = String(assistantMsg.id);
            if (assistantNode._replayBtn) {
              assistantNode._replayBtn.dataset.replayId = String(assistantMsg.id);
              assistantNode._replayBtn.onclick = () => speakText(assistantMsg.content, assistantMsg.id);
            }
            if (assistantNode._copyBtn) {
              assistantNode._copyBtn.onclick = async () => {
                await copyToClipboard(assistantMsg.content);
              };
            }
            if (assistantNode._metricsEl) {
              assistantNode._metricsEl.textContent = buildMetricsBadge(assistantMsg);
            }
            if (parsed.data.title) {
              el.chatTitle.textContent = parsed.data.title;
            }
          } else if (parsed.event === "error") {
            receivedError = true;
            const errMsg = parsed.data.error || "Streaming error occurred.";
            assistantMsg.content = `**Error:** ${errMsg}`;
            showToast(errMsg, "error");
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        if (!assistantMsg.content.trim()) {
          assistantMsg.content = "_Generation stopped._";
        }
      } else {
        receivedError = true;
        assistantMsg.content = `**Request Error:** ${err.message || "Connection failed"}`;
        showToast(err.message || "Chat request failed", "error");
      }
    } finally {
      assistantNode._bodyEl.classList.remove("streaming-cursor");
      assistantNode._bodyEl.innerHTML = renderMarkdown(assistantMsg.content);
      enhanceCodeBlocks(assistantNode._bodyEl);
      setStreamingUi(false);
      state.abortController = null;
      scrollToBottom(false);
      fetchSessions(el.sessionSearch.value);

      if (state.voiceModalOpen) {
        updateVoiceSubtitle(messageText, assistantMsg.content);
      }

      if (!receivedError && finalReplyText.trim() && (state.autoSpeak || state.voiceModalOpen)) {
        await speakText(finalReplyText, assistantMsg.id);
      } else if (state.voiceModalOpen) {
        setVoiceState("idle");
      }
    }
  }

  // =========================================================================
  // Microphone Recording, Whisper Transcription & Canvas Waveform Visualizer
  // =========================================================================
  function getSupportedAudioMimeType() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ];
    if (typeof MediaRecorder === "undefined") return "";
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function updateRecordingTimer() {
    const elapsedSec = Math.floor((Date.now() - state.recordingStartAt) / 1000);
    const mins = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
    const secs = String(elapsedSec % 60).padStart(2, "0");
    el.dockRecordingTimer.textContent = `${mins}:${secs}`;
  }

  function releaseMicrophoneStream() {
    if (state.micSourceNode) {
      try {
        state.micSourceNode.disconnect();
      } catch (_e) {
        // Ignore
      }
      state.micSourceNode = null;
    }
    state.micAnalyser = null;
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((track) => track.stop());
      state.mediaStream = null;
    }
  }

  async function startRecording(origin = "dock") {
    if (state.isRecording || state.isStreaming) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast("Microphone API unavailable in this browser context.", "error");
      return;
    }

    await ensureAudioUnlocked();
    stopSpeaking(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      state.mediaStream = stream;

      if (state.audioCtx) {
        const micSource = state.audioCtx.createMediaStreamSource(stream);
        const analyser = state.audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.78;
        micSource.connect(analyser);
        state.micSourceNode = micSource;
        state.micAnalyser = analyser;
      }

      const mimeType = getSupportedAudioMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      state.recordedChunks = [];
      state.recordingOrigin = origin;
      state.mediaRecorder = recorder;

      recorder.ondataavailable = (evt) => {
        if (evt.data && evt.data.size > 0) {
          state.recordedChunks.push(evt.data);
        }
      };

      recorder.onstop = async () => {
        const blobType = recorder.mimeType || mimeType || "audio/webm";
        const audioBlob = new Blob(state.recordedChunks, { type: blobType });
        state.recordedChunks = [];
        releaseMicrophoneStream();
        await handleRecordedAudio(audioBlob, blobType, origin);
      };

      recorder.start(120);
      state.isRecording = true;
      state.recordingStartAt = Date.now();

      if (origin === "dock") {
        el.dockRecordingBar.classList.remove("hidden");
        el.dockRecordingBar.classList.add("flex");
        el.micBtn.classList.add("bg-rose-500/20", "text-rose-400");
        updateRecordingTimer();
        state.recordingTimerId = setInterval(updateRecordingTimer, 500);
      } else {
        setVoiceState("listening");
      }
    } catch (err) {
      releaseMicrophoneStream();
      showToast(`Microphone error: ${err.message || "Permission denied"}`, "error");
      if (state.voiceModalOpen) {
        setVoiceState("idle");
      }
    }
  }

  function stopRecording() {
    if (!state.isRecording) return;
    state.isRecording = false;
    clearInterval(state.recordingTimerId);
    state.recordingTimerId = null;

    el.dockRecordingBar.classList.add("hidden");
    el.dockRecordingBar.classList.remove("flex");
    el.micBtn.classList.remove("bg-rose-500/20", "text-rose-400");

    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
      state.mediaRecorder.stop();
    }
  }

  async function handleRecordedAudio(audioBlob, mimeType, origin) {
    if (!audioBlob || audioBlob.size < 400) {
      showToast("Recording too short — please speak clearly.", "warning");
      if (origin === "modal") setVoiceState("idle");
      return;
    }

    if (origin === "modal") {
      setVoiceState("transcribing");
    } else {
      showToast("Transcribing audio...", "info");
    }

    const ext = mimeType.includes("mp4")
      ? "m4a"
      : mimeType.includes("ogg")
      ? "ogg"
      : "webm";

    const formData = new FormData();
    formData.append("file", audioBlob, `voice_input.${ext}`);

    try {
      const resp = await fetch("/api/voice/transcribe", {
        method: "POST",
        body: formData,
      });

      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.detail || `Transcription failed (${resp.status})`);
      }

      const transcript = (data.text || "").trim();
      if (!transcript) {
        showToast("No speech detected in audio.", "warning");
        if (origin === "modal") setVoiceState("idle");
        return;
      }

      if (origin === "modal") {
        await sendChatMessage(transcript, { voiceMode: true });
      } else {
        const prefix = el.promptInput.value.trim();
        el.promptInput.value = prefix ? `${prefix} ${transcript}` : transcript;
        autoResizeTextarea();
        el.promptInput.focus();
      }
    } catch (err) {
      showToast(err.message || "Voice transcription failed", "error");
      if (origin === "modal") {
        setVoiceState("idle");
      }
    }
  }

  // =========================================================================
  // Live Voice Mode Modal & Canvas Frequency Waveform Loop
  // =========================================================================
  function updateVoiceModalMeta() {
    el.voiceModalMeta.textContent = `${state.persona} • Voice: ${state.voice}`;
  }

  function updateVoiceSubtitle(userText, aiText) {
    el.voiceTranscriptBox.innerHTML = `
      <div class="text-xs text-cyan-300"><span class="font-semibold">You:</span> ${escapeHtml(userText || "")}</div>
      <div class="text-xs leading-relaxed text-slate-200"><span class="font-semibold text-indigo-300">AI:</span> ${escapeHtml(aiText || "")}</div>
    `;
    el.voiceTranscriptBox.scrollTop = el.voiceTranscriptBox.scrollHeight;
  }

  function setVoiceState(newState) {
    state.voiceState = newState;
    el.voiceActionBtn.classList.remove("voice-orb-listening", "voice-orb-speaking");
    el.voiceOrbMic.classList.remove("hidden");
    el.voiceOrbStop.classList.add("hidden");

    switch (newState) {
      case "listening":
        el.voiceStatusDot.className = "h-2.5 w-2.5 animate-ping rounded-full bg-emerald-400";
        el.voiceStatusText.textContent = "Listening... speak now";
        el.voiceActionLabel.textContent = "Tap to Stop & Send";
        el.voiceActionBtn.classList.add("voice-orb-listening");
        el.voiceOrbMic.classList.add("hidden");
        el.voiceOrbStop.classList.remove("hidden");
        break;
      case "transcribing":
        el.voiceStatusDot.className = "h-2.5 w-2.5 animate-pulse rounded-full bg-amber-400";
        el.voiceStatusText.textContent = "Transcribing with Whisper...";
        el.voiceActionLabel.textContent = "Processing speech";
        break;
      case "thinking":
        el.voiceStatusDot.className = "h-2.5 w-2.5 animate-pulse rounded-full bg-indigo-400";
        el.voiceStatusText.textContent = "Thinking & streaming reply...";
        el.voiceActionLabel.textContent = "Generating response";
        break;
      case "speaking":
        el.voiceStatusDot.className = "h-2.5 w-2.5 animate-pulse rounded-full bg-violet-400";
        el.voiceStatusText.textContent = "AI Speaking...";
        el.voiceActionLabel.textContent = "Tap to Interrupt & Speak";
        el.voiceActionBtn.classList.add("voice-orb-speaking");
        break;
      default:
        el.voiceStatusDot.className = "h-2.5 w-2.5 rounded-full bg-cyan-400";
        el.voiceStatusText.textContent = "Ready — Tap microphone to speak";
        el.voiceActionLabel.textContent = "Tap to Speak";
        break;
    }
  }

  function resizeWaveformCanvas() {
    const canvas = el.voiceWaveform;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(300, Math.floor(rect.width * dpr));
    canvas.height = Math.max(140, Math.floor(rect.height * dpr));
  }

  function drawWaveformFrame(ts) {
    if (!state.voiceModalOpen) {
      state.waveformRafId = null;
      return;
    }

    const canvas = el.voiceWaveform;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const midY = h / 2;

    ctx.clearRect(0, 0, w, h);

    // Subtle horizontal baseline
    ctx.strokeStyle = "rgba(148, 163, 184, 0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    const barCount = 56;
    const gap = w / barCount;
    const barWidth = Math.max(3, gap * 0.54);
    const t = ts * 0.004;

    let freqData = null;
    if (state.voiceState === "listening" && state.micAnalyser) {
      freqData = new Uint8Array(state.micAnalyser.frequencyBinCount);
      state.micAnalyser.getByteFrequencyData(freqData);
    } else if (state.voiceState === "speaking" && state.playbackAnalyser && state.speakingSource === "audio") {
      freqData = new Uint8Array(state.playbackAnalyser.frequencyBinCount);
      state.playbackAnalyser.getByteFrequencyData(freqData);
    }

    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    if (state.voiceState === "listening") {
      gradient.addColorStop(0, "#06b6d4");
      gradient.addColorStop(0.5, "#10b981");
      gradient.addColorStop(1, "#06b6d4");
    } else if (state.voiceState === "speaking") {
      gradient.addColorStop(0, "#6366f1");
      gradient.addColorStop(0.5, "#c084fc");
      gradient.addColorStop(1, "#38bdf8");
    } else if (state.voiceState === "thinking" || state.voiceState === "transcribing") {
      gradient.addColorStop(0, "#f59e0b");
      gradient.addColorStop(0.5, "#6366f1");
      gradient.addColorStop(1, "#38bdf8");
    } else {
      gradient.addColorStop(0, "#334155");
      gradient.addColorStop(0.5, "#6366f1");
      gradient.addColorStop(1, "#334155");
    }

    ctx.fillStyle = gradient;

    for (let i = 0; i < barCount; i++) {
      let amplitude = 0.08;
      if (freqData && freqData.length > 0) {
        const binIndex = Math.min(
          freqData.length - 1,
          Math.floor((i / barCount) * (freqData.length * 0.72))
        );
        amplitude = Math.max(0.06, freqData[binIndex] / 255);
      }

      if (state.voiceState === "speaking" && (!freqData || amplitude < 0.09)) {
        // Smooth harmonic pulse when speaking via Web Speech API or buffered output
        const env = Math.sin((i / (barCount - 1)) * Math.PI);
        amplitude =
          (0.24 + 0.48 * Math.abs(Math.sin(t * 2.1 + i * 0.35) * Math.cos(t * 1.3 - i * 0.18))) *
          (0.45 + 0.55 * env);
      } else if (state.voiceState === "thinking" || state.voiceState === "transcribing") {
        amplitude = 0.14 + 0.18 * Math.abs(Math.sin(t * 1.9 + i * 0.28));
      } else if (state.voiceState === "idle") {
        amplitude = 0.06 + 0.06 * Math.sin(t * 0.8 + i * 0.22);
      }

      const barHeight = Math.max(6, amplitude * (h * 0.84));
      const x = i * gap + (gap - barWidth) / 2;
      const y = midY - barHeight / 2;
      const radius = barWidth / 2;

      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, barWidth, barHeight, radius);
      } else {
        ctx.rect(x, y, barWidth, barHeight);
      }
      ctx.fill();
    }

    state.waveformRafId = requestAnimationFrame(drawWaveformFrame);
  }

  async function openVoiceModal() {
    await ensureAudioUnlocked();
    state.voiceModalOpen = true;
    updateVoiceModalMeta();
    el.voiceModal.classList.remove("hidden");
    el.voiceModal.classList.add("flex");
    setVoiceState(state.isSpeaking ? "speaking" : "idle");
    resizeWaveformCanvas();
    if (!state.waveformRafId) {
      state.waveformRafId = requestAnimationFrame(drawWaveformFrame);
    }
  }

  function closeVoiceModal() {
    if (state.isRecording && state.recordingOrigin === "modal") {
      stopRecording();
    }
    stopSpeaking(true);
    state.voiceModalOpen = false;
    el.voiceModal.classList.add("hidden");
    el.voiceModal.classList.remove("flex");
    if (state.waveformRafId) {
      cancelAnimationFrame(state.waveformRafId);
      state.waveformRafId = null;
    }
    setVoiceState("idle");
  }

  // =========================================================================
  // Layout Helpers & Event Bindings
  // =========================================================================
  function autoResizeTextarea() {
    el.promptInput.style.height = "auto";
    el.promptInput.style.height = `${Math.min(el.promptInput.scrollHeight, 176)}px`;
  }

  function openMobileSidebar() {
    el.sidebar.classList.remove("-translate-x-full");
    el.sidebarBackdrop.classList.remove("hidden");
  }

  function closeMobileSidebar() {
    el.sidebar.classList.add("-translate-x-full");
    el.sidebarBackdrop.classList.add("hidden");
  }

  function bindEvents() {
    // Unlock audio on first user gesture
    const unlockOnce = () => {
      ensureAudioUnlocked();
      window.removeEventListener("pointerdown", unlockOnce);
      window.removeEventListener("keydown", unlockOnce);
    };
    window.addEventListener("pointerdown", unlockOnce);
    window.addEventListener("keydown", unlockOnce);

    window.addEventListener("resize", () => {
      if (state.voiceModalOpen) resizeWaveformCanvas();
    });

    el.mobileMenuBtn.addEventListener("click", openMobileSidebar);
    el.sidebarBackdrop.addEventListener("click", closeMobileSidebar);

    el.dismissBannerBtn.addEventListener("click", () => {
      el.apiKeyBanner.classList.add("hidden");
      el.apiKeyBanner.classList.remove("flex");
    });

    el.newChatBtn.addEventListener("click", () => {
      createNewSession();
      closeMobileSidebar();
    });

    el.sessionSearch.addEventListener("input", () => {
      const val = el.sessionSearch.value;
      el.clearSearchBtn.classList.toggle("hidden", !val.trim());
      clearTimeout(state.searchTimerId);
      state.searchTimerId = setTimeout(() => {
        fetchSessions(val);
      }, 180);
    });

    el.clearSearchBtn.addEventListener("click", () => {
      el.sessionSearch.value = "";
      el.clearSearchBtn.classList.add("hidden");
      fetchSessions("");
    });

    el.personaSelect.addEventListener("change", async () => {
      state.persona = el.personaSelect.value;
      localStorage.setItem("nexus_persona", state.persona);
      syncPersonaUi();
      if (state.activeSessionId) {
        await fetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ persona: state.persona }),
        });
        fetchSessions(el.sessionSearch.value);
      }
    });

    el.voiceSelect.value = state.voice;
    el.voiceSelect.addEventListener("change", () => {
      state.voice = el.voiceSelect.value;
      localStorage.setItem("nexus_voice", state.voice);
      updateVoiceModalMeta();
    });

    el.autoSpeakToggle.checked = state.autoSpeak;
    el.autoSpeakToggle.addEventListener("change", () => {
      state.autoSpeak = el.autoSpeakToggle.checked;
      localStorage.setItem("nexus_autospeak", String(state.autoSpeak));
    });

    el.stopAudioBtn.addEventListener("click", () => stopSpeaking(false));
    el.voiceInterruptBtn.addEventListener("click", () => stopSpeaking(false));

    el.chatScroll.addEventListener("scroll", () => {
      const distance =
        el.chatScroll.scrollHeight - el.chatScroll.scrollTop - el.chatScroll.clientHeight;
      el.scrollBottomBtn.classList.toggle("hidden", distance < 180);
    });
    el.scrollBottomBtn.addEventListener("click", () => scrollToBottom(true));

    el.promptInput.addEventListener("input", autoResizeTextarea);
    el.promptInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.shiftKey) {
        evt.preventDefault();
        if (!state.isStreaming) {
          sendChatMessage(el.promptInput.value);
        }
      }
    });

    el.sendBtn.addEventListener("click", () => {
      if (state.isStreaming && state.abortController) {
        state.abortController.abort();
      } else {
        sendChatMessage(el.promptInput.value);
      }
    });

    el.micBtn.addEventListener("click", () => {
      if (state.isRecording) {
        stopRecording();
      } else {
        startRecording("dock");
      }
    });

    el.openVoiceModalBtn.addEventListener("click", openVoiceModal);
    el.dockVoiceBtn.addEventListener("click", openVoiceModal);
    el.closeVoiceModalBtn.addEventListener("click", closeVoiceModal);

    el.voiceActionBtn.addEventListener("click", () => {
      if (state.isRecording) {
        stopRecording();
      } else if (state.isSpeaking) {
        stopSpeaking(true);
        startRecording("modal");
      } else if (!state.isStreaming) {
        startRecording("modal");
      }
    });

    document.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape" && state.voiceModalOpen) {
        closeVoiceModal();
      }
    });
  }

  async function init() {
    bindEvents();
    syncPersonaUi();
    await fetchConfig();
    await fetchSessions();

    if (state.sessions.length > 0) {
      await loadSession(state.sessions[0].id);
    } else {
      renderMessages();
    }
  }

  init();
})();
