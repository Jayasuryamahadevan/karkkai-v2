import { api, errorMessage } from "./api.js";
import {
  clearExtraWords,
  clearRecents,
  clearAllLocalData,
  loadExtraWords,
  loadPrefs,
  loadRecents,
  savePrefs,
} from "./store.js";
import {
  escapeHtml,
  focusTrap,
  hydrateIcons,
  icon,
  toast,
} from "./ui.js";
import { renderHome } from "./views/home.js";
import { renderTranslate } from "./views/translate.js";
import { renderVoice } from "./views/voice.js";
import { renderSpellcheck } from "./views/spellcheck.js";
import { renderWords } from "./views/words.js";
import { renderPdf } from "./views/pdf.js";

const VIEWS = {
  home: { title: "Home", render: renderHome },
  translate: { title: "Translate", render: renderTranslate },
  voice: { title: "Voice", render: renderVoice },
  spellcheck: { title: "Spell check", render: renderSpellcheck },
  words: { title: "Word finder", render: renderWords },
  pdf: { title: "PDF studio", render: renderPdf },
};

const NAV = [
  { section: "Workspace" },
  { id: "home", label: "Home", ta: "முகப்பு", icon: "home" },
  { id: "translate", label: "Translate", ta: "மொழிபெயர்", icon: "translate" },
  { id: "voice", label: "Voice", ta: "குரல்", icon: "mic" },
  { section: "Tamil tools" },
  { id: "spellcheck", label: "Spell check", ta: "எழுத்து", icon: "spell" },
  { id: "words", label: "Word finder", ta: "சொல்", icon: "book" },
  { id: "pdf", label: "PDF studio", ta: "ஆவணம்", icon: "file" },
];

const FALLBACK_LANGUAGES = [
  { code: "en", name: "English", ta: "ஆங்கிலம்" },
  { code: "ta", name: "Tamil", ta: "தமிழ்" },
  { code: "hi", name: "Hindi", ta: "இந்தி" },
  { code: "ml", name: "Malayalam", ta: "மலையாளம்" },
  { code: "te", name: "Telugu", ta: "தெலுங்கு" },
  { code: "kn", name: "Kannada", ta: "கன்னடம்" },
  { code: "bn", name: "Bengali", ta: "வங்காளம்" },
  { code: "mr", name: "Marathi", ta: "மராத்தி" },
  { code: "gu", name: "Gujarati", ta: "குஜராத்தி" },
  { code: "fr", name: "French", ta: "பிரெஞ்சு" },
  { code: "de", name: "German", ta: "ஜெர்மன்" },
  { code: "es", name: "Spanish", ta: "ஸ்பானிஷ்" },
  { code: "ar", name: "Arabic", ta: "அரபு" },
  { code: "zh-CN", name: "Chinese", ta: "சீனம்" },
  { code: "ja", name: "Japanese", ta: "ஜப்பானியம்" },
];

export const appState = {
  health: null,
  healthError: null,
  healthAt: 0,
  prefs: loadPrefs(),
  languages: FALLBACK_LANGUAGES,
  languagesLoaded: false,
  pending: null,
};

const root = document.getElementById("view");
const sidebar = document.getElementById("sidebar");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const settingsLayer = document.getElementById("settingsLayer");
let currentCleanup = null;
let currentController = null;
let currentRoute = null;
let healthPromise = null;
let languagesPromise = null;
let settingsRelease = null;
let lastHash = "";

/* ------------------------------------------------------------------ health */
export async function ensureHealth(force = false) {
  if (!force && appState.health && Date.now() - appState.healthAt < 45000) {
    return appState.health;
  }
  if (healthPromise) return healthPromise;
  healthPromise = api
    .get("/api/health", {}, { timeout: 20000 })
    .then((health) => {
      appState.health = health;
      appState.healthError = null;
      appState.healthAt = Date.now();
      paintConnection();
      return health;
    })
    .catch((error) => {
      appState.healthError = error;
      paintConnection();
      return null;
    })
    .finally(() => {
      healthPromise = null;
    });
  paintConnection("busy");
  return healthPromise;
}

