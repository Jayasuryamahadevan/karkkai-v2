import { api, errorMessage } from "../api.js";
import { createSpeech } from "../tts.js";
import {
  baseLang,
  copyText,
  escapeHtml,
  formatBytes,
  formatTime,
  icon,
  setButtonLoading,
  toast,
} from "../ui.js";

const SPEECH_LANGS = [
  { code: "ta-IN", label: "Tamil · தமிழ்" },
  { code: "en-IN", label: "English · India" },
  { code: "en-US", label: "English · US" },
  { code: "hi-IN", label: "Hindi · हिन्दी" },
  { code: "ml-IN", label: "Malayalam · മലയാളം" },
];

const TTS_LANGS = [
  { code: "ta", label: "Tamil · தமிழ்" },
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi · हिन्दी" },
  { code: "ml", label: "Malayalam" },
  { code: "te", label: "Telugu" },
  { code: "kn", label: "Kannada" },
  { code: "bn", label: "Bengali" },
];

const TTS_PRESETS = [
  "வணக்கம், எப்படி இருக்கிறீர்கள்?",
  "இன்று காலை நான் பள்ளிக்குச் சென்றேன்.",
  "தமிழ் மொழி மிகவும் அழகானது.",
  "உங்கள் உதவிக்கு மனமார்ந்த நன்றி.",
];

