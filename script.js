/* =========================================================
   Laporan Produksi — script.js
   Frontend Google Sheets + Google Apps Script Web App
   - login.html terpisah dari index.html
   - request tanpa custom header / JSON preflight
   - form input di atas tabel
   - pagination 20 baris per halaman
   ========================================================= */

// let currentPage = 1;
// const rowPerPage = 4;

// const passwordInput = document.getElementById("loginPassword");
// const togglePassword = document.getElementById("togglePassword");

// togglePassword.addEventListener("click", function () {
//     if (passwordInput.type === "password") {
//         passwordInput.type = "text";
//         togglePassword.textContent = "🙈";
//     } else {
//         passwordInput.type = "password";
//         togglePassword.textContent = "👁";
//     }
// })
   
(function () {
  "use strict";

  const CONFIG = {
    URL_KEY: "ppr_apps_script_url_v3",
    TOKEN_KEY: "ppr_session_token_v3",
    USER_KEY: "ppr_session_user_v3",
    MASTER_KEY: "ppr_master_cache_v3",
    PREVIEW_KEY: "ppr_preview_cache_v4",
    FORM_DRAFT_KEY: "ppr_form_draft_v4",
    REQUEST_TIMEOUT: 12000, // gagal lebih cepat jika Apps Script tidak merespons
    PAGE_SIZE: 20,

    // Ganti dengan URL deployment Web App terbaru yang berakhir /exec.
    WEB_APP_URL: "https://script.google.com/macros/s/AKfycbwhPdhaZ2Q1VrkasN_e0EXARua3uVIBcltKcq3l8E87c59QQMXvmxSThmtPjy1_mvGq1Q/exec"
  };

  const LINE_LABEL = { filling: "Filling", press: "Press" };
  const pageType = document.body.dataset.page || "app";

  const state = {
    token: localStorage.getItem(CONFIG.TOKEN_KEY) || "",
    currentUser: null,
    master: { operator: [], produk: [], botol: [], botolpecah: [] },
    entries: [],
    preview: { filling: [], press: [] },
    users: [],
    search: {
      filling: { operator: "", date: "" },
      press: { operator: "", date: "" }
    },
    pages: { filling: 1, press: 1, laporan: 1 },
    lastLaporan: null
  };

  // Antrean tulis: UI tetap instan, request Spreadsheet dikirim satu per satu
  // agar input cepat berulang tidak saling berebut LockService di Apps Script.
  let writeQueue = Promise.resolve();

  function enqueueWrite(task) {
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => {});
    return run;
  }

  function makeClientRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `client-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function el(id) { return document.getElementById(id); }
  function qs(selector, root = document) { return root.querySelector(selector); }
  function qsa(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }

  /* ------------------------- LOCAL DRAFT / PREVIEW CACHE ------------------------- */
  function storageOwner() {
    const user = state.currentUser;
    if (user && user.username) return String(user.username).trim().toLowerCase();
    try {
      const cached = JSON.parse(localStorage.getItem(CONFIG.USER_KEY) || "null");
      if (cached && cached.username) return String(cached.username).trim().toLowerCase();
    } catch (_) {}
    return "anonymous";
  }

  function userStorageKey(baseKey) {
    return `${baseKey}:${storageOwner()}`;
  }

  function persistPreview() {
    try {
      localStorage.setItem(userStorageKey(CONFIG.PREVIEW_KEY), JSON.stringify(state.preview));
    } catch (err) {
      console.warn("Gagal menyimpan preview lokal:", err);
    }
  }

  function loadPersistedPreview() {
    try {
      const raw = localStorage.getItem(userStorageKey(CONFIG.PREVIEW_KEY));
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return;
      state.preview = {
        filling: Array.isArray(saved.filling) ? saved.filling : [],
        press: Array.isArray(saved.press) ? saved.press : []
      };
    } catch (err) {
      console.warn("Preview lokal tidak dapat dibaca:", err);
    }
  }

  function getFormDrafts() {
    try {
      const raw = localStorage.getItem(userStorageKey(CONFIG.FORM_DRAFT_KEY));
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveFormDraft(line, form) {
    if (!form) return;
    try {
      const drafts = getFormDrafts();
      drafts[line] = {
        operator: qs(".f-operator", form)?.value || "",
        produk: qs(".f-produk", form)?.value || "",
        botol: qs(".f-botol", form)?.value || "",
        qtyKardus: qs(".f-qty-kardus", form)?.value || "",
        qtyBotolPerKardus: qs(".f-qty-botol", form)?.value || "",
        qtyBotolPecah: qs(".f-qty-pecah", form)?.value || "0",
        editingId: qs(".f-editing-id", form)?.value || "",
        savedAt: nowIso()
      };
      localStorage.setItem(userStorageKey(CONFIG.FORM_DRAFT_KEY), JSON.stringify(drafts));
    } catch (err) {
      console.warn("Gagal menyimpan draft form:", err);
    }
  }

  function clearFormDraft(line) {
    try {
      const drafts = getFormDrafts();
      delete drafts[line];
      localStorage.setItem(userStorageKey(CONFIG.FORM_DRAFT_KEY), JSON.stringify(drafts));
    } catch (_) {}
  }

  function restoreFormDraft(line) {
    const section = el("view-" + line);
    const form = section ? qs(".form-panel", section) : null;
    if (!form) return;
    const draft = getFormDrafts()[line];
    if (!draft) return;

    const operator = qs(".f-operator", form);
    const produk = qs(".f-produk", form);
    const botol = qs(".f-botol", form);
    const qtyKardus = qs(".f-qty-kardus", form);
    const qtyBotol = qs(".f-qty-botol", form);
    const qtyPecah = qs(".f-qty-pecah", form);
    const botolPecah = qs(".f-botol-pecah", form);
    const total = qs(".f-total", form);
    const editing = qs(".f-editing-id", form);
    const submitBtn = qs(".f-submit-btn", form);
    const cancelBtn = qs(".f-cancel-btn", form);
    const stamp = qs(".stamp", form);

    if (operator && isMasterValue("operator", draft.operator)) operator.value = canonicalMasterValue("operator", draft.operator);
    if (produk && isMasterValue("produk", draft.produk)) produk.value = canonicalMasterValue("produk", draft.produk);
    if (botol && isMasterValue("botol", draft.botol)) botol.value = canonicalMasterValue("botol", draft.botol);
    if (qtyKardus) qtyKardus.value = draft.qtyKardus ?? "";
    if (qtyBotol) qtyBotol.value = draft.qtyBotolPerKardus ?? "";
    if (qtyPecah) qtyPecah.value = draft.qtyBotolPecah ?? "0";
    if (botolPecah) botolPecah.value = (botol && botol.value) || "-";
    if (total) total.value = ((Number(qtyKardus?.value) || 0) * (Number(qtyBotol?.value) || 0)).toLocaleString("id-ID");

    // Jika sebelumnya sedang edit preview, pulihkan mode edit hanya bila item masih ada.
    const editId = draft.editingId || "";
    const editExists = editId && (state.preview[line] || []).some(item => item.id === editId);
    if (editing) editing.value = editExists ? editId : "";
    if (editExists) {
      if (submitBtn) submitBtn.textContent = "Simpan Perubahan";
      if (cancelBtn) cancelBtn.hidden = false;
      if (stamp) stamp.textContent = "EDIT PREVIEW";
    }
  }

  function normalizeWebAppUrl(value) {
    return String(value || "").trim().replace(/\/$/, "");
  }

  function isValidWebAppUrl(url) {
    return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/i.test(url);
  }

  function getWebhookUrl() {
    return normalizeWebAppUrl(localStorage.getItem(CONFIG.URL_KEY) || CONFIG.WEB_APP_URL || "");
  }

  function setWebhookUrl(url) {
    const clean = normalizeWebAppUrl(url);
    if (!isValidWebAppUrl(clean)) {
      throw new Error("URL tidak valid. Gunakan URL Web App Apps Script yang berakhir /exec.");
    }
    localStorage.setItem(CONFIG.URL_KEY, clean);
    setConnection("idle", "URL Apps Script tersimpan");
    return clean;
  }

  function clearWebhookUrl() {
    localStorage.removeItem(CONFIG.URL_KEY);
  }

  function requireWebhookUrl() {
    const url = getWebhookUrl();
    if (!url || !isValidWebAppUrl(url)) {
      throw new Error("URL Apps Script belum benar. Tempel URL deployment Web App /exec pada CONFIG.WEB_APP_URL.");
    }
    return url;
  }

  async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function parseApiResponse(response) {
    const text = await response.text();
    const trimmed = text.trim();

    if (!response.ok) {
      throw new Error(`Server mengembalikan HTTP ${response.status}.`);
    }
    if (!trimmed) {
      throw new Error("Apps Script tidak mengembalikan data.");
    }
    if (/^<!doctype html/i.test(trimmed) || /^<html/i.test(trimmed) || /accounts\.google\.com/i.test(trimmed)) {
      throw new Error("Apps Script mengembalikan halaman Google, bukan JSON. Deploy sebagai Web App: Execute as = Me dan akses = Anyone.");
    }

    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (_) {
      throw new Error("Respons Apps Script bukan JSON valid. Pastikan Code.gs dan deployment sudah diperbarui.");
    }

    if (!data || data.ok !== true) {
      throw new Error((data && data.message) || "Permintaan ke Apps Script gagal.");
    }
    return data;
  }

  function normalizeApiError(err) {
    if (err && err.name === "AbortError") {
      return new Error("Koneksi ke Apps Script terlalu lama. Periksa internet dan deployment Web App.");
    }
    const msg = err && err.message ? err.message : String(err || "Terjadi kesalahan.");
    if (/Failed to fetch|NetworkError|Load failed|CORS/i.test(msg)) {
      return new Error("Tidak dapat menghubungi Apps Script. Gunakan URL /exec terbaru, deploy dengan akses Anyone, dan jangan memakai request JSON/custom header.");
    }
    return err instanceof Error ? err : new Error(msg);
  }

  function setConnection(mode, text) {
    const status = el("connectionStatus");
    const label = el("connectionText");
    const loginLabel = el("loginConnectionText");
    if (status) status.dataset.state = mode;
    if (label) label.textContent = text;
    if (loginLabel) loginLabel.textContent = text;
  }

  async function apiGet(action, params = {}, withToken = true) {
    const base = requireWebhookUrl();
    const query = new URLSearchParams();
    query.set("action", action);
    query.set("_ts", String(Date.now()));
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) query.set(key, String(value));
    });
    if (withToken && state.token) query.set("token", state.token);

    setConnection("loading", "Menghubungkan…");
    try {
      const response = await fetchWithTimeout(`${base}?${query.toString()}`, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        redirect: "follow",
        credentials: "omit"
      });
      const data = await parseApiResponse(response);
      setConnection("online", "Spreadsheet terhubung");
      return data;
    } catch (err) {
      setConnection("error", "Koneksi gagal");
      throw normalizeApiError(err);
    }
  }

  async function apiPost(action, payload = {}, withToken = true) {
    const base = requireWebhookUrl();

    // URLSearchParams menghasilkan application/x-www-form-urlencoded,
    // termasuk CORS-safelisted request sehingga tidak memicu preflight JSON.
    const body = new URLSearchParams();
    body.set("action", action);
    if (withToken && state.token) body.set("token", state.token);
    Object.entries(payload).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    });

    setConnection("loading", action === "login" ? "Memeriksa login…" : "Menyimpan cepat…");
    try {
      const response = await fetchWithTimeout(base, {
        method: "POST",
        mode: "cors",
        body,
        cache: "no-store",
        redirect: "follow",
        credentials: "omit"
      });
      const data = await parseApiResponse(response);
      setConnection("online", "Spreadsheet terhubung");
      return data;
    } catch (err) {
      setConnection("error", "Koneksi gagal");
      throw normalizeApiError(err);
    }
  }

  window.SheetsIntegration = {
    setWebhookUrl,
    getWebhookUrl,
    clearWebhookUrl,
    testConnection: () => apiGet("ping", {}, false)
  };

  function todayStr() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function nowIso() { return new Date().toISOString(); }

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString("id-ID", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function toCSV(headers, rows) {
    const quote = value => {
      const text = String(value == null ? "" : value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [headers.map(quote).join(","), ...rows.map(row => row.map(quote).join(","))].join("\n");
  }

  function downloadText(filename, text) {
    const blob = new Blob(["\uFEFF", text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function genLaporanId() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `LAP-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  let toastEl = null;
  let toastTimer = null;
  function toast(message, isError = false) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.className = isError ? "err show" : "show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = ""; }, 3500);
  }

  function pageNumbers(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const values = [1];
    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);
    if (start > 2) values.push("…");
    for (let i = start; i <= end; i++) values.push(i);
    if (end < total - 1) values.push("…");
    values.push(total);
    return values;
  }

  function renderPagination(container, current, total, onChange) {
    if (!container) return;
    if (total <= 1) {
      container.innerHTML = "";
      return;
    }

    const prev = `<button type="button" class="page-btn" data-page="${current - 1}" ${current <= 1 ? "disabled" : ""}>‹</button>`;
    const numbers = pageNumbers(current, total).map(item => {
      if (item === "…") return '<span class="page-ellipsis">…</span>';
      return `<button type="button" class="page-btn ${item === current ? "active" : ""}" data-page="${item}">${item}</button>`;
    }).join("");
    const next = `<button type="button" class="page-btn" data-page="${current + 1}" ${current >= total ? "disabled" : ""}>›</button>`;
    container.innerHTML = prev + numbers + next;

    container.onclick = event => {
      const btn = event.target.closest("button[data-page]");
      if (!btn || btn.disabled) return;
      const target = Number(btn.dataset.page);
      if (target >= 1 && target <= total && target !== current) onChange(target);
    };
  }

  /* ------------------------- LOGIN PAGE ------------------------- */
  async function initLoginPage() {
    const form = el("loginForm");
    if (!form) return;

    // Jangan menunggu ping/bootstrap di halaman login.
    // Jika token ada, aplikasi utama yang memvalidasi sesi.
    if (state.token) {
      window.location.replace("index.html");
      return;
    }

    setConnection("idle", "Siap untuk login");

    // Event login dipasang langsung saat DOM/script siap.
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const errorEl = el("loginError");
      const submit = el("loginSubmit");
      errorEl.hidden = true;
      submit.disabled = true;
      submit.textContent = "Masuk…";

      try {
        const data = await apiPost("login", {
          username: el("loginUsername").value.trim(),
          password: el("loginPassword").value
        }, false);

        state.token = data.token;
        state.currentUser = data.user || null;
        localStorage.setItem(CONFIG.TOKEN_KEY, state.token);
        if (data.user) {
          localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(data.user));
        }

        // Begitu kredensial terkonfirmasi, langsung pindah.
        window.location.replace("index.html");
      } catch (err) {
        state.token = "";
        state.currentUser = null;
        localStorage.removeItem(CONFIG.TOKEN_KEY);
        localStorage.removeItem(CONFIG.USER_KEY);
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submit.disabled = false;
        submit.textContent = "Masuk";
      }
    });
  }

  /* ------------------------- APP COMMON ------------------------- */
  function buildPressView() {
    const filling = el("view-filling");
    const oldPress = el("view-press");
    if (!filling || !oldPress) return;

    const clone = filling.cloneNode(true);
    qsa("[id]", clone).forEach(node => node.removeAttribute("id"));
    clone.id = "view-press";
    clone.dataset.line = "press";
    clone.hidden = true;
    qsa("[data-line]", clone).forEach(node => { node.dataset.line = "press"; });
    qsa("h2", clone).forEach(h => { h.textContent = h.textContent.replace(/Filling/g, "Press"); });

    const stack = qs(".line-stack", clone);
    const form = qs(".form-panel", clone);
    if (stack && form) {
      const balancePanel = document.createElement("section");
      balancePanel.className = "panel table-panel press-balance-panel";
      balancePanel.innerHTML = `
        <div class="panel-head">
          <div>
            <p class="eyebrow">Balance Filling → Press</p>
            <h2>Sisa Pengerjaan yang Menunggu Press</h2>
            <p class="press-balance-note">Saldo dihitung dari seluruh tanggal: Total Filling tersimpan − Total Press tersimpan − preview Press.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Produk</th><th>Botol</th><th>Total Filling</th><th>Press Tersimpan</th>
                <th>Preview Press</th><th>Sisa Qty</th><th>Aksi</th>
              </tr>
            </thead>
            <tbody class="press-balance-tbody">
              <tr><td colspan="7" class="empty-row">Memuat saldo Filling…</td></tr>
            </tbody>
          </table>
        </div>
        <div class="table-footer"><p class="table-summary press-balance-summary"></p></div>`;
      stack.insertBefore(balancePanel, form);

      const hint = document.createElement("p");
      hint.className = "press-available-hint";
      hint.dataset.state = "empty";
      hint.textContent = "Pilih Produk dan Botol dari data master untuk melihat sisa Qty Filling.";
      const error = qs(".f-error", form);
      if (error) error.insertAdjacentElement("beforebegin", hint);
      else form.appendChild(hint);
    }

    clone.addEventListener("click", event => {
      const btn = event.target.closest(".press-balance-use");
      if (!btn) return;
      const pressForm = qs(".form-panel", clone);
      if (!pressForm) return;
      const produk = qs(".f-produk", pressForm);
      const botol = qs(".f-botol", pressForm);
      if (produk) produk.value = btn.dataset.produk || "";
      if (botol) botol.value = btn.dataset.botol || "";
      if (botol) botol.dispatchEvent(new Event("change", { bubbles: true }));
      if (produk) produk.dispatchEvent(new Event("change", { bubbles: true }));
      updatePressAvailabilityHint(pressForm);
      saveFormDraft("press", pressForm);
      pressForm.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    oldPress.replaceWith(clone);
    initMasterSearches(clone);
  }

  function applyBootstrap(data) {
    if (data.user) state.currentUser = data.user;
    if (data.master) {
      state.master = data.master;
      try { localStorage.setItem(CONFIG.MASTER_KEY, JSON.stringify(data.master)); } catch (_) {}
    }
    if (Array.isArray(data.entries)) state.entries = data.entries;
    if (Array.isArray(data.users)) state.users = data.users;

    refreshAllDropdowns();
    loadPersistedPreview();
    restoreFormDraft("filling");
    restoreFormDraft("press");
    renderPreview("filling");
    renderPreview("press");
    renderPressBalance();
    renderMasterChips();
    renderUsers();
    renderUserHeader();
  }

  async function loadBootstrap() {
    const data = await apiGet("bootstrap");
    applyBootstrap(data);
    return data;
  }

  async function loadAppData() {
    const data = await apiGet("appdata");
    applyBootstrap(data);
    return data;
  }

  function fillSelect(select, list, placeholder) {
    if (!select) return;
    const current = select.value;
    const unique = [...new Set((list || []).map(v => String(v).trim()).filter(Boolean))];
    select.innerHTML = `<option value="">${esc(placeholder)}</option>` + unique.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
    if (unique.includes(current)) select.value = current;
  }


  function masterValues(category) {
    return [...new Set((state.master[category] || [])
      .map(value => String(value || "").trim())
      .filter(Boolean))];
  }

  function canonicalMasterValue(category, value) {
    const target = String(value || "").trim().toLowerCase();
    if (!target) return "";
    return masterValues(category).find(item => item.toLowerCase() === target) || "";
  }

  function isMasterValue(category, value) {
    return Boolean(canonicalMasterValue(category, value));
  }

  function validateMasterInput(input, allowPartial = false) {
    if (!input || !input.dataset.master) return true;
    const value = String(input.value || "").trim();

    // Filter operator boleh kosong/partial karena fungsinya memang mencari.
    if (allowPartial || input.classList.contains("filter-master-search")) {
      input.setCustomValidity("");
      input.classList.remove("is-invalid");
      return true;
    }

    if (!value) {
      input.setCustomValidity("Field ini wajib dipilih dari data master.");
      input.classList.add("is-invalid");
      return false;
    }

    const canonical = canonicalMasterValue(input.dataset.master, value);
    if (!canonical) {
      input.setCustomValidity("Pilih nilai yang tersedia pada data master.");
      input.classList.add("is-invalid");
      return false;
    }

    input.value = canonical;
    input.setCustomValidity("");
    input.classList.remove("is-invalid");
    return true;
  }

  function closeMasterSuggestions(exceptInput = null) {
    qsa(".master-suggest").forEach(list => {
      if (!exceptInput || list._ownerInput !== exceptInput) list.hidden = true;
    });
  }

  function attachMasterSearch(input) {
    if (!input || input.dataset.masterSearchReady === "1") return;
    input.dataset.masterSearchReady = "1";

    const field = input.closest(".field") || input.parentElement;
    if (!field) return;

    const list = document.createElement("div");
    list.className = "master-suggest";
    list.hidden = true;
    list._ownerInput = input;
    field.appendChild(list);

    function renderList() {
      const query = String(input.value || "").trim().toLowerCase();
      const values = masterValues(input.dataset.master)
        .filter(value => !query || value.toLowerCase().includes(query))
        .slice(0, 50);

      if (!values.length) {
        list.innerHTML = '<div class="master-suggest-empty">Tidak ada data master yang cocok.</div>';
      } else {
        list.innerHTML = values.map(value =>
          `<button type="button" data-value="${esc(value)}">${esc(value)}</button>`
        ).join("");
      }
      list.hidden = false;
    }

    input.addEventListener("focus", renderList);
    input.addEventListener("input", () => {
      if (!input.classList.contains("filter-master-search")) {
        input.setCustomValidity("");
        input.classList.remove("is-invalid");
      }
      renderList();
    });
    input.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        list.hidden = true;
        input.blur();
      } else if (event.key === "ArrowDown" && !list.hidden) {
        event.preventDefault();
        const first = list.querySelector("button");
        if (first) first.focus();
      }
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        list.hidden = true;
        validateMasterInput(input);
      }, 120);
    });

    list.addEventListener("keydown", event => {
      const buttons = qsa("button", list);
      const index = buttons.indexOf(document.activeElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        (buttons[index + 1] || buttons[0])?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (index <= 0) input.focus();
        else buttons[index - 1]?.focus();
      } else if (event.key === "Escape") {
        list.hidden = true;
        input.focus();
      }
    });

    list.addEventListener("mousedown", event => {
      const btn = event.target.closest("button[data-value]");
      if (!btn) return;
      event.preventDefault();
      input.value = btn.dataset.value;
      input.setCustomValidity("");
      input.classList.remove("is-invalid");
      list.hidden = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
    });
  }

  function initMasterSearches(root = document) {
    qsa(".master-search-input", root).forEach(attachMasterSearch);
  }

  function refreshAllDropdowns() {
    // Form Filling/Press memakai autocomplete custom. Data suggestion dibaca
    // langsung dari state.master sehingga tidak perlu membuat <option>.
    initMasterSearches();

    // Filter laporan tetap select karena tidak diminta diubah.
    fillSelect(el("lap-operator"), state.master.operator, "Semua operator");

    // Setelah master diperbarui, validasi ulang input form yang sudah terisi.
    qsa(".master-search-input:not(.filter-master-search)").forEach(input => {
      if (input.value) validateMasterInput(input);
    });
  }

  function renderUserHeader() {
    const user = state.currentUser;
    if (!user) return;
    const avatar = el("userAvatar");
    if (avatar) avatar.textContent = (user.name || user.username || "U").trim().charAt(0).toUpperCase();
    if (el("userName")) el("userName").textContent = user.name || user.username;
    if (el("userRole")) el("userRole").textContent = user.role === "superuser" ? "Super User" : "User Biasa";
    if (el("masterTabBtn")) el("masterTabBtn").hidden = user.role !== "superuser";
    if (el("deviceDateDisplay")) {
      el("deviceDateDisplay").textContent = new Date().toLocaleDateString("id-ID", {
        weekday: "long", day: "2-digit", month: "long", year: "numeric"
      });
    }
  }

  function filteredEntries(line) {
    const filter = state.search[line];
    return state.entries
      .filter(e => e.tab === line)
      .filter(e => !filter.operator || String(e.operator || "").toLowerCase().includes(String(filter.operator).toLowerCase()))
      .filter(e => !filter.date || e.tanggal === filter.date)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  function filteredPreviewEntries(line) {
    const filter = state.search[line];
    const rows = state.preview && state.preview[line] ? state.preview[line] : [];
    return rows
      .filter(e => !filter.operator || String(e.operator || "").toLowerCase().includes(String(filter.operator).toLowerCase()))
      .filter(e => !filter.date || e.tanggal === filter.date)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  function upsertEntry(entry) {
    if (!entry || !entry.id) return;
    const index = state.entries.findIndex(x => x.id === entry.id);
    if (index >= 0) state.entries[index] = entry;
    else state.entries.push(entry);
  }


  function balanceKey(produk, botol) {
    return `${String(produk || "").trim().toLowerCase()}||${String(botol || "").trim().toLowerCase()}`;
  }

  function getPressBalanceRows(options = {}) {
    const excludePreviewId = options.excludePreviewId || "";
    const map = new Map();

    function ensure(produk, botol) {
      const key = balanceKey(produk, botol);
      if (!map.has(key)) {
        map.set(key, {
          key,
          produk: String(produk || "").trim(),
          botol: String(botol || "").trim(),
          fillingTotal: 0,
          pressSaved: 0,
          pressPreview: 0,
          remaining: 0
        });
      }
      return map.get(key);
    }

    state.entries
      .filter(entry => !entry._syncState)
      .forEach(entry => {
        const row = ensure(entry.produk, entry.botol);
        if (entry.tab === "filling") row.fillingTotal += Number(entry.totalQty) || 0;
        if (entry.tab === "press") row.pressSaved += Number(entry.totalQty) || 0;
      });

    (state.preview.press || []).forEach(entry => {
      if (entry.id === excludePreviewId) return;
      const row = ensure(entry.produk, entry.botol);
      row.pressPreview += Number(entry.totalQty) || 0;
    });

    return Array.from(map.values()).map(row => ({
      ...row,
      remaining: row.fillingTotal - row.pressSaved - row.pressPreview
    })).sort((a, b) => {
      if (a.remaining !== b.remaining) return b.remaining - a.remaining;
      return a.produk.localeCompare(b.produk, "id");
    });
  }

  function getPressAvailable(produk, botol, excludePreviewId = "") {
    const key = balanceKey(produk, botol);
    const row = getPressBalanceRows({ excludePreviewId }).find(item => item.key === key);
    return row ? row.remaining : 0;
  }

  function renderPressBalance() {
    const section = el("view-press");
    if (!section) return;
    const tbody = qs(".press-balance-tbody", section);
    const summary = qs(".press-balance-summary", section);
    if (!tbody) return;

    const allRows = getPressBalanceRows();
    const rows = allRows.filter(row => row.remaining > 0);
    tbody.innerHTML = rows.length ? rows.map(row => `
      <tr>
        <td>${esc(row.produk)}</td>
        <td>${esc(row.botol)}</td>
        <td>${row.fillingTotal.toLocaleString("id-ID")}</td>
        <td>${row.pressSaved.toLocaleString("id-ID")}</td>
        <td>${row.pressPreview.toLocaleString("id-ID")}</td>
        <td><strong>${row.remaining.toLocaleString("id-ID")}</strong></td>
        <td><button type="button" class="btn btn-ghost press-balance-use"
          data-produk="${esc(row.produk)}" data-botol="${esc(row.botol)}">Gunakan</button></td>
      </tr>`).join("")
      : '<tr><td colspan="7" class="empty-row">Tidak ada sisa pekerjaan Filling yang menunggu Press.</td></tr>';

    const remainingTotal = rows.reduce((sum, row) => sum + row.remaining, 0);
    if (summary) {
      summary.textContent = `${rows.length} kombinasi Produk/Botol belum balance · Sisa ${remainingTotal.toLocaleString("id-ID")} botol`;
    }

    const form = qs(".form-panel", section);
    updatePressAvailabilityHint(form);
  }

  function updatePressAvailabilityHint(form) {
    if (!form || form.dataset.line !== "press") return;
    const produk = qs(".f-produk", form)?.value || "";
    const botol = qs(".f-botol", form)?.value || "";
    const editingId = qs(".f-editing-id", form)?.value || "";
    const hint = qs(".press-available-hint", form);
    if (!hint) return;

    if (!isMasterValue("produk", produk) || !isMasterValue("botol", botol)) {
      hint.dataset.state = "empty";
      hint.textContent = "Pilih Produk dan Botol dari data master untuk melihat sisa Qty Filling.";
      return;
    }

    const available = getPressAvailable(produk, botol, editingId);
    hint.dataset.state = available > 0 ? "ok" : "empty";
    hint.textContent = available > 0
      ? `Sisa Qty Filling yang tersedia untuk Press: ${available.toLocaleString("id-ID")} botol.`
      : "Produk/Botol ini sudah balance atau belum memiliki Qty Filling tersimpan.";
  }

  function validatePressPayload(payload, editingId = "") {
    if (payload.line !== "press") return "";
    const requested = (Number(payload.qtyKardus) || 0) * (Number(payload.qtyBotolPerKardus) || 0);
    const available = getPressAvailable(payload.produk, payload.botol, editingId);
    if (requested > available) {
      return `Qty Press ${requested.toLocaleString("id-ID")} botol melebihi sisa Filling ${Math.max(0, available).toLocaleString("id-ID")} botol untuk ${payload.produk} / ${payload.botol}.`;
    }
    if (requested <= 0) return "Total Qty Press harus lebih dari 0 botol.";
    return "";
  }

  function renderEntryRow(entry) {
    const syncState = entry._syncState || "";
    const isPending = syncState === "pending";
    const isError = syncState === "error";
    const canEdit = !syncState && state.currentUser && (state.currentUser.role === "superuser" || entry.createdBy === state.currentUser.username);
    const canDelete = !syncState && state.currentUser && state.currentUser.role === "superuser";

    let idCell = `<span class="id-badge">${esc(entry.reportId)}</span>`;
    if (isPending) {
      idCell = '<span class="sync-badge pending"><span class="sync-spinner"></span>Menyimpan…</span>';
    } else if (isError) {
      idCell = '<span class="sync-badge error">Gagal disimpan</span>';
    }

    return `
      <tr class="${isPending ? "pending-row" : isError ? "sync-error-row" : ""}">
        <td>${idCell}</td>
        <td>${esc(entry.tanggal)}</td>
        <td>${esc(entry.operator)}</td>
        <td>${esc(entry.produk)}</td>
        <td>${esc(entry.botol)}</td>
        <td>${Number(entry.qtyKardus) || 0}</td>
        <td>${Number(entry.qtyBotolPerKardus) || 0}</td>
        <td><strong>${Number(entry.totalQty) || 0}</strong></td>
        <td>${esc(entry.botolPecahJenis || "—")}</td>
        <td class="${Number(entry.qtyBotolPecah) > 0 ? "pecah-tag" : ""}">${Number(entry.qtyBotolPecah) || 0}</td>
        <td class="row-actions">
          ${isPending ? '<span class="sync-note">Diproses</span>' : ""}
          ${isError ? `<button type="button" class="btn btn-secondary btn-retry" data-id="${esc(entry.id)}">Coba Lagi</button>` : ""}
          ${canEdit ? `<button type="button" class="btn btn-ghost btn-edit" data-id="${esc(entry.id)}">Update</button>` : ""}
          ${canDelete ? `<button type="button" class="btn btn-danger btn-delete" data-id="${esc(entry.id)}">Hapus</button>` : ""}
        </td>
      </tr>`;
  }

  function renderEntries(line) {
    const section = el("view-" + line);
    if (!section) return;
    const tbody = qs(".f-tbody", section);
    const summary = qs(".f-summary", section);
    const pagination = qs(".f-pagination", section);
    const rows = filteredEntries(line);

    const totalPages = Math.max(1, Math.ceil(rows.length / CONFIG.PAGE_SIZE));
    state.pages[line] = Math.min(Math.max(1, state.pages[line]), totalPages);
    const page = state.pages[line];
    const start = (page - 1) * CONFIG.PAGE_SIZE;
    const visibleRows = rows.slice(start, start + CONFIG.PAGE_SIZE);

    tbody.innerHTML = visibleRows.length
      ? visibleRows.map(renderEntryRow).join("")
      : '<tr><td colspan="11" class="empty-row">Belum ada data.</td></tr>';

    const totalQty = rows.reduce((sum, e) => sum + (Number(e.totalQty) || 0), 0);
    const totalPecah = rows.reduce((sum, e) => sum + (Number(e.qtyBotolPecah) || 0), 0);
    const from = rows.length ? start + 1 : 0;
    const to = Math.min(start + CONFIG.PAGE_SIZE, rows.length);
    const pendingCount = rows.filter(e => e._syncState === "pending").length;
    const errorCount = rows.filter(e => e._syncState === "error").length;
    const syncInfo = [
      pendingCount ? `${pendingCount} sedang disimpan` : "",
      errorCount ? `${errorCount} gagal` : ""
    ].filter(Boolean).join(" · ");
    summary.textContent = `${from}–${to} dari ${rows.length} entri · Total Qty Botol: ${totalQty.toLocaleString("id-ID")} · Total Botol Pecah: ${totalPecah.toLocaleString("id-ID")}${syncInfo ? ` · ${syncInfo}` : ""}`;

    renderPagination(pagination, page, totalPages, nextPage => {
      state.pages[line] = nextPage;
      renderEntries(line);
      qs(".table-panel", section)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  

  function renderPreview(line) {
    const section = el("view-" + line);
    if (!section) return;

    const tbody = qs(".f-tbody", section);
    const summary = qs(".f-summary", section);
    const pagination = qs(".f-pagination", section);
    const saveBtn = qs(".f-save-btn", section);
    if (!tbody) return;

    const rows = filteredPreviewEntries(line);
    const totalPages = Math.max(1, Math.ceil(rows.length / CONFIG.PAGE_SIZE));
    state.pages[line] = Math.min(Math.max(1, state.pages[line]), totalPages);
    const page = state.pages[line];
    const start = (page - 1) * CONFIG.PAGE_SIZE;
    const visibleRows = rows.slice(start, start + CONFIG.PAGE_SIZE);

    tbody.innerHTML = visibleRows.length ? visibleRows.map(entry => `
      <tr>
        <td><span class="id-badge">PREVIEW</span></td>
        <td>${esc(entry.tanggal)}</td>
        <td>${esc(entry.operator)}</td>
        <td>${esc(entry.produk)}</td>
        <td>${esc(entry.botol)}</td>
        <td>${Number(entry.qtyKardus) || 0}</td>
        <td>${Number(entry.qtyBotolPerKardus) || 0}</td>
        <td><strong>${Number(entry.totalQty) || 0}</strong></td>
        <td>${esc(entry.botolPecahJenis || "—")}</td>
        <td class="${Number(entry.qtyBotolPecah) > 0 ? "pecah-tag" : ""}">${Number(entry.qtyBotolPecah) || 0}</td>
        <td class="row-actions">
          <button type="button" class="btn btn-ghost btn-preview-edit" data-id="${esc(entry.id)}">Edit</button>
          <button type="button" class="btn btn-danger btn-preview-delete" data-id="${esc(entry.id)}">Hapus</button>
        </td>
      </tr>`).join("")
      : '<tr><td colspan="11" class="empty-row">Belum ada data yang diinput untuk preview</td></tr>';

    const totalQty = rows.reduce((sum, e) => sum + (Number(e.totalQty) || 0), 0);
    const totalPecah = rows.reduce((sum, e) => sum + (Number(e.qtyBotolPecah) || 0), 0);
    const from = rows.length ? start + 1 : 0;
    const to = Math.min(start + CONFIG.PAGE_SIZE, rows.length);
    if (summary) {
      summary.textContent = `${from}–${to} dari ${rows.length} data preview · Total Qty Botol: ${totalQty.toLocaleString("id-ID")} · Total Botol Pecah: ${totalPecah.toLocaleString("id-ID")}`;
    }

    if (saveBtn) {
      saveBtn.disabled = rows.length === 0;
      saveBtn.textContent = rows.length ? `Simpan (${rows.length})` : "Simpan";
    }

    renderPagination(pagination, page, totalPages, nextPage => {
      state.pages[line] = nextPage;
      renderPreview(line);
    });
  }

  function wireLineView(line) {
    const section = el("view-" + line);
    if (!section) return;
    const form = qs(".form-panel", section);
    if (!form) return;

    const operator = qs(".f-operator", form);
    const produk = qs(".f-produk", form);
    const botol = qs(".f-botol", form);
    const botolPecah = qs(".f-botol-pecah", form);
    const editing = qs(".f-editing-id", form);
    const tanggal = qs(".f-tanggal", form);
    const qtyKardus = qs(".f-qty-kardus", form);
    const qtyBotol = qs(".f-qty-botol", form);
    const total = qs(".f-total", form);
    const qtyPecah = qs(".f-qty-pecah", form);
    const submitBtn = qs(".f-submit-btn", form);
    const cancelBtn = qs(".f-cancel-btn", form);
    const errorEl = qs(".f-error", form);
    const stamp = qs(".stamp", form);
    tanggal.value = todayStr();

    function recalc() {
      total.value = ((Number(qtyKardus.value) || 0) * (Number(qtyBotol.value) || 0)).toLocaleString("id-ID");
      if (line === "press") updatePressAvailabilityHint(form);
    }

    function syncBotolPecah() {
      if (botolPecah) botolPecah.value = botol.value || "-";
    }

    function resetForm() {
      if (botolPecah) botolPecah.value = "-";
      form.reset();
      editing.value = "";
      tanggal.value = todayStr();
      total.value = "0";
      qtyPecah.value = "0";
      submitBtn.textContent = "+ Tambah List";
      submitBtn.disabled = false;
      cancelBtn.hidden = true;
      stamp.textContent = "ID otomatis";
      errorEl.hidden = true;
      qsa(".master-search-input", form).forEach(input => {
        input.setCustomValidity("");
        input.classList.remove("is-invalid");
      });
      clearFormDraft(line);
      if (line === "press") updatePressAvailabilityHint(form);
    }

    botol.addEventListener("change", () => {
      syncBotolPecah();
      if (line === "press") updatePressAvailabilityHint(form);
    });
    produk?.addEventListener("change", () => {
      if (line === "press") updatePressAvailabilityHint(form);
    });
    produk?.addEventListener("input", () => {
      if (line === "press") updatePressAvailabilityHint(form);
    });
    botol.addEventListener("input", () => {
      if (line === "press") updatePressAvailabilityHint(form);
    });
    qtyKardus.addEventListener("input", recalc);
    qtyBotol.addEventListener("input", recalc);
    cancelBtn.addEventListener("click", resetForm);

    // Simpan draft form setiap ada perubahan agar refresh tidak menghapus input.
    form.addEventListener("input", () => saveFormDraft(line, form));
    form.addEventListener("change", () => saveFormDraft(line, form));

    function buildOptimisticEntry(payload, clientRequestId) {
      const createdAt = nowIso();
      return {
        id: clientRequestId,
        reportId: "Menyimpan…",
        tab: line,
        tanggal: payload.tanggal,
        operator: payload.operator,
        produk: payload.produk,
        botol: payload.botol,
        qtyKardus: payload.qtyKardus,
        qtyBotolPerKardus: payload.qtyBotolPerKardus,
        totalQty: payload.qtyKardus * payload.qtyBotolPerKardus,
        botolPecahJenis: payload.botolPecahJenis || "",
        qtyBotolPecah: payload.qtyBotolPecah || 0,
        createdBy: state.currentUser ? state.currentUser.username : "",
        createdByName: state.currentUser ? (state.currentUser.name || state.currentUser.username) : "",
        createdAt,
        updatedAt: createdAt,
        _syncState: "pending",
        _syncPayload: { ...payload, clientRequestId }
      };
    }

    function queueOptimisticSave(entry) {
      entry._syncState = "pending";
      entry.reportId = "Menyimpan…";
      renderEntries(line);

      enqueueWrite(() => apiPost("entry.create", { data: entry._syncPayload }))
        .then(response => {
          // Backend memakai clientRequestId yang sama sebagai ID, sehingga retry aman
          // dan baris sementara langsung diganti oleh data resmi Spreadsheet.
          upsertEntry(response.entry);
          renderEntries(line);
          toast(`Tersimpan — ${response.entry.reportId}`);
        })
        .catch(err => {
          const current = state.entries.find(x => x.id === entry.id);
          if (current) {
            current._syncState = "error";
            current._syncError = err.message;
            current.reportId = "Gagal disimpan";
          }
          renderEntries(line);
          toast(`Gagal menyimpan: ${err.message}`, true);
        });
    }

    form.addEventListener("submit", async event => {
      event.preventDefault();
      errorEl.hidden = true;
      const payload = {
        line,
        tanggal: todayStr(),
        operator: qs(".f-operator", form).value,
        produk: qs(".f-produk", form).value,
        botol: qs(".f-botol", form).value,
        qtyKardus: Number(qtyKardus.value),
        qtyBotolPerKardus: Number(qtyBotol.value),
        botolPecahJenis: botolPecah && botolPecah.value !== "-" ? botolPecah.value : "",
        // botolPecahJenis: qs(".f-botol-pecah", form).value,
        qtyBotolPecah: Number(qtyPecah.value) || 0
      };

      const masterInputs = [operator, produk, botol];
      const masterValid = masterInputs.every(input => validateMasterInput(input));
      if (!masterValid) {
        errorEl.textContent = "Operator, Produk, dan Botol harus dipilih dari data master yang tersedia.";
        errorEl.hidden = false;
        masterInputs.find(input => !input.checkValidity())?.reportValidity();
        return;
      }

      // Gunakan penulisan canonical dari master, bukan teks bebas hasil ketikan.
      payload.operator = canonicalMasterValue("operator", operator.value);
      payload.produk = canonicalMasterValue("produk", produk.value);
      payload.botol = canonicalMasterValue("botol", botol.value);
      payload.botolPecahJenis = payload.botol;

      if (!Number.isFinite(payload.qtyKardus) || payload.qtyKardus < 0 ||
          !Number.isFinite(payload.qtyBotolPerKardus) || payload.qtyBotolPerKardus < 0 ||
          payload.qtyBotolPecah < 0) {
        errorEl.textContent = "Lengkapi Qty dengan benar.";
        errorEl.hidden = false;
        return;
      }

      const id = editing.value;
      const pressError = validatePressPayload(payload, id);
      if (pressError) {
        errorEl.textContent = pressError;
        errorEl.hidden = false;
        return;
      }

      // UPDATE data preview saja. Belum menyentuh Spreadsheet.
      if (id) {
        const index = state.preview[line].findIndex(item => item.id === id);
        if (index >= 0) {
          state.preview[line][index] = {
            ...state.preview[line][index],
            tanggal: payload.tanggal,
            operator: payload.operator,
            produk: payload.produk,
            botol: payload.botol,
            qtyKardus: payload.qtyKardus,
            qtyBotolPerKardus: payload.qtyBotolPerKardus,
            totalQty: payload.qtyKardus * payload.qtyBotolPerKardus,
            botolPecahJenis: payload.botolPecahJenis || "",
            qtyBotolPecah: payload.qtyBotolPecah || 0
          };
          state.pages[line] = 1;
          persistPreview();
          resetForm();
          renderPreview(line);
          if (line === "press") renderPressBalance();
          toast("Data preview berhasil diperbarui.");
          return;
        }
      }

      // CREATE hanya masuk ke preview lokal. Belum dikirim ke Spreadsheet.
      const previewId = makeClientRequestId();
      state.preview[line].push({
        id: previewId,
        tab: line,
        tanggal: payload.tanggal,
        operator: payload.operator,
        produk: payload.produk,
        botol: payload.botol,
        qtyKardus: payload.qtyKardus,
        qtyBotolPerKardus: payload.qtyBotolPerKardus,
        totalQty: payload.qtyKardus * payload.qtyBotolPerKardus,
        botolPecahJenis: payload.botolPecahJenis || "",
        qtyBotolPecah: payload.qtyBotolPecah || 0,
        createdAt: nowIso()
      });
      state.pages[line] = 1;
      persistPreview();
      resetForm();
      renderPreview(line);
      if (line === "press") renderPressBalance();
      toast("Data ditambahkan ke preview. Belum disimpan ke Spreadsheet.");
    });

    const searchOperator = qs(".f-search-operator", section);
    const searchDate = qs(".f-search-date", section);
    const resetSearch = qs(".f-search-reset", section);

    searchOperator.addEventListener("input", () => {
      state.search[line].operator = searchOperator.value.trim();
      state.pages[line] = 1;
      renderPreview(line);
    });
    searchOperator.addEventListener("change", () => {
      state.search[line].operator = searchOperator.value.trim();
      state.pages[line] = 1;
      renderPreview(line);
    });
    searchDate.addEventListener("change", () => {
      state.search[line].date = searchDate.value;
      state.pages[line] = 1;
      renderPreview(line);
    });
    resetSearch.addEventListener("click", () => {
      state.search[line] = { operator: "", date: "" };
      state.pages[line] = 1;
      searchOperator.value = "";
      searchDate.value = "";
      renderPreview(line);
    });

    const saveBtn = qs(".f-save-btn", section);
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        const previewRows = [...(state.preview[line] || [])];
        if (!previewRows.length) {
          toast("Belum ada data preview.", true);
          return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = "Menyimpan...";
        const failed = [];
        let successCount = 0;

        for (const item of previewRows) {
          try {
            const response = await enqueueWrite(() => apiPost("entry.create", {
              data: {
                line: item.tab,
                tanggal: item.tanggal,
                operator: item.operator,
                produk: item.produk,
                botol: item.botol,
                qtyKardus: Number(item.qtyKardus) || 0,
                qtyBotolPerKardus: Number(item.qtyBotolPerKardus) || 0,
                botolPecahJenis: item.botolPecahJenis || "",
                qtyBotolPecah: Number(item.qtyBotolPecah) || 0,
                clientRequestId: item.id
              }
            }));
            if (response.entry) upsertEntry(response.entry);
            successCount++;
          } catch (err) {
            failed.push({ ...item, _saveError: err.message });
          }
        }

        state.preview[line] = failed;
        state.pages[line] = 1;
        persistPreview();
        renderPreview(line);
        renderPressBalance();

        if (successCount) toast(`${successCount} data berhasil disimpan ke Spreadsheet.`);
        if (failed.length) toast(`${failed.length} data gagal disimpan. Silakan klik Simpan lagi.`, true);
      });
    }

    qs(".f-export-btn", section).addEventListener("click", () => {
      const rows = filteredPreviewEntries(line);
      if (!rows.length) return toast("Belum ada data preview untuk diexport.", true);
      const csv = toCSV(
        ["ID Pengerjaan", "Line", "Tanggal", "Operator", "Produk", "Botol", "Qty Kardus", "Botol/Kardus", "Total Qty", "Botol Pecah", "Qty Pecah", "Dibuat Oleh"],
        rows.map(e => [e.reportId, LINE_LABEL[e.tab], e.tanggal, e.operator, e.produk, e.botol, e.qtyKardus, e.qtyBotolPerKardus, e.totalQty, e.botolPecahJenis || "", e.qtyBotolPecah, e.createdByName || e.createdBy || "PREVIEW"])
      );
      downloadText(`laporan-${line}-${todayStr()}.csv`, csv);
    });

    qs(".f-tbody", section).addEventListener("click", event => {
      const editBtn = event.target.closest(".btn-preview-edit");
      const deleteBtn = event.target.closest(".btn-preview-delete");

      if (editBtn) {
        const entry = state.preview[line].find(x => x.id === editBtn.dataset.id);
        if (!entry) return;
        editing.value = entry.id;
        tanggal.value = entry.tanggal;
        qs(".f-operator", form).value = entry.operator;
        qs(".f-produk", form).value = entry.produk;
        qs(".f-botol", form).value = entry.botol;
        qtyKardus.value = entry.qtyKardus;
        qtyBotol.value = entry.qtyBotolPerKardus;
        if (botolPecah) botolPecah.value = entry.botolPecahJenis || entry.botol || "-";
        qtyPecah.value = entry.qtyBotolPecah || 0;
        recalc();
        submitBtn.textContent = "Simpan Perubahan";
        cancelBtn.hidden = false;
        stamp.textContent = "EDIT PREVIEW";
        saveFormDraft(line, form);
        if (line === "press") updatePressAvailabilityHint(form);
        form.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      if (deleteBtn) {
        state.preview[line] = state.preview[line].filter(x => x.id !== deleteBtn.dataset.id);
        state.pages[line] = 1;
        persistPreview();
        renderPreview(line);
        if (line === "press") renderPressBalance();
        toast("Data dihapus dari preview.");
      }
    });

  }

  function initTabs() {
    const tabbar = el("mainTabbar");
    if (!tabbar) return;
    tabbar.addEventListener("click", event => {
      const btn = event.target.closest(".tab-btn");
      if (!btn || !state.currentUser) return;
      const view = btn.dataset.view;
      if (view === "master" && state.currentUser.role !== "superuser") return;

      qsa(".tab-btn", tabbar).forEach(node => node.classList.toggle("active", node === btn));
      qsa(".content > .view").forEach(node => { node.hidden = node.id !== "view-" + view; });
    });
  }

  /* ------------------------- LAPORAN ------------------------- */
  function renderLaporanRows() {
    if (!state.lastLaporan) return;
    const rows = state.lastLaporan.rows;
    const tbody = el("lap-tbody");
    const totalPages = Math.max(1, Math.ceil(rows.length / CONFIG.PAGE_SIZE));
    state.pages.laporan = Math.min(Math.max(1, state.pages.laporan), totalPages);
    const page = state.pages.laporan;
    const start = (page - 1) * CONFIG.PAGE_SIZE;
    const visible = rows.slice(start, start + CONFIG.PAGE_SIZE);

    tbody.innerHTML = visible.map(e => `
      <tr>
        <td><span class="id-badge">${esc(e.reportId)}</span></td>
        <td>${esc(LINE_LABEL[e.tab] || e.tab)}</td>
        <td>${esc(e.tanggal)}</td>
        <td>${esc(e.operator)}</td>
        <td>${esc(e.produk)}</td>
        <td>${esc(e.botol)}</td>
        <td>${Number(e.qtyKardus) || 0}</td>
        <td><strong>${Number(e.totalQty) || 0}</strong></td>
        <td>${Number(e.qtyBotolPecah) || 0}</td>
      </tr>`).join("");

    const from = rows.length ? start + 1 : 0;
    const to = Math.min(start + CONFIG.PAGE_SIZE, rows.length);
    el("lap-page-summary").textContent = `${from}–${to} dari ${rows.length} entri · Halaman ${page} dari ${totalPages}`;
    renderPagination(el("lap-pagination"), page, totalPages, nextPage => {
      state.pages.laporan = nextPage;
      renderLaporanRows();
    });
  }

  function initLaporan() {
    const generate = el("lap-generate");
    if (!generate) return;

    generate.addEventListener("click", () => {
      const line = el("lap-line").value;
      const operator = el("lap-operator").value;
      const start = el("lap-start").value;
      const end = el("lap-end").value;
      // Laporan hanya memakai data yang sudah benar-benar dikonfirmasi Spreadsheet.
      let rows = state.entries.filter(e => !e._syncState);

      if (line !== "all") rows = rows.filter(e => e.tab === line);
      if (operator) rows = rows.filter(e => e.operator === operator);
      if (start) rows = rows.filter(e => e.tanggal >= start);
      if (end) rows = rows.filter(e => e.tanggal <= end);
      rows.sort((a, b) => String(a.tanggal).localeCompare(String(b.tanggal)));

      const result = el("lap-result");
      if (!rows.length) {
        result.hidden = true;
        toast("Tidak ada data yang cocok dengan filter laporan.", true);
        return;
      }

      const id = genLaporanId();
      state.lastLaporan = { id, rows };
      state.pages.laporan = 1;
      el("lap-id").textContent = id;
      el("lap-created").textContent = fmtDateTime(nowIso());
      el("lap-by").textContent = `${state.currentUser.name} (${state.currentUser.role === "superuser" ? "Super User" : "User"})`;
      el("lap-period").textContent = (start || end) ? `${start || "…"} s/d ${end || "…"}` : "Semua tanggal";
      el("lap-total-entries").textContent = rows.length;
      el("lap-total-kardus").textContent = rows.reduce((s, e) => s + (Number(e.qtyKardus) || 0), 0).toLocaleString("id-ID");
      el("lap-total-qty").textContent = rows.reduce((s, e) => s + (Number(e.totalQty) || 0), 0).toLocaleString("id-ID");
      el("lap-total-pecah").textContent = rows.reduce((s, e) => s + (Number(e.qtyBotolPecah) || 0), 0).toLocaleString("id-ID");
      renderLaporanRows();
      result.hidden = false;
    });

    el("lap-export")?.addEventListener("click", () => {
      if (!state.lastLaporan) return;
      const csv = toCSV(
        ["ID Laporan", "ID Pengerjaan", "Line", "Tanggal", "Operator", "Produk", "Botol", "Qty Kardus", "Total Qty", "Qty Pecah"],
        state.lastLaporan.rows.map(e => [state.lastLaporan.id, e.reportId, LINE_LABEL[e.tab], e.tanggal, e.operator, e.produk, e.botol, e.qtyKardus, e.totalQty, e.qtyBotolPecah])
      );
      downloadText(`${state.lastLaporan.id}.csv`, csv);
    });

    el("lap-print")?.addEventListener("click", () => window.print());
  }

  /* ------------------------- MASTER ------------------------- */

  /* =========================================================
   SEE MORE MASTER DATA
   Hanya untuk Operator dan Produk
   ========================================================= */
  function updateMasterSeeMore(category, wrap) {

    // Hanya Operator dan Produk yang dibatasi
    const isLimited =
      category === "operator" ||
      category === "produk";

    if (!isLimited) {
      wrap.classList.remove("limit-6", "show-all");
      return;
    }

    // Aktifkan CSS pembatas 6 item
    wrap.classList.add("limit-6");

    const parent = wrap.parentElement;
    if (!parent) return;

    // Cari tombol jika sebelumnya sudah pernah dibuat
    let button = parent.querySelector(
      `.see-more-btn[data-see-more="${category}"]`
    );

    // Kalau belum ada, buat otomatis
    if (!button) {

      button = document.createElement("button");

      button.type = "button";
      button.className = "see-more-btn";
      button.dataset.seeMore = category;

      // Letakkan setelah daftar chip
      wrap.insertAdjacentElement("afterend", button);

      button.addEventListener("click", () => {

        const isOpen = wrap.classList.toggle("show-all");

        const total = wrap.querySelectorAll(".chip").length;
        const remaining = Math.max(0, total - 6);

        button.textContent = isOpen
          ? "Sembunyikan"
          : `Lihat lainnya (${remaining})`;
      });
    }

    // Hitung jumlah data
    const total = wrap.querySelectorAll(".chip").length;

    if (total > 6) {

      button.hidden = false;

      const remaining = total - 6;

      button.textContent =
        wrap.classList.contains("show-all")
          ? "Sembunyikan"
          : `Lihat lainnya (${remaining})`;

    } else {

      // Kalau data <= 6, tombol tidak perlu ditampilkan
      wrap.classList.remove("show-all");
      button.hidden = true;
    }
  }

  function renderMasterChips() {

  ["operator", "produk", "botol", "botolpecah"].forEach(category => {

    const wrap = qs(`.chip-list[data-cat="${category}"]`);

    if (!wrap) return;

    const values = state.master[category] || [];

    wrap.innerHTML = values.length
      ? values.map(value => {

          const readonly = category === "botolpecah";

          return `
            <span class="chip">
              ${esc(value)}
              ${
                readonly
                  ? ""
                  : `
                    <button
                      type="button"
                      data-cat="${category}"
                      data-value="${esc(value)}"
                      title="Hapus"
                    >
                      ✕
                    </button>
                  `
              }
            </span>
          `;

        }).join("")

      : `
        <span style="
          color:var(--ink-faint);
          font-size:12px;
        ">
          Belum ada data.
        </span>
      `;


    /* =========================================
       UPDATE SEE MORE
       ========================================= */
    updateMasterSeeMore(category, wrap);

  });

}

  // function renderMasterChips() {
  //   ["operator", "produk", "botol", "botolpecah"].forEach(category => {
  //     const wrap = qs(`.chip-list[data-cat="${category}"]`);
  //     if (!wrap) return;
  //     const values = state.master[category] || [];
  //     wrap.innerHTML = values.length ? values.map(value => {
  //       const readonly = category === "botolpecah";
  //       return `<span class="chip">${esc(value)}${readonly ? "" : `<button type="button" data-cat="${category}" data-value="${esc(value)}" title="Hapus">✕</button>`}</span>`;
  //     }).join("") : '<span style="color:var(--ink-faint);font-size:12px">Belum ada data.</span>';
  //   });
  //     /* =========================================
  //       UPDATE SEE MORE
  //       ========================================= */
  //     updateMasterSeeMore(category, wrap);
  // }

  function initMasterData() {
    qsa(".chip-list").forEach(wrap => {
      wrap.addEventListener("click", async event => {
        const btn = event.target.closest("button[data-cat]");
        if (!btn) return;
        if (!confirm(`Hapus "${btn.dataset.value}" dari master?`)) return;
        try {
          const data = await apiPost("master.remove", { category: btn.dataset.cat, value: btn.dataset.value });
          state.master = data.master;
          renderMasterChips();
          refreshAllDropdowns();
          toast("Master data berhasil dihapus.");
        } catch (err) { toast(err.message, true); }
      });
    });

    qsa(".chip-add").forEach(wrap => {
      const category = wrap.dataset.cat;
      if (category === "botolpecah") return;
      const input = qs("input", wrap);
      const btn = qs("button", wrap);
      if (!input || !btn) return;

      async function addMaster() {
        const value = input.value.trim();
        if (!value) return;
        btn.disabled = true;
        try {
          const data = await apiPost("master.add", { category, value });
          state.master = data.master;
          input.value = "";
          renderMasterChips();
          refreshAllDropdowns();
          toast("Master data berhasil ditambahkan.");
        } catch (err) { toast(err.message, true); }
        finally { btn.disabled = false; }
      }

      btn.addEventListener("click", addMaster);
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); addMaster(); }
      });
    });

    el("masterReload")?.addEventListener("click", async event => {
      const btn = event.currentTarget;
      btn.disabled = true;
      try { await loadBootstrap(); await loadAppData(); toast("Data terbaru sudah dimuat dari Spreadsheet."); }
      catch (err) { toast(err.message, true); }
      finally { btn.disabled = false; }
    });

    el("masterCsvExport")?.addEventListener("click", () => {
      const op = state.master.operator || [];
      const produk = state.master.produk || [];
      const botol = state.master.botol || [];
      const max = Math.max(op.length, produk.length, botol.length);
      const rows = Array.from({ length: max }, (_, i) => [op[i] || "", produk[i] || "", botol[i] || ""]);
      downloadText(`master-data-${todayStr()}.csv`, toCSV(["Nama Operator", "Nama Produk", "Nama Botol"], rows));
    });
  }

  /* ------------------------- USERS ------------------------- */
  function renderUsers() {
    const tbody = el("userTbody");
    if (!tbody) return;
    if (!state.currentUser || state.currentUser.role !== "superuser") {
      tbody.innerHTML = "";
      return;
    }
    tbody.innerHTML = state.users.map(user => `
      <tr>
        <td>${esc(user.name)}</td>
        <td class="mono">${esc(user.username)}</td>
        <td><span class="role-tag ${esc(user.role)}">${user.role === "superuser" ? "Super User" : "User"}</span></td>
        <td>${user.username === state.currentUser.username ? "" : `<button type="button" class="btn btn-danger btn-del-user" data-username="${esc(user.username)}">Hapus</button>`}</td>
      </tr>`).join("");
  }

  function initUserManagement() {
    const form = el("userAddForm");
    const tbody = el("userTbody");
    if (!form || !tbody) return;

    form.addEventListener("submit", async event => {
      event.preventDefault();
      const submit = qs('button[type="submit"]', form);
      submit.disabled = true;
      try {
        const data = await apiPost("user.add", {
          name: el("newUserName").value.trim(),
          username: el("newUserUsername").value.trim(),
          password: el("newUserPassword").value,
          role: el("newUserRole").value
        });
        state.users = data.users || [];
        form.reset();
        renderUsers();
        toast("User berhasil ditambahkan.");
      } catch (err) { toast(err.message, true); }
      finally { submit.disabled = false; }
    });

    tbody.addEventListener("click", async event => {
      const btn = event.target.closest(".btn-del-user");
      if (!btn) return;
      if (!confirm(`Hapus user "${btn.dataset.username}"?`)) return;
      try {
        const data = await apiPost("user.remove", { username: btn.dataset.username });
        state.users = data.users || [];
        renderUsers();
        toast("User berhasil dihapus.");
      } catch (err) { toast(err.message, true); }
    });
  }

  function initLogout() {
    el("logoutBtn")?.addEventListener("click", async () => {
      try { if (state.token) await apiPost("logout"); } catch (_) {}
      state.token = "";
      localStorage.removeItem(CONFIG.TOKEN_KEY);
      localStorage.removeItem(CONFIG.USER_KEY);
      window.location.replace("login.html");
    });
  }

  async function initAppPage() {
    if (!state.token) {
      window.location.replace("login.html");
      return;
    }

    buildPressView();
    wireLineView("filling");
    wireLineView("press");
    initTabs();
    initLaporan();
    initMasterData();
    initUserManagement();
    initLogout();

    // Tampilkan aplikasi langsung memakai profil + master cache terakhir.
    // Validasi server tetap berjalan segera setelahnya.
    try {
      const cachedUser = JSON.parse(localStorage.getItem(CONFIG.USER_KEY) || "null");
      const cachedMaster = JSON.parse(localStorage.getItem(CONFIG.MASTER_KEY) || "null");
      if (cachedUser && cachedUser.username) {
        state.currentUser = cachedUser;
        if (cachedMaster) state.master = cachedMaster;
        refreshAllDropdowns();
        loadPersistedPreview();
        restoreFormDraft("filling");
        restoreFormDraft("press");
        renderPreview("filling");
        renderPreview("press");
        renderPressBalance();
        renderUserHeader();
        el("appScreen").hidden = false;
        setConnection("loading", "Menyegarkan data…");
      }
    } catch (_) {}

    try {
      // Bootstrap sekarang ringan: hanya validasi user + master dropdown.
      await loadBootstrap();
      if (state.currentUser) {
        localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(state.currentUser));
      }
      el("appScreen").hidden = false;

      // Daftar pengerjaan/users dimuat setelah halaman sudah bisa dipakai.
      loadAppData().catch(err => {
        setConnection("error", "Daftar data gagal dimuat");
        toast(err.message, true);
      });
    } catch (err) {
      state.token = "";
      state.currentUser = null;
      localStorage.removeItem(CONFIG.TOKEN_KEY);
      localStorage.removeItem(CONFIG.USER_KEY);
      alert(`Sesi/koneksi tidak valid: ${err.message}`);
      window.location.replace("login.html");
    }
  }

  if (pageType === "login") initLoginPage();
  else initAppPage();
})();
