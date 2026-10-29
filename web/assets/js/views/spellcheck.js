import { api, errorMessage } from "../api.js";
import { addExtraWord, loadExtraWords } from "../store.js";
import {
  copyText,
  debounce,
  escapeHtml,
  icon,
  setButtonLoading,
  toast,
} from "../ui.js";

const SAMPLE = "இன்று காலை நான் பள்ளிக்குச் சென்றேன். ஆசிரியர் தமிழ் பாடம் நடத்தினார். வணக்கம, நன்றி! இது ஒரு சோதனை .";

function issueKindLabel(issue) {
  if (issue.kind === "repetition") return "Repeated";
  if (issue.kind === "spacing") return "Spacing";
  return issue.severity === "error" ? "Spelling" : "Review";
}

function issueIcon(issue) {
  if (issue.kind === "repetition") return "refresh";
  if (issue.kind === "spacing") return "type";
  return "spell";
}

function markedPreview(text, issues, selectedId) {
  if (!text) return `<div class="marked-empty">Your text will appear here with the words Chillian wants to check.</div>`;
  const points = [];
  for (const issue of issues) {
    if (issue.start === issue.end) continue;
    if (!Number.isFinite(issue.start) || !Number.isFinite(issue.end)) continue;
    points.push(issue);
  }
  points.sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  let html = "";
  for (const issue of points) {
    if (issue.start < cursor) continue;
    if (issue.start >= text.length) continue;
    const end = Math.min(issue.end, text.length);
    html += escapeHtml(text.slice(cursor, issue.start));
    const cls = `${issue.severity || "review"} ${issue.kind || "spelling"}${issue.id === selectedId ? " selected" : ""}`;
    html += `<mark class="${cls}" data-mark-issue="${escapeHtml(issue.id)}" title="${escapeHtml(issue.message || "")}">${escapeHtml(text.slice(issue.start, end))}</mark>`;
    cursor = end;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}

export function renderSpellcheck(ctx) {
  let result = null;
  let visibleIssues = [];
  let selectedId = null;
  let checking = false;
  let checkToken = 0;
  let dismissed = new Set();
  let lastCheckedText = "";
  const pendingText = ctx.takePending("spellText") || ctx.params.get("text") || "";

  ctx.root.innerHTML = `
    <div class="view-head">
      <div class="view-head-copy">
        <span class="eyebrow">Spell check</span>
        <h1>Write Tamil with a <em>second pair of eyes</em>.</h1>
        <p>A dictionary-led check for spelling, repeated words and spacing. It understands Tamil suffixes and sandhi forms, and runs entirely on your machine.</p>
      </div>
      <div class="view-head-actions">
        <button class="btn btn-secondary btn-sm" type="button" id="spellSample">${icon("sparkle", 14)} Try a sample</button>
        <button class="btn btn-ghost btn-sm" type="button" id="spellClear">${icon("trash", 14)} Clear</button>
      </div>
    </div>

    <div class="spell-layout">
      <section class="spell-editor-card">
        <div class="panel-bar">
          <div class="panel-bar-left">
            <span class="badge green">தமிழ்</span>
            <h3>Your writing</h3>
          </div>
          <div class="panel-bar-actions">
            <button class="icon-btn" type="button" id="copySpellText" aria-label="Copy text" title="Copy">${icon("copy", 15)}</button>
          </div>
        </div>
        <textarea class="spell-textarea" id="spellText" maxlength="50000" spellcheck="false" placeholder="தமிழில் எழுதுங்கள்… or paste a paragraph here.">${escapeHtml(pendingText)}</textarea>
        <div class="spell-foot">
          <div class="stats-inline" id="spellStats"><span>Start typing to check your Tamil.</span></div>
          <button class="btn btn-primary" type="button" id="checkSpell">${icon("check", 16)} <span class="btn-label">Check now</span></button>
        </div>
      </section>

      <section class="issues-card">
        <div class="panel-bar">
          <div class="panel-bar-left"><h3>Suggestions</h3><span class="badge" id="issueBadge">—</span></div>
          <span class="tiny muted" id="lexiconLabel">Tamil dictionary</span>
        </div>
        <div class="issues-list" id="issuesList">
          <div class="empty-state" style="padding:42px 22px">
            <span class="empty-glyph">ழ</span>
            <h3>A quiet first draft</h3>
            <p>Type or paste Tamil text. Suggestions will appear here as you write.</p>
          </div>
        </div>
      </section>
    </div>

    <section class="marked-card">
      <div class="panel-bar">
        <div class="panel-bar-left"><h3>Marked text</h3><span class="badge gold">Preview</span></div>
        <button class="btn btn-ghost btn-sm" type="button" id="copyCorrected" disabled>${icon("copy", 13)} Copy text</button>
      </div>
      <div class="marked-text" id="markedText"><div class="marked-empty">Your text will appear here with the words Chillian wants to check.</div></div>
    </section>

    <div class="note spell-note">
      ${icon("info", 15)}
      <span>This is a dictionary and surface-pattern check, not a grammar checker. Names, dialect words and new coinages can be added to <b>My words</b>. Nothing is sent anywhere.</span>
    </div>
  `;

  const textarea = ctx.root.querySelector("#spellText");
  const statsHost = ctx.root.querySelector("#spellStats");
  const issuesList = ctx.root.querySelector("#issuesList");
  const issueBadge = ctx.root.querySelector("#issueBadge");
  const markedText = ctx.root.querySelector("#markedText");
  const checkButton = ctx.root.querySelector("#checkSpell");
  const copyCorrected = ctx.root.querySelector("#copyCorrected");
  const lexiconLabel = ctx.root.querySelector("#lexiconLabel");

  function updateStats() {
    if (!result) {
      statsHost.innerHTML = `<span>${textarea.value.trim() ? "Ready to check." : "Start typing to check your Tamil."}</span>`;
      return;
    }
    const stats = result.stats;
    statsHost.innerHTML = `
      <span><b>${stats.words}</b> words</span>
      ${stats.errors ? `<span class="stat-pill error">${stats.errors} spelling</span>` : ""}
      ${stats.reviews ? `<span class="stat-pill review">${stats.reviews} review</span>` : ""}
      ${!stats.errors && !stats.reviews ? `<span class="stat-pill" style="color:var(--green)">Looks clear</span>` : ""}
    `;
  }

  function renderIssues() {
    if (!result) {
      issueBadge.textContent = "—";
      issuesList.innerHTML = `<div class="empty-state" style="padding:42px 22px">
        <span class="empty-glyph">ழ</span>
        <h3>A quiet first draft</h3>
        <p>Type or paste Tamil text. Suggestions will appear here as you write.</p>
      </div>`;
      return;
    }
    issueBadge.textContent = String(visibleIssues.length);
    issueBadge.className = `badge ${visibleIssues.length ? "terra" : "green"}`;
    if (!visibleIssues.length) {
      issuesList.innerHTML = `<div class="empty-state" style="padding:44px 22px">
        <span class="empty-glyph" style="color:var(--green-2)">✓</span>
        <h3>Nothing to flag</h3>
        <p>Every Tamil word here is in the dictionary or your personal word list. Names and new words can still be added.</p>
      </div>`;
      return;
    }
    issuesList.innerHTML = visibleIssues.map((issue) => `
      <article class="issue ${issue.severity} ${issue.id === selectedId ? "selected" : ""}" data-issue-card="${escapeHtml(issue.id)}">
        <div class="issue-top">
          <div style="min-width:0">
            <div class="issue-word"><span class="bad">${escapeHtml(issue.word)}</span></div>
            <div class="issue-message">${escapeHtml(issue.message)}</div>
          </div>
          <span class="kind-icon" title="${escapeHtml(issueKindLabel(issue))}">${icon(issueIcon(issue), 13)}</span>
        </div>
        ${issue.suggestions?.length ? `<div class="issue-suggestions">
          ${issue.suggestions.map((suggestion) => `<button class="chip tamil" type="button" data-suggestion="${escapeHtml(suggestion)}" data-issue="${escapeHtml(issue.id)}">${escapeHtml(suggestion)}</button>`).join("")}
        </div>` : ""}
        <div class="issue-actions">
          ${issue.fix ? `<button type="button" data-fix="${escapeHtml(issue.fix)}" data-issue="${escapeHtml(issue.id)}">Fix</button>` : ""}
          ${issue.kind === "spelling" ? `<button type="button" data-add-word="${escapeHtml(issue.word)}" data-issue="${escapeHtml(issue.id)}">Add to my words</button>` : ""}
          <button type="button" data-dismiss="${escapeHtml(issue.id)}">Dismiss</button>
        </div>
      </article>
    `).join("");
  }

  function renderMarked() {
    markedText.innerHTML = markedPreview(textarea.value, visibleIssues, selectedId);
    copyCorrected.disabled = !textarea.value.trim();
  }

  function renderAll() {
    updateStats();
    renderIssues();
    renderMarked();
  }

  function selectIssue(id, scroll = false) {
    selectedId = id;
    renderIssues();
    renderMarked();
    if (scroll) {
      const card = issuesList.querySelector(`[data-issue-card="${CSS.escape(id)}"]`);
      if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      const mark = markedText.querySelector(`[data-mark-issue="${CSS.escape(id)}"]`);
      if (mark) mark.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  async function checkNow(options = {}) {
    const text = textarea.value;
    if (!text.trim()) {
      result = null;
      visibleIssues = [];
      selectedId = null;
      lastCheckedText = "";
      dismissed = new Set();
      renderAll();
      return;
    }
    if (checking) return;
    checking = true;
    const token = ++checkToken;
    checkButton.disabled = true;
    if (options.manual) setButtonLoading(checkButton, true, "Checking…");
    try {
      const data = await api.post("/api/spellcheck", {
        text,
        extra_words: loadExtraWords(),
      }, { timeout: 30000, signal: ctx.signal });
      if (token !== checkToken || ctx.signal.aborted) return;
      result = data;
      lastCheckedText = text;
      visibleIssues = (data.issues || []).filter((issue) => !dismissed.has(issue.id));
      if (!visibleIssues.some((issue) => issue.id === selectedId)) selectedId = null;
      lexiconLabel.textContent = `${Number(data.lexicon_size || 0).toLocaleString()} words · local`;
      renderAll();
      if (options.manual && !visibleIssues.length) {
        toast("No obvious spelling or spacing issues.", { type: "success" });
      }
    } catch (error) {
      if (ctx.signal.aborted) return;
      result = null;
      visibleIssues = [];
      issueBadge.textContent = "!";
      issueBadge.className = "badge terra";
      issuesList.innerHTML = `<div class="note danger" style="margin:12px">${icon("alert", 15)}<span>${escapeHtml(errorMessage(error))}</span></div>`;
      markedText.innerHTML = `<div class="marked-empty">The check could not finish. Your text is still here.</div>`;
      toast(errorMessage(error), { type: "error", title: "Spell check failed" });
    } finally {
      if (token === checkToken) {
        checking = false;
        checkButton.disabled = false;
        setButtonLoading(checkButton, false);
      }
    }
  }

  const autoCheck = debounce(() => checkNow(), 700);

  async function replaceRange(issueId, replacement) {
    if (lastCheckedText !== textarea.value) {
      await checkNow();
      toast("Text changed. Check the suggestions again.", { type: "info" });
      return;
    }
    const issue = visibleIssues.find((item) => item.id === issueId);
    if (!issue) return;
    const { start, end } = issue;
    textarea.value = `${textarea.value.slice(0, start)}${replacement}${textarea.value.slice(end)}`;
    const caret = start + replacement.length;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    dismissed = new Set();
    await checkNow();
  }

  function dismissIssue(issueId) {
    dismissed.add(issueId);
    visibleIssues = (result?.issues || []).filter((issue) => !dismissed.has(issue.id));
    if (selectedId === issueId) selectedId = null;
    renderIssues();
    renderMarked();
  }

  async function addWord(word) {
    addExtraWord(word);
    toast(`“${word}” added to My words.`, { type: "success" });
    dismissed = new Set();
    await checkNow();
  }

  textarea.addEventListener("input", () => {
    dismissed = new Set();
    selectedId = null;
    updateStats();
    copyCorrected.disabled = !textarea.value.trim();
    autoCheck();
  });
  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      autoCheck.cancel();
      checkNow({ manual: true });
    }
  });

  checkButton.addEventListener("click", () => {
    autoCheck.cancel();
    checkNow({ manual: true });
  });
  ctx.root.querySelector("#spellSample")?.addEventListener("click", () => {
    textarea.value = SAMPLE;
    textarea.focus();
    checkNow({ manual: true });
  });
  ctx.root.querySelector("#spellClear")?.addEventListener("click", () => {
    textarea.value = "";
    result = null;
    visibleIssues = [];
    selectedId = null;
    dismissed = new Set();
    renderAll();
    textarea.focus();
  });
  ctx.root.querySelector("#copySpellText")?.addEventListener("click", () => {
    if (textarea.value.trim()) copyText(textarea.value, "Text copied");
  });
  copyCorrected.addEventListener("click", () => {
    if (textarea.value.trim()) copyText(textarea.value, "Text copied");
  });

  issuesList.addEventListener("click", async (event) => {
    const suggestion = event.target.closest("[data-suggestion]");
    if (suggestion) {
      await replaceRange(suggestion.dataset.issue, suggestion.dataset.suggestion);
      return;
    }
    const fix = event.target.closest("[data-fix]");
    if (fix) {
      await replaceRange(fix.dataset.issue, fix.dataset.fix);
      return;
    }
    const add = event.target.closest("[data-add-word]");
    if (add) {
      await addWord(add.dataset.addWord);
      return;
    }
    const dismiss = event.target.closest("[data-dismiss]");
    if (dismiss) {
      dismissIssue(dismiss.dataset.dismiss);
      return;
    }
    const card = event.target.closest("[data-issue-card]");
    if (card) selectIssue(card.dataset.issueCard);
  });

  markedText.addEventListener("click", (event) => {
    const mark = event.target.closest("[data-mark-issue]");
    if (!mark) return;
    selectIssue(mark.dataset.markIssue, true);
    const card = issuesList.querySelector(`[data-issue-card="${CSS.escape(mark.dataset.markIssue)}"]`);
    if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  renderAll();
  if (pendingText.trim()) {
    checkNow();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  return () => {
    autoCheck.cancel();
    checkToken += 1;
  };
}
