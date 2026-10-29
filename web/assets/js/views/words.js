import { api, errorMessage } from "../api.js";
import { createSpeech } from "../tts.js";
import {
  copyText,
  debounce,
  escapeHtml,
  freqBars,
  frequencyLabel,
  icon,
  isTamilText,
  toast,
} from "../ui.js";

const FALLBACK_CATEGORIES = {
  basics: { en: "Everyday", ta: "அன்றாடம்" },
  family: { en: "Family", ta: "குடும்பம்" },
  nature: { en: "Nature", ta: "இயற்கை" },
  time: { en: "Time", ta: "நேரம்" },
  emotion: { en: "Feelings", ta: "உணர்வுகள்" },
  food: { en: "Food", ta: "உணவு" },
  action: { en: "Actions", ta: "செயல்கள்" },
  quality: { en: "Qualities", ta: "பண்புகள்" },
  place: { en: "Places", ta: "இடங்கள்" },
  technology: { en: "Technology", ta: "தொழில்நுட்பம்" },
};

function categoryInfo(categories, code) {
  const item = categories?.[code];
  return item || { en: code || "General", ta: "" };
}

function wordListItem(word, active) {
  const en = (word.en || []).filter(Boolean).slice(0, 2).join(" · ");
  return `<button class="word-list-item ${active ? "active" : ""}" type="button" data-word="${escapeHtml(word.ta)}">
    <span class="wl-main">
      <span class="wl-ta">${escapeHtml(word.ta)}</span>
      <span class="wl-en">${escapeHtml(en || (word.source === "similar" ? "Similar word" : "Tamil word"))}</span>
    </span>
    <span class="wl-meta">${freqBars(word.frequency)}</span>
  </button>`;
}

function detailSkeleton() {
  return `<div class="word-loading">
    <div class="skeleton"></div>
    <div class="skeleton"></div>
    <div class="skeleton"></div>
    <div class="skeleton"></div>
    <div class="skeleton"></div>
  </div>`;
}

function chipRow(items, attribute = "data-explore") {
  if (!items?.length) return "";
  return `<div class="chip-row">${items.map((item) => {
    const word = typeof item === "string" ? item : item.ta;
    const extra = typeof item === "string" ? "" : item.score ? `<span class="tiny muted">${Math.round(item.score)}%</span>` : "";
    return `<button class="chip tamil" type="button" ${attribute}="${escapeHtml(word)}">${escapeHtml(word)} ${extra}</button>`;
  }).join("")}</div>`;
}

function section(title, content) {
  if (!content) return "";
  return `<section class="word-section"><h3>${escapeHtml(title)}</h3><div class="section-content">${content}</div></section>`;
}

