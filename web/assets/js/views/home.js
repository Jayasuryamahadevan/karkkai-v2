import { api, errorMessage } from "../api.js";
import { createSpeech } from "../tts.js";
import { escapeHtml, icon, toast } from "../ui.js";

const TOOLS = [
  {
    id: "translate",
    label: "Translate",
    ta: "மொழிபெயர்",
    icon: "translate",
    desc: "Move naturally between Tamil and English, with Google and MyMemory behind you.",
    badge: "Online",
    accent: "rgba(191,90,61,0.1)",
    ink: "#9c432c",
    bg: "#f7ddd2",
    large: true,
  },
  {
    id: "voice",
    label: "Speech to text",
    ta: "பேச்சு → எழுத்து",
    icon: "mic",
    desc: "Speak and watch Tamil appear, right in your browser.",
    badge: "Chrome / Edge",
    accent: "rgba(14,79,73,0.09)",
    ink: "#0e4f49",
    bg: "#dfece7",
    tab: "live",
  },
  {
    id: "voice",
    label: "Text to speech",
    ta: "எழுத்து → பேச்சு",
    icon: "volume",
    desc: "Turn Tamil or English writing into a clear, downloadable voice.",
    badge: "Online",
    accent: "rgba(201,149,59,0.11)",
    ink: "#7c5a19",
    bg: "#f7e9ca",
    tab: "tts",
  },
  {
    id: "spellcheck",
    label: "Spell check",
    ta: "எழுத்துப்பிழை",
    icon: "spell",
    desc: "Catch slips, repeated words and spacing — with Tamil morphology, not guesswork.",
    badge: "Local",
    accent: "rgba(66,106,136,0.09)",
    ink: "#426a88",
    bg: "#e5eef4",
  },
  {
    id: "words",
    label: "Word finder",
    ta: "சொல் தேடல்",
    icon: "book",
    desc: "Explore meanings, synonyms, families and inflected forms from a 64k word index.",
    badge: "Local + online",
    accent: "rgba(14,79,73,0.09)",
    ink: "#0e4f49",
    bg: "#dfece7",
  },
  {
    id: "pdf",
    label: "Compress PDF",
    ta: "PDF சுருக்கம்",
    icon: "compress",
    desc: "Make heavy PDFs lighter without losing the Tamil text inside.",
    badge: "Local",
    accent: "rgba(191,90,61,0.09)",
    ink: "#9c432c",
    bg: "#f7ddd2",
    tab: "compress",
  },
  {
    id: "pdf",
    label: "Edit Tamil PDF",
    ta: "PDF திருத்தம்",
    icon: "edit",
    desc: "Replace Tamil lines, erase, highlight and add text on the page itself.",
    badge: "Local",
    accent: "rgba(201,149,59,0.1)",
    ink: "#7c5a19",
    bg: "#f7e9ca",
    tab: "edit",
  },
];

function toolCard(tool, index) {
  const href = tool.tab ? `#/${tool.id}?tab=${tool.tab}` : `#/${tool.id}`;
  return `<a class="tool-card ${tool.large ? "large" : ""}" href="${href}" style="--card-accent:${tool.accent};--card-ink:${tool.ink};--card-bg:${tool.bg}">
    <div class="tool-top">
      <span class="tool-icon">${icon(tool.icon, 21)}</span>
      <span class="tool-index">0${index + 1}</span>
    </div>
    <div class="tool-body">
      <div class="tool-main">
        <h3>${escapeHtml(tool.label)}</h3>
        <div class="tool-ta">${tool.ta}</div>
        <p>${escapeHtml(tool.desc)}</p>
      </div>
      ${tool.large ? `<div class="tool-visual" aria-hidden="true"><span class="ta">வணக்கம்</span><span class="en">HELLO · GREETING</span></div>` : ""}
    </div>
    <div class="tool-foot">
      <span class="badge">${escapeHtml(tool.badge)}</span>
      <span class="tool-arrow">${icon("arrow", 14)}</span>
    </div>
  </a>`;
}

