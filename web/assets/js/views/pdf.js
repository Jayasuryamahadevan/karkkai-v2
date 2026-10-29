import { api, errorMessage } from "../api.js";
import {
  downloadBlob,
  downloadUrl,
  escapeHtml,
  formatBytes,
  icon,
  setButtonLoading,
  toast,
} from "../ui.js";

const FALLBACK_PRESETS = {
  balanced: { label: "Balanced", description: "Good everyday compression at 150 dpi. Keeps text selectable." },
  smallest: { label: "Smallest", description: "Aggressive 72 dpi compression. Best for email or quick sharing." },
  print: { label: "Print quality", description: "300 dpi output for documents that need to look crisp." },
  text: { label: "Keep text sharp", description: "Lossless image handling and font subsetting. Best for text-heavy PDFs." },
  raster: { label: "Maximum (flatten)", description: "Rebuilds pages as images. Smallest result, but text is no longer selectable." },
};

function headerValue(headers, name, fallback = "") {
  if (!headers) return fallback;
  const lower = name.toLowerCase();
  if (headers[lower] !== undefined) return headers[lower];
  const found = Object.keys(headers).find((key) => key.toLowerCase() === lower);
  return found ? headers[found] : fallback;
}

function ensurePdfExtension(name) {
  return /\.pdf$/i.test(name || "") ? name : `${name || "chillian-document"}.pdf`;
}

function dropzoneMarkup(kind) {
  const isEdit = kind === "edit";
  return `<div class="dropzone" data-dropzone="${kind}" role="button" tabindex="0" aria-label="${isEdit ? "Open a PDF to edit" : "Choose a PDF to compress"}">
    <span class="dz-icon">${icon(isEdit ? "edit" : "compress", 29)}</span>
    <h3>${isEdit ? "Open a Tamil PDF to edit." : "Make a PDF lighter."}</h3>
    <p>${isEdit
      ? "Click a line to replace it, erase an area, highlight, or add new Tamil text. Text-based PDFs work best."
      : "Drop a PDF here and choose how much to compress. Tamil text stays selectable in every preset except Maximum."}</p>
    <div class="dz-actions">
      <span class="btn btn-primary">${icon("upload", 15)} Choose PDF</span>
    </div>
    <span class="dz-foot">PDF only · up to 30 MB · up to 80 pages · processed on this machine</span>
    <input type="file" accept="application/pdf,.pdf" data-file-input="${kind}">
  </div>`;
}

function bindDropzone(host, kind, onFile) {
  const zone = host.querySelector(`[data-dropzone="${kind}"]`);
  if (!zone) return;
  const input = zone.querySelector(`[data-file-input="${kind}"]`);
  const open = () => input?.click();
  zone.addEventListener("click", (event) => {
    if (event.target === input) return;
    open();
  });
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
  input?.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) onFile(file);
  });
}

