const KEYS = {
  prefs: "chillian.prefs.v1",
  recents: "chillian.recents.v1",
  extraWords: "chillian.extraWords.v1",
};

export const DEFAULT_PREFS = Object.freeze({
  translateEngine: "auto",
  ttsEngine: "auto",
  ttsSlow: false,
  defaultSource: "en",
  defaultTarget: "ta",
  sentenceMode: false,
});

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadPrefs() {
  const stored = read(KEYS.prefs, {});
  return { ...DEFAULT_PREFS, ...(stored && typeof stored === "object" ? stored : {}) };
}

export function savePrefs(prefs) {
  return write(KEYS.prefs, prefs);
}

export function loadRecents() {
  const list = read(KEYS.recents, []);
  return Array.isArray(list) ? list.slice(0, 8) : [];
}

export function addRecent(item) {
  const current = loadRecents().filter(
    (entry) => !(entry.text === item.text && entry.target === item.target && entry.source === item.source)
  );
  current.unshift({ ...item, ts: Date.now() });
  const next = current.slice(0, 6);
  write(KEYS.recents, next);
  return next;
}

export function clearRecents() {
  write(KEYS.recents, []);
}

export function loadExtraWords() {
  const list = read(KEYS.extraWords, []);
  return Array.isArray(list) ? list.filter((w) => typeof w === "string") : [];
}

export function saveExtraWords(words) {
  const unique = [...new Set(words.map((w) => String(w).trim()).filter(Boolean))];
  write(KEYS.extraWords, unique.slice(0, 500));
  return unique.slice(0, 500);
}

export function addExtraWord(word) {
  return saveExtraWords([...loadExtraWords(), word]);
}

export function clearExtraWords() {
  write(KEYS.extraWords, []);
}

export function clearAllLocalData() {
  for (const key of Object.values(KEYS)) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
}
