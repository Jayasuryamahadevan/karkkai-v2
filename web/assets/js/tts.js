import { api } from "./api.js";

const cache = new Map();
const MAX_CACHE = 14;

function cacheKey(text, lang, slow, engine) {
  return `${engine || "auto"}|${lang}|${slow ? 1 : 0}|${text}`;
}

export async function createSpeech(text, options = {}) {
  const {
    lang = "ta",
    slow = false,
    engine = "auto",
    signal,
  } = options;
  const value = String(text || "").trim();
  if (!value) throw new Error("There is no text to speak.");
  const key = cacheKey(value, lang, slow, engine);
  const cached = cache.get(key);
  if (cached) return { ...cached, cached: true };

  const { blob, headers } = await api.blob(
    "/api/tts",
    { text: value, lang, slow: Boolean(slow), engine: engine === "auto" ? null : engine },
    { timeout: 120000, signal }
  );
  if (!blob || blob.size === 0) throw new Error("The voice service returned an empty audio file.");
  const url = URL.createObjectURL(blob);
  const result = {
    url,
    blob,
    provider: headers["x-tts-provider"] || "google",
    cached: headers["x-tts-cached"] === "1",
  };
  cache.set(key, result);
  while (cache.size > MAX_CACHE) {
    const [oldKey, oldValue] = cache.entries().next().value || [];
    if (!oldKey) break;
    cache.delete(oldKey);
    setTimeout(() => URL.revokeObjectURL(oldValue.url), 8000);
  }
  return result;
}

export function clearSpeechCache() {
  for (const value of cache.values()) URL.revokeObjectURL(value.url);
  cache.clear();
}