export async function ensureLanguages() {
  if (appState.languagesLoaded) return appState.languages;
  if (languagesPromise) return languagesPromise;
  languagesPromise = api
    .get("/api/languages", {}, { timeout: 12000 })
    .then((data) => {
      if (Array.isArray(data.languages) && data.languages.length) {
        appState.languages = data.languages;
      }
      appState.languagesLoaded = true;
      return appState.languages;
    })
    .catch(() => appState.languages)
    .finally(() => {
      languagesPromise = null;
    });
  return languagesPromise;
}

function paintConnection(state = null) {
  const dot = document.getElementById("statusDot");
  const title = document.getElementById("connectionTitle");
  const text = document.getElementById("connectionText");
  const netDot = document.querySelector("#netPill .status-dot");
  const netLabel = document.getElementById("netLabel");
  if (!dot) return;

  const offline = !navigator.onLine;
  let mode = state === "busy" ? "busy" : "online";
  if (offline) mode = "offline";
  if (!offline && appState.healthError && !appState.health) mode = "offline";
  if (!offline && appState.health && appState.health.ok === false) mode = "offline";

  dot.className = `status-dot ${mode}`;
  if (netDot) netDot.className = `status-dot ${mode}`;

  if (mode === "busy") {
    if (title) title.textContent = "Checking connection";
    if (text) text.textContent = "Talking to the local server";
    if (netLabel) netLabel.textContent = "Checking";
  } else if (mode === "offline") {
    if (title) title.textContent = offline ? "You are offline" : "Online engines unreachable";
    if (text) text.textContent = "PDF, spell check & dictionary still work";
    if (netLabel) netLabel.textContent = "Offline";
  } else {
    const lexicon = appState.health?.lexicon;
    if (title) title.textContent = "Chillian is ready";
    if (text) {
      text.textContent = lexicon?.ready
        ? `${lexicon.words.toLocaleString()} Tamil words · local server`
        : "Online engines · local server";
    }
    if (netLabel) netLabel.textContent = "Online";
  }

  const card = document.getElementById("connectionCard");
  if (card) card.title = mode === "offline"
    ? "Translation and browser speech need a connection. Local tools remain available."
    : "Translation and speech use online engines. PDF and dictionary tools run locally.";
}

/* --------------------------------------------------------------- navigation */
function parseRoute() {
  const raw = (location.hash || "#/home").replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const id = VIEWS[path] ? path : "home";
  return {
    id,
    params: new URLSearchParams(query),
    path,
    hash: raw,
  };
}

function navMarkup() {
  return NAV.map((item) => {
    if (item.section) return `<div class="nav-label">${escapeHtml(item.section)}</div>`;
    return `<a class="nav-item" data-route="${item.id}" href="#/${item.id}">
      <span class="nav-icon">${icon(item.icon, 17)}</span>
      <span>${escapeHtml(item.label)}</span>
      <span class="nav-tamil">${item.ta}</span>
    </a>`;
  }).join("");
}

