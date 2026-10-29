/*
 * Chillian static engine.
 *
 * This module powers the app when it is hosted as plain files (GitHub Pages,
 * an installed PWA, or file://). It uses:
 *   - Google's public CORS translation endpoint for online translation.
 *   - The same Google Input Tools endpoint used by Desh-style keyboards for
 *     Tanglish -> Tamil typing.
 *   - Bundled Tamil data for dictionary translation, word finding and spelling.
 *
 * Nothing here talks to another Chillian folder or another app.
 */

import { CONFIG } from "./config.js";

const DATA = {
  glossary: new URL("../data/glossary.json", import.meta.url),
  thesaurus: new URL("../data/thesaurus.json", import.meta.url),
  phrases: new URL("../data/phrases.json", import.meta.url),
  words: new URL("../data/tamil_words.txt", import.meta.url),
  lexiconMeta: new URL("../data/lexicon-meta.json", import.meta.url),
};

const TAMIL_RE = /[\u0B80-\u0BFF]/;
const TAMIL_WORD_RE = /^[\u0B80-\u0BFF]+$/;
const TAMIL_TOKEN_RE = /[\u0B80-\u0BFF]+/g;
const LATIN_RE = /[A-Za-z]/;
const MEMORY = new Map();
const MAX_CACHE = 240;

const COMMON_PARTICLES = new Set([
  "ஓ", "ஏ", "ஆ", "ஈ", "ஒ", "ஔ", "ஃ", "உம்", "ஏன்", "என்ன", "எப்படி", "எங்கே",
  "யார்", "எது", "இது", "அது", "இவை", "அவை", "இங்கே", "அங்கே", "மிக", "மிகவும்",
  "மட்டும்", "கூட", "தான்", "என்று", "என", "ஆக",
]);

const SUFFIXES = [
  "களுக்கு", "களுடன்", "களிலிருந்து", "களில்", "களின்", "களை", "களால்", "களது", "களாக", "கள்",
  "க்காக", "க்கும்", "க்கு", "த்துக்கு", "த்தில்", "த்தை", "த்தால்", "த்தின்", "த்துடன்",
  "த்திலிருந்து", "இலிருந்து", "ிலிருந்து", "இருந்து", "வரை", "போல", "போல்", "என்று",
  "என", "ஆக", "ஆல்", "ஆன்", "ஆர்", "ஆள்", "ஐ", "இல்", "இன்", "உடன்", "உம்", "அன்",
  "அர்", "அது", "உக்கு",
].sort((a, b) => b.length - a.length);

const FAMILY_SUFFIXES = [
  "கள்", "களை", "களுக்கு", "களில்", "க்கு", "இல்", "ஐ", "ஆல்", "உடன்", "ஆக", "அன்",
  "அர்", "ஆள்", "ஆர்", "த்தை", "த்தில்", "வு", "ப்பு",
];

const COMMON_TYPOS = {
  "வணக்கம": ["வணக்கம்"],
  "நனறி": ["நன்றி"],
  "நன்றீ": ["நன்றி"],
  "தமழ்": ["தமிழ்"],
  "தமிழ": ["தமிழ்"],
  "அமா": ["அம்மா"],
  "அபா": ["அப்பா"],
  "மகிழ்சி": ["மகிழ்ச்சி"],
  "பள்ளிகு": ["பள்ளிக்கு"],
  "பள்ளிக்கூடம": ["பள்ளிக்கூடம்"],
  "ஆசிரியர": ["ஆசிரியர்"],
  "எழுத": ["எழுது"],
  "செய்தீ": ["செய்தி"],
  "படிக": ["படிக்க"],
  "வேல": ["வேலை"],
};

const CONFUSION_GROUPS = ["லள", "ரற", "நனண", "சஷஸ", "ஜய"];
const VOWEL_SIGN_GROUPS = ["ிீ", "ுூ", "ெே", "ொோ"];

const LANGUAGE_NAMES = {
  en: "English", ta: "Tamil", hi: "Hindi", ml: "Malayalam", te: "Telugu",
  kn: "Kannada", bn: "Bengali", mr: "Marathi", gu: "Gujarati", fr: "French",
  de: "German", es: "Spanish", ar: "Arabic", "zh-CN": "Chinese", ja: "Japanese",
};