export function renderHome(ctx) {
  let audio = null;

  ctx.root.innerHTML = `
    <section class="home-hero">
      <div class="hero-copy">
        <span class="eyebrow">Tamil, without the friction</span>
        <h1>Your everyday<br><em>Tamil</em> workspace.</h1>
        <div class="hero-tamil">தமிழை எழுது. பேசு. திருத்து. கண்டறி.</div>
        <p class="hero-lead">Translation, voice, spell check, word discovery and PDF tools in one quiet app that runs on your machine.</p>
        <div class="hero-actions">
          <a class="btn btn-primary btn-lg" href="#/translate">${icon("translate", 17)} Start translating</a>
          <a class="btn btn-secondary btn-lg" href="#/words">${icon("search", 17)} Find a word</a>
        </div>
        <div class="hero-meta">
          <span>${icon("globe", 13)} Online translation &amp; voice</span>
          <span>${icon("lock", 13)} Local dictionary &amp; PDF</span>
          <span>${icon("file", 13)} No account needed</span>
        </div>
      </div>
      <div class="hero-art" aria-hidden="true">
        <div class="hero-tile back"></div>
        <div class="hero-tile front">
          <span class="tile-tag">Tamil · தமிழ்</span>
          <span class="glyph">ழ</span>
          <span class="plus">+</span>
          <span class="tile-caption">a language with a long memory</span>
        </div>
        <div class="word-figure" id="wordFigure">
          <div class="word-figure-top">
            <span class="eyebrow no-line">Word of the day</span>
            <span class="badge green">தமிழ்</span>
          </div>
          <div class="skeleton" style="height:31px;width:55%;margin-top:9px"></div>
          <div class="skeleton" style="height:12px;width:38%;margin-top:7px"></div>
        </div>
      </div>
    </section>

    <div class="stat-row">
      <div class="stat"><strong>7</strong><span>tools in one calm place</span></div>
      <div class="stat"><strong id="homeWordCount">64k</strong><span>words in the Tamil index</span></div>
      <div class="stat"><strong>4</strong><span>PDF &amp; language tools run locally</span></div>
    </div>

    <div class="section-head">
      <div><h2>Seven small tools. One place.</h2><p>Use one, or move between them without losing your thread.</p></div>
      <a class="section-link" href="#/translate">Open the workspace ${icon("arrow", 14)}</a>
    </div>
    <section class="tool-grid" aria-label="Tools">
      ${TOOLS.map(toolCard).join("")}
    </section>

    <div class="home-lower">
      <section class="local-card">
        <span class="eyebrow">What runs where</span>
        <h3 class="mt-8">Clear about the internet.</h3>
        <p>Translation and generated speech need a connection. Your words, PDFs and dictionary lookups do not.</p>
        <div class="local-grid">
          <div class="local-item">${icon("globe", 15)}<div><strong>Online</strong><span>Google Translate, MyMemory, gTTS and browser speech.</span></div></div>
          <div class="local-item">${icon("lock", 15)}<div><strong>Local</strong><span>Tamil spell check, 64k word index, PDF compression and editing.</span></div></div>
          <div class="local-item">${icon("file", 15)}<div><strong>Your files</strong><span>PDF sessions live on this machine and expire automatically.</span></div></div>
          <div class="local-item">${icon("sparkle", 15)}<div><strong>Optional keys</strong><span>Sarvam or OpenAI can add uploaded-audio transcription.</span></div></div>
        </div>
      </section>
      <section class="quote-card">
        <div>
          <span class="eyebrow">From the Sangam</span>
          <blockquote>யாதும் ஊரே யாவரும் கேளிர்</blockquote>
          <p class="quote-en">Every town is my town; every person is my kin.</p>
        </div>
        <div class="quote-foot">
          <span>புறநானூறு · 192</span>
          <button class="icon-btn" type="button" id="speakQuote" aria-label="Speak the Tamil quote">${icon("volume", 16)}</button>
        </div>
      </section>
    </div>

    <footer class="home-foot">
      <span>Chillian · a local-first Tamil workspace</span>
      <span>Online where it helps. Local where it matters.</span>
    </footer>
  `;

  const figure = ctx.root.querySelector("#wordFigure");
  const wordCount = ctx.root.querySelector("#homeWordCount");
  let currentWord = null;

  async function loadWord() {
    if (!figure) return;
    figure.innerHTML = `<div class="word-figure-top"><span class="eyebrow no-line">Word of the day</span><span class="badge green">தமிழ்</span></div>
      <div class="skeleton" style="height:31px;width:55%;margin-top:9px"></div>
      <div class="skeleton" style="height:12px;width:38%;margin-top:7px"></div>`;
    try {
      const word = await api.get("/api/words/random", {}, { signal: ctx.signal });
      if (!word || !word.ta) throw new Error("No word returned");
      currentWord = word;
      figure.innerHTML = `
        <div class="word-figure-top">
          <span class="eyebrow no-line">Word of the day</span>
          <div class="flex items-center gap-8">
            <span class="badge green">${escapeHtml(word.category || "தமிழ்")}</span>
            <button class="icon-btn sm" type="button" data-word-refresh aria-label="Show another word" title="Show another word">${icon("refresh", 13)}</button>
          </div>
        </div>
        <div class="word-line">
          <button class="word-ta" type="button" data-word-open title="Explore this word">${escapeHtml(word.ta)}</button>
          <span class="word-en">${escapeHtml((word.en || []).slice(0, 2).join(" · "))}</span>
          <button class="icon-btn sm" type="button" data-word-speak aria-label="Speak this word">${icon("volume", 13)}</button>
        </div>
        ${word.example ? `<div class="word-example">${escapeHtml(word.example)}</div>` : ""}
      `;
    } catch (error) {
      if (ctx.signal.aborted) return;
      figure.innerHTML = `<div class="word-figure-top"><span class="eyebrow no-line">Word of the day</span><span class="badge">தமிழ்</span></div>
        <div class="word-line"><span class="word-ta">தமிழ்</span><span class="word-en">Tamil</span></div>
        <div class="word-example">A language, a people, a way of seeing.</div>`;
    }
  }

  figure?.addEventListener("click", async (event) => {
    if (event.target.closest("[data-word-refresh]")) { loadWord(); return; }
    if (event.target.closest("[data-word-open]") && currentWord) {
      ctx.go("words", { q: currentWord.ta });
      return;
    }
    if (event.target.closest("[data-word-speak]") && currentWord) {
      const button = event.target.closest("button");
      button.disabled = true;
      try {
        const speech = await createSpeech(currentWord.ta, { lang: "ta", slow: ctx.prefs.ttsSlow, engine: ctx.prefs.ttsEngine, signal: ctx.signal });
        if (audio) audio.pause();
        audio = new Audio(speech.url);
        audio.play().catch(() => {});
      } catch (error) {
        if (!ctx.signal.aborted) toast(errorMessage(error), { type: "error", title: "Voice unavailable" });
      } finally {
        button.disabled = false;
      }
    }
  });

  ctx.root.querySelector("#speakQuote")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const speech = await createSpeech("யாதும் ஊரே யாவரும் கேளிர்", { lang: "ta", slow: true, engine: ctx.prefs.ttsEngine, signal: ctx.signal });
      if (audio) audio.pause();
      audio = new Audio(speech.url);
      audio.play().catch(() => {});
    } catch (error) {
      if (!ctx.signal.aborted) toast(errorMessage(error), { type: "error", title: "Voice unavailable" });
    } finally {
      button.disabled = false;
    }
  });

  loadWord();
  ctx.ensureHealth().then((health) => {
    if (!health || !wordCount || ctx.signal.aborted) return;
    if (health.lexicon?.words) wordCount.textContent = `${Math.round(health.lexicon.words / 1000)}k`;
  });

  return () => {
    if (audio) { audio.pause(); audio.src = ""; audio = null; }
  };
}
