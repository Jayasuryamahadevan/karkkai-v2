let spriteReady = false;

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function icon(name, size = 18, className = "") {
  return `<svg class="ui-icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

export function hydrateIcons(root = document) {
  if (!spriteReady) {
    const template = document.getElementById("iconSprite");
    if (template) {
      document.body.appendChild(template.content.cloneNode(true));
      spriteReady = true;
    }
  }
  root.querySelectorAll("[data-icon]").forEach((node) => {
    const name = node.getAttribute("data-icon");
    if (!name) return;
    node.outerHTML = icon(name, 18, node.className || "");
  });
}

export function toast(message, options = {}) {
  const {
    title = "",
    type = "info",
    timeout = 4200,
  } = options;
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = document.createElement("div");
  const iconName = type === "error" ? "alert" : type === "success" ? "check" : "info";
  el.className = `toast ${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.innerHTML = `
    <span class="toast-icon">${icon(iconName, 13)}</span>
    <span class="toast-copy">${title ? `<strong>${escapeHtml(title)}</strong>` : ""}<span>${escapeHtml(message)}</span></span>
  `;
  host.appendChild(el);
  const remove = () => {
    if (!el.isConnected) return;
    el.classList.add("out");
    setTimeout(() => el.remove(), 260);
  };
  const timer = setTimeout(remove, timeout);
  el.addEventListener("click", () => {
    clearTimeout(timer);
    remove();
  });
}

export async function copyText(text, message = "Copied to clipboard") {
  const value = String(text ?? "");
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const area = document.createElement("textarea");
      area.value = value;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    toast(message, { type: "success", timeout: 2200 });
    return true;
  } catch {
    toast("The browser blocked clipboard access.", { type: "error" });
    return false;
  }
}

export function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

export function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const mins = Math.floor(value / 60);
  const secs = Math.floor(value % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

export function relativeTime(ts) {
  const diff = Math.max(0, Date.now() - Number(ts || 0));
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function freqBars(frequency, bars = 5) {
  const zipf = Number(frequency?.zipf || 0);
  const filled = Math.max(0, Math.min(bars, Math.round((zipf / 7) * bars)));
  return `<span class="freq-bars" title="Corpus frequency${frequency?.rank ? ` · rank ${frequency.rank}` : ""}">${Array.from({ length: bars }, (_, i) => `<i class="${i < filled ? "on" : ""}"></i>`).join("")}</span>`;
}

export function frequencyLabel(frequency) {
  const zipf = Number(frequency?.zipf || 0);
  if (zipf >= 5) return "Very common";
  if (zipf >= 4) return "Common";
  if (zipf >= 3) return "Uncommon";
  if (zipf > 0) return "Rare";
  return "Not ranked";
}

export function isTamilText(text) {
  return /[\u0B80-\u0BFF]/.test(String(text || ""));
}

export function isMostlyTamil(text) {
  const value = String(text || "").replace(/\s+/g, "");
  if (!value) return false;
  const tamil = (value.match(/[\u0B80-\u0BFF]/g) || []).length;
  return tamil / value.length > 0.18;
}

export function languageLabel(code, languages = []) {
  const found = languages.find((lang) => lang.code === code);
  if (found) return found.name;
  const fallback = {
    auto: "Auto-detect",
    en: "English",
    ta: "Tamil",
    hi: "Hindi",
    ml: "Malayalam",
    te: "Telugu",
    kn: "Kannada",
    bn: "Bengali",
    mr: "Marathi",
    gu: "Gujarati",
    fr: "French",
    de: "German",
    es: "Spanish",
    ar: "Arabic",
    "zh-CN": "Chinese",
    ja: "Japanese",
  };
  return fallback[code] || String(code || "").toUpperCase();
}

export function baseLang(code) {
  return String(code || "").toLowerCase().split("-")[0];
}

export function setButtonLoading(button, loading, label = "Working…") {
  if (!button) return;
  if (loading) {
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.classList.add("loading");
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="btn-label">${escapeHtml(label)}</span>`;
  } else {
    button.disabled = false;
    button.classList.remove("loading");
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml;
      delete button.dataset.originalHtml;
    }
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "download";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 12000);
}

export function downloadUrl(url, filename) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "download";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function focusTrap(container) {
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const previouslyFocused = document.activeElement;
  const onKeydown = (event) => {
    if (event.key !== "Tab") return;
    const nodes = [...container.querySelectorAll(selector)].filter((el) => el.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener("keydown", onKeydown);
  setTimeout(() => {
    const focusable = container.querySelector(selector);
    if (focusable) focusable.focus();
  }, 40);
  return () => {
    container.removeEventListener("keydown", onKeydown);
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
  };
}

export function showError(host, message, title = "Something went wrong") {
  if (!host) return;
  host.innerHTML = `
    <div class="note danger">${icon("alert", 15)}
      <span><strong>${escapeHtml(title)}.</strong> ${escapeHtml(message)}</span>
    </div>`;
}

export function safeDate(ts) {
  try {
    return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export function iconButton(name, label, extra = "", size = 16) {
  return `<button class="icon-btn ${extra}" type="button" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon(name, size)}</button>`;
}