function paintNav(activeId) {
  document.querySelectorAll(".nav-item").forEach((item) => {
    const active = item.dataset.route === activeId;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
}

export function go(id, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  }
  const target = `#/${id}${query.toString() ? `?${query}` : ""}`;
  closeSidebar();
  if (location.hash === target) {
    route(true);
  } else {
    location.hash = target;
  }
}

function setPending(data) {
  appState.pending = data;
}

function takePending(key) {
  if (!appState.pending) return null;
  if (key && !(key in appState.pending)) return null;
  const value = key ? appState.pending[key] : { ...appState.pending };
  if (key) delete appState.pending[key];
  else appState.pending = null;
  return value;
}

function buildContext(routeInfo, controller) {
  return {
    root,
    signal: controller.signal,
    params: routeInfo.params,
    route: routeInfo,
    state: appState,
    prefs: appState.prefs,
    go,
    navigate: go,
    setPending,
    takePending,
    ensureHealth,
    refreshHealth: () => ensureHealth(true),
    ensureLanguages,
    languages: () => appState.languages,
    openSettings,
    toast,
  };
}

function route(force = false) {
  const parsed = parseRoute();
  if (!force && parsed.hash === lastHash) return;
  lastHash = parsed.hash;
  currentRoute = parsed;

  if (currentCleanup) {
    try { currentCleanup(); } catch (error) { console.warn("View cleanup failed", error); }
    currentCleanup = null;
  }
  if (currentController) currentController.abort();
  currentController = new AbortController();

  const view = VIEWS[parsed.id] || VIEWS.home;
  document.title = `${view.title} · Chillian`;
  const titleEl = document.getElementById("pageTitle");
  if (titleEl) titleEl.textContent = view.title;
  paintNav(parsed.id);
  closeSidebar();
  closeSettings(false);

  root.innerHTML = "";
  const ctx = buildContext(parsed, currentController);
  try {
    const result = view.render(ctx);
    if (typeof result === "function") currentCleanup = result;
  } catch (error) {
    console.error(error);
    root.innerHTML = `<div class="panel panel-pad"><div class="empty-state">
      <div class="empty-glyph">ழ</div>
      <h3>This view could not open</h3>
      <p>${escapeHtml(errorMessage(error))}</p>
      <button class="btn btn-primary" onclick="location.reload()">Reload Chillian</button>
    </div></div>`;
  }
  window.scrollTo({ top: 0, behavior: "instant" });
  root.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ sidebar */
function openSidebar() {
  sidebar.classList.add("open");
  sidebarBackdrop.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarBackdrop.hidden = true;
  if (!settingsLayer.hidden) return;
  document.body.style.overflow = "";
}

/* ------------------------------------------------------------------ settings */
function statusItem(name, on, detail = "") {
  return `<div class="status-list-item">
    <span class="name"><span class="dot ${on ? "on" : ""}"></span>${escapeHtml(name)}</span>
    <span class="state ${on ? "on" : ""}">${on ? "Ready" : escapeHtml(detail || "Optional")}</span>
  </div>`;
}

function settingsMarkup() {
  const health = appState.health;
  const online = health?.online || {};
  const prefs = appState.prefs;
  const extraWords = loadExtraWords();
  const recents = loadRecents();
  const sarvamTranslation = Boolean(online?.translation?.sarvam);
  const sarvamTts = Boolean(online?.tts?.sarvam);
  const serverStt = Array.isArray(health?.stt?.server_available) ? health.stt.server_available : [];
  const lexicon = health?.lexicon;

  return `
    <section class="settings-section">
      <h3>Online engines</h3>
      <p>Translation and voice use online services. Choose a preference; Chillian quietly falls back if an engine is unavailable.</p>
      <div class="settings-card">
        <div class="settings-row">
          <div class="row-copy"><strong>Translation</strong><span>Sarvam AI is the default. Yandex and MyMemory are the fallbacks.</span></div>
          <select class="select" data-pref="translateEngine" aria-label="Translation engine">
            <option value="auto" ${prefs.translateEngine === "auto" ? "selected" : ""}>Auto</option>
            <option value="mozhi" ${prefs.translateEngine === "mozhi" ? "selected" : ""}>Yandex</option>
            <option value="mymemory" ${prefs.translateEngine === "mymemory" ? "selected" : ""}>MyMemory</option>
            <option value="sarvam" ${prefs.translateEngine === "sarvam" ? "selected" : ""} ${sarvamTranslation ? "" : "disabled"}>Sarvam${sarvamTranslation ? "" : " · key needed"}</option>
          </select>
        </div>
        <div class="settings-row">
          <div class="row-copy"><strong>Voice</strong><span>Google gTTS works without a key. Sarvam adds a more natural Tamil voice.</span></div>
          <select class="select" data-pref="ttsEngine" aria-label="Speech engine">
            <option value="auto" ${prefs.ttsEngine === "auto" ? "selected" : ""}>Auto</option>
            <option value="google" ${prefs.ttsEngine === "google" ? "selected" : ""}>Google</option>
            <option value="sarvam" ${prefs.ttsEngine === "sarvam" ? "selected" : ""} ${sarvamTts ? "" : "disabled"}>Sarvam${sarvamTts ? "" : " · key needed"}</option>
          </select>
        </div>
        <div class="settings-row">
          <div class="row-copy"><strong>Slow speech by default</strong><span>Useful for language practice and clearer playback.</span></div>
          <label class="switch"><input type="checkbox" data-pref="ttsSlow" ${prefs.ttsSlow ? "checked" : ""} aria-label="Slow speech by default"><span></span></label>
        </div>
        <div class="settings-row">
          <div class="row-copy"><strong>Default target</strong><span>Used when Translate opens.</span></div>
          <select class="select" data-pref="defaultTarget" aria-label="Default translation target">
            <option value="ta" ${prefs.defaultTarget === "ta" ? "selected" : ""}>Tamil</option>
            <option value="en" ${prefs.defaultTarget === "en" ? "selected" : ""}>English</option>
          </select>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h3>Service status</h3>
      <p>${health ? `Checked ${new Date(appState.healthAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · local server ${health.version || ""}` : "The local server has not answered yet."}</p>
      <div class="settings-card">
        <div class="status-list">
          ${statusItem("Sarvam AI", Boolean(online?.translation?.sarvam), "No key")}
          ${statusItem("Yandex Translator", Boolean(online?.translation?.mozhi), "Online")}
          ${statusItem("MyMemory fallback", Boolean(online?.translation?.mymemory), "Online")}
          ${statusItem("Google speech voice", Boolean(online?.tts?.google), "Online")}
          ${statusItem("Uploaded-audio STT", serverStt.length > 0, "Key needed")}
          ${statusItem("Browser live speech", Boolean(health?.stt?.browser), "Chrome / Edge")}
          ${statusItem("Tamil dictionary", Boolean(lexicon?.ready), "Loading")}
          ${statusItem("PDF engine + Ghostscript", Boolean(health?.local?.pdf), "Local")}
        </div>
      </div>
      <div class="settings-note">
        <b>Optional keys.</b> Copy <code>.env.example</code> to <code>.env</code> and add
        <code>SARVAM_API_KEY</code> for Sarvam translation, voice and audio upload, or
        <code>OPENAI_API_KEY</code> for Whisper transcription. Restart the server after editing.
      </div>
      <div class="settings-actions">
        <button class="btn btn-sm btn-secondary" data-settings-action="refresh">${icon("refresh", 13)} Refresh status</button>
        <a class="btn btn-sm btn-ghost" href="/api/docs" target="_blank" rel="noopener">${icon("external", 13)} API explorer</a>
      </div>
    </section>

    <section class="settings-section">
      <h3>On this device</h3>
      <p>Recent translations and custom words never leave this browser.</p>
      <div class="settings-card">
        <div class="settings-row">
          <div class="row-copy"><strong>My words</strong><span>${extraWords.length} custom word${extraWords.length === 1 ? "" : "s"} accepted by spell check.</span></div>
          <button class="btn btn-sm btn-secondary" data-settings-action="clear-words" ${extraWords.length ? "" : "disabled"}>Clear</button>
        </div>
        <div class="settings-row">
          <div class="row-copy"><strong>Recent translations</strong><span>${recents.length} saved on this device.</span></div>
          <button class="btn btn-sm btn-secondary" data-settings-action="clear-recents" ${recents.length ? "" : "disabled"}>Clear</button>
        </div>
        <div class="settings-row">
          <div class="row-copy"><strong>Reset preferences</strong><span>Restore the default engines and language pair.</span></div>
          <button class="btn btn-sm btn-ghost" data-settings-action="reset">Reset</button>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h3>About</h3>
      <div class="settings-about">
        <div class="about-brand">
          <span class="brand-mark" aria-hidden="true">ழ</span>
          <div><strong>Chillian</strong><br><span>Tamil workspace</span></div>
        </div>
        <p>Seven Tamil tools in one local app. Translation and speech use online engines; spell check, the 64k word index and PDF work run on your machine.</p>
        <p>Version ${escapeHtml(health?.version || "0.1.0")} · Tamil fonts bundled · Built with care.</p>
      </div>
    </section>
  `;
}

export function openSettings() {
  const body = document.getElementById("settingsBody");
  if (!body) return;
  body.innerHTML = settingsMarkup();
  settingsLayer.hidden = false;
  document.body.style.overflow = "hidden";
  settingsRelease = focusTrap(document.querySelector(".drawer"));
  closeSidebar();
}

export function closeSettings(restoreFocus = true) {
  if (!settingsLayer || settingsLayer.hidden) return;
  settingsLayer.hidden = true;
  if (settingsRelease) {
    try { settingsRelease(); } catch { /* ignore */ }
    settingsRelease = null;
  }
  if (!restoreFocus) {
    // focusTrap restores focus; this branch only exists for route cleanup.
  }
  document.body.style.overflow = "";
}

function handleSettingsChange(event) {
  const control = event.target.closest("[data-pref]");
  if (!control) return;
  const key = control.dataset.pref;
  let value;
  if (control.type === "checkbox") value = control.checked;
  else value = control.value;
  appState.prefs[key] = value;
  savePrefs(appState.prefs);
  const row = control.closest(".settings-card");
  if (row) {
    row.dataset.saved = "1";
    setTimeout(() => { delete row.dataset.saved; }, 1200);
  }
}

async function handleSettingsAction(event) {
  const button = event.target.closest("[data-settings-action]");
  if (!button) return;
  const action = button.dataset.settingsAction;
  if (action === "refresh") {
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> Checking…`;
    await ensureHealth(true);
    openSettings();
    toast("Service status refreshed.", { type: "success" });
  } else if (action === "clear-words") {
    clearExtraWords();
    openSettings();
    toast("Custom words cleared.", { type: "success" });
  } else if (action === "clear-recents") {
    clearRecents();
    openSettings();
    toast("Recent translations cleared.", { type: "success" });
  } else if (action === "reset") {
    appState.prefs = loadPrefs();
    for (const key of Object.keys(appState.prefs)) delete appState.prefs[key];
    Object.assign(appState.prefs, {
      translateEngine: "auto",
      ttsEngine: "auto",
      ttsSlow: false,
      defaultSource: "en",
      defaultTarget: "ta",
      sentenceMode: false,
    });
    savePrefs(appState.prefs);
    openSettings();
    toast("Preferences reset.", { type: "success" });
  }
}

/* --------------------------------------------------------------------- boot */
function bindShell() {
  hydrateIcons();
  document.getElementById("mainNav").innerHTML = navMarkup();
  paintNav(parseRoute().id);

  document.getElementById("mobileMenu")?.addEventListener("click", openSidebar);
  document.getElementById("sidebarClose")?.addEventListener("click", closeSidebar);
  sidebarBackdrop?.addEventListener("click", closeSidebar);
  document.getElementById("openSettings")?.addEventListener("click", openSettings);
  document.getElementById("openSettingsTop")?.addEventListener("click", openSettings);
  document.getElementById("closeSettings")?.addEventListener("click", () => closeSettings());
  document.getElementById("settingsBackdrop")?.addEventListener("click", () => closeSettings());
  settingsLayer?.addEventListener("change", handleSettingsChange);
  settingsLayer?.addEventListener("click", handleSettingsAction);

  const quick = document.getElementById("quickSearch");
  const quickInput = document.getElementById("quickSearchInput");
  quick?.addEventListener("submit", (event) => {
    event.preventDefault();
    const q = quickInput?.value.trim();
    if (!q) {
      quickInput?.focus();
      return;
    }
    go("words", { q });
  });

  window.addEventListener("hashchange", () => route(false));
  window.addEventListener("online", () => { paintConnection("busy"); ensureHealth(true); });
  window.addEventListener("offline", () => paintConnection());

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === ",") {
      event.preventDefault();
      openSettings();
    }
    if (event.key === "Escape" && !settingsLayer.hidden) {
      event.preventDefault();
      closeSettings();
    }
    if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const tag = document.activeElement?.tagName;
      if (!["INPUT", "TEXTAREA", "SELECT"].includes(tag) && settingsLayer.hidden) {
        event.preventDefault();
        quickInput?.focus();
      }
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    console.error("Unhandled promise rejection", event.reason);
  });
}

bindShell();
route(false);
ensureHealth();
ensureLanguages();

setInterval(() => {
  if (!document.hidden && navigator.onLine) ensureHealth(false);
}, 90000);
