import { api, errorMessage } from "../api.js";
import { addRecent, loadRecents } from "../store.js";
import { createSpeech } from "../tts.js";
import {
  baseLang,
  escapeHtml,
  icon,
  languageLabel,
  setButtonLoading,
  toast,
} from "../ui.js";

const MAX_CHARS = 5000;

function langOptions(languages, selected, includeAuto = false) {
  const items = includeAuto ? [{ code: "auto", name: "Auto-detect" }, ...languages] : languages;
  return items.map((lang) => {
    const native = lang.code !== "en" && lang.ta ? ` · ${lang.ta}` : "";
    return `<option value="${escapeHtml(lang.code)}" ${lang.code === selected ? "selected" : ""}>${escapeHtml(lang.name)}${native}</option>`;
  }).join("");
}

export function renderTranslate(ctx) {
  const languages = ctx.languages();
  const pending = ctx.takePending("translate") || {};
  const params = ctx.params;
  let source = pending.source || params.get("source") || ctx.prefs.defaultSource || "en";
  let target = pending.target || params.get("target") || ctx.prefs.defaultTarget || "ta";
  if (source === "auto" && target === "auto") source = "en";
  if (source === target) {
    target = source === "ta" ? "en" : "ta";
  }
  let result = null;
  let loading = false;
  let audio = null;
  let lastIssueText = "";

  ctx.root.innerHTML = `
    <div class="view-head">
      <div class="view-head-copy">
        <span class="eyebrow">Translate</span>
        <h1>Move between <em>English</em> and Tamil.</h1>
        <p>Write naturally. Chillian uses Yandex Translator first, then falls back to MyMemory if it needs to. Tamil text is set in a proper Tamil serif.</p>
      </div>
      <div class="view-head-actions">
        <button class="btn btn-secondary btn-sm" type="button" id="clearTranslate">${icon("trash", 14)} Clear</button>
        <button class="btn btn-ghost btn-sm" type="button" id="openVoice">${icon("mic", 14)} Voice instead</button>
      </div>
    </div>

    <section class="language-bar" aria-label="Translation languages">
      <div class="field lang-field">
        <label for="sourceLang">From</label>
        <select class="select" id="sourceLang">${langOptions(languages, source, true)}</select>
      </div>
      <button class="swap-btn" type="button" id="swapLanguages" aria-label="Swap languages" title="Swap languages">${icon("swap", 18)}</button>
      <div class="field lang-field">
        <label for="targetLang">To</label>
        <select class="select" id="targetLang">${langOptions(languages, target, false)}</select>
      </div>
    </section>
    <div class="lang-meta-row">
      <span id="languageHint">${source === "auto" ? "Chillian will detect the source language." : `Translating from ${escapeHtml(languageLabel(source, languages))}.`}</span>
      <span>${icon("lock", 12)} Text is processed in memory and never stored on the server.</span>
    </div>

    <div class="workbench">
      <section class="editor-panel">
        <div class="panel-bar">
          <div class="panel-bar-left">
            <span class="badge terra" id="sourceBadge">${escapeHtml(languageLabel(source, languages).toUpperCase())}</span>
            <h3>Your text</h3>
          </div>
          <div class="panel-bar-actions">
            <button class="icon-btn" type="button" id="pasteText" aria-label="Paste text" title="Paste">${icon("copy", 15)}</button>
            <button class="icon-btn" type="button" id="clearText" aria-label="Clear text" title="Clear">${icon("x", 15)}</button>
          </div>
        </div>
        <textarea class="translate-input" id="sourceText" maxlength="${MAX_CHARS}" placeholder="Type or paste something to translate…" spellcheck="false">${escapeHtml(pending.text || params.get("text") || "")}</textarea>
        <div class="editor-foot">
          <span class="char-count" id="charCount">0 / ${MAX_CHARS.toLocaleString()}</span>
          <button class="btn btn-primary" type="button" id="translateBtn">${icon("sparkle", 16)} <span class="btn-label">Translate</span></button>
        </div>
      </section>

      <section class="result-panel" aria-live="polite">
        <div class="panel-bar">
          <div class="panel-bar-left">
            <span class="badge green" id="targetBadge">${escapeHtml(languageLabel(target, languages).toUpperCase())}</span>
            <h3>Translation</h3>
          </div>
          <div class="panel-bar-actions">
            <button class="icon-btn" type="button" id="copyResult" aria-label="Copy translation" title="Copy" disabled>${icon("copy", 15)}</button>
            <button class="icon-btn" type="button" id="speakResult" aria-label="Speak translation" title="Listen" disabled>${icon("volume", 15)}</button>
          </div>
        </div>
        <div class="result-body" id="resultBody"></div>
        <div class="result-foot" id="resultFoot">
          <span class="result-meta">Ready when you are.</span>
          <span class="badge">Ctrl + Enter</span>
        </div>
      </section>
    </div>

    <div class="translate-actionbar">
      <div class="example-row" id="exampleRow"></div>
      <span class="shortcut-hint">${navigator.onLine ? "Online translation" : "You are offline — translation will resume when connected"}</span>
    </div>

    <section class="recents" id="recentsSection" hidden>
      <div class="section-head" style="margin-top:26px">
        <div><h2>Recently translated</h2><p>Kept only in this browser.</p></div>
        <button class="btn btn-ghost btn-sm" type="button" id="clearRecents">Clear history</button>
      </div>
      <div class="recent-list" id="recentList"></div>
    </section>
  `;

  const sourceSelect = ctx.root.querySelector("#sourceLang");
  const targetSelect = ctx.root.querySelector("#targetLang");
  const sourceText = ctx.root.querySelector("#sourceText");
  const charCount = ctx.root.querySelector("#charCount");
  const translateBtn = ctx.root.querySelector("#translateBtn");
  const resultBody = ctx.root.querySelector("#resultBody");
  const resultFoot = ctx.root.querySelector("#resultFoot");
  const copyButton = ctx.root.querySelector("#copyResult");
  const speakButton = ctx.root.querySelector("#speakResult");

  function refreshLanguageOptions() {
    const langs = ctx.languages();
    const currentSource = sourceSelect.value;
    const currentTarget = targetSelect.value;
    sourceSelect.innerHTML = langOptions(langs, currentSource, true);
    targetSelect.innerHTML = langOptions(langs, currentTarget, false);
    updateLanguageHints();
  }

  function updateLanguageHints() {
    source = sourceSelect.value;
    target = targetSelect.value;
    const langs = ctx.languages();
    const hint = ctx.root.querySelector("#languageHint");
    if (hint) {
      hint.textContent = source === "auto"
        ? "Chillian will detect the source language."
        : `Translating from ${languageLabel(source, langs)}.`;
    }
    ctx.root.querySelector("#sourceBadge").textContent = languageLabel(source, langs).toUpperCase();
    ctx.root.querySelector("#targetBadge").textContent = languageLabel(target, langs).toUpperCase();
    sourceText.placeholder = source === "ta"
      ? "தமிழில் எழுதுங்கள்…"
      : "Type or paste something to translate…";
  }

  function updateCount() {
    const length = sourceText.value.length;
    charCount.textContent = `${length.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`;
    charCount.classList.toggle("near", length > MAX_CHARS * 0.9);
    translateBtn.disabled = loading || !sourceText.value.trim() || length > MAX_CHARS;
    buildExamples();
  }

  function examples() {
    if (target === "ta") {
      return [
        ["Good morning, how are you?", "en"],
        ["Where is the nearest bus stop?", "en"],
        ["I would like a cup of tea.", "en"],
      ];
    }
    return [
      ["இன்று மாலை நான் வீட்டிற்கு வருகிறேன்.", "ta"],
      ["உங்களுக்கு எப்படி உதவலாம்?", "ta"],
      ["தமிழ் மொழி மிகவும் அழகானது.", "ta"],
    ];
  }

  function buildExamples() {
    const host = ctx.root.querySelector("#exampleRow");
    if (!host) return;
    host.innerHTML = `<span class="label">Try</span>` + examples().map(([text, lang]) =>
      `<button class="chip" type="button" data-example="${escapeHtml(text)}" data-lang="${lang}">${escapeHtml(text.length > 44 ? `${text.slice(0, 42)}…` : text)}</button>`
    ).join("");
  }

  function placeholder() {
    return `<div class="result-placeholder">
      <span class="ph-glyph">ழ</span>
      <h3>Your words, on the other side.</h3>
      <p>Write on the left, then translate. You can copy the result or hear it spoken.</p>
    </div>`;
  }

  function renderResult() {
    const langs = ctx.languages();
    if (!result) {
      resultBody.innerHTML = placeholder();
      resultFoot.innerHTML = `<span class="result-meta">Ready when you are.</span><span class="badge">Ctrl + Enter</span>`;
      copyButton.disabled = true;
      speakButton.disabled = true;
      return;
    }
    const isTamil = baseLang(result.target_lang) === "ta";
    const warning = (result.warnings || []).map((warning) =>
      `<div class="note warn result-note">${icon("info", 15)}<span>${escapeHtml(warning)}</span></div>`
    ).join("");
    resultBody.innerHTML = `
      <div class="result-lang">
        <span class="small muted">${result.source_lang ? `Detected ${escapeHtml(languageLabel(result.source_lang, langs))}` : "Translated"}</span>
        <span class="badge ${result.cached ? "" : "green"}">${result.cached ? "From cache" : escapeHtml(result.engine_label || "Online")}</span>
      </div>
      <div class="result-text ${isTamil ? "" : "english"}" id="resultText">${escapeHtml(result.translation)}</div>
      ${warning}
    `;
    resultFoot.innerHTML = `
      <span class="result-meta">
        ${icon("clock", 12)} ${result.latency_ms ? `${result.latency_ms} ms` : "Instant"}
        <span>·</span>
        <span>${escapeHtml(result.engine_label || "Online")}</span>
        ${result.cached ? "<span>·</span><span>cached</span>" : ""}
      </span>
      <button class="btn btn-ghost btn-sm" type="button" id="useAsInput">${icon("swap", 13)} Use as input</button>
    `;
    copyButton.disabled = false;
    speakButton.disabled = false;
    resultFoot.querySelector("#useAsInput")?.addEventListener("click", useAsInput);
  }

  function currentSourceLang() {
    if (source !== "auto") return source;
    return result?.source_lang || (ctx.languages().some((l) => l.code === "en") ? "en" : "en");
  }

  async function translate(options = {}) {
    const text = sourceText.value.trim();
    if (!text || loading) return;
    if (text.length > MAX_CHARS) {
      toast(`Text is too long. Maximum ${MAX_CHARS.toLocaleString()} characters.`, { type: "error" });
      return;
    }
    loading = true;
    updateCount();
    setButtonLoading(translateBtn, true, "Translating…");
    resultBody.innerHTML = `<div class="result-placeholder"><span class="spinner" style="width:26px;height:26px;color:var(--terracotta)"></span><h3 class="mt-16">Finding the words…</h3><p>${navigator.onLine ? "Talking to the translation engine." : "The engine needs an internet connection."}</p></div>`;
    try {
      result = await api.post("/api/translate", {
        text,
        source,
        target,
        engine: ctx.prefs.translateEngine === "auto" ? null : ctx.prefs.translateEngine,
      }, { timeout: 45000, signal: ctx.signal });
      lastIssueText = text;
      renderResult();
      addRecent({
        text,
        translation: result.translation,
        source,
        detected: result.source_lang,
        target,
        engine: result.engine_label,
        latency: result.latency_ms,
      });
      renderRecents();
      if (!options.silent) {
        // The result itself is the feedback. Only announce when the browser
        // tab is not visible, so screen readers get a useful update.
        if (document.hidden) toast("Translation ready.", { type: "success" });
      }
    } catch (error) {
      if (ctx.signal.aborted) return;
      result = null;
      resultBody.innerHTML = `<div class="note danger">${icon("alert", 15)}<span><strong>Translation did not finish.</strong> ${escapeHtml(errorMessage(error))}</span></div>`;
      resultFoot.innerHTML = `<span class="result-meta">Check your connection, then try again.</span>`;
      copyButton.disabled = true;
      speakButton.disabled = true;
      toast(errorMessage(error), { type: "error", title: "Could not translate" });
    } finally {
      loading = false;
      setButtonLoading(translateBtn, false);
      updateCount();
    }
  }

  function useAsInput() {
    if (!result) return;
    const previousTarget = target;
    sourceText.value = result.translation;
    sourceSelect.value = result.target_lang || target;
    targetSelect.value = result.source_lang || (previousTarget === "ta" ? "en" : "ta");
    if (sourceSelect.value === targetSelect.value) {
      targetSelect.value = sourceSelect.value === "ta" ? "en" : "ta";
    }
    result = null;
    updateLanguageHints();
    updateCount();
    renderResult();
    sourceText.focus();
  }

  async function speakResult() {
    if (!result?.translation) return;
    speakButton.disabled = true;
    const original = speakButton.innerHTML;
    speakButton.innerHTML = `<span class="spinner" style="width:14px;height:14px"></span>`;
    try {
      const speech = await createSpeech(result.translation, {
        lang: baseLang(result.target_lang) || target,
        slow: ctx.prefs.ttsSlow,
        engine: ctx.prefs.ttsEngine,
        signal: ctx.signal,
      });
      if (audio) audio.pause();
      audio = new Audio(speech.url);
      audio.play().catch(() => toast("Press play in your browser to hear the audio.", { type: "info" }));
    } catch (error) {
      if (!ctx.signal.aborted) toast(errorMessage(error), { type: "error", title: "Voice unavailable" });
    } finally {
      speakButton.innerHTML = original;
      speakButton.disabled = !result;
    }
  }

  function renderRecents() {
    const recents = loadRecents();
    const section = ctx.root.querySelector("#recentsSection");
    const list = ctx.root.querySelector("#recentList");
    if (!section || !list) return;
    section.hidden = recents.length === 0;
    list.innerHTML = recents.map((entry, index) => `
      <button class="recent-item" type="button" data-recent="${index}">
        <span class="recent-source">${escapeHtml(entry.text)}</span>
        <span class="recent-target">${escapeHtml(entry.translation)}</span>
        <span class="recent-meta">${escapeHtml(entry.engine || "Online")} · ${escapeHtml(entry.target || "ta")}</span>
      </button>
    `).join("");
  }

  sourceSelect.addEventListener("change", () => {
    if (sourceSelect.value !== "auto" && sourceSelect.value === targetSelect.value) {
      targetSelect.value = sourceSelect.value === "ta" ? "en" : "ta";
    }
    updateLanguageHints();
    updateCount();
  });
  targetSelect.addEventListener("change", () => {
    if (targetSelect.value === sourceSelect.value) {
      sourceSelect.value = targetSelect.value === "ta" ? "en" : "ta";
    }
    updateLanguageHints();
    updateCount();
  });

  ctx.root.querySelector("#swapLanguages")?.addEventListener("click", () => {
    const nextSource = target;
    const nextTarget = source === "auto" ? (result?.source_lang || "en") : source;
    sourceSelect.value = nextSource;
    targetSelect.value = nextTarget === nextSource ? (nextSource === "ta" ? "en" : "ta") : nextTarget;
    if (result?.translation) {
      sourceText.value = result.translation;
      result = null;
      renderResult();
      updateLanguageHints();
      updateCount();
      translate();
    } else {
      updateLanguageHints();
      updateCount();
    }
  });

  sourceText.addEventListener("input", () => {
    if (result && sourceText.value.trim() !== lastIssueText) {
      // Keep the old translation visible while the user edits, but make it
      // clear that it belongs to the previous text.
      resultFoot.innerHTML = `<span class="result-meta">${icon("info", 12)} Translation is for the previous text.</span>`;
    }
    updateCount();
  });
  sourceText.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      translate();
    }
  });

  translateBtn.addEventListener("click", () => translate());
  ctx.root.querySelector("#clearTranslate")?.addEventListener("click", clearAll);
  ctx.root.querySelector("#clearText")?.addEventListener("click", clearText);
  ctx.root.querySelector("#copyResult")?.addEventListener("click", async () => {
    if (result?.translation) {
      const { copyText } = await import("../ui.js");
      copyText(result.translation, "Translation copied");
    }
  });
  speakButton.addEventListener("click", speakResult);
  ctx.root.querySelector("#clearRecents")?.addEventListener("click", async () => {
    const { clearRecents } = await import("../store.js");
    clearRecents();
    renderRecents();
    toast("Translation history cleared.", { type: "success" });
  });
  ctx.root.querySelector("#exampleRow")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-example]");
    if (!button) return;
    sourceText.value = button.dataset.example;
    if (button.dataset.lang === "ta") {
      sourceSelect.value = "ta";
      targetSelect.value = "en";
    } else {
      sourceSelect.value = "en";
      targetSelect.value = "ta";
    }
    updateLanguageHints();
    updateCount();
    sourceText.focus();
  });
  ctx.root.querySelector("#recentList")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-recent]");
    if (!button) return;
    const entry = loadRecents()[Number(button.dataset.recent)];
    if (!entry) return;
    sourceText.value = entry.text;
    source = entry.source || "auto";
    target = entry.target || "ta";
    sourceSelect.value = source;
    targetSelect.value = target;
    result = {
      translation: entry.translation,
      source_lang: entry.detected || (source === "auto" ? "en" : source),
      target_lang: target,
      engine_label: entry.engine || "Online",
      latency_ms: entry.latency || 0,
      cached: true,
      warnings: [],
    };
    lastIssueText = entry.text;
    updateLanguageHints();
    updateCount();
    renderResult();
  });
  ctx.root.querySelector("#openVoice")?.addEventListener("click", () => ctx.go("voice", { tab: "live" }));
  ctx.root.querySelector("#pasteText")?.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      sourceText.value = text.slice(0, MAX_CHARS);
      updateCount();
      sourceText.focus();
    } catch {
      toast("Clipboard access was blocked. Paste with Ctrl+V instead.", { type: "info" });
    }
  });

  function clearText() {
    sourceText.value = "";
    result = null;
    updateCount();
    renderResult();
    sourceText.focus();
  }
  function clearAll() {
    clearText();
    sourceSelect.value = ctx.prefs.defaultSource || "en";
    targetSelect.value = ctx.prefs.defaultTarget || "ta";
    if (sourceSelect.value === targetSelect.value) targetSelect.value = sourceSelect.value === "ta" ? "en" : "ta";
    updateLanguageHints();
  }

  updateLanguageHints();
  updateCount();
  renderResult();
  renderRecents();
  ctx.ensureLanguages().then(() => {
    if (!ctx.signal.aborted) refreshLanguageOptions();
  });

  if (pending.text) {
    sourceText.focus();
    sourceText.setSelectionRange(sourceText.value.length, sourceText.value.length);
    if (pending.autoTranslate) translate({ silent: true });
  }

  return () => {
    if (audio) {
      audio.pause();
      audio.src = "";
      audio = null;
    }
  };
}