function detailMarkup(data, categories) {
  if (!data) {
    return `<div class="word-detail-empty">
      <span class="glyph">சொல்</span>
      <h3>Pick a word to wander through.</h3>
      <p>Search in Tamil or English, browse a category, or open one of the suggestions. Meanings, word families and similar forms will appear here.</p>
    </div>`;
  }
  const word = data.word || data.ta || "";
  const gloss = data.gloss || data.en || [];
  const category = categoryInfo(categories, data.category);
  const isOnline = data.lookup === "online";
  const isEnglishQuery = data.kind === "english" && data.query && data.query !== word;
  const example = data.example;
  const exampleEn = data.example_en;

  const sections = [
    section("Example", example ? `<div class="example-card">
      <div class="ex-ta">${escapeHtml(example)}</div>
      ${exampleEn ? `<div class="ex-en">${escapeHtml(exampleEn)}</div>` : ""}
      <div class="ex-actions">
        <button class="btn btn-sm btn-ghost" type="button" data-speak-example="${escapeHtml(example)}">${icon("volume", 13)} Hear it</button>
        <button class="btn btn-sm btn-ghost" type="button" data-translate-example="${escapeHtml(example)}">${icon("translate", 13)} Translate</button>
      </div>
    </div>` : ""),
    section("Synonyms", chipRow(data.synonyms)),
    section("Word family", chipRow((data.family || []).filter((item) => item !== word))),
    section("Built from", (data.roots?.length || data.compounds?.length) ? `<div class="chip-row">
      ${(data.roots || []).map((root) => `<button class="chip tamil" type="button" data-explore="${escapeHtml(root)}">${escapeHtml(root)} <span class="tiny muted">root</span></button>`).join("")}
      ${(data.compounds || []).map((parts) => `<span class="chip tamil" style="cursor:default">${escapeHtml(parts.join(" + "))}</span>`).join("")}
    </div>` : ""),
    section("Related ideas", chipRow((data.related_concepts || []).map((concept) => concept.ta).filter(Boolean))),
    section("Similar words", chipRow(data.similar || [])),
    section("Other matches", data.alternatives?.length ? `<div class="word-alts">${data.alternatives.map((alt) => `<button type="button" data-explore="${escapeHtml(alt.ta)}"><span class="ta">${escapeHtml(alt.ta)}</span><span class="en">${escapeHtml((alt.en || []).slice(0, 2).join(" · "))}</span></button>`).join("")}</div>` : ""),
  ].filter(Boolean).join("");

  return `
    <div class="word-detail-head">
      <div class="word-kicker">
        <span class="badge ${data.known ? "green" : "gold"}">${data.known ? "In the dictionary" : "Closest match"}</span>
        ${category.en ? `<span class="badge">${escapeHtml(category.en)}</span>` : ""}
        ${isOnline ? `<span class="badge blue">Online</span>` : ""}
      </div>
      <h2>${escapeHtml(word)}</h2>
      <div class="word-actions">
        <button class="icon-btn" type="button" data-word-action="copy" aria-label="Copy word" title="Copy">${icon("copy", 16)}</button>
        <button class="icon-btn" type="button" data-word-action="speak" aria-label="Speak word" title="Listen">${icon("volume", 16)}</button>
      </div>
      ${gloss.length ? `<div class="word-gloss">${gloss.slice(0, 8).map((meaning) => `<span class="chip">${escapeHtml(meaning)}</span>`).join("")}</div>` : `<p class="small muted mt-8">No English gloss in the local dictionary.</p>`}
      ${isEnglishQuery ? `<p class="small muted mt-8">Showing the Tamil match for “${escapeHtml(data.query)}”.</p>` : ""}
      <div class="word-meta-row">
        <span>${icon("globe", 13)} ${escapeHtml(data.source === "loose" ? "Not in local index" : isOnline ? "Found online" : "Local word index")}</span>
        <span class="freq-meter">${freqBars(data.frequency)} ${escapeHtml(frequencyLabel(data.frequency))}</span>
        ${data.frequency?.rank ? `<span>#${Number(data.frequency.rank).toLocaleString()} in corpus</span>` : ""}
        ${category.ta ? `<span class="tamil">${escapeHtml(category.ta)}</span>` : ""}
      </div>
    </div>
    <div class="word-detail-body">
      <div class="flex gap-8 wrap">
        <button class="btn btn-sm btn-primary" type="button" data-word-action="translate">${icon("translate", 13)} Use in translate</button>
        <button class="btn btn-sm btn-ghost" type="button" data-word-action="copy">${icon("copy", 13)} Copy</button>
      </div>
      ${isOnline ? `<div class="note green">${icon("info", 15)}<span>This concept had no local match, so Chillian translated “${escapeHtml(data.query)}” online with ${escapeHtml(data.engine || "Google Translate")}. The word details below come from the local index.</span></div>` : ""}
      ${!data.known && !isOnline ? `<div class="note warn">${icon("info", 15)}<span>This word is not in the local index. The closest forms and roots are shown below; check the spelling if something looks unfamiliar.</span></div>` : ""}
      ${sections || `<div class="note">${icon("info", 15)}<span>The local dictionary has a meaning for this word, but no example or related forms yet.</span></div>`}
    </div>
  `;
}

export function renderWords(ctx) {
  let categories = { ...FALLBACK_CATEGORIES };
  let suggestions = [];
  let detail = null;
  let activeWord = "";
  let activeCategory = null;
  let query = ctx.params.get("q") || "";
  let exploreToken = 0;
  let audio = null;
  let initialBusy = false;

  ctx.root.innerHTML = `
    <div class="view-head">
      <div class="view-head-copy">
        <span class="eyebrow">Word finder</span>
        <h1>Find the word that <em>fits</em>.</h1>
        <p>Search in Tamil or English. Chillian looks through a curated glossary, a 64k word index and Tamil morphology to find meanings, families and near neighbours.</p>
      </div>
      <div class="view-head-actions">
        <button class="btn btn-secondary btn-sm" type="button" id="randomWord">${icon("sparkle", 14)} Surprise me</button>
      </div>
    </div>

    <section class="word-search-card">
      <div class="word-search-head">
        <div class="word-search-copy">
          <h2>What are you looking for?</h2>
          <p>Tamil word, English meaning, or a fragment you half-remember.</p>
        </div>
        <span class="badge" style="background:rgba(255,255,255,.1);color:rgba(255,250,242,.7)">64k word index</span>
      </div>
      <form class="word-search-form" id="wordSearchForm" role="search">
        <input class="input" id="wordSearchInput" type="search" value="${escapeHtml(query)}" placeholder="மகிழ்ச்சி, happiness, அன்பு…" autocomplete="off" aria-label="Search for a Tamil or English word">
        <button class="btn" type="submit">${icon("search", 17)} <span>Find</span></button>
      </form>
      <div class="word-tools-row" id="wordCategories">
        <span class="label">Browse</span>
        <button class="chip" type="button" data-category="">All words</button>
        ${Object.entries(categories).slice(0, 8).map(([code, info]) => `<button class="chip" type="button" data-category="${escapeHtml(code)}">${escapeHtml(info.en)}</button>`).join("")}
      </div>
    </section>

    <div class="word-layout">
      <section class="word-list-card">
        <div class="panel-bar">
          <div class="panel-bar-left"><h3 id="wordListTitle">Suggestions</h3><span class="badge" id="wordListCount">—</span></div>
          <button class="icon-btn sm" type="button" id="refreshWords" aria-label="Show another word" title="Surprise me">${icon("refresh", 14)}</button>
        </div>
        <div class="word-list" id="wordList">
          <div class="word-loading" style="padding:17px">
            <div class="skeleton" style="height:35px"></div>
            <div class="skeleton" style="height:35px"></div>
            <div class="skeleton" style="height:35px"></div>
          </div>
        </div>
      </section>
      <section class="word-detail" id="wordDetail">
        <div class="word-detail-empty">
          <span class="glyph">சொல்</span>
          <h3>Pick a word to wander through.</h3>
          <p>Search in Tamil or English, or browse a category. Meanings and word families will appear here.</p>
        </div>
      </section>
    </div>

    <div class="note mt-16">
      ${icon("lock", 15)}
      <span>Dictionary lookups run on this machine. If an English concept is not in the local glossary, Chillian asks the online translator for one Tamil equivalent.</span>
    </div>
  `;

  const searchForm = ctx.root.querySelector("#wordSearchForm");
  const searchInput = ctx.root.querySelector("#wordSearchInput");
  const listHost = ctx.root.querySelector("#wordList");
  const listTitle = ctx.root.querySelector("#wordListTitle");
  const listCount = ctx.root.querySelector("#wordListCount");
  const detailHost = ctx.root.querySelector("#wordDetail");
  const categoryHost = ctx.root.querySelector("#wordCategories");

  function renderCategoryChips() {
    categoryHost.innerHTML = `<span class="label">Browse</span>
      <button class="chip ${activeCategory === null ? "solid" : ""}" type="button" data-category="">All words</button>
      ${Object.entries(categories).slice(0, 9).map(([code, info]) => `<button class="chip ${activeCategory === code ? "solid" : ""}" type="button" data-category="${escapeHtml(code)}">${escapeHtml(info.en)}</button>`).join("")}`;
  }

  function renderList() {
    listCount.textContent = String(suggestions.length);
    if (!suggestions.length) {
      listHost.innerHTML = `<div class="word-list-empty">No words found. Try a shorter fragment, another spelling, or search in English.</div>`;
      return;
    }
    listHost.innerHTML = suggestions.map((word) => wordListItem(word, word.ta === activeWord)).join("");
  }

  function renderDetail() {
    detailHost.innerHTML = detailMarkup(detail, categories);
  }

  async function explore(word) {
    const value = String(word || "").trim();
    if (!value) return;
    const token = ++exploreToken;
    activeWord = value;
    searchInput.value = value;
    detailHost.innerHTML = detailSkeleton();
    renderList();
    try {
      const data = await api.get("/api/words/explore", { q: value }, { timeout: 45000, signal: ctx.signal });
      if (token !== exploreToken || ctx.signal.aborted) return;
      detail = data;
      activeWord = data.word || value;
      // If this word is not in the current suggestion list, put it first so the
      // selection always has a visible anchor.
      if (!suggestions.some((item) => item.ta === activeWord)) {
        suggestions = [{ ta: activeWord, en: data.gloss || [], frequency: data.frequency, source: "selected" }, ...suggestions].slice(0, 40);
      }
      renderList();
      renderDetail();
      updateUrl();
    } catch (error) {
      if (token !== exploreToken || ctx.signal.aborted) return;
      console.error("Word explore failed", error);
      detail = null;
      detailHost.innerHTML = `<div class="word-detail-empty">
        <span class="glyph">?</span>
        <h3>I could not open that word.</h3>
        <p>${escapeHtml(errorMessage(error))}</p>
        <button class="btn btn-secondary btn-sm mt-16" type="button" data-retry="${escapeHtml(value)}">Try again</button>
      </div>`;
    }
  }

  async function suggest(value, options = {}) {
    const q = String(value || "").trim();
    listTitle.textContent = q ? "Search results" : activeCategory ? categoryInfo(categories, activeCategory).en : "Suggestions";
    try {
      let data;
      if (!q) {
        data = await api.get("/api/words/browse", { category: activeCategory || undefined, limit: 32 }, { signal: ctx.signal });
        suggestions = data.words || [];
      } else {
        const result = await api.get("/api/words/suggest", { q, limit: 14 }, { signal: ctx.signal });
        suggestions = result.suggestions || [];
      }
      if (ctx.signal.aborted) return;
      renderList();
      if (options.exploreFirst && suggestions.length) explore(suggestions[0].ta);
    } catch (error) {
      if (ctx.signal.aborted) return;
      suggestions = [];
      renderList();
      if (!options.silent) toast(errorMessage(error), { type: "error", title: "Word search failed" });
    }
  }

  async function loadCategories() {
    try {
      const data = await api.get("/api/words/categories", {}, { signal: ctx.signal });
      if (data?.categories && typeof data.categories === "object") {
        categories = { ...categories, ...data.categories };
        renderCategoryChips();
        renderDetail();
      }
    } catch {
      // Fallback categories already visible.
    }
  }

  function updateUrl() {
    const next = `#/words${activeWord ? `?q=${encodeURIComponent(activeWord)}` : ""}`;
    if (location.hash !== next) history.replaceState(null, "", next);
  }

  function useInTranslate(word) {
    ctx.setPending({
      translate: {
        text: word,
        source: isTamilText(word) ? "ta" : "en",
        target: isTamilText(word) ? "en" : "ta",
        autoTranslate: true,
      },
    });
    ctx.go("translate");
  }

  async function speak(text) {
    if (!text) return;
    try {
      const speech = await createSpeech(text, {
        lang: isTamilText(text) ? "ta" : "en",
        slow: ctx.prefs.ttsSlow,
        engine: ctx.prefs.ttsEngine,
        signal: ctx.signal,
      });
      if (audio) audio.pause();
      audio = new Audio(speech.url);
      audio.play().catch(() => {});
    } catch (error) {
      if (!ctx.signal.aborted) toast(errorMessage(error), { type: "error", title: "Voice unavailable" });
    }
  }

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const q = searchInput.value.trim();
    if (!q) return;
    suggest(q, { silent: true });
    explore(q);
  });
  const liveSuggest = debounce(() => {
    const q = searchInput.value.trim();
    if (q) suggest(q, { silent: true });
    else suggest("", { silent: true });
  }, 260);
  searchInput.addEventListener("input", liveSuggest);

  categoryHost.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    activeCategory = button.dataset.category || null;
    activeWord = "";
    renderCategoryChips();
    suggest("", { exploreFirst: true });
  });

  listHost.addEventListener("click", (event) => {
    const button = event.target.closest("[data-word]");
    if (!button) return;
    explore(button.dataset.word);
  });

  detailHost.addEventListener("click", (event) => {
    const exploreChip = event.target.closest("[data-explore]");
    if (exploreChip) {
      explore(exploreChip.dataset.explore);
      return;
    }
    const speakExample = event.target.closest("[data-speak-example]");
    if (speakExample) {
      speak(speakExample.dataset.speakExample);
      return;
    }
    const translateExample = event.target.closest("[data-translate-example]");
    if (translateExample) {
      useInTranslate(translateExample.dataset.translateExample);
      return;
    }
    const retry = event.target.closest("[data-retry]");
    if (retry) {
      explore(retry.dataset.retry);
      return;
    }
    const action = event.target.closest("[data-word-action]");
    if (!action || !detail) return;
    const word = detail.word || detail.ta || activeWord;
    if (action.dataset.wordAction === "copy") copyText(word, "Word copied");
    if (action.dataset.wordAction === "speak") speak(word);
    if (action.dataset.wordAction === "translate") useInTranslate(word);
  });

  async function random() {
    try {
      const word = await api.get("/api/words/random", {}, { signal: ctx.signal });
      if (!word?.ta) return;
      await suggest(word.ta, { silent: true });
      explore(word.ta);
    } catch (error) {
      if (!ctx.signal.aborted) toast(errorMessage(error), { type: "error" });
    }
  }

  ctx.root.querySelector("#randomWord")?.addEventListener("click", random);
  ctx.root.querySelector("#refreshWords")?.addEventListener("click", random);

  async function boot() {
    initialBusy = true;
    detailHost.innerHTML = detailSkeleton();
    listHost.innerHTML = `<div class="word-loading" style="padding:17px">
      <div class="skeleton" style="height:35px"></div>
      <div class="skeleton" style="height:35px"></div>
      <div class="skeleton" style="height:35px"></div>
    </div>`;
    loadCategories();
    try {
      if (query) {
        await suggest(query, { silent: true });
        explore(query);
      } else {
        const [browse, word] = await Promise.all([
          api.get("/api/words/browse", { limit: 32 }, { signal: ctx.signal }),
          api.get("/api/words/random", {}, { signal: ctx.signal }).catch(() => null),
        ]);
        if (ctx.signal.aborted) return;
        suggestions = browse.words || [];
        if (word?.ta && !suggestions.some((item) => item.ta === word.ta)) {
          suggestions.unshift({ ...word, source: "word-of-the-day" });
        }
        activeWord = word?.ta || suggestions[0]?.ta || "";
        renderList();
        if (activeWord) explore(activeWord);
        else renderDetail();
      }
    } catch (error) {
      if (ctx.signal.aborted) return;
      listHost.innerHTML = `<div class="word-list-empty">${escapeHtml(errorMessage(error))}</div>`;
      detailHost.innerHTML = `<div class="word-detail-empty"><span class="glyph">?</span><h3>The dictionary did not load.</h3><p>${escapeHtml(errorMessage(error))}</p><button class="btn btn-secondary btn-sm mt-16" type="button" onclick="location.reload()">Reload</button></div>`;
    } finally {
      initialBusy = false;
    }
  }

  updateUrl();
  boot();

  return () => {
    liveSuggest.cancel();
    exploreToken += 1;
    if (audio) {
      audio.pause();
      audio.src = "";
      audio = null;
    }
  };
}