const LANGUAGES = [
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

const store = {
  glossary: null,
  thesaurus: null,
  phrases: null,
  words: null,
  wordsSorted: null,
  indexes: null,
};
const loading = {};

/* ------------------------------------------------------------------ helpers */
function cacheGet(key) {
  const hit = MEMORY.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { MEMORY.delete(key); return null; }
  MEMORY.set(key, hit);
  return hit.value;
}
function cacheSet(key, value, ttl = 3600_000) {
  MEMORY.set(key, { value, expires: Date.now() + ttl });
  while (MEMORY.size > MAX_CACHE) MEMORY.delete(MEMORY.keys().next().value);
}
function uniq(list) { return [...new Set(list.filter(Boolean))]; }
function clean(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function normalize(value) {
  return clean(value).toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[.,!?;:]+$/g, "")
    .trim();
}
function escapeRe(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function isTamilText(text) { return TAMIL_RE.test(String(text || "")); }
function tamilRatio(text) {
  const value = String(text || "").replace(/\s+/g, "");
  if (!value) return 0;
  return (value.match(/[\u0B80-\u0BFF]/g) || []).length / value.length;
}
function detectLang(text) {
  const value = String(text || "");
  if (tamilRatio(value) >= 0.12) return "ta";
  if (LATIN_RE.test(value)) return "en";
  return "en";
}

async function fetchJson(url, options = {}, timeout = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadJson(url, key) {
  if (store[key]) return store[key];
  if (loading[key]) return loading[key];
  loading[key] = fetchJson(url).then((data) => {
    store[key] = data;
    return data;
  }).finally(() => { delete loading[key]; });
  return loading[key];
}

export async function loadGlossary() { return loadJson(DATA.glossary, "glossary"); }
export async function loadThesaurus() { return loadJson(DATA.thesaurus, "thesaurus"); }
export async function loadPhrases() { return loadJson(DATA.phrases, "phrases"); }

export async function loadWords() {
  if (store.words) return store.words;
  if (loading.words) return loading.words;
  loading.words = fetch(DATA.words).then((response) => {
    if (!response.ok) throw new Error("The bundled Tamil word list is missing.");
    return response.text();
  }).then((text) => {
    const words = text.split("\n").map((line) => line.trim()).filter(Boolean);
    store.words = new Set(words);
    store.wordsSorted = [...store.words].sort();
    return store.words;
  }).finally(() => { delete loading.words; });
  return loading.words;
}

async function buildIndexes() {
  if (store.indexes) return store.indexes;
  const [glossary, thesaurus, phrases] = await Promise.all([
    loadGlossary(), loadThesaurus(), loadPhrases(),
  ]);
  const byTa = new Map();
  const en = [];
  for (const entry of glossary.entries || []) {
    if (entry.ta) byTa.set(entry.ta, entry);
    for (const term of entry.en || []) en.push([String(term).toLowerCase(), entry]);
  }
  const phraseByEn = new Map();
  const phraseByTa = new Map();
  const phraseIndex = [];
  for (const phrase of phrases.phrases || []) {
    phraseByEn.set(normalize(phrase.en), phrase);
    phraseByTa.set(normalize(phrase.ta), phrase);
    phraseIndex.push(phrase);
  }
  for (const phrase of phrases.phrases || []) {
    for (const term of [phrase.en, phrase.ta]) {
      if (term) en.push([String(term).toLowerCase(), {
        ta: phrase.ta, en: [phrase.en], category: phrase.category,
        synonyms: [], example: phrase.ta, example_en: phrase.en, ...phrase,
      }]);
    }
  }
  en.sort((a, b) => b[0].length - a[0].length);
  const groups = thesaurus.groups || [];
  store.indexes = { byTa, en, phraseByEn, phraseByTa, phraseIndex, groups, categories: glossary.categories || {} };
  return store.indexes;
}

/* -------------------------------------------------------------- translation */
function parseGoogleTranslation(data, fallbackLang = "auto") {
  if (typeof data === "string") return { text: data, detected: fallbackLang };
  if (!Array.isArray(data)) return { text: "", detected: fallbackLang };
  if (typeof data[0] === "string") {
    return { text: data.filter((part) => typeof part === "string").join(""), detected: data[1] || fallbackLang };
  }
  if (Array.isArray(data[0]) && typeof data[0][0] === "string") {
    return { text: data.map((row) => row[0] || "").join(""), detected: data[0][1] || fallbackLang };
  }
  let text = "";
  for (const row of data) {
    if (Array.isArray(row)) text += parseGoogleTranslation(row, fallbackLang).text;
    else if (typeof row === "string") text += row;
  }
  return { text, detected: fallbackLang };
}

function splitForProxy(text, max = 1200) {
  const paragraphs = String(text).split(/\n{2,}/);
  const chunks = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= max) { chunks.push(paragraph); continue; }
    const sentences = paragraph.match(/[^.!?।]+[.!?।]?/g) || [paragraph];
    let current = "";
    for (const sentence of sentences) {
      if ((current + sentence).length > max && current) {
        chunks.push(current);
        current = "";
      }
      if (sentence.length > max) {
        for (let i = 0; i < sentence.length; i += max) chunks.push(sentence.slice(i, i + max));
      } else {
        current += sentence;
      }
    }
    if (current) chunks.push(current);
  }
  return chunks.length ? chunks : [String(text)];
}

async function googleTranslate(text, source, target) {
  const chunks = splitForProxy(text);
  const parts = [];
  let detected = source === "auto" ? "" : source;
  for (const chunk of chunks) {
    if (!chunk.trim()) { parts.push(chunk); continue; }
    const url = new URL(CONFIG.translateProxy);
    url.searchParams.set("client", "dict-chrome-ex");
    url.searchParams.set("sl", source || "auto");
    url.searchParams.set("tl", target);
    url.searchParams.set("q", chunk);
    const data = await fetchJson(url.toString(), {}, 22000);
    const parsed = parseGoogleTranslation(data, detected || "auto");
    if (!parsed.text.trim()) throw new Error("The translation proxy returned no text.");
    parts.push(parsed.text);
    if (parsed.detected && parsed.detected !== "auto") detected = parsed.detected;
  }
  return { translation: parts.join(" "), detected: detected || "auto" };
}

function phraseLookup(text, source, target) {
  const ix = store.indexes;
  if (!ix) return null;
  const key = normalize(text);
  if (source === "en" && target === "ta") {
    const hit = ix.phraseByEn.get(key);
    if (hit) return hit.ta;
    const entry = ix.byTa && [...ix.byTa.values()].find((item) =>
      (item.en || []).some((term) => normalize(term) === key));
    if (entry) return entry.ta;
  }
  if (source === "ta" && target === "en") {
    const hit = ix.phraseByTa.get(key);
    if (hit) return hit.en;
    const entry = ix.byTa.get(clean(text));
    if (entry) return (entry.en || [])[0] || null;
  }
  return null;
}

function dictionaryWord(word, source, target) {
  const ix = store.indexes;
  if (!ix) return null;
  const lower = word.toLowerCase();
  if (source === "en" && target === "ta") {
    let best = null;
    for (const [term, entry] of ix.en) {
      if (term === lower) { best = entry; break; }
    }
    if (best) return best.ta;
    // phrases that begin the word
    for (const [term, entry] of ix.en) {
      if (term.startsWith(lower) && term.split(" ").length > 1) return entry.ta;
    }
    return null;
  }
  if (source === "ta" && target === "en") {
    const entry = ix.byTa.get(word);
    if (entry) return (entry.en || [])[0] || null;
    for (const group of ix.groups) {
      if ((group.words || []).includes(word)) return group.en || null;
    }
    for (const suffix of SUFFIXES) {
      if (word.length > suffix.length + 1 && word.endsWith(suffix)) {
        const root = word.slice(0, -suffix.length);
        const rootEntry = ix.byTa.get(root);
        if (rootEntry) return (rootEntry.en || [])[0] || null;
      }
    }
    return null;
  }
  return null;
}

function translateWithDictionary(text, source, target) {
  const ix = store.indexes;
  if (!ix) return text;
  const exact = phraseLookup(text, source, target);
  if (exact) return exact;

  const tokens = String(text).match(/\s+|[^\s]+/g) || [];
  const output = [];
  for (const token of tokens) {
    if (/^\s+$/.test(token)) { output.push(token); continue; }
    const match = token.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
    if (!match) { output.push(token); continue; }
    const [, lead, core, trail] = match;
    if (!core) { output.push(token); continue; }
    if (core.match(/^\d+([.,]\d+)?$/)) { output.push(token); continue; }
    const translated = dictionaryWord(core, source, target);
    output.push(`${lead}${translated || core}${trail}`);
  }
  return output.join("");
}

function translateWithDictionarySmart(text, source, target) {
  const ix = store.indexes;
  if (!ix) return translateWithDictionary(text, source, target);
  const lower = text.toLowerCase();
  // Longest phrase first (up to six words) across sentence-like input.
  const words = text.split(/\s+/);
  if (words.length > 1) {
    for (let n = Math.min(6, words.length); n >= 2; n -= 1) {
      for (let i = 0; i + n <= words.length; i += 1) {
        const chunk = words.slice(i, i + n).join(" ");
        const hit = dictionaryWord(chunk.replace(/[.,!?;:]+$/, ""), source, target)
          || phraseLookup(chunk, source, target);
        if (hit) {
          // Replace just the matched phrase, then translate the rest.
          const before = words.slice(0, i).join(" ");
          const after = words.slice(i + n).join(" ");
          return [
            before ? translateWithDictionarySmart(before, source, target) : "",
            hit,
            after ? translateWithDictionarySmart(after, source, target) : "",
          ].filter(Boolean).join(" ");
        }
      }
    }
  }
  return translateWithDictionary(text, source, target);
}

export async function staticTranslate(text, source = "auto", target = "ta", engine = null) {
  const value = String(text || "").trim();
  if (!value) throw new Error("Enter some text to translate.");
  source = String(source || "auto").toLowerCase();
  target = String(target || "ta").toLowerCase();
  if (source === target && source !== "auto") {
    return {
      translation: value, source_lang: source, target_lang: target,
      engine: "none", engine_label: "Same language", latency_ms: 0, cached: false, warnings: [],
    };
  }
  const preferred = String(engine || "auto").toLowerCase();
  const cacheKey = `tr:${preferred}:${source}:${target}:${value}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true, latency_ms: 0 };

  const started = performance.now();
  const detected = source === "auto" ? detectLang(value) : source;
  const warnings = [];
  const localOnly = preferred === "local";

  if (!localOnly && navigator.onLine) {
    try {
      const result = await googleTranslate(value, source, target);
      const payload = {
        translation: result.translation.trim(),
        source_lang: result.detected || detected,
        target_lang: target,
        engine: "google-proxy",
        engine_label: "Google Translate proxy",
        latency_ms: Math.round(performance.now() - started),
        cached: false,
        warnings,
      };
      cacheSet(cacheKey, payload);
      return payload;
    } catch (error) {
      warnings.push("Google’s proxy was unreachable; used the offline dictionary instead.");
    }
  }

  if (!["en", "ta"].includes(detected) || !["en", "ta"].includes(target)) {
    throw new Error(
      "Offline translation supports English and Tamil only. Reconnect or choose English/Tamil."
    );
  }

  await buildIndexes();
  const translation = translateWithDictionarySmart(value, detected, target);
  const payload = {
    translation,
    source_lang: detected,
    target_lang: target,
    engine: "local",
    engine_label: "Offline dictionary",
    latency_ms: Math.round(performance.now() - started),
    cached: false,
    warnings: [
      ...warnings,
      "Offline dictionary translation is word-by-word; grammar may need a light edit.",
    ],
    quality: "dictionary",
  };
  cacheSet(cacheKey, payload);
  return payload;
}

/* ---------------------------------------------------------- transliteration */
const CONSONANTS = {
  kh: "க", gh: "க", ch: "ச", chh: "ச", jh: "ஜ", th: "த", dh: "த", ph: "ப", bh: "ப",
  sh: "ஷ", ss: "ஸ", zh: "ழ", ng: "ங", nj: "ஞ", gn: "ஞ", k: "க", g: "க", c: "ச",
  j: "ஜ", t: "ட", d: "ட", n: "ந", N: "ண", p: "ப", b: "ப", m: "ம", y: "ய",
  r: "ர", R: "ற", l: "ல", L: "ள", v: "வ", w: "வ", s: "ஸ", h: "ஹ", f: "ஃப",
  x: "க்ஸ", q: "க",
};
const VOWELS = {
  aaa: "ஆ", aa: "ஆ", A: "ஆ", ai: "ஐ", au: "ஔ", ou: "ஔ", ii: "ஈ", ee: "ஈ",
  I: "ஈ", uu: "ஊ", oo: "ஊ", U: "ஊ", e: "எ", E: "ஏ", o: "ஒ", O: "ஓ",
  a: "அ", i: "இ", u: "உ",
};
const SIGNS = {
  "ஆ": "ா", "இ": "ி", "ஈ": "ீ", "உ": "ு", "ஊ": "ூ", "எ": "ெ", "ஏ": "ே",
  "ஐ": "ை", "ஒ": "ொ", "ஓ": "ோ", "ஔ": "ௌ",
};
const VIRAMA = "்";

function localTransliterate(text) {
  const value = String(text || "");
  let out = "";
  let i = 0;
  while (i < value.length) {
    const rest = value.slice(i);
    if (!LATIN_RE.test(value[i])) { out += value[i]; i += 1; continue; }
    let matched = null;
    for (const key of Object.keys(CONSONANTS).sort((a, b) => b.length - a.length)) {
      if (rest.toLowerCase().startsWith(key.toLowerCase())) { matched = { key, type: "c" }; break; }
    }
    for (const key of Object.keys(VOWELS).sort((a, b) => b.length - a.length)) {
      if (rest.toLowerCase().startsWith(key.toLowerCase())) {
        if (!matched || key.length > matched.key.length) matched = { key, type: "v" };
        break;
      }
    }
    if (!matched) { out += value[i]; i += 1; continue; }
    const token = rest.slice(0, matched.key.length);
    i += matched.key.length;
    if (matched.type === "v") {
      const vowel = VOWELS[matched.key.toLowerCase()] || VOWELS[matched.key] || "";
      const prev = out.slice(-1);
      const consonantBases = new Set(Object.values(CONSONANTS));
      if (consonantBases.has(prev)) {
        out = out.slice(0, -1) + (SIGNS[vowel] ? prev + SIGNS[vowel] : prev + VIRAMA + vowel);
      } else {
        out += vowel;
      }
    } else {
      const consonant = CONSONANTS[matched.key.toLowerCase()] || CONSONANTS[matched.key] || token;
      const next = value.slice(i);
      let vowelMatch = null;
      for (const key of Object.keys(VOWELS).sort((a, b) => b.length - a.length)) {
        if (next.toLowerCase().startsWith(key.toLowerCase())) { vowelMatch = { key, vowel: VOWELS[key.toLowerCase()] }; break; }
      }
      if (vowelMatch) {
        i += vowelMatch.key.length;
        out += SIGNS[vowelMatch.vowel] ? consonant + SIGNS[vowelMatch.vowel] : consonant + VIRAMA + vowelMatch.vowel;
      } else {
        out += consonant + VIRAMA;
      }
    }
  }
  return out;
}

const INPUT_TOOL_LANGS = {
  ta: "ta-t-i0-und", hi: "hi-t-i0-und", ml: "ml-t-i0-und", te: "te-t-i0-und",
  kn: "kn-t-i0-und", bn: "bn-t-i0-und", gu: "gu-t-i0-und", mr: "mr-t-i0-und",
};

export async function staticTransliterate(text, lang = "ta") {
  const value = String(text || "");
  if (!value.trim()) return { input: value, suggestions: [], source: "empty" };
  const key = `tl:${lang}:${value}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const itc = INPUT_TOOL_LANGS[lang] || INPUT_TOOL_LANGS.ta;
  if (navigator.onLine) {
    try {
      const url = new URL(CONFIG.transliterateProxy);
      url.searchParams.set("text", value);
      url.searchParams.set("itc", itc);
      url.searchParams.set("num", "6");
      url.searchParams.set("cp", "0");
      url.searchParams.set("cs", "1");
      url.searchParams.set("ie", "utf-8");
      url.searchParams.set("oe", "utf-8");
      const data = await fetchJson(url.toString(), {}, 12000);
      const suggestions = data?.[1]?.[0]?.[1] || [];
      const result = {
        input: value,
        suggestions: uniq(suggestions).filter((item) => !String(item).endsWith("\u200c")),
        source: "desh-proxy",
        lang,
      };
      if (result.suggestions.length) cacheSet(key, result, 7 * 86400_000);
      return result;
    } catch {
      /* fall through to local rules */
    }
  }
  const local = localTransliterate(value);
  const result = { input: value, suggestions: local ? [local] : [], source: "local", lang };
  cacheSet(key, result, 86400_000);
  return result;
}

/* --------------------------------------------------------------- spellcheck */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        prev[j] + 1,
        current[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = current;
  }
  return prev[b.length];
}

