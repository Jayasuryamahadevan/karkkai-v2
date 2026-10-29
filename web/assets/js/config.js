const runtime = window.CHILLIAN_CONFIG || {};
const params = new URLSearchParams(window.location.search);

function stored(key) {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}

const apiBase = String(
  params.get("api") || stored("chillian.apiBase") || runtime.apiBase || ""
).replace(/\/+$/, "");

const staticMode = String(
  params.get("static") || stored("chillian.staticMode") || runtime.staticMode || "auto"
).toLowerCase();

export const CONFIG = {
  apiBase,
  staticMode,
  translateProxy: String(runtime.translateProxy || "https://clients5.google.com/translate_a/t"),
  transliterateProxy: String(runtime.transliterateProxy || "https://inputtools.google.com/request"),
  ttsProxy: String(runtime.ttsProxy || ""),
  version: String(runtime.version || "0.2.0"),
};

export const STATIC_PREFERENCE = staticMode === "always" || (staticMode !== "never" && !apiBase);

export function apiUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${apiBase}${clean}`;
}

export function setApiBase(value) {
  const next = String(value || "").trim().replace(/\/+$/, "");
  try {
    if (next) localStorage.setItem("chillian.apiBase", next);
    else localStorage.removeItem("chillian.apiBase");
  } catch { /* storage may be blocked */ }
}

export function setStaticMode(value) {
  const next = ["auto", "always", "never"].includes(value) ? value : "auto";
  try { localStorage.setItem("chillian.staticMode", next); } catch { /* ignore */ }
  return next;
}

export function isStaticPreferred() {
  return STATIC_PREFERENCE;
}
