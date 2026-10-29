/*
 * Chillian runtime configuration.
 *
 * The same web/ folder runs in three places:
 *   1. Served by the Chillian FastAPI server (everything available).
 *   2. Static hosting such as GitHub Pages (browser engines + proxies).
 *   3. Offline as an installed PWA (service worker cache).
 *
 * Leave apiBase empty when the page is served by the Chillian server, or set it
 * to the public HTTPS URL of a deployed Chillian server when the page is static.
 * You can also override it for a single visit with ?api=https://example.com
 */
window.CHILLIAN_CONFIG = Object.assign(
  {
    apiBase: "",
    staticMode: "auto",
    translateProxy: "https://clients5.google.com/translate_a/t",
    transliterateProxy: "https://inputtools.google.com/request",
    ttsProxy: "",
    version: "0.2.0",
  },
  window.CHILLIAN_CONFIG || {}
);