function confusionVariants(word) {
  const out = new Set();
  for (const group of CONFUSION_GROUPS) {
    for (const char of group) {
      if (!word.includes(char)) continue;
      for (const replacement of group) {
        if (replacement !== char) out.add(word.replace(char, replacement));
      }
    }
  }
  for (const group of VOWEL_SIGN_GROUPS) {
    for (const char of group) {
      if (!word.includes(char)) continue;
      for (const replacement of group) {
        if (replacement !== char) out.add(word.replace(char, replacement));
      }
    }
  }
  if (word.endsWith(VIRAMA)) out.add(word.slice(0, -1));
  else out.add(word + VIRAMA);
  for (let i = 1; i < word.length; i += 1) {
    if (word[i] === word[i - 1] && !" ாிீுூெேைொோௌ".includes(word[i])) {
      out.add(word.slice(0, i) + word.slice(i + 1));
    }
  }
  for (let i = 1; i < word.length; i += 1) {
    if ("கசடதபறமயரலவழளன".includes(word[i])) out.add(word.slice(0, i) + word[i] + word.slice(i));
  }
  return [...out].filter((item) => item !== word);
}

function validWord(word, words, extra) {
  if (words.has(word) || extra.has(word) || COMMON_PARTICLES.has(word)) return true;
  for (const suffix of SUFFIXES) {
    if (word.length > suffix.length + 1 && word.endsWith(suffix)) {
      const root = word.slice(0, -suffix.length);
      if (words.has(root) || extra.has(root)) return true;
    }
  }
  return false;
}