export function renderVoice(ctx) {
  const initialTab = ctx.takePending("voiceTab") || ctx.params.get("tab") || "live";
  let activeTab = initialTab === "tts" ? "tts" : "live";
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = Boolean(Recognition);
  let recognition = null;
  let listening = false;
  let manualStop = true;
  let restartTimer = null;
  let audio = null;
  let ttsAudio = null;
  let liveAudio = null;
  let ttsUrl = null;
  let selectedFile = null;
  let serverProviders = [];

  ctx.root.innerHTML = `
    <div class="view-head">
      <div class="view-head-copy">
        <span class="eyebrow">Voice</span>
        <h1>Let Tamil <em>speak</em>.</h1>
        <p>Dictate live in your browser, or turn written Tamil into a voice you can listen to and download. Live recognition is best in Chrome or Edge.</p>
      </div>
      <div class="view-head-actions">
        <div class="tabs" role="tablist" aria-label="Voice tools">
          <button class="tab-btn ${activeTab === "live" ? "active" : ""}" type="button" role="tab" aria-selected="${activeTab === "live"}" data-tab="live">${icon("mic", 15)} Speech to text</button>
          <button class="tab-btn ${activeTab === "tts" ? "active" : ""}" type="button" role="tab" aria-selected="${activeTab === "tts"}" data-tab="tts">${icon("volume", 15)} Text to speech</button>
        </div>
      </div>
    </div>

    <div id="livePane" class="pdf-pane" ${activeTab === "live" ? "" : "hidden"}>
      <div class="voice-grid">
        <section class="mic-panel" id="micPanel">
          <h3>Speak naturally.</h3>
          <p class="mic-sub">Tamil, English, or another language. Your browser does the listening.</p>
          <div class="mic-stage">
            <span class="mic-ring"></span>
            <span class="mic-ring r2"></span>
            <span class="mic-ring r3"></span>
            <button class="mic-button" type="button" id="micButton" aria-label="Start listening" ${supported ? "" : "disabled"}>
              ${icon("mic", 38)}
            </button>
          </div>
          <div class="mic-status" id="micStatus"><strong>${supported ? "Tap the microphone" : "Live speech is not available"}</strong>${supported ? " to begin." : " in this browser."}</div>
          <div class="wave-bars" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
          <div class="mic-controls">
            <div class="field">
              <label for="speechLang">Language</label>
              <select class="select select-sm" id="speechLang">
                ${SPEECH_LANGS.map((lang) => `<option value="${lang.code}">${escapeHtml(lang.label)}</option>`).join("")}
              </select>
            </div>
            <div class="switch-row" style="padding:0;border:0;gap:8px">
              <div class="switch-copy"><strong>Continuous</strong><span>Keep listening</span></div>
              <label class="switch"><input type="checkbox" id="continuousToggle" checked aria-label="Continuous listening"><span></span></label>
            </div>
          </div>
          ${supported ? "" : `<div class="note warn" style="margin-top:18px;text-align:left">${icon("alert", 15)}<span>Try Chrome or Edge, and make sure the page is on <b>localhost</b> or HTTPS. Uploaded audio still works with an API key.</span></div>`}
        </section>

        <div class="voice-side">
          <section class="transcript-card">
            <div class="panel-bar">
              <div class="panel-bar-left"><span class="badge green">Transcript</span><h3>Dictation</h3></div>
              <div class="panel-bar-actions">
                <button class="icon-btn" type="button" id="copyTranscript" aria-label="Copy transcript" title="Copy">${icon("copy", 15)}</button>
                <button class="icon-btn" type="button" id="clearTranscript" aria-label="Clear transcript" title="Clear">${icon("x", 15)}</button>
              </div>
            </div>
            <textarea class="transcript-area" id="transcript" placeholder="Your speech will appear here. You can also type and edit it…" spellcheck="false"></textarea>
            <div class="transcript-interim" id="interim"></div>
            <div class="panel-bar" style="border-top:1px solid var(--line);border-bottom:0">
              <div class="transcript-actions">
                <button class="btn btn-sm btn-secondary" type="button" id="translateTranscript" disabled>${icon("translate", 13)} Translate</button>
                <button class="btn btn-sm btn-ghost" type="button" id="speakTranscript" disabled>${icon("volume", 13)} Speak</button>
              </div>
              <span class="tiny muted" id="transcriptCount">0 characters</span>
            </div>
          </section>

          <section class="upload-card">
            <div class="upload-card-head">
              <div>
                <h3>Transcribe an audio file</h3>
                <p>Upload a recording for server-side transcription. This needs a Sarvam or OpenAI key.</p>
              </div>
              <span class="badge" id="uploadBadge">Checking…</span>
            </div>
            <div class="upload-empty" id="uploadEmpty">
              ${icon("upload", 22)}
              <span>MP3, WAV, M4A, WebM or OGG · up to 25 MB</span>
            </div>
            <div class="file-row" id="uploadFileRow" hidden>
              <span class="badge green">Audio</span>
              <span class="file-name" id="uploadFileName"></span>
              <button class="icon-btn sm" type="button" id="removeUpload" aria-label="Remove audio file">${icon("x", 14)}</button>
            </div>
            <div class="flex items-center gap-8 wrap mt-12">
              <input type="file" id="audioFile" accept="audio/*,.webm,.m4a,.mp3,.wav,.ogg" hidden>
              <button class="btn btn-sm btn-secondary" type="button" id="chooseAudio">${icon("upload", 14)} Choose audio</button>
              <button class="btn btn-sm btn-primary" type="button" id="transcribeFile" disabled>${icon("sparkle", 14)} Transcribe</button>
              <select class="select select-sm" id="sttProvider" style="max-width:160px" hidden></select>
            </div>
            <div id="uploadNote" class="note mt-12">${icon("info", 15)}<span>Live speech above works without a key. Uploaded audio is sent only to your chosen provider and is not kept by Chillian.</span></div>
          </section>
        </div>
      </div>
    </div>

    <div id="ttsPane" class="pdf-pane" ${activeTab === "tts" ? "" : "hidden"}>
      <div class="tts-workbench">
        <section class="tts-editor">
          <div class="panel-bar">
            <div class="panel-bar-left"><span class="badge gold">Text to speech</span><h3>What should it say?</h3></div>
            <div class="panel-bar-actions">
              <button class="icon-btn" type="button" id="clearTtsText" aria-label="Clear text" title="Clear">${icon("x", 15)}</button>
            </div>
          </div>
          <textarea class="tts-textarea" id="ttsText" maxlength="4500" placeholder="தமிழில் எழுதுங்கள்… or write in English." spellcheck="false">${escapeHtml(ctx.takePending("ttsText") || "")}</textarea>
          <div class="editor-foot">
            <span class="char-count" id="ttsCount">0 / 4,500</span>
            <button class="btn btn-primary" type="button" id="generateSpeech">${icon("volume", 16)} <span class="btn-label">Generate voice</span></button>
          </div>
        </section>

        <div class="tts-side">
          <section class="tts-options">
            <div class="tts-options-grid">
              <div class="field">
                <label for="ttsLang">Language</label>
                <select class="select select-sm" id="ttsLang">
                  ${TTS_LANGS.map((lang) => `<option value="${lang.code}">${escapeHtml(lang.label)}</option>`).join("")}
                </select>
              </div>
              <div class="field">
                <label>Voice engine</label>
                <div class="input" style="display:flex;align-items:center;height:34px;font-size:11px" id="ttsProviderLabel">Google voice</div>
              </div>
            </div>
            <div class="switch-row">
              <div class="switch-copy"><strong>Slow speech</strong><span>Clearer for practice</span></div>
              <label class="switch"><input type="checkbox" id="ttsSlow" ${ctx.prefs.ttsSlow ? "checked" : ""} aria-label="Slow speech"><span></span></label>
            </div>
            <div class="switch-row">
              <div class="switch-copy"><strong>Save this preference</strong><span>Use slow speech everywhere</span></div>
              <label class="switch"><input type="checkbox" id="ttsRememberSlow" checked aria-label="Remember slow speech preference"><span></span></label>
            </div>
            <div class="example-row" style="margin-top:7px">
              ${TTS_PRESETS.slice(0, 3).map((text) => `<button class="chip tamil" type="button" data-tts-preset="${escapeHtml(text)}">${escapeHtml(text.length > 30 ? `${text.slice(0, 28)}…` : text)}</button>`).join("")}
            </div>
          </section>

          <section class="audio-panel">
            <div class="flex items-center justify-between gap-8">
              <h3>Listen</h3>
              <span class="badge" id="audioBadge">Ready</span>
            </div>
            <div class="audio-empty" id="audioEmpty">Generate a voice to play or download it here.</div>
            <div class="audio-player" id="audioPlayer" hidden>
              <div class="audio-row">
                <button class="audio-play" type="button" id="playTts" aria-label="Play audio">${icon("play", 18)}</button>
                <div class="audio-progress">
                  <input type="range" id="ttsProgress" min="0" max="100" value="0" step="0.1" aria-label="Audio progress">
                  <div class="audio-times"><span id="ttsCurrent">0:00</span><span id="ttsDuration">0:00</span></div>
                </div>
                <div class="audio-actions">
                  <a class="icon-btn" id="downloadTts" download="chillian-voice.mp3" aria-label="Download audio" title="Download">${icon("download", 15)}</a>
                </div>
              </div>
            </div>
            <div class="note mt-12">${icon("info", 15)}<span>Generated speech uses Google gTTS by default. Tamil is spoken with a natural Indian-English voice model; longer text can take a few seconds.</span></div>
          </section>
        </div>
      </div>
    </div>
  `;

  const livePane = ctx.root.querySelector("#livePane");
  const ttsPane = ctx.root.querySelector("#ttsPane");
  const micPanel = ctx.root.querySelector("#micPanel");
  const micButton = ctx.root.querySelector("#micButton");
  const micStatus = ctx.root.querySelector("#micStatus");
  const transcript = ctx.root.querySelector("#transcript");
  const interim = ctx.root.querySelector("#interim");
  const speechLang = ctx.root.querySelector("#speechLang");
  const continuousToggle = ctx.root.querySelector("#continuousToggle");
  const transcriptCount = ctx.root.querySelector("#transcriptCount");
  const speakTranscript = ctx.root.querySelector("#speakTranscript");
  const translateTranscript = ctx.root.querySelector("#translateTranscript");

  /* ------------------------------------------------------------------ tabs */
  function setTab(tab) {
    activeTab = tab === "tts" ? "tts" : "live";
    livePane.hidden = activeTab !== "live";
    ttsPane.hidden = activeTab !== "tts";
    ctx.root.querySelectorAll("[data-tab]").forEach((button) => {
      const active = button.dataset.tab === activeTab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    if (activeTab !== "live" && listening) stopListening(true);
  }

  ctx.root.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => setTab(button.dataset.tab));
  });
  setTab(activeTab);

  /* --------------------------------------------------------------- transcript */
  function updateTranscriptUi() {
    const length = transcript.value.length;
    transcriptCount.textContent = `${length.toLocaleString()} character${length === 1 ? "" : "s"}`;
    translateTranscript.disabled = !transcript.value.trim();
    speakTranscript.disabled = !transcript.value.trim();
  }

  transcript.addEventListener("input", updateTranscriptUi);

  function appendTranscript(text) {
    const cleaned = String(text || "").trim();
    if (!cleaned) return;
    const current = transcript.value;
    const joiner = current && !/[\s\n]$/.test(current) ? " " : "";
    transcript.value = `${current}${joiner}${cleaned}`;
    updateTranscriptUi();
  }

  ctx.root.querySelector("#copyTranscript")?.addEventListener("click", () => {
    if (transcript.value.trim()) copyText(transcript.value, "Transcript copied");
    else toast("There is no transcript to copy yet.", { type: "info" });
  });
  ctx.root.querySelector("#clearTranscript")?.addEventListener("click", () => {
    transcript.value = "";
    interim.textContent = "";
    updateTranscriptUi();
    transcript.focus();
  });
  translateTranscript.addEventListener("click", () => {
    const text = transcript.value.trim();
    if (!text) return;
    const source = baseLang(speechLang.value);
    ctx.setPending({
      translate: {
        text,
        source,
        target: source === "ta" ? "en" : "ta",
        autoTranslate: true,
      },
    });
    ctx.go("translate");
  });
  speakTranscript.addEventListener("click", async () => {
    const text = transcript.value.trim();
    if (!text) return;
    setButtonLoading(speakTranscript, true, "Loading…");
    try {
      const speech = await createSpeech(text, {
        lang: baseLang(speechLang.value),
        slow: ctx.prefs.ttsSlow,
        engine: ctx.prefs.ttsEngine,
        signal: ctx.signal,
      });
      if (liveAudio) liveAudio.pause();
      liveAudio = new Audio(speech.url);
      liveAudio.play().catch(() => {});
    } catch (error) {
      if (!ctx.signal.aborted) toast(errorMessage(error), { type: "error", title: "Voice unavailable" });
    } finally {
      setButtonLoading(speakTranscript, false);
    }
  });

  /* ---------------------------------------------------------- speech to text */
  function setListeningState(value) {
    listening = value;
    micPanel.classList.toggle("listening", value);
    micButton.setAttribute("aria-label", value ? "Stop listening" : "Start listening");
    if (value) {
      micStatus.innerHTML = `<strong>Listening…</strong> speak now.`;
    } else {
      micStatus.innerHTML = `<strong>${supported ? "Tap the microphone" : "Live speech is not available"}</strong>${supported ? " to begin." : " in this browser."}`;
    }
  }

  function speechErrorMessage(code) {
    const messages = {
      "not-allowed": "Microphone permission was blocked. Allow it in the browser’s site settings and try again.",
      "service-not-allowed": "The browser blocked its speech service. Check microphone permissions and network access.",
      "no-speech": "I did not hear anything. Try again a little closer to the microphone.",
      "audio-capture": "No microphone was found. Check that one is connected and permitted.",
      network: "The browser’s speech service needs an internet connection.",
      aborted: "",
      "language-not-supported": "This browser does not support the selected speech language.",
    };
    return messages[code] ?? "Speech recognition stopped unexpectedly. Please try again.";
  }

  function createRecognition() {
    if (!supported) return null;
    const instance = new Recognition();
    instance.lang = speechLang.value;
    instance.continuous = continuousToggle.checked;
    instance.interimResults = true;
    instance.maxAlternatives = 1;

    instance.onstart = () => {
      manualStop = false;
      setListeningState(true);
    };
    instance.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      if (finalText) {
        appendTranscript(finalText);
        interim.textContent = "";
      } else {
        interim.textContent = interimText;
      }
    };
    instance.onerror = (event) => {
      if (event.error === "aborted") return;
      const message = speechErrorMessage(event.error);
      if (message) toast(message, { type: "error", title: "Live speech" });
      manualStop = true;
      setListeningState(false);
      interim.textContent = "";
    };
    instance.onend = () => {
      setListeningState(false);
      interim.textContent = "";
      if (!manualStop && continuousToggle.checked && activeTab === "live") {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          try { instance.start(); } catch { /* already started */ }
        }, 350);
      }
    };
    return instance;
  }

  function startListening() {
    if (!supported) {
      toast("Live speech needs Chrome or Edge. You can still upload audio below.", { type: "info" });
      return;
    }
    if (!window.isSecureContext) {
      toast("Live speech needs localhost or HTTPS.", { type: "error" });
      return;
    }
    recognition = createRecognition();
    manualStop = false;
    try {
      recognition.start();
    } catch (error) {
      manualStop = true;
      toast("The microphone could not start. Close other apps using it and try again.", { type: "error" });
    }
  }

  function stopListening(quiet = false) {
    manualStop = true;
    clearTimeout(restartTimer);
    if (recognition && listening) {
      try { recognition.stop(); } catch { /* ignore */ }
    }
    setListeningState(false);
    if (!quiet) toast("Listening stopped.", { type: "info", timeout: 1800 });
  }

  micButton?.addEventListener("click", () => {
    if (listening) stopListening();
    else startListening();
  });
  speechLang.addEventListener("change", () => {
    if (listening) {
      stopListening(true);
      setTimeout(startListening, 250);
    }
  });

  /* ------------------------------------------------------------- upload STT */
  const audioFile = ctx.root.querySelector("#audioFile");
  const chooseAudio = ctx.root.querySelector("#chooseAudio");
  const transcribeFile = ctx.root.querySelector("#transcribeFile");
  const uploadFileRow = ctx.root.querySelector("#uploadFileRow");
  const uploadEmpty = ctx.root.querySelector("#uploadEmpty");
  const uploadFileName = ctx.root.querySelector("#uploadFileName");
  const uploadBadge = ctx.root.querySelector("#uploadBadge");
  const uploadNote = ctx.root.querySelector("#uploadNote");
  const sttProvider = ctx.root.querySelector("#sttProvider");

  function updateSelectedFile() {
    if (!selectedFile) {
      uploadFileRow.hidden = true;
      uploadEmpty.hidden = false;
      transcribeFile.disabled = true;
      return;
    }
    uploadFileRow.hidden = false;
    uploadEmpty.hidden = true;
    uploadFileName.textContent = `${selectedFile.name} · ${formatBytes(selectedFile.size)}`;
    transcribeFile.disabled = serverProviders.length === 0;
  }

  chooseAudio.addEventListener("click", () => audioFile.click());
  audioFile.addEventListener("change", () => {
    const file = audioFile.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      toast("That audio file is larger than 25 MB.", { type: "error" });
      return;
    }
    selectedFile = file;
    updateSelectedFile();
  });
  ctx.root.querySelector("#removeUpload")?.addEventListener("click", () => {
    selectedFile = null;
    audioFile.value = "";
    updateSelectedFile();
  });

  transcribeFile.addEventListener("click", async () => {
    if (!selectedFile) return;
    setButtonLoading(transcribeFile, true, "Transcribing…");
    try {
      const form = new FormData();
      form.append("file", selectedFile, selectedFile.name);
      form.append("lang", baseLang(speechLang.value));
      form.append("provider", sttProvider.value || "auto");
      const data = await api.form("/api/stt", form, { timeout: 120000, signal: ctx.signal });
      if (data.transcript) {
        appendTranscript(data.transcript);
        toast(`Audio transcribed with ${data.provider_label || "the server"}.`, { type: "success" });
        transcript.focus();
      } else {
        toast("The transcription was empty. Try a clearer or longer recording.", { type: "info" });
      }
    } catch (error) {
      if (!ctx.signal.aborted) {
        toast(errorMessage(error), { type: "error", title: "Could not transcribe" });
        if (error.status === 503) {
          uploadNote.className = "note warn mt-12";
          uploadNote.innerHTML = `${icon("info", 15)}<span>${escapeHtml(errorMessage(error))}</span>`;
        }
      }
    } finally {
      setButtonLoading(transcribeFile, false);
      updateSelectedFile();
    }
  });

  function paintServerStt(health) {
    const stt = health?.stt;
    serverProviders = Array.isArray(stt?.server_available) ? stt.server_available : [];
    if (serverProviders.length) {
      uploadBadge.className = "badge green";
      uploadBadge.textContent = "Ready";
      uploadNote.className = "note green mt-12";
      uploadNote.innerHTML = `${icon("check", 15)}<span>Uploaded audio can be transcribed with ${serverProviders.map((p) => stt.labels?.[p] || p).join(" or ")}.</span>`;
      sttProvider.hidden = serverProviders.length < 2;
      sttProvider.innerHTML = serverProviders.map((provider) => `<option value="${provider}">${escapeHtml(stt.labels?.[provider] || provider)}</option>`).join("");
      transcribeFile.disabled = !selectedFile;
    } else {
      uploadBadge.className = "badge gold";
      uploadBadge.textContent = "Key needed";
      uploadNote.className = "note mt-12";
      uploadNote.innerHTML = `${icon("info", 15)}<span>Live speech above works without a key. For uploaded audio, add <b>SARVAM_API_KEY</b> or <b>OPENAI_API_KEY</b> to <code>.env</code>, then restart.</span>`;
      transcribeFile.disabled = true;
      sttProvider.hidden = true;
    }
  }

  /* ------------------------------------------------------------------- TTS */
  const ttsText = ctx.root.querySelector("#ttsText");
  const ttsCount = ctx.root.querySelector("#ttsCount");
  const ttsLang = ctx.root.querySelector("#ttsLang");
  const ttsSlow = ctx.root.querySelector("#ttsSlow");
  const rememberSlow = ctx.root.querySelector("#ttsRememberSlow");
  const generateSpeech = ctx.root.querySelector("#generateSpeech");
  const audioEmpty = ctx.root.querySelector("#audioEmpty");
  const audioPlayer = ctx.root.querySelector("#audioPlayer");
  const playTts = ctx.root.querySelector("#playTts");
  const ttsProgress = ctx.root.querySelector("#ttsProgress");
  const ttsCurrent = ctx.root.querySelector("#ttsCurrent");
  const ttsDuration = ctx.root.querySelector("#ttsDuration");
  const downloadTts = ctx.root.querySelector("#downloadTts");
  const audioBadge = ctx.root.querySelector("#audioBadge");
  const ttsProviderLabel = ctx.root.querySelector("#ttsProviderLabel");

  function updateTtsCount() {
    const length = ttsText.value.length;
    ttsCount.textContent = `${length.toLocaleString()} / 4,500`;
    ttsCount.classList.toggle("near", length > 4000);
    generateSpeech.disabled = !ttsText.value.trim();
  }
  ttsText.addEventListener("input", updateTtsCount);
  ctx.root.querySelector("#clearTtsText")?.addEventListener("click", () => {
    ttsText.value = "";
    updateTtsCount();
    ttsText.focus();
  });
  ctx.root.querySelectorAll("[data-tts-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      ttsText.value = button.dataset.ttsPreset;
      updateTtsCount();
      ttsText.focus();
    });
  });

  function paintAudio() {
    if (!ttsAudio) {
      audioEmpty.hidden = false;
      audioPlayer.hidden = true;
      return;
    }
    audioEmpty.hidden = true;
    audioPlayer.hidden = false;
    audioBadge.className = "badge green";
    audioBadge.textContent = "Generated";
    const update = () => {
      const duration = Number.isFinite(ttsAudio.duration) ? ttsAudio.duration : 0;
      ttsDuration.textContent = formatTime(duration);
      ttsCurrent.textContent = formatTime(ttsAudio.currentTime);
      ttsProgress.value = duration ? (ttsAudio.currentTime / duration) * 100 : 0;
      playTts.innerHTML = ttsAudio.paused ? icon("play", 18) : icon("pause", 18);
    };
    if (ttsAudio.readyState >= 1) update();
    else ttsAudio.addEventListener("loadedmetadata", update, { once: true });
    playTts.innerHTML = ttsAudio.paused ? icon("play", 18) : icon("pause", 18);
  }

  generateSpeech.addEventListener("click", async () => {
    const text = ttsText.value.trim();
    if (!text) return;
    setButtonLoading(generateSpeech, true, "Generating…");
    audioBadge.className = "badge gold";
    audioBadge.textContent = "Working";
    try {
      const speech = await createSpeech(text, {
        lang: ttsLang.value,
        slow: ttsSlow.checked,
        engine: ctx.prefs.ttsEngine,
        signal: ctx.signal,
      });
      if (ttsAudio) { ttsAudio.pause(); ttsAudio.src = ""; }
      if (ttsUrl) URL.revokeObjectURL(ttsUrl);
      ttsUrl = speech.url;
      ttsAudio = new Audio(ttsUrl);
      ttsAudio.addEventListener("timeupdate", () => {
        const duration = ttsAudio.duration || 0;
        ttsProgress.value = duration ? (ttsAudio.currentTime / duration) * 100 : 0;
        ttsCurrent.textContent = formatTime(ttsAudio.currentTime);
        ttsDuration.textContent = formatTime(duration);
      });
      ttsAudio.addEventListener("play", () => { playTts.innerHTML = icon("pause", 18); });
      ttsAudio.addEventListener("pause", () => { playTts.innerHTML = icon("play", 18); });
      ttsAudio.addEventListener("ended", () => {
        playTts.innerHTML = icon("play", 18);
        ttsProgress.value = 0;
        ttsAudio.currentTime = 0;
      });
      downloadTts.href = ttsUrl;
      downloadTts.download = `chillian-voice-${Date.now()}.mp3`;
      paintAudio();
      audioBadge.innerHTML = `${escapeHtml(speech.provider === "sarvam" ? "Sarvam" : "Google")} voice`;
      ttsAudio.play().catch(() => {});
      if (rememberSlow.checked) {
        ctx.prefs.ttsSlow = ttsSlow.checked;
        const { savePrefs } = await import("../store.js");
        savePrefs(ctx.prefs);
      }
    } catch (error) {
      audioBadge.className = "badge terra";
      audioBadge.textContent = "Failed";
      if (!ctx.signal.aborted) toast(errorMessage(error), { type: "error", title: "Could not generate voice" });
    } finally {
      setButtonLoading(generateSpeech, false);
      updateTtsCount();
    }
  });

  playTts.addEventListener("click", () => {
    if (!ttsAudio) return;
    if (ttsAudio.paused) ttsAudio.play().catch(() => {});
    else ttsAudio.pause();
  });
  ttsProgress.addEventListener("input", () => {
    if (!ttsAudio || !Number.isFinite(ttsAudio.duration)) return;
    ttsAudio.currentTime = (Number(ttsProgress.value) / 100) * ttsAudio.duration;
  });
  ttsSlow.addEventListener("change", () => {
    if (rememberSlow.checked) {
      ctx.prefs.ttsSlow = ttsSlow.checked;
      import("../store.js").then(({ savePrefs }) => savePrefs(ctx.prefs));
    }
  });

  function paintTtsProvider(health) {
    const preferred = health?.tts?.preferred || "google";
    const available = health?.tts?.available || {};
    let provider = ctx.prefs.ttsEngine;
    if (provider === "auto") provider = preferred;
    if (provider === "sarvam" && !available.sarvam) provider = "google";
    ttsProviderLabel.textContent = provider === "sarvam" ? "Sarvam voice" : "Google voice";
    ttsProviderLabel.title = provider === "sarvam" ? "Sarvam AI" : "Google gTTS";
  }

  updateTtsCount();
  updateTranscriptUi();
  updateSelectedFile();
  ctx.ensureHealth().then((health) => {
    if (ctx.signal.aborted) return;
    paintServerStt(health);
    paintTtsProvider(health);
    if (serverProviders.length && !selectedFile) {
      // Keep the upload section honest: ready, but still needs a file.
      transcribeFile.disabled = true;
    }
  });

  return () => {
    manualStop = true;
    clearTimeout(restartTimer);
    if (recognition) {
      try { recognition.abort(); } catch { /* ignore */ }
      recognition = null;
    }
    if (audio) { audio.pause(); audio.src = ""; }
    if (ttsAudio) { ttsAudio.pause(); ttsAudio.src = ""; }
    if (liveAudio) { liveAudio.pause(); liveAudio.src = ""; }
    if (ttsUrl) URL.revokeObjectURL(ttsUrl);
  };
}