export function renderPdf(ctx) {
  const requestedTab = ctx.params.get("tab");
  let tab = requestedTab === "edit" || requestedTab === "editor" ? "edit" : "compress";
  let compressFile = null;
  let compressAnalysis = null;
  let compressResult = null;
  let compressUrl = null;
  let doc = null;
  let page = 0;
  let pageToken = 0;
  let pageInfo = null;
  let lines = [];
  let edits = [];
  let editCounter = 0;
  let selectedLineId = null;
  let selectedEditId = null;
  let pendingRect = null;
  let tool = "select";
  let scale = 1;
  let scaleAdjusted = false;
  let drag = null;
  let editorMounted = false;
  let exporting = false;
  let exportResult = null;
  let exportUrl = null;
  let pingTimer = null;
  let disposed = false;

  ctx.root.innerHTML = `
    <div class="view-head">
      <div class="view-head-copy">
        <span class="eyebrow">PDF studio</span>
        <h1>Lighter files. <em>Tamil</em> edits.</h1>
        <p>Compress a PDF, or open one and work on its pages directly. Everything stays on this machine, with Tamil fonts embedded when you export.</p>
      </div>
      <div class="view-head-actions">
        <div class="tabs" role="tablist" aria-label="PDF tools">
          <button class="tab-btn ${tab === "compress" ? "active" : ""}" type="button" role="tab" aria-selected="${tab === "compress"}" data-pdf-tab="compress">${icon("compress", 15)} Compress</button>
          <button class="tab-btn ${tab === "edit" ? "active" : ""}" type="button" role="tab" aria-selected="${tab === "edit"}" data-pdf-tab="edit">${icon("edit", 15)} Edit Tamil</button>
        </div>
      </div>
    </div>

    <div class="pdf-tabs-row">
      <div class="chip-row">
        <span class="badge green">Local processing</span>
        <span class="badge">PyMuPDF</span>
        <span class="badge">Ghostscript</span>
      </div>
      <span class="tiny muted">No upload to a cloud server. Sessions expire automatically.</span>
    </div>

    <div id="compressPane" class="pdf-pane" ${tab === "compress" ? "" : "hidden"}>
      <div id="compressContent"></div>
    </div>
    <div id="editPane" class="pdf-pane" ${tab === "edit" ? "" : "hidden"}>
      <div id="editContent"></div>
    </div>
  `;

  const compressPane = ctx.root.querySelector("#compressPane");
  const editPane = ctx.root.querySelector("#editPane");
  const compressContent = ctx.root.querySelector("#compressContent");
  const editContent = ctx.root.querySelector("#editContent");

  ctx.root.querySelectorAll("[data-pdf-tab]").forEach((button) => {
    button.addEventListener("click", () => setTab(button.dataset.pdfTab));
  });

  function setTab(next) {
    tab = next === "edit" ? "edit" : "compress";
    compressPane.hidden = tab !== "compress";
    editPane.hidden = tab !== "edit";
    ctx.root.querySelectorAll("[data-pdf-tab]").forEach((button) => {
      const active = button.dataset.pdfTab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    if (tab === "compress" && !compressAnalysis && !compressResult) renderCompressIdle();
    if (tab === "edit" && !doc) renderEditIdle();
    const nextHash = `#/pdf?tab=${tab}`;
    if (location.hash !== nextHash) history.replaceState(null, "", nextHash);
  }

  function validatePdf(file) {
    if (!file) return false;
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
    if (!isPdf) {
      toast("Please choose a PDF file.", { type: "error" });
      return false;
    }
    const maxMb = Number(ctx.state.health?.limits?.pdf_mb || 30);
    if (file.size > maxMb * 1024 * 1024) {
      toast(`That PDF is larger than ${maxMb} MB.`, { type: "error" });
      return false;
    }
    return true;
  }

  /* ================================================================ COMPRESS */
  function renderCompressIdle() {
    compressResult = null;
    compressAnalysis = null;
    compressFile = null;
    compressContent.innerHTML = `
      ${dropzoneMarkup("compress")}
      <div class="home-lower" style="margin-top:16px">
        <section class="local-card">
          <span class="eyebrow">How it works</span>
          <h3 class="mt-8">Smaller, still readable.</h3>
          <p>Ghostscript re-encodes images and embeds fonts without touching the words. Chillian checks the result and returns the smaller file.</p>
          <div class="local-grid">
            <div class="local-item">${icon("compress", 15)}<div><strong>Four presets</strong><span>Balanced, smallest, print and sharp text.</span></div></div>
            <div class="local-item">${icon("lock", 15)}<div><strong>Stays local</strong><span>The file is never sent to an online service.</span></div></div>
          </div>
        </section>
        <section class="quote-card" style="min-height:210px">
          <div>
            <span class="eyebrow">A smaller file</span>
            <blockquote style="font-size:19px">“எளிமையானது அழகானது.”</blockquote>
            <p class="quote-en">Simple is beautiful.</p>
          </div>
          <div class="quote-foot"><span>Chillian PDF studio</span><span class="badge" style="background:rgba(255,255,255,.1);color:rgba(255,250,242,.65)">Ghostscript</span></div>
        </section>
      </div>
    `;
    bindDropzone(compressContent, "compress", handleCompressFile);
  }

  async function handleCompressFile(file) {
    if (!validatePdf(file)) return;
    compressFile = file;
    compressAnalysis = null;
    compressResult = null;
    compressContent.innerHTML = `<div class="upload-loading">
      <span class="spinner"></span>
      <strong>Opening the PDF…</strong>
      <span>${escapeHtml(file.name)} · ${formatBytes(file.size)}</span>
    </div>`;
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const analysis = await api.form("/api/pdf/analyze", form, { timeout: 60000, signal: ctx.signal });
      if (ctx.signal.aborted) return;
      compressAnalysis = analysis;
      renderCompressAnalysis();
    } catch (error) {
      if (ctx.signal.aborted) return;
      compressContent.innerHTML = `${dropzoneMarkup("compress")}
        <div class="note danger mt-16">${icon("alert", 15)}<span>${escapeHtml(errorMessage(error))}</span></div>`;
      bindDropzone(compressContent, "compress", handleCompressFile);
      toast(errorMessage(error), { type: "error", title: "Could not open PDF" });
    }
  }

  function renderCompressAnalysis() {
    if (!compressAnalysis || !compressFile) return;
    const presets = compressAnalysis.presets || FALLBACK_PRESETS;
    const scanned = Boolean(compressAnalysis.scanned);
    const selected = "balanced";
    compressContent.innerHTML = `
      <div class="compress-layout">
        <aside class="file-card">
          <div class="file-preview">
            ${compressAnalysis.preview ? `<img src="${compressAnalysis.preview}" alt="First page preview">` : ""}
            <span class="badge ${scanned ? "gold" : "green"} scan-badge">${scanned ? "Scanned pages" : "Text-based"}</span>
          </div>
          <div class="file-info">
            <h3>${escapeHtml(compressFile.name)}</h3>
            <div class="file-meta">
              <span class="badge">${formatBytes(compressAnalysis.size)}</span>
              <span class="badge">${compressAnalysis.pages} page${compressAnalysis.pages === 1 ? "" : "s"}</span>
              ${scanned ? `<span class="badge gold">Images</span>` : `<span class="badge green">Selectable text</span>`}
            </div>
            <div class="file-stats">
              <div><b>${compressAnalysis.pages}</b><span>pages</span></div>
              <div><b>${formatBytes(compressAnalysis.size)}</b><span>original size</span></div>
            </div>
            ${compressAnalysis.metadata?.title ? `<p class="tiny muted mt-12" style="word-break:break-word">${escapeHtml(compressAnalysis.metadata.title)}</p>` : ""}
          </div>
        </aside>
        <div class="compress-main">
          <section class="panel">
            <div class="panel-body">
              <div class="preset-head"><h3>Choose compression</h3><span>Smaller files keep their pages</span></div>
              <div class="preset-grid mt-12" id="presetGrid">
                ${Object.entries(presets).map(([key, preset]) => `
                  <label class="preset-option">
                    <input type="radio" name="pdfPreset" value="${escapeHtml(key)}" ${key === selected ? "checked" : ""}>
                    <span class="preset-name"><span>${escapeHtml(preset.label)}</span><span class="radio"></span></span>
                    <p>${escapeHtml(preset.description)}</p>
                  </label>
                `).join("")}
              </div>
              ${scanned ? `<div class="note warn mt-12">${icon("info", 15)}<span>This PDF looks like a scan. Compression will mainly shrink the page images, not any hidden text.</span></div>` : ""}
              <div class="result-actions">
                <button class="btn btn-primary btn-lg" type="button" id="compressNow">${icon("compress", 17)} <span class="btn-label">Compress PDF</span></button>
                <button class="btn btn-secondary" type="button" id="openOriginalInEditor">${icon("edit", 16)} Open in editor</button>
                <button class="btn btn-ghost" type="button" id="chooseAnotherPdf">${icon("upload", 15)} Choose another</button>
              </div>
            </div>
          </section>
          <div class="note">${icon("info", 15)}<span>The <b>Keep text sharp</b> preset is the safest for Tamil documents with selectable text. <b>Maximum</b> turns pages into images, so text will no longer be editable after compression.</span></div>
        </div>
      </div>
    `;

    ctx.root.querySelector("#chooseAnotherPdf")?.addEventListener("click", renderCompressIdle);
    ctx.root.querySelector("#compressNow")?.addEventListener("click", compressNow);
    ctx.root.querySelector("#openOriginalInEditor")?.addEventListener("click", () => openEditor(compressFile));
  }

  async function compressNow(event) {
    const button = event.currentTarget;
    const preset = compressContent.querySelector('input[name="pdfPreset"]:checked')?.value || "balanced";
    if (!compressFile) return;
    setButtonLoading(button, true, "Compressing…");
    try {
      const form = new FormData();
      form.append("file", compressFile, compressFile.name);
      form.append("preset", preset);
      const { blob, headers } = await api.blob("/api/pdf/compress", form, { timeout: 170000, signal: ctx.signal });
      if (ctx.signal.aborted) return;
      if (compressUrl) URL.revokeObjectURL(compressUrl);
      compressUrl = URL.createObjectURL(blob);
      const filename = ensurePdfExtension(headerValue(headers, "x-pdf-filename", compressFile.name));
      compressResult = {
        blob,
        url: compressUrl,
        filename,
        size: blob.size,
        original: Number(headerValue(headers, "x-pdf-original-size", compressAnalysis?.size || compressFile.size)),
        savedPercent: Number(headerValue(headers, "x-pdf-saved-percent", 0)),
        engine: headerValue(headers, "x-pdf-engine", "ghostscript"),
        note: headerValue(headers, "x-pdf-note", ""),
        preset,
      };
      renderCompressResult();
    } catch (error) {
      if (!ctx.signal.aborted) toast(errorMessage(error), { type: "error", title: "Compression failed" });
    } finally {
      if (!ctx.signal.aborted) setButtonLoading(button, false);
    }
  }

  function renderCompressResult() {
    if (!compressResult) return;
    const result = compressResult;
    const saved = Math.max(0, result.original - result.size);
    const percent = result.original ? (saved / result.original) * 100 : 0;
    compressContent.innerHTML = `
      <div class="compress-layout">
        <aside class="file-card">
          <div class="file-preview">
            ${compressAnalysis?.preview ? `<img src="${compressAnalysis.preview}" alt="First page preview">` : ""}
            <span class="badge green scan-badge">Compressed</span>
          </div>
          <div class="file-info">
            <h3>${escapeHtml(result.filename)}</h3>
            <div class="file-meta">
              <span class="badge green">${formatBytes(result.size)}</span>
              <span class="badge">${escapeHtml(result.engine)}</span>
            </div>
            <div class="file-stats">
              <div><b>${formatBytes(result.original)}</b><span>before</span></div>
              <div><b>${formatBytes(result.size)}</b><span>after</span></div>
            </div>
          </div>
        </aside>
        <div class="compress-main">
          <section class="compress-result">
            <div class="result-title"><span class="ok-icon">${icon("check", 17)}</span> Ready to download.</div>
            <div class="result-sizes">
              <div class="size-block"><span>Original</span><strong>${formatBytes(result.original)}</strong></div>
              <span class="size-arrow">${icon("arrow", 18)}</span>
              <div class="size-block after"><span>Compressed</span><strong>${formatBytes(result.size)}</strong></div>
              <span class="saved">${percent > 0 ? `Saved ${percent.toFixed(0)}%` : "Already lean"}</span>
            </div>
            <div class="result-actions">
              <a class="btn btn-primary" href="${result.url}" download="${escapeHtml(result.filename)}">${icon("download", 16)} Download PDF</a>
              <button class="btn btn-secondary" type="button" id="openCompressedInEditor">${icon("edit", 16)} Open in editor</button>
              <button class="btn btn-ghost" type="button" id="compressAgain">${icon("refresh", 15)} Compress again</button>
            </div>
            <div class="result-meta-lines">
              ${result.note ? `<div>${escapeHtml(result.note)}</div>` : ""}
              <div>Preset: ${escapeHtml(capitalizePreset(result.preset))} · Engine: ${escapeHtml(result.engine)} · Your file stays on this machine.</div>
            </div>
          </section>
          <div class="note green">${icon("check", 15)}<span>Downloaded files are generated locally. The compressed copy is also available from the link above until you leave this page.</span></div>
        </div>
      </div>
    `;
    ctx.root.querySelector("#compressAgain")?.addEventListener("click", () => {
      if (compressUrl) URL.revokeObjectURL(compressUrl);
      compressUrl = null;
      compressResult = null;
      renderCompressAnalysis();
    });
    ctx.root.querySelector("#openCompressedInEditor")?.addEventListener("click", () => {
      const file = new File([result.blob], result.filename, { type: "application/pdf" });
      openEditor(file);
    });
  }

  function capitalizePreset(preset) {
    return (FALLBACK_PRESETS[preset]?.label || preset || "Balanced");
  }

  /* ==================================================================== EDIT */
  function renderEditIdle() {
    doc = null;
    editorMounted = false;
    edits = [];
    selectedLineId = null;
    selectedEditId = null;
    pendingRect = null;
    lines = [];
    pageInfo = null;
    editContent.innerHTML = `
      ${dropzoneMarkup("edit")}
      <div class="home-lower" style="margin-top:16px">
        <section class="local-card">
          <span class="eyebrow">Visual editing</span>
          <h3 class="mt-8">Work on the page itself.</h3>
          <p>Click any extracted line to replace it, or draw a box to erase, highlight or add new text. Tamil fonts are embedded on export.</p>
          <div class="local-grid">
            <div class="local-item">${icon("edit", 15)}<div><strong>Line by line</strong><span>Replace text while keeping the page layout.</span></div></div>
            <div class="local-item">${icon("text-add", 15)}<div><strong>Draw &amp; place</strong><span>Add Tamil anywhere, or cover an area first.</span></div></div>
          </div>
        </section>
        <section class="local-card">
          <span class="eyebrow">If text looks unusual</span>
          <h3 class="mt-8">Scans welcome.</h3>
          <p>Some PDFs split Tamil glyphs during extraction. If a line reads as gibberish, use <b>Erase area</b>, then <b>Add text</b> for a clean result.</p>
          <div class="note warn mt-12">${icon("info", 15)}<span>Inserted Tamil renders beautifully but may extract as individual glyphs in other PDF readers. Keep the exported file for reading and printing.</span></div>
        </section>
      </div>
    `;
    bindDropzone(editContent, "edit", openEditor);
  }

  async function openEditor(file, options = {}) {
    if (!validatePdf(file)) return;
    setTab("edit");
    if (doc) {
      await deleteSession(doc.doc_id);
      doc = null;
    }
    editContent.innerHTML = `<div class="upload-loading">
      <span class="spinner"></span>
      <strong>Preparing the editor…</strong>
      <span>${escapeHtml(file.name)} · ${formatBytes(file.size)}</span>
    </div>`;
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const meta = await api.form("/api/pdf/open", form, { timeout: 60000, signal: ctx.signal });
      if (ctx.signal.aborted) return;
      doc = meta;
      page = 0;
      edits = [];
      editCounter = 0;
      selectedLineId = null;
      selectedEditId = null;
      pendingRect = null;
      tool = "select";
      scale = 1;
      scaleAdjusted = false;
      exportResult = null;
      if (exportUrl) URL.revokeObjectURL(exportUrl);
      exportUrl = null;
      renderEditorShell();
      await loadPage(0, { fit: true });
    } catch (error) {
      if (ctx.signal.aborted) return;
      editContent.innerHTML = `${dropzoneMarkup("edit")}<div class="note danger mt-16">${icon("alert", 15)}<span>${escapeHtml(errorMessage(error))}</span></div>`;
      bindDropzone(editContent, "edit", openEditor);
      toast(errorMessage(error), { type: "error", title: "Could not open the PDF" });
    }
  }

  async function deleteSession(docId) {
    if (!docId) return;
    try { await api.delete(`/api/pdf/${docId}`); } catch { /* session cleanup is best effort */ }
  }

  function renderEditorShell() {
    if (!doc) return;
    editorMounted = true;
    const meta = doc.metadata || {};
    editContent.innerHTML = `
      <div class="pdf-editor">
        <div class="pdf-editor-top">
          <div class="pdf-file-id">
            <span class="pdf-file-icon">${icon("file", 16)}</span>
            <div>
              <strong title="${escapeHtml(doc.filename)}">${escapeHtml(doc.filename)}</strong>
              <span>${doc.page_count} page${doc.page_count === 1 ? "" : "s"} · ${formatBytes(doc.size)}${meta.title ? ` · ${escapeHtml(meta.title)}` : ""}</span>
            </div>
          </div>
          <div class="pdf-editor-top-actions">
            <button class="btn btn-sm btn-ghost" type="button" data-action="change-file">${icon("upload", 14)} Change file</button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="close-doc">${icon("x", 14)} Close</button>
            <button class="btn btn-sm btn-primary" type="button" data-action="export">${icon("download", 14)} Export PDF</button>
          </div>
        </div>

        <div class="pdf-toolbar">
          <div class="tool-group" role="group" aria-label="Editing tools">
            <button class="tool-btn active" type="button" data-tool="select" title="Select a line">${icon("select", 14)} <span>Select</span></button>
            <button class="tool-btn" type="button" data-tool="add" title="Draw a box and add text">${icon("text-add", 14)} <span>Add text</span></button>
            <button class="tool-btn" type="button" data-tool="whiteout" title="Draw a box to erase">${icon("eraser", 14)} <span>Erase</span></button>
            <button class="tool-btn" type="button" data-tool="highlight" title="Draw a highlight">${icon("highlight", 14)} <span>Highlight</span></button>
          </div>
          <div class="tool-group">
            <button class="tool-btn" type="button" data-nav="prev" aria-label="Previous page">${icon("chevron-left", 14)}</button>
            <span class="tiny muted" id="pageLabel">Page 1 of ${doc.page_count}</span>
            <button class="tool-btn" type="button" data-nav="next" aria-label="Next page">${icon("chevron-right", 14)}</button>
          </div>
          <div class="toolbar-spacer"></div>
          <div class="zoom-control tool-group">
            <button class="icon-btn sm" type="button" data-zoom="-1" aria-label="Zoom out">−</button>
            <span id="zoomLabel">100%</span>
            <button class="icon-btn sm" type="button" data-zoom="1" aria-label="Zoom in">+</button>
          </div>
          <div class="tool-group">
            <button class="tool-btn" type="button" data-action="undo" title="Undo last edit">${icon("undo", 14)} <span>Undo</span></button>
          </div>
        </div>

        <div class="pdf-editor-grid">
          <div class="pdf-stage" id="pdfStage">
            <div class="pdf-stage-inner">
              <div class="pdf-canvas tool-select" id="pdfCanvas">
                <img id="pdfPageImage" alt="PDF page" draggable="false">
                <div class="line-layer" id="lineLayer"></div>
                <div class="edit-layer" id="editLayer"></div>
                <div class="draw-box" id="drawBox" hidden></div>
                <div class="pdf-empty-lines" id="emptyLines" hidden><span>No selectable text on this page — draw to add or erase.</span></div>
              </div>
            </div>
          </div>
          <aside class="pdf-inspector" id="pdfInspector"></aside>
        </div>
      </div>
    `;
    paintTool();
    renderInspector();
    // The editor keeps one delegated listener set on #editContent; the shell can
    // therefore be rebuilt without stacking handlers.
  }

  function currentPageMeta() {
    return doc?.pages?.[page] || null;
  }

  async function loadPage(index, options = {}) {
    if (!doc) return;
    const nextPage = Math.max(0, Math.min(doc.page_count - 1, Number(index) || 0));
    const token = ++pageToken;
    page = nextPage;
    selectedLineId = null;
    selectedEditId = null;
    pendingRect = null;
    tool = "select";
    paintTool();
    hideDrawBox();
    const label = editContent.querySelector("#pageLabel");
    if (label) label.textContent = `Page ${page + 1} of ${doc.page_count}`;
    const image = editContent.querySelector("#pdfPageImage");
    if (!image) return;
    const pageMeta = currentPageMeta();
    if (pageMeta) {
      if (!scaleAdjusted || options.fit) {
        const stage = editContent.querySelector("#pdfStage");
        const available = Math.max(320, (stage?.clientWidth || 760) - 54);
        scale = Math.min(1.35, Math.max(0.55, available / Math.max(pageMeta.width, 1)));
        scaleAdjusted = true;
      }
      resizeCanvas(pageMeta.width, pageMeta.height);
    }
    image.src = `${doc.page_url.replace("{page}", String(page))}?zoom=${encodeURIComponent("1.7")}`;
    image.alt = `Page ${page + 1} of ${doc.filename}`;
    const linesLayer = editContent.querySelector("#lineLayer");
    if (linesLayer) linesLayer.innerHTML = "";
    try {
      const data = await api.get(`/api/pdf/${doc.doc_id}/lines/${page}`, {}, { timeout: 30000, signal: ctx.signal });
      if (token !== pageToken || ctx.signal.aborted) return;
      pageInfo = data;
      lines = data.lines || [];
      resizeCanvas(data.width || pageMeta?.width || 595, data.height || pageMeta?.height || 842);
      renderOverlays();
      renderInspector();
    } catch (error) {
      if (token !== pageToken || ctx.signal.aborted) return;
      lines = [];
      pageInfo = pageMeta ? { width: pageMeta.width, height: pageMeta.height } : null;
      renderOverlays();
      renderInspector();
      toast(errorMessage(error), { type: "error", title: "Could not read page text" });
    }
  }

  function resizeCanvas(width, height) {
    const canvas = editContent.querySelector("#pdfCanvas");
    if (!canvas) return;
    canvas.style.width = `${Math.round(Number(width) * scale)}px`;
    canvas.style.aspectRatio = `${Number(width)} / ${Number(height)}`;
    const zoomLabel = editContent.querySelector("#zoomLabel");
    if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  }

  function pctRect(rect) {
    const width = pageInfo?.width || currentPageMeta()?.width || 595;
    const height = pageInfo?.height || currentPageMeta()?.height || 842;
    const x0 = Math.max(0, Math.min(Number(rect?.[0] || 0), width));
    const y0 = Math.max(0, Math.min(Number(rect?.[1] || 0), height));
    const x1 = Math.max(x0, Math.min(Number(rect?.[2] || 0), width));
    const y1 = Math.max(y0, Math.min(Number(rect?.[3] || 0), height));
    return {
      left: `${(x0 / width) * 100}%`,
      top: `${(y0 / height) * 100}%`,
      width: `${Math.max(0.2, ((x1 - x0) / width) * 100)}%`,
      height: `${Math.max(0.2, ((y1 - y0) / height) * 100)}%`,
    };
  }

  function rectStyle(rect) {
    const style = pctRect(rect);
    return `left:${style.left};top:${style.top};width:${style.width};height:${style.height}`;
  }

  function renderOverlays() {
    const lineLayer = editContent.querySelector("#lineLayer");
    const editLayer = editContent.querySelector("#editLayer");
    const empty = editContent.querySelector("#emptyLines");
    if (!lineLayer || !editLayer) return;
    lineLayer.innerHTML = lines.map((line) => `
      <div class="line-box ${line.id === selectedLineId ? "selected" : ""}" data-line-id="${escapeHtml(line.id)}" style="${rectStyle(line.bbox)}" title="${escapeHtml(line.text)}"></div>
    `).join("");
    if (empty) empty.hidden = lines.length > 0;
    const pageEdits = edits.filter((edit) => edit.page === page);
    editLayer.innerHTML = pageEdits.map((edit) => {
      const isText = edit.kind === "replace" || edit.kind === "add";
      const fontSize = Number(edit.font_size || (edit.kind === "replace" ? 12 : 14));
      const style = rectStyle(edit.rect);
      const fontStyle = isText
        ? `font-size:calc(${fontSize} / ${pageInfo?.width || 595} * 100cqw);line-height:1.3;`
        : "";
      return `<div class="edit-box ${escapeHtml(edit.kind)} ${edit.id === selectedEditId ? "selected" : ""}" data-edit-id="${escapeHtml(edit.id)}" style="${style};${fontStyle}" title="${escapeHtml(edit.kind === "whiteout" ? "Erased area" : edit.kind === "highlight" ? "Highlight" : edit.text || "")}">
        <span class="edit-label">${escapeHtml(edit.kind === "replace" ? "Replaced" : edit.kind === "add" ? "Added" : edit.kind === "whiteout" ? "Erased" : "Highlight")}</span>
        ${isText ? `<span class="edit-text" style="color:${escapeHtml(edit.color || "#171512")};text-align:${escapeHtml(edit.align || "left")}">${escapeHtml(edit.text || "")}</span>` : ""}
      </div>`;
    }).join("");
  }

  function selectedLine() {
    return lines.find((line) => line.id === selectedLineId) || null;
  }
  function selectedEdit() {
    return edits.find((edit) => edit.id === selectedEditId) || null;
  }
  function replacementForLine(lineId) {
    return edits.find((edit) => edit.page === page && edit.line_id === lineId && edit.kind === "replace") || null;
  }

  function paintTool() {
    const canvas = editContent.querySelector("#pdfCanvas");
    if (canvas) {
      canvas.classList.remove("tool-select", "tool-add", "tool-whiteout", "tool-highlight");
      canvas.classList.add(`tool-${tool}`);
    }
    editContent.querySelectorAll("[data-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === tool);
    });
  }

  function setTool(next, options = {}) {
    if (!["select", "add", "whiteout", "highlight"].includes(next)) return;
    if (!options.keepPending) {
      pendingRect = null;
      hideDrawBox();
    }
    tool = next;
    if (next !== "select") {
      selectedLineId = null;
      selectedEditId = null;
    }
    paintTool();
    if (!options.keepPending) renderInspector();
    renderOverlays();
  }

  function hideDrawBox() {
    const box = editContent.querySelector("#drawBox");
    if (box) box.hidden = true;
  }

  function showDrawBox(rect) {
    const box = editContent.querySelector("#drawBox");
    if (!box) return;
    box.hidden = false;
    box.style.cssText = rectStyle(rect);
  }

  function getCanvasRect() {
    const canvas = editContent.querySelector("#pdfCanvas");
    return canvas?.getBoundingClientRect() || null;
  }

  function pointToPage(clientX, clientY, bounds) {
    const width = pageInfo?.width || currentPageMeta()?.width || 595;
    const height = pageInfo?.height || currentPageMeta()?.height || 842;
    const x = Math.max(0, Math.min(width, ((clientX - bounds.left) / bounds.width) * width));
    const y = Math.max(0, Math.min(height, ((clientY - bounds.top) / bounds.height) * height));
    return [x, y];
  }

  function roundedRect(start, end) {
    const width = pageInfo?.width || 595;
    const height = pageInfo?.height || 842;
    let x0 = Math.min(start[0], end[0]);
    let y0 = Math.min(start[1], end[1]);
    let x1 = Math.max(start[0], end[0]);
    let y1 = Math.max(start[1], end[1]);
    if (x1 - x0 < 3 || y1 - y0 < 2) return null;
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(width, x1);
    y1 = Math.min(height, y1);
    return [Number(x0.toFixed(2)), Number(y0.toFixed(2)), Number(x1.toFixed(2)), Number(y1.toFixed(2))];
  }

  function renderInspector() {
    const host = editContent.querySelector("#pdfInspector");
    if (!host) return;
    const line = selectedLine();
    const edit = selectedEdit();
    const pageEdits = edits.filter((item) => item.page === page);
    let context = "";
    if (pendingRect) {
      context = `<div class="inspector-card">
        <div class="inspector-head"><h3>Add text</h3><button class="icon-btn sm" type="button" data-action="cancel-context" aria-label="Cancel">${icon("x", 13)}</button></div>
        <div class="inspector-body">
          <p class="inspector-hint">The drawn box will hold your Tamil or English text. Use a comfortable size; Chillian shrinks text if it needs to fit.</p>
          <textarea class="inspector-textarea mt-8" id="editText" placeholder="உங்கள் உரை…" autofocus></textarea>
          <div class="inspector-grid mt-8">
            <div class="inspector-field"><label for="editFontSize">Font size</label><input class="input" id="editFontSize" type="number" min="4" max="144" step="0.5" value="13"></div>
            <div class="inspector-field"><label for="editAlign">Align</label><select class="select" id="editAlign"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></div>
            <div class="inspector-field"><label for="editColor">Colour</label><input id="editColor" type="color" value="#171512"></div>
          </div>
          <div class="inspector-actions"><button class="btn btn-primary btn-sm" type="button" data-action="apply-context">${icon("text-add", 13)} Add text</button><button class="btn btn-ghost btn-sm" type="button" data-action="cancel-context">Cancel</button></div>
        </div>
      </div>`;
    } else if (line) {
      const existing = replacementForLine(line.id);
      const value = existing?.text || line.text || "";
      context = `<div class="inspector-card">
        <div class="inspector-head"><h3>${existing ? "Edit replacement" : "Replace line"}</h3><button class="icon-btn sm" type="button" data-action="cancel-context" aria-label="Cancel">${icon("x", 13)}</button></div>
        <div class="inspector-body">
          <div class="inspector-line-original">${escapeHtml(line.text)}</div>
          <textarea class="inspector-textarea mt-8" id="editText" placeholder="New text…">${escapeHtml(value)}</textarea>
          <div class="inspector-grid mt-8">
            <div class="inspector-field"><label for="editFontSize">Font size</label><input class="input" id="editFontSize" type="number" min="4" max="144" step="0.5" value="${Number(existing?.font_size || line.font_size || 12).toFixed(1)}"></div>
            <div class="inspector-field"><label for="editAlign">Align</label><select class="select" id="editAlign">
              ${["left", "center", "right"].map((align) => `<option value="${align}" ${((existing?.align || "left") === align) ? "selected" : ""}>${align[0].toUpperCase() + align.slice(1)}</option>`).join("")}
            </select></div>
            <div class="inspector-field"><label for="editColor">Colour</label><input id="editColor" type="color" value="${escapeHtml(existing?.color || line.color || "#171512")}"></div>
          </div>
          <div class="inspector-actions"><button class="btn btn-primary btn-sm" type="button" data-action="apply-context">${icon("check", 13)} ${existing ? "Update" : "Replace"}</button><button class="btn btn-ghost btn-sm" type="button" data-action="cancel-context">Cancel</button></div>
          <div class="note mt-8" style="padding:8px 9px;font-size:9.5px">${icon("info", 14)}<span>If this line extracts as gibberish, erase the area and add text instead.</span></div>
        </div>
      </div>`;
    } else if (edit) {
      const isText = edit.kind === "replace" || edit.kind === "add";
      context = `<div class="inspector-card">
        <div class="inspector-head"><h3>${edit.kind === "replace" ? "Replacement" : edit.kind === "add" ? "Added text" : edit.kind === "whiteout" ? "Erased area" : "Highlight"}</h3><button class="icon-btn sm" type="button" data-action="cancel-context" aria-label="Cancel">${icon("x", 13)}</button></div>
        <div class="inspector-body">
          ${isText ? `<textarea class="inspector-textarea" id="editText">${escapeHtml(edit.text || "")}</textarea>
          <div class="inspector-grid mt-8">
            <div class="inspector-field"><label>Font size</label><input class="input" id="editFontSize" type="number" min="4" max="144" step="0.5" value="${Number(edit.font_size || 13).toFixed(1)}"></div>
            <div class="inspector-field"><label>Align</label><select class="select" id="editAlign">${["left", "center", "right"].map((align) => `<option value="${align}" ${((edit.align || "left") === align) ? "selected" : ""}>${align[0].toUpperCase() + align.slice(1)}</option>`).join("")}</select></div>
            <div class="inspector-field"><label>Colour</label><input id="editColor" type="color" value="${escapeHtml(edit.color || "#171512")}"></div>
          </div>
          <div class="inspector-actions"><button class="btn btn-primary btn-sm" type="button" data-action="apply-context">${icon("check", 13)} Update</button><button class="btn btn-danger btn-sm" type="button" data-action="remove-edit" data-edit-id="${escapeHtml(edit.id)}">${icon("trash", 13)} Remove</button></div>`
          : `<div class="inspector-hint">This is a ${edit.kind === "whiteout" ? "white cover" : "soft yellow highlight"} over the page. It will be applied when you export.</div>
             <div class="inspector-actions"><button class="btn btn-danger btn-sm" type="button" data-action="remove-edit" data-edit-id="${escapeHtml(edit.id)}">${icon("trash", 13)} Remove</button></div>`}
        </div>
      </div>`;
    }

    host.innerHTML = `
      ${context}
      <div class="inspector-card">
        <div class="inspector-head"><h3>Edits</h3><span class="badge">${edits.length}</span></div>
        <div class="edits-list" id="editsList">
          ${edits.length ? edits.map((item) => `<div class="edit-row" data-edit-select="${escapeHtml(item.id)}" role="button" tabindex="0">
            <span class="edit-kind ${escapeHtml(item.kind)}">${icon(item.kind === "replace" ? "edit" : item.kind === "add" ? "text-add" : item.kind === "whiteout" ? "eraser" : "highlight", 11)}</span>
            <span class="edit-summary"><b>p${item.page + 1}</b> · ${escapeHtml(item.kind === "whiteout" ? "Erased area" : item.kind === "highlight" ? "Highlight" : (item.text || "").slice(0, 42) || "Text edit")}</span>
            <button class="icon-btn" type="button" data-action="remove-edit" data-edit-id="${escapeHtml(item.id)}" aria-label="Remove edit">${icon("x", 12)}</button>
          </div>`).join("") : `<div class="word-list-empty" style="padding:13px">No edits yet. Select a line or draw on the page.</div>`}
        </div>
      </div>
      <div class="export-card">
        <h3>Export PDF</h3>
        <select class="select" id="exportCompress" aria-label="Extra compression">
          <option value="none">No extra compression</option>
          <option value="balanced">Balanced after editing</option>
          <option value="smallest">Smallest after editing</option>
          <option value="text">Keep text sharp</option>
        </select>
        <button class="btn btn-green" type="button" data-action="export" ${exporting ? "disabled" : ""}>${exporting ? `<span class="spinner"></span> Exporting…` : `${icon("download", 15)} Export edited PDF`}</button>
        ${exportResult ? `<div class="export-result"><strong>Saved ${formatBytes(exportResult.size)}</strong><br>${escapeHtml(exportResult.filename)}<br><a href="${exportResult.url}" download="${escapeHtml(exportResult.filename)}" style="text-decoration:underline">Download again</a></div>` : ""}
        <p class="tiny muted mt-8">${pageEdits.length} edit${pageEdits.length === 1 ? "" : "s"} on this page · ${edits.length} total</p>
      </div>
      <div class="pdf-tips">
        <strong>Working notes</strong>
        <ul>
          <li>Select a line, then replace it in the panel.</li>
          <li>Add text, Erase and Highlight work by drawing a box on the page.</li>
          <li>Edits preview on top of the page; the original is changed only on export.</li>
        </ul>
      </div>
    `;
  }

  function addEdit(data) {
    editCounter += 1;
    const edit = { id: `e${Date.now().toString(36)}${editCounter}`, ...data };
    edits.push(edit);
    return edit;
  }

  function applyContext() {
    const text = editContent.querySelector("#editText")?.value ?? "";
    const fontSize = Number(editContent.querySelector("#editFontSize")?.value || 13);
    const color = editContent.querySelector("#editColor")?.value || "#171512";
    const align = editContent.querySelector("#editAlign")?.value || "left";
    if (pendingRect) {
      if (!text.trim()) {
        toast("Write some text before adding it to the page.", { type: "info" });
        return;
      }
      addEdit({ kind: "add", page, rect: pendingRect, text: text.trim(), font_size: Math.min(144, Math.max(4, fontSize)), color, align });
      pendingRect = null;
      hideDrawBox();
      selectedLineId = null;
      selectedEditId = null;
      tool = "select";
      paintTool();
      renderOverlays();
      renderInspector();
      return;
    }
    if (selectedLineId) {
      const line = selectedLine();
      if (!line) return;
      if (!text.trim()) {
        toast("The replacement needs some text. To simply remove it, erase the area instead.", { type: "info" });
        return;
      }
      const existing = replacementForLine(line.id);
      if (existing) {
        Object.assign(existing, { text: text.trim(), font_size: fontSize, color, align });
      } else {
        addEdit({
          kind: "replace",
          page,
          rect: [...line.bbox],
          text: text.trim(),
          font_size: Number.isFinite(fontSize) ? Math.min(144, Math.max(4, fontSize)) : line.font_size || 12,
          color,
          align,
          line_id: line.id,
        });
      }
      selectedLineId = null;
      selectedEditId = null;
      renderOverlays();
      renderInspector();
      return;
    }
    if (selectedEditId) {
      const edit = selectedEdit();
      if (!edit) return;
      if (edit.kind === "replace" || edit.kind === "add") {
        if (!text.trim()) {
          toast("This text edit cannot be empty.", { type: "info" });
          return;
        }
        Object.assign(edit, { text: text.trim(), font_size: fontSize, color, align });
      }
      selectedEditId = null;
      renderOverlays();
      renderInspector();
    }
  }

  function removeEdit(editId) {
    edits = edits.filter((edit) => edit.id !== editId);
    if (selectedEditId === editId) selectedEditId = null;
    renderOverlays();
    renderInspector();
  }

  function cancelContext() {
    pendingRect = null;
    hideDrawBox();
    selectedLineId = null;
    selectedEditId = null;
    tool = "select";
    paintTool();
    renderOverlays();
    renderInspector();
  }

  async function exportPdf() {
    if (!doc || exporting) return;
    exporting = true;
    renderInspector();
    try {
      const compress = editContent.querySelector("#exportCompress")?.value || "none";
      const { blob, headers } = await api.blob(`/api/pdf/${doc.doc_id}/export`, { edits, compress }, { timeout: 180000, signal: ctx.signal });
      if (ctx.signal.aborted) return;
      if (exportUrl) URL.revokeObjectURL(exportUrl);
      exportUrl = URL.createObjectURL(blob);
      const filename = ensurePdfExtension(headerValue(headers, "x-pdf-filename", doc.filename.replace(/\.pdf$/i, "") + "-edited.pdf"));
      exportResult = { url: exportUrl, filename, size: blob.size };
      downloadUrl(exportUrl, filename);
      toast("Edited PDF exported. Check your downloads.", { type: "success" });
    } catch (error) {
      if (!ctx.signal.aborted) toast(errorMessage(error), { type: "error", title: "Export failed" });
    } finally {
      exporting = false;
      if (!ctx.signal.aborted) renderInspector();
    }
  }

  async function closeEditor() {
    if (edits.length && !window.confirm("Close this PDF and discard your edits?")) return;
    const docId = doc?.doc_id;
    doc = null;
    edits = [];
    pageInfo = null;
    lines = [];
    selectedLineId = null;
    selectedEditId = null;
    pendingRect = null;
    exportResult = null;
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = null;
    editorMounted = false;
    renderEditIdle();
    if (docId) await deleteSession(docId);
  }

  function selectLine(lineId) {
    if (pendingRect) return;
    selectedLineId = lineId;
    selectedEditId = null;
    const existing = replacementForLine(lineId);
    if (existing) selectedEditId = null;
    renderOverlays();
    renderInspector();
  }

  function selectEdit(editId) {
    if (pendingRect) return;
    const edit = edits.find((item) => item.id === editId);
    if (!edit) return;
    if (edit.page !== page) {
      loadPage(edit.page).then(() => {
        selectedEditId = editId;
        selectedLineId = null;
        renderOverlays();
        renderInspector();
      });
      return;
    }
    selectedEditId = editId;
    selectedLineId = null;
    renderOverlays();
    renderInspector();
  }

  /* ---------------------------------------------------------- editor events */
  editContent.addEventListener("click", (event) => {
    const toolButton = event.target.closest("[data-tool]");
    if (toolButton) { setTool(toolButton.dataset.tool); return; }

    const nav = event.target.closest("[data-nav]");
    if (nav) {
      loadPage(page + (nav.dataset.nav === "next" ? 1 : -1));
      return;
    }

    const zoom = event.target.closest("[data-zoom]");
    if (zoom) {
      const before = scale;
      scale = Math.max(0.5, Math.min(2.4, scale + Number(zoom.dataset.zoom) * 0.12));
      if (scale !== before) {
        const meta = pageInfo || currentPageMeta();
        if (meta) resizeCanvas(meta.width, meta.height);
      }
      return;
    }

    const action = event.target.closest("[data-action]");
    if (action) {
      const name = action.dataset.action;
      if (name === "export") exportPdf();
      else if (name === "undo") {
        if (edits.length) { edits.pop(); if (!edits.some((edit) => edit.id === selectedEditId)) selectedEditId = null; renderOverlays(); renderInspector(); }
      } else if (name === "apply-context") applyContext();
      else if (name === "cancel-context") cancelContext();
      else if (name === "remove-edit") removeEdit(action.dataset.editId);
      else if (name === "close-doc") closeEditor();
      else if (name === "change-file") {
        if (edits.length && !window.confirm("Change the file and discard your edits?")) return;
        const docId = doc?.doc_id;
        doc = null; edits = []; renderEditIdle(); if (docId) deleteSession(docId);
      }
      return;
    }

    const editBox = event.target.closest("[data-edit-id]");
    if (editBox) { selectEdit(editBox.dataset.editId); return; }

    const lineBox = event.target.closest("[data-line-id]");
    if (lineBox) { selectLine(lineBox.dataset.lineId); return; }

    const editRow = event.target.closest("[data-edit-select]");
    if (editRow) { selectEdit(editRow.dataset.editSelect); return; }

    if (event.target.closest("#pdfPageImage") || event.target.closest("#lineLayer") || event.target.closest("#editLayer")) {
      if (tool === "select" && !pendingRect) {
        selectedLineId = null;
        selectedEditId = null;
        renderOverlays();
        renderInspector();
      }
    }
  });

  editContent.addEventListener("keydown", (event) => {
    const row = event.target.closest("[data-edit-select]");
    if (row && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      selectEdit(row.dataset.editSelect);
    }
  });

  editContent.addEventListener("pointerdown", (event) => {
    if (tool === "select") return;
    const canvas = event.target.closest("#pdfCanvas");
    if (!canvas) return;
    const bounds = getCanvasRect();
    if (!bounds) return;
    event.preventDefault();
    const start = pointToPage(event.clientX, event.clientY, bounds);
    drag = { start, bounds, pointerId: event.pointerId };
    canvas.setPointerCapture?.(event.pointerId);
    showDrawBox([start[0], start[1], start[0], start[1]]);
  });

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const end = pointToPage(event.clientX, event.clientY, drag.bounds);
    const rect = roundedRect(drag.start, end);
    if (rect) showDrawBox(rect);
  }

  function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const end = pointToPage(event.clientX, event.clientY, drag.bounds);
    const rect = roundedRect(drag.start, end);
    drag = null;
    if (!rect) { hideDrawBox(); return; }
    if (tool === "add") {
      pendingRect = rect;
      showDrawBox(rect);
      setTool("select", { keepPending: true });
      renderInspector();
      setTimeout(() => editContent.querySelector("#editText")?.focus(), 60);
    } else if (tool === "whiteout" || tool === "highlight") {
      addEdit({ kind: tool, page, rect, color: tool === "highlight" ? "#f4c95d" : "#ffffff" });
      hideDrawBox();
      setTool("select");
      toast(tool === "whiteout" ? "Area will be erased on export." : "Highlight added.", { type: "success", timeout: 2200 });
    }
  }

  function globalKeydown(event) {
    if (tab !== "edit" || !doc) return;
    const tag = document.activeElement?.tagName;
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !typing) {
      event.preventDefault();
      if (edits.length) { edits.pop(); renderOverlays(); renderInspector(); }
    }
    if (event.key === "Escape" && (pendingRect || selectedLineId || selectedEditId)) {
      event.preventDefault();
      cancelContext();
    }
  }
  document.addEventListener("keydown", globalKeydown);

  function startPing() {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (disposed) return;
      if (document.hidden || !doc) return;
      api.get(`/api/pdf/${doc.doc_id}/lines/${page}`, {}, { timeout: 12000 }).catch(() => {});
    }, 60000);
  }
  startPing();

  /* ------------------------------------------------------------------- boot */
  if (tab === "compress") renderCompressIdle();
  if (tab === "edit") renderEditIdle();
  setTab(tab);

  return () => {
    disposed = true;
    clearInterval(pingTimer);
    document.removeEventListener("keydown", globalKeydown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    const docId = doc?.doc_id;
    doc = null;
    if (docId) {
      api.delete(`/api/pdf/${docId}`).catch(() => {});
    }
    if (compressUrl) URL.revokeObjectURL(compressUrl);
    if (exportUrl) URL.revokeObjectURL(exportUrl);
  };
}