function suggestWords(word, words, extra, limit = 6) {
  const ranked = new Map();
  for (const correction of COMMON_TYPOS[word] || []) {
    if (correction !== word) ranked.set(correction, 1000);
  }
  for (const variant of confusionVariants(word)) {
    if (words.has(variant) || extra.has(variant)) ranked.set(variant, Math.max(ranked.get(variant) || 0, 900 + 100 - Math.abs(variant.length - word.length)));
  }
  const first = word[0];
  const pool = (store.wordsSorted || []).filter((candidate) =>
    Math.abs(candidate.length - word.length) <= 2 && candidate[0] === first && candidate !== word
  ).slice(0, 4000);
  for (const candidate of pool) {
    const distance = levenshtein(word, candidate);
    const score = 100 - distance * 12;
    if (score >= 58) ranked.set(candidate, Math.max(ranked.get(candidate) || 0, score));
  }
  for (const candidate of words) {
    if (candidate.startsWith(word)) ranked.set(candidate, Math.max(ranked.get(candidate) || 0, 80));
  }
  return [...ranked.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([candidate]) => candidate);
}

export async function staticSpellcheck(text, extraWords = []) {
  const value = String(text || "");
  await loadWords();
  const extra = new Set((extraWords || []).map((word) => String(word).trim()).filter(Boolean));
  const words = store.words;
  const issues = [];
  const seen = new Set();
  const tokens = [...value.matchAll(new RegExp(TAMIL_TOKEN_RE.source, "g"))];
  for (const match of tokens) {
    const word = match[0];
    if (word.length <= 1) continue;
    seen.add(word);
    if (validWord(word, words, extra)) continue;
    const suggestions = suggestWords(word, words, extra);
    const best = suggestions[0];
    const strong = Boolean(best && levenshtein(word, best) <= 2);
    issues.push({
      id: `sp-${match.index}`,
      kind: "spelling",
      severity: strong ? "error" : "review",
      word,
      start: match.index,
      end: match.index + word.length,
      suggestions,
      message: strong ? `Did you mean “${best}”?` : "This word is not in the dictionary.",
    });
  }
  for (let i = 1; i < tokens.length; i += 1) {
    const prev = tokens[i - 1];
    const curr = tokens[i];
    if (prev[0] === curr[0] && !value.slice(prev.index + prev[0].length, curr.index).trim()) {
      issues.push({
        id: `rep-${curr.index}`, kind: "repetition", severity: "review", word: curr[0],
        start: curr.index, end: curr.index + curr[0].length, suggestions: [],
        message: "Repeated word — remove one copy if this was unintentional.",
      });
    }
  }
  for (const match of value.matchAll(/[ \t]+([,.!?;:])/g)) {
    issues.push({
      id: `space-${match.index}`, kind: "spacing", severity: "review", word: match[0],
      start: match.index, end: match.index + match[0].length, suggestions: [],
      fix: match[1], message: `Remove the space before “${match[1]}”.",
    });
  }
  issues.sort((a, b) => a.start - b.start);
  return {
    issues: issues.slice(0, 120),
    stats: {
      characters: value.length,
      words: tokens.length,
      unique: seen.size,
      errors: issues.filter((issue) => issue.severity === "error").length,
      reviews: issues.filter((issue) => issue.severity === "review").length,
      style: issues.filter((issue) => issue.kind === "spacing").length,
      total: issues.length,
    },
    lexicon_size: words.size,
    mode: "static",
  };
}

/* -------------------------------------------------------------------- words */
function wordEntry(entry, source = "glossary") {
  return {
    ta: entry.ta,
    en: entry.en || [],
    category: entry.category || null,
    synonyms: (entry.synonyms || []).slice(0, 5),
    example: entry.example,
    example_en: entry.example_en,
    frequency: { zipf: 0, rank: null, common: false },
    source,
  };
}

function englishMatches(query, limit) {
  const ix = store.indexes;
  const q = String(query).toLowerCase().trim();
  const results = [];
  const seen = new Set();
  for (const [term, entry] of ix.en) {
    if (seen.has(entry.ta)) continue;
    let rank = -1;
    if (term === q) rank = 0;
    else if (term.startsWith(q)) rank = 1;
    else if (term.includes(q)) rank = 2;
    if (rank < 0) continue;
    results.push([rank, entry]);
    seen.add(entry.ta);
    if (results.length >= limit * 4) break;
  }
  results.sort((a, b) => a[0] - b[0] || String(a[1].en?.[0]).localeCompare(String(b[1].en?.[0])));
  return results.slice(0, limit).map(([, entry]) => wordEntry(entry, "glossary"));
}

export async function staticWordsSuggest(q, limit = 12) {
  await buildIndexes();
  await loadWords();
  const query = clean(q);
  if (!query) {
    return { query: "", kind: "empty", suggestions: [], categories: store.indexes.categories };
  }
  limit = Math.max(1, Math.min(Number(limit) || 12, 30));
  if (!isTamilText(query)) {
    const results = englishMatches(query, limit);
    if (!results.length) {
      for (const phrase of store.indexes.phraseIndex) {
        if (phrase.en.toLowerCase().includes(query.toLowerCase())) results.push(wordEntry(phrase, "phrasebook"));
      }
    }
    return { query, kind: "english", suggestions: results.slice(0, limit), categories: store.indexes.categories };
  }
  const suggestions = [];
  const seen = new Set();
  const exact = store.indexes.byTa.get(query);
  if (exact) { suggestions.push(wordEntry(exact)); seen.add(query); }
  const prefix = (store.wordsSorted || []).filter((word) => word.startsWith(query)).slice(0, 40);
  for (const word of prefix) {
    if (seen.has(word)) continue;
    const entry = store.indexes.byTa.get(word);
    suggestions.push(entry ? wordEntry(entry) : {
      ta: word, en: [], category: null, synonyms: [], frequency: { zipf: 0, rank: null }, source: "prefix",
    });
    seen.add(word);
    if (suggestions.length >= limit) break;
  }
  if (suggestions.length < 6) {
    for (const candidate of suggestWords(query, store.words, new Set(), limit)) {
      if (seen.has(candidate)) continue;
      const entry = store.indexes.byTa.get(candidate);
      suggestions.push(entry ? wordEntry(entry) : {
        ta: candidate, en: [], category: null, synonyms: [], frequency: { zipf: 0, rank: null },
        source: "similar", score: 80,
      });
      seen.add(candidate);
    }
  }
  return { query, kind: "tamil", suggestions: suggestions.slice(0, limit), categories: store.indexes.categories };
}

export async function staticWordsExplore(query) {
  await buildIndexes();
  await loadWords();
  const value = clean(query);
  if (!value) throw new Error("Enter a Tamil or English word");
  if (!isTamilText(value)) {
    const matches = englishMatches(value, 8);
    if (matches.length) {
      const first = matches[0];
      return {
        query: value, word: first.ta, kind: "english", known: true, gloss: first.en,
        category: first.category, synonyms: first.synonyms, roots: [], family: [],
        compounds: [], similar: [], related_concepts: [], example: first.example,
        example_en: first.example_en, frequency: first.frequency, source: "glossary",
        alternatives: matches.slice(1),
      };
    }
    const translated = await staticTranslate(value, "en", "ta").catch(() => null);
    return {
      query: value, word: translated?.translation || value, kind: "english", known: false,
      gloss: [], category: null, synonyms: [], roots: [], family: [], compounds: [],
      similar: [], related_concepts: [],
      frequency: { zipf: 0, rank: null }, source: translated?.engine || "unknown",
      lookup: translated?.engine === "google-proxy" ? "online" : "local",
      engine: translated?.engine_label,
    };
  }

  const entry = store.indexes.byTa.get(value) || {};
  const roots = [];
  for (const suffix of SUFFIXES) {
    if (value.length > suffix.length + 1 && value.endsWith(suffix)) {
      const root = value.slice(0, -suffix.length);
      if (store.words.has(root) && !roots.includes(root)) roots.push(root);
    }
  }
  const family = [];
  for (const root of roots) {
    for (const suffix of FAMILY_SUFFIXES) {
      const candidate = root + suffix;
      if (store.words.has(candidate) && candidate !== value) family.push(candidate);
    }
  }
  const compounds = [];
  if (value.length >= 6) {
    for (let i = 3; i <= value.length - 3; i += 1) {
      const left = value.slice(0, i);
      const right = value.slice(i);
      if (store.words.has(left) && store.words.has(right)) compounds.push([left, right]);
      if (compounds.length >= 3) break;
    }
  }
  const synonyms = uniq(entry.synonyms || []);
  const related = [];
  for (const group of store.indexes.groups) {
    const words = group.words || [];
    if (words.includes(value)) {
      synonyms.push(...words.filter((word) => word !== value));
      related.push({ en: group.en, ta: group.ta });
    }
  }
  const similar = suggestWords(value, store.words, new Set(), 6)
    .filter((word) => word !== value)
    .map((word) => ({ ta: word, score: Math.max(55, 100 - levenshtein(value, word) * 10) }));

  return {
    query: value,
    word: value,
    kind: "tamil",
    known: Boolean(entry.ta) || store.words.has(value),
    gloss: entry.en || [],
    category: entry.category || null,
    synonyms: uniq(synonyms),
    roots,
    family: uniq(family).slice(0, 24),
    compounds,
    similar,
    related_concepts: related,
    example: entry.example,
    example_en: entry.example_en,
    frequency: { zipf: 0, rank: null, common: false },
    source: entry.ta ? "glossary" : "index",
  };
}

export async function staticWordsRandom(category = null) {
  await buildIndexes();
  const entries = (store.glossary.entries || []).filter((entry) => !category || entry.category === category);
  const pool = entries.length ? entries : store.glossary.entries || [];
  if (!pool.length) return {};
  const seed = Math.floor(Date.now() / 86400000);
  return wordEntry(pool[seed % pool.length], "word-of-the-day");
}

export async function staticWordsBrowse(category = null, limit = 40) {
  await buildIndexes();
  const entries = (store.glossary.entries || []).filter((entry) => !category || entry.category === category);
  return entries.slice(0, Math.max(1, Math.min(Number(limit) || 40, 200))).map((entry) => wordEntry(entry, "browse"));
}

export async function staticWordCategories() {
  await buildIndexes();
  return { categories: store.indexes.categories };
}

/* ---------------------------------------------------------------- phrasebook */
export async function staticPhrasebook(q = "", category = "") {
  const data = await loadPhrases();
  const query = clean(q).toLowerCase();
  const phrases = (data.phrases || []).filter((phrase) => {
    if (category && phrase.category !== category) return false;
    if (!query) return true;
    return phrase.en.toLowerCase().includes(query)
      || phrase.ta.includes(q)
      || (phrase.roman || "").toLowerCase().includes(query);
  });
  return { categories: data.categories || {}, phrases, total: phrases.length };
}

/* ------------------------------------------------------------- text analysis */
export async function staticAnalyzeText(text) {
  const value = String(text || "");
  const chars = [...value].length;
  const words = value.trim() ? value.trim().split(/\s+/).filter(Boolean) : [];
  const tamilWords = words.filter((word) => TAMIL_RE.test(word));
  const englishWords = words.filter((word) => LATIN_RE.test(word));
  const sentences = value.split(/[.!?।]+/).map((part) => part.trim()).filter(Boolean);
  const paragraphs = value.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const frequency = new Map();
  for (const word of words.map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean)) {
    const key = word.toLowerCase();
    frequency.set(key, (frequency.get(key) || 0) + 1);
  }
  const top = [...frequency.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);
  const unique = frequency.size;
  const readingMinutes = Math.max(0.1, words.length / 180);
  return {
    characters: chars,
    characters_no_spaces: value.replace(/\s/g, "").length,
    words: words.length,
    unique_words: unique,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    tamil_words: tamilWords.length,
    english_words: englishWords.length,
    tamil_ratio: Math.round((tamilWords.length / Math.max(words.length, 1)) * 1000) / 10,
    avg_word_length: words.length ? Math.round((words.reduce((sum, word) => sum + [...word].length, 0) / words.length) * 10) / 10 : 0,
    avg_sentence_words: sentences.length ? Math.round((words.length / sentences.length) * 10) / 10 : 0,
    reading_minutes: Math.round(readingMinutes * 10) / 10,
    top_words: top.map(([word, count]) => ({ word, count })),
    longest_word: words.reduce((best, word) => ([...word].length > [...best].length ? word : best), ""),
  };
}

/* ------------------------------------------------------------------ practice */
export async function staticPracticeQuiz(count = 8, category = "") {
  await buildIndexes();
  const entries = (store.glossary.entries || []).filter((entry) => entry.ta && (entry.en || []).length && (!category || entry.category === category));
  const pool = entries.length ? entries : (store.glossary.entries || []).filter((entry) => entry.ta && (entry.en || []).length);
  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.max(1, Math.min(Number(count) || 8, 30)));
  return {
    questions: shuffled.map((entry, index) => {
      const correct = entry.en[0];
      const distractors = pool
        .filter((item) => item.ta !== entry.ta && item.en?.[0] && item.en[0] !== correct)
        .sort(() => Math.random() - 0.5)
        .slice(0, 3)
        .map((item) => item.en[0]);
      const options = [...distractors, correct].sort(() => Math.random() - 0.5);
      return {
        id: index,
        prompt: entry.ta,
        answer: correct,
        options: uniq(options).slice(0, 4),
        category: entry.category || null,
      };
    }),
  };
}

/* ---------------------------------------------------------------- static API */
export function staticHealth() {
  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  return {
    ok: true,
    app: "Chillian",
    version: CONFIG.version,
    mode: "static",
    online: {
      translation: { google: online, local: true },
      tts: { browser: true, google: online },
      stt: { browser: true },
    },
    local: { spellcheck: true, word_finder: true, pdf: false, ghostscript: false, tamil_font: true },
    lexicon: { ready: true, words: 24068, status: "bundled" },
    stt: {
      server_available: [], browser: true,
      labels: { sarvam: "Sarvam Saarika", openai: "OpenAI Whisper" },
      hint: "Live speech uses the browser. Uploaded audio needs the Chillian server.",
    },
    tts: {
      available: { browser: true, google: online },
      preferred: "browser",
      labels: { browser: "Device voice", google: "Google proxy" },
    },
    translation: {
      available: { google: online, local: true },
      preferred: "auto",
      labels: { "google-proxy": "Google Translate proxy", local: "Offline dictionary" },
    },
    typing: {
      available: online,
      proxy: CONFIG.transliterateProxy,
      labels: { "desh-proxy": "Desh-style input tools", local: "Offline transliteration" },
    },
    limits: {
      translate_chars: 5000, tts_chars: 4500, pdf_mb: 30, audio_mb: 25,
      pdf_pages: 80, pdf_timeout_seconds: 150,
    },
  };
}

export function staticLanguages() {
  return { languages: LANGUAGES, primary: ["en", "ta"] };
}

function unsupported(feature) {
  const error = new Error(`${feature} needs the Chillian server. Open the local server or set apiBase in config.js.`);
  error.status = 501;
  error.code = "static_unsupported";
  throw error;
}

export async function staticJson(path, options = {}) {
  const url = new URL(path, "https://chillian.local");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const params = url.searchParams;
  const method = (options.method || "GET").toUpperCase();
  const body = options.body ? (typeof options.body === "string" ? JSON.parse(options.body) : options.body) : {};

  if (p === "/api/health") return staticHealth();
  if (p === "/api/languages") return staticLanguages();
  if (p === "/api/translate" && method === "POST") {
    return staticTranslate(body.text, body.source, body.target, body.engine);
  }
  if (p === "/api/spellcheck" && method === "POST") {
    return staticSpellcheck(body.text, body.extra_words || []);
  }
  if (p === "/api/transliterate" || p === "/api/type") {
    const text = params.get("text") || body.text || "";
    const lang = params.get("lang") || body.lang || "ta";
    return staticTransliterate(text, lang);
  }
  if (p === "/api/words/suggest") return staticWordsSuggest(params.get("q") || "", params.get("limit") || 12);
  if (p === "/api/words/explore") return staticWordsExplore(params.get("q") || "");
  if (p === "/api/words/random") return staticWordsRandom(params.get("category") || null);
  if (p === "/api/words/browse") return { category: params.get("category") || null, words: await staticWordsBrowse(params.get("category") || null, params.get("limit") || 40) };
  if (p === "/api/words/categories") return staticWordCategories();
  if (p === "/api/phrasebook") return staticPhrasebook(params.get("q") || "", params.get("category") || "");
  if (p === "/api/text/analyze") return staticAnalyzeText(body.text || params.get("text") || "");
  if (p === "/api/practice/quiz") return staticPracticeQuiz(params.get("count") || 8, params.get("category") || "");
  if (p.startsWith("/api/pdf/")) unsupported("The PDF studio");
  if (p.startsWith("/api/stt")) unsupported("Uploaded-audio transcription");
  if (p === "/api/tts") unsupported("Server text-to-speech");
  throw Object.assign(new Error(`The static build does not implement ${p}.`), { status: 404 });
}

export async function staticBlob(path, data) {
  const p = new URL(path, "https://chillian.local").pathname;
  if (p === "/api/tts") {
    const payload = data && typeof data === "string" ? JSON.parse(data) : (data || {});
    if (!CONFIG.ttsProxy) {
      throw Object.assign(new Error("This browser should use its built-in voice."), { code: "use_browser_voice" });
    }
    const url = new URL(CONFIG.ttsProxy);
    url.searchParams.set("text", payload.text || "");
    url.searchParams.set("lang", payload.lang || "ta");
    url.searchParams.set("slow", payload.slow ? "1" : "0");
    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`The TTS proxy returned HTTP ${response.status}.`);
    const blob = await response.blob();
    return {
      blob,
      headers: { "x-tts-provider": "proxy", "x-tts-cached": "0" },
      status: 200,
    };
  }
  unsupported("This download");
}

export function staticForm() {
  unsupported("File tools");
}

export const staticData = { DATA, LANGUAGES, detectLang, isTamilText, localTransliterate };
