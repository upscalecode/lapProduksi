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
    REQUEST_TIMEOUT: 30000, // safety net; simpan batch normalnya jauh lebih cepat
    PAGE_SIZE: 20,
    PRESS_BALANCE_PAGE_SIZE: 5,
    DASHBOARD_PRIORITY_PAGE_SIZE: 6,

    // Ganti dengan URL deployment Web App terbaru yang berakhir /exec.
    WEB_APP_URL: "https://script.google.com/macros/s/AKfycbyzM7BTrMfpc6OvQBzxBcxHRUCQHpNm_F4ZheB3TUiLics1M8GXMRSDXgg1pBQoDGnaPA/exec"
  };

  const LINE_LABEL = { filling: "Filling", press: "Press" };
  const pageType = document.body.dataset.page || "app";

  const state = {
    token: localStorage.getItem(CONFIG.TOKEN_KEY) || "",
    currentUser: null,
    master: { operator: [], produk: [], botol: [], botolpecah: [] },
    entries: [],
    adjustments: [],
    remainders: [],
    preview: { filling: [], press: [] },
    users: [],
    search: {
      filling: { query: "" },
      press: { query: "" }
    },
    pages: { filling: 1, press: 1, laporan: 1 },
    savedPages: { filling: 1, press: 1 },
    pressBalance: { search: "", page: 1 },
    dashboard: {chartMode: "7days", chartMonth:"", chartYear:"", chartStart:"", chartEnd:"", priorityPage: 1 },
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

  const DEFAULT_USER_PERMISSIONS = Object.freeze({
    accessDashboard: false,
    accessFilling: true,
    accessPress: true,
    accessReports: false,
    deleteUnpressed: false,
    viewAllData: false,
    editOwn: true,
    editOthers: false,
    deleteOwn: false,
    deleteOthers: false,
    accessMaster: false
  });

  function permissionsOf(user = state.currentUser) {
    if (!user) return { ...DEFAULT_USER_PERMISSIONS };
    if (user.role === "superuser") {
      return Object.fromEntries(Object.keys(DEFAULT_USER_PERMISSIONS).map(key => [key, true]));
    }
    return { ...DEFAULT_USER_PERMISSIONS, ...(user.permissions || {}) };
  }

  function can(permission, user = state.currentUser) {
    return Boolean(user && (user.role === "superuser" || permissionsOf(user)[permission] === true));
  }

  function canEditEntry(entry) {
    if (!state.currentUser || !entry) return false;
    return entry.createdBy === state.currentUser.username ? can("editOwn") : can("editOthers");
  }

  function canDeleteEntry(entry) {
    if (!state.currentUser || !entry) return false;
    return entry.createdBy === state.currentUser.username ? can("deleteOwn") : can("deleteOthers");
  }

  function firstAllowedView() {
    if (can("accessDashboard")) return "dashboard"
    if (can("accessFilling")) return "filling";
    if (can("accessPress")) return "press";
    if (can("accessReports")) return "laporan";
    if (can("accessMaster")) return "master";
    return "";
  }

  function applyAccessControl() {
    const accessMap = {
      dashboard: can("accessDashboard"),
      filling: can("accessFilling"),
      press: can("accessPress"),
      laporan: can("accessReports"),
      master: can("accessMaster")
    };
    Object.entries(accessMap).forEach(([view, allowed]) => {
      const btn = qs(`.tab-btn[data-view="${view}"]`);
      if (btn) btn.hidden = !allowed;
    });
    const userPanel = el("userManagementPanel");
    if (userPanel) userPanel.hidden = !state.currentUser || state.currentUser.role !== "superuser";

    const active = qs(".tab-btn.active");
    if (active && !accessMap[active.dataset.view]) {
      const fallback = firstAllowedView();
      qsa(".tab-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.view === fallback);
      });
      qsa(".content > .view").forEach(node => { 
        node.hidden = !fallback ||
        node.id !== "view-" + fallback; });
    }
  }

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
      setConnection("online", "Aktif");
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
      setConnection("online", "Aktif");
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
            <p class="eyebrow">Filling → Press</p>
            <h2>Pengerjaan belum di Press</h2>
          </div>
        </div>
        <div class="search-bar press-balance-toolbar">
          <label class="field field-inline press-balance-search-field">
            <span>Cari Nama Produk</span>
            <input type="search" class="press-balance-search" placeholder="Cari nama produk…" autocomplete="off">
          </label>
          <button type="button" class="btn btn-ghost press-balance-search-reset">Reset</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Tanggal Asal</th>
                <th>Produk</th>
                <th>Botol</th>
                <th>Qty (Kardus)</th>
                <th>Qty Filling</th>
                <th>Sudah Press</th>
                <th>Sisa</th>
                <th>Sumber</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody class="press-balance-tbody">
              <tr><td colspan="9" class="empty-row">Memuat sisa pengerjaan Press…</td></tr>
            </tbody>
          </table>
        </div>
        <div class="table-footer">
          <p class="table-summary press-balance-summary"></p>
          <div class="pagination press-balance-pagination" aria-label="Navigasi halaman sisa Press"></div>
        </div>`;
      stack.insertBefore(balancePanel, form);

      const hint = document.createElement("p");
      hint.className = "press-available-hint";
      hint.dataset.state = "empty";
      hint.textContent = "Pilih Nama Produk untuk melihat Qty Filling yang tersedia untuk Press.";
      const error = qs(".f-error", form);
      if (error) error.insertAdjacentElement("beforebegin", hint);
      else form.appendChild(hint);
    }

    clone.addEventListener("click", async event => {
      const deleteBtn = event.target.closest(".press-balance-delete");
      if (deleteBtn) {
        if(!can("deleteUnpressed")){
          return toast("Tidak ada akses", true);
        }
        const produkValue = deleteBtn.dataset.produk || "";
        const botolValue = deleteBtn.dataset.botol || "";
        const row = getPressBalanceRows().find(item =>
          balanceKey(item.produk, item.botol) === balanceKey(produkValue, botolValue)
        );
        if (!row) return toast("Data sisa Press tidak ditemukan.", true);
        if (row.hasPreview) {
          return toast("Simpan data Preview Filling terlebih dahulu sebelum menghapus sisa Press.", true);
        }

        const alasan = await askClosePressReason(row);
        if (!alasan) return;

        deleteBtn.disabled = true;
        const oldText = deleteBtn.textContent;
        deleteBtn.textContent = "Menghapus…";
        try {
          const response = await enqueueWrite(() => apiPost("press.adjustment.close", {
            data: { produk: row.produk, botol: row.botol, alasan }
          }));
          if (response.adjustment) upsertAdjustment(response.adjustment);
          if (Array.isArray(response.remainders)) state.remainders = response.remainders;
          state.pressBalance.page = 1;
          renderPressBalance();
          toast(`Sisa ${row.produk} / ${row.botol} berhasil dihapus dengan alasan tercatat.`);
        } catch (err) {
          deleteBtn.disabled = false;
          deleteBtn.textContent = oldText;
          toast(`Gagal menghapus sisa Press: ${err.message}`, true);
        }
        return;
      }

      const useBtn = event.target.closest(".press-balance-use");
      if (!useBtn) return;

      const pressForm = qs(".form-panel", clone);
      if (!pressForm) return;
      const produk = qs(".f-produk", pressForm);
      const botol = qs(".f-botol", pressForm);

      if (produk) {
        produk.value = useBtn.dataset.produk || "";
        produk.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (botol && useBtn.dataset.botol && isMasterValue("botol", useBtn.dataset.botol)) {
        botol.value = useBtn.dataset.botol;
        botol.dispatchEvent(new Event("change", { bubbles: true }));
      }

      updatePressAvailabilityHint(pressForm);
      saveFormDraft("press", pressForm);
      pressForm.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    const balanceSearch = qs(".press-balance-search", clone);
    const balanceSearchReset = qs(".press-balance-search-reset", clone);
    if (balanceSearch) {
      balanceSearch.value = state.pressBalance.search || "";
      balanceSearch.addEventListener("input", () => {
        state.pressBalance.search = balanceSearch.value.trim();
        state.pressBalance.page = 1;
        renderPressBalance();
      });
    }
    if (balanceSearchReset) {
      balanceSearchReset.addEventListener("click", () => {
        state.pressBalance.search = "";
        state.pressBalance.page = 1;
        if (balanceSearch) balanceSearch.value = "";
        renderPressBalance();
      });
    }

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
    if (Array.isArray(data.adjustments)) state.adjustments = data.adjustments;
    if (Array.isArray(data.remainders)) state.remainders = data.remainders;
    if (Array.isArray(data.users)) state.users = data.users;

    refreshAllDropdowns();
    loadPersistedPreview();
    restoreFormDraft("filling");
    restoreFormDraft("press");
    renderPreview("filling");
    renderPreview("press");
    renderEntries("filling");
    renderEntries("press");
    renderPressBalance();
    renderMasterChips();
    renderUsers();
    renderUserHeader();
    applyAccessControl();
    renderDashboard();
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
    if (el("masterTabBtn")) el("masterTabBtn").hidden = !can("accessMaster", user);
    if (el("deviceDateDisplay")) {
      el("deviceDateDisplay").textContent = new Date().toLocaleDateString("id-ID", {
        weekday: "long", day: "2-digit", month: "long", year: "numeric"
      });
    }
  }

  function matchesPreviewSearch(entry, query) {
    const keyword = String(query || "").trim().toLowerCase();
    if (!keyword) return true;
    return [entry.operator, entry.produk].some(value =>
      String(value || "").toLowerCase().includes(keyword)
    );
  }

  function filteredEntries(line) {
    const filter = state.search[line] || { query: "" };
    const today = todayStr();

    // Tabel data tersimpan pada menu Filling / Press hanya menampilkan
    // pengerjaan dengan tanggal hari ini. Data tanggal lain tetap berada di
    // state.entries sehingga fitur Laporan, Dashboard, dan balance Press tetap
    // menggunakan histori sesuai logic yang sudah ada.
    return state.entries
      .filter(e => e.tab === line && e.tanggal === today)
      .filter(e => matchesPreviewSearch(e, filter.query))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  function filteredPreviewEntries(line) {
    const filter = state.search[line] || { query: "" };
    const rows = state.preview && state.preview[line] ? state.preview[line] : [];
    return rows
      .filter(e => matchesPreviewSearch(e, filter.query))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  // Press hanya boleh disimpan setelah seluruh Preview Filling sudah
  // benar-benar disimpan ke Spreadsheet. Preview Press tetap boleh dibuat/edit.
  function hasUnsavedFillingPreview() {
    return can("accessFilling") && Array.isArray(state.preview.filling) && state.preview.filling.length > 0;
  }

  function updateSaveButtonState(line) {
    const section = el("view-" + line);
    const saveBtn = section ? qs(".f-save-btn", section) : null;
    if (!saveBtn) return;

    // Pertahankan perilaku lama: tombol mengikuti jumlah baris preview yang
    // sedang tampil setelah filter. Khusus Press ditambah syarat Filling harus tersimpan dulu.
    const rows = filteredPreviewEntries(line);
    const waitingForFilling = line === "press" && hasUnsavedFillingPreview();

    saveBtn.disabled = rows.length === 0 || waitingForFilling;
    saveBtn.textContent = rows.length ? `Simpan (${rows.length})` : "Simpan";

    if (waitingForFilling) {
      saveBtn.title = "Simpan data Filling terlebih dahulu sebelum menyimpan Press.";
      saveBtn.dataset.waitingFilling = "1";
    } else {
      saveBtn.removeAttribute("title");
      delete saveBtn.dataset.waitingFilling;
    }
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

  function upsertAdjustment(adjustment) {
    if (!adjustment || !adjustment.id) return;
    const index = state.adjustments.findIndex(item => item.id === adjustment.id);
    if (index >= 0) state.adjustments[index] = adjustment;
    else state.adjustments.push(adjustment);
  }

  function ensureClosePressModalStyle() {
    if (el("pressCloseReasonStyle")) return;
    const style = document.createElement("style");
    style.id = "pressCloseReasonStyle";
    style.textContent = `
      .press-close-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px}
      .press-close-dialog{width:min(520px,100%);background:#fff;border-radius:16px;padding:20px;box-shadow:0 24px 70px rgba(15,23,42,.28)}
      .press-close-dialog h3{margin:0 0 6px;font-size:18px}.press-close-dialog p{margin:0 0 14px;color:#64748b;font-size:13px;line-height:1.5}
      .press-close-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}.press-close-meta div{padding:10px;background:#f8fafc;border-radius:10px;font-size:12px}
      .press-close-dialog textarea{width:100%;min-height:110px;resize:vertical;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:10px;padding:10px;font:inherit}
      .press-close-error{color:#b91c1c!important;margin:7px 0 0!important;min-height:18px}.press-close-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
      .press-balance-actions{
        display:flex;
        gap:8px;
        flex-wrap:nowrap;
        align-items:center;
        white-space:nowrap
      }
      .press-balance-actions .btn{
        flex:0 0 auto
      }
      .press-balance-panel .data-table th:last-child,
      .press-balance-panel .data-table td:last-child{
        min-width:220px;
        width:220px;
        white-space:nowrap
      }
      .press-product-name{
        display:block;
        max-width:280px;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis
      }
    `;
    document.head.appendChild(style);
  }

  function askClosePressReason(row) {
    ensureClosePressModalStyle();
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "press-close-overlay";
      overlay.innerHTML = `
        <div class="press-close-dialog" role="dialog" aria-modal="true" aria-labelledby="pressCloseTitle">
          <h3 id="pressCloseTitle">Hapus Sisa Pengerjaan Press</h3>
          <p>Qty sisa akan dikeluarkan dari saldo Press aktif, tetapi riwayat Filling/Press tidak dihapus. Alasan wajib dicatat untuk audit.</p>
          <div class="press-close-meta">
            <div><strong>Produk</strong><br>${esc(row.produk)}</div>
            <div><strong>Botol</strong><br>${esc(row.botol)}</div>
            <div><strong>Sisa Qty</strong><br>${Number(row.remaining).toLocaleString("id-ID")} botol</div>
            <div><strong>Tanggal</strong><br>${esc(todayStr())}</div>
          </div>
          <label class="field"><span>Alasan Hapus <b>*</b></span>
            <textarea class="press-close-reason" maxlength="500" placeholder="Contoh: sisa botol rusak dan tidak dapat diproses press" required></textarea>
          </label>
          <p class="press-close-error"></p>
          <div class="press-close-actions">
            <button type="button" class="btn btn-ghost press-close-cancel">Batal</button>
            <button type="button" class="btn btn-danger press-close-confirm">Hapus Sisa</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const textarea = qs(".press-close-reason", overlay);
      const error = qs(".press-close-error", overlay);
      const finish = value => { overlay.remove(); resolve(value); };
      qs(".press-close-cancel", overlay).addEventListener("click", () => finish(""));
      overlay.addEventListener("click", event => { if (event.target === overlay) finish(""); });
      overlay.addEventListener("keydown", event => { if (event.key === "Escape") finish(""); });
      qs(".press-close-confirm", overlay).addEventListener("click", () => {
        const reason = String(textarea.value || "").trim();
        if (reason.length < 5) {
          error.textContent = "Alasan wajib diisi minimal 5 karakter.";
          textarea.focus();
          return;
        }
        finish(reason);
      });
      setTimeout(() => textarea.focus(), 0);
    });
  }

  function getQtyBotolPerKardusFromRemainder(item) {
    const direct = Number(item && item.qtyBotolPerKardus) || 0;
    if (direct > 0) return direct;

    // ID pada Sisa Press mengikuti ID entry Filling asal, jadi nilai Botol/Kardus
    // bisa diambil dari data Pengerjaan tanpa menambah kolom/sheet baru.
    const sourceEntry = (state.entries || []).find(entry =>
      String(entry.id || "") === String((item && item.id) || "") && entry.tab === "filling"
    );
    return Number(sourceEntry && sourceEntry.qtyBotolPerKardus) || 0;
  }

  function getPressBalanceRows(options = {}) {
    const excludePreviewId = options.excludePreviewId || "";
    const lots = [];

    // 1) Sisa yang sudah resmi tersimpan di Sheet "Sisa Press".
    (state.remainders || []).forEach(item => {
      const remaining = Number(item.sisaQty ?? item.remaining) || 0;
      if (remaining <= 0) return;
      const hasGroupStats = item.groupQtyFilling !== undefined && item.groupQtyPressTerpakai !== undefined;
      lots.push({
        id: String(item.id || ""),
        tanggalAsal: String(item.tanggalAsal || item.tanggal || ""),
        produk: String(item.produk || "").trim(),
        botol: String(item.botol || "").trim(),
        qtyBotolPerKardus: getQtyBotolPerKardusFromRemainder(item),
        qtyBotolPerKardusValues: Array.isArray(item.groupQtyBotolPerKardusValues)
          ? item.groupQtyBotolPerKardusValues.map(Number).filter(value => value > 0)
          : [],
        qtyFilling: Number(item.qtyFilling) || remaining,
        qtyPressTerpakai: Number(item.qtyPressTerpakai) || 0,
        groupQtyFilling: hasGroupStats ? (Number(item.groupQtyFilling) || 0) : null,
        groupQtyPressTerpakai: hasGroupStats ? (Number(item.groupQtyPressTerpakai) || 0) : null,
        previewPressTerpakai: 0,
        remaining,
        source: "spreadsheet"
      });
    });

    // 2) Filling yang BARU MASUK PREVIEW ikut dibaca Press walaupun belum disimpan.
    (state.preview.filling || []).forEach(item => {
      const qty = Number(item.totalQty) || 0;
      if (qty <= 0) return;
      lots.push({
        id: `preview-filling-${item.id}`,
        tanggalAsal: String(item.tanggal || todayStr()),
        produk: String(item.produk || "").trim(),
        botol: String(item.botol || "").trim(),
        qtyBotolPerKardus: Number(item.qtyBotolPerKardus) || 0,
        qtyFilling: qty,
        qtyPressTerpakai: 0,
        groupQtyFilling: null,
        groupQtyPressTerpakai: null,
        previewPressTerpakai: 0,
        remaining: qty,
        source: "preview"
      });
    });

    // FIFO per Nama Produk: preview Press mengurangi lot tertua terlebih dahulu.
    const previewPress = (state.preview.press || [])
      .filter(item => item.id !== excludePreviewId)
      .slice()
      .sort((a, b) =>
        String(a.tanggal || "").localeCompare(String(b.tanggal || "")) ||
        String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
      );

    previewPress.forEach(press => {
      let needed = Number(press.totalQty) || 0;
      if (needed <= 0) return;
      const key = String(press.produk || "").trim().toLowerCase();
      const pressDate = String(press.tanggal || todayStr());

      lots
        .filter(lot =>
          lot.remaining > 0 &&
          String(lot.produk || "").trim().toLowerCase() === key &&
          (!lot.tanggalAsal || lot.tanggalAsal <= pressDate)
        )
        .sort((a, b) =>
          String(a.tanggalAsal || "").localeCompare(String(b.tanggalAsal || "")) ||
          String(a.id).localeCompare(String(b.id))
        )
        .forEach(lot => {
          if (needed <= 0) return;
          const used = Math.min(needed, lot.remaining);
          lot.remaining -= used;
          lot.qtyPressTerpakai += used;
          lot.previewPressTerpakai = (Number(lot.previewPressTerpakai) || 0) + used;
          needed -= used;
        });
    });

    // Gabungkan tampilan berdasarkan Nama Produk + Botol. Semua lot ikut
    // dihitung, termasuk lot yang menjadi 0 karena Preview Press. Baris baru
    // disembunyikan setelah total Sisa kombinasi benar-benar 0.
    //
    // Backend mengirim groupQtyFilling/groupQtyPressTerpakai agar histori lot
    // yang sudah habis Press tetap masuk ke kolom Qty Filling dan Sudah Press.
    const grouped = new Map();
    lots.forEach(lot => {
      const key = balanceKey(lot.produk, lot.botol);
      if (!grouped.has(key)) {
        grouped.set(key, {
          id: `balance-${key}`,
          tanggalAsal: "",
          produk: String(lot.produk || "").trim(),
          botol: String(lot.botol || "").trim(),
          qtyFilling: 0,
          qtyPressTerpakai: 0,
          remaining: 0,
          savedGroupStatsApplied: false,
          qtyBotolPerKardusValues: new Set(),
          sources: new Set()
        });
      }
      const group = grouped.get(key);
      const tanggal = String(lot.tanggalAsal || "");

      // Tanggal Asal adalah lot tertua yang masih memiliki sisa setelah seluruh
      // Preview Press dialokasikan.
      if (lot.remaining > 0 && tanggal && (!group.tanggalAsal || tanggal < group.tanggalAsal)) {
        group.tanggalAsal = tanggal;
      }

      if (lot.source === "spreadsheet" && lot.groupQtyFilling !== null && lot.groupQtyPressTerpakai !== null) {
        // Nilai grup dari backend identik pada setiap lot aktif kombinasi yang sama,
        // sehingga cukup dimasukkan satu kali agar tidak terduplikasi.
        if (!group.savedGroupStatsApplied) {
          group.qtyFilling += Number(lot.groupQtyFilling) || 0;
          group.qtyPressTerpakai += Number(lot.groupQtyPressTerpakai) || 0;
          group.savedGroupStatsApplied = true;
        }
      } else {
        // Kompatibilitas deployment lama dan Preview Filling.
        group.qtyFilling += Number(lot.qtyFilling) || 0;
        group.qtyPressTerpakai += Number(lot.qtyPressTerpakai) || 0;
      }

      // Preview Press belum ada di angka grup backend, jadi tambahkan delta ini
      // secara terpisah untuk semua lot yang dikonsumsi preview.
      if (lot.source === "spreadsheet" && lot.groupQtyFilling !== null) {
        group.qtyPressTerpakai += Number(lot.previewPressTerpakai) || 0;
      }

      group.remaining += Number(lot.remaining) || 0;

      const backendPerKardus = Array.isArray(lot.qtyBotolPerKardusValues)
        ? lot.qtyBotolPerKardusValues
        : [];
      backendPerKardus.forEach(value => {
        const qty = Number(value) || 0;
        if (qty > 0) group.qtyBotolPerKardusValues.add(qty);
      });
      const qtyPerKardus = Number(lot.qtyBotolPerKardus) || 0;
      if (qtyPerKardus > 0) group.qtyBotolPerKardusValues.add(qtyPerKardus);
      group.sources.add(lot.source || "spreadsheet");
    });

    return Array.from(grouped.values())
      .filter(group => group.remaining > 0)
      .map(group => ({
        ...group,
        qtyBotolPerKardus: Array.from(group.qtyBotolPerKardusValues).sort((a, b) => a - b),
        source: group.sources.size > 1 ? "mixed" : Array.from(group.sources)[0],
        hasPreview: group.sources.has("preview"),
        hasSpreadsheet: group.sources.has("spreadsheet")
      }))
      .sort((a, b) =>
        String(a.tanggalAsal || "").localeCompare(String(b.tanggalAsal || "")) ||
        a.produk.localeCompare(b.produk, "id") ||
        a.botol.localeCompare(b.botol, "id")
      );
  }

  function getPressAvailable(produk, excludePreviewId = "", pressDate = todayStr()) {
    const key = String(produk || "").trim().toLowerCase();
    if (!key) return 0;
    return getPressBalanceRows({ excludePreviewId })
      .filter(row =>
        String(row.produk || "").trim().toLowerCase() === key &&
        (!row.tanggalAsal || row.tanggalAsal <= pressDate)
      )
      .reduce((sum, row) => sum + (Number(row.remaining) || 0), 0);
  }

  function renderPressBalance() {
    const section = el("view-press");
    if (!section) return;
    const tbody = qs(".press-balance-tbody", section);
    const summary = qs(".press-balance-summary", section);
    const pagination = qs(".press-balance-pagination", section);
    const searchInput = qs(".press-balance-search", section);
    if (!tbody) return;

    const allRows = getPressBalanceRows();
    const query = String(state.pressBalance.search || "").trim().toLowerCase();
    const rows = query
      ? allRows.filter(row => String(row.produk || "").toLowerCase().includes(query))
      : allRows;

    const totalPages = Math.max(1, Math.ceil(rows.length / CONFIG.PRESS_BALANCE_PAGE_SIZE));
    state.pressBalance.page = Math.min(Math.max(1, state.pressBalance.page || 1), totalPages);
    const page = state.pressBalance.page;
    const start = (page - 1) * CONFIG.PRESS_BALANCE_PAGE_SIZE;
    const visibleRows = rows.slice(start, start + CONFIG.PRESS_BALANCE_PAGE_SIZE);

    if (searchInput && searchInput.value !== state.pressBalance.search) {
      searchInput.value = state.pressBalance.search || "";
    }

    tbody.innerHTML = visibleRows.length ? visibleRows.map(row => {
      const produkAktif = isMasterValue("produk", row.produk);
      const botolAktif = isMasterValue("botol", row.botol);
      const sourceLabel = row.source === "preview"
        ? '<span class="sync-badge pending">Preview Filling</span>'
        : row.source === "mixed"
          ? '<span class="sync-badge pending">Spreadsheet + Preview</span>'
          : '<span class="sync-badge saved">Spreadsheet</span>';
      const deleteAllowed = can("deleteUnpressed");
      const deleteDisabled = row.hasPreview || !row.hasSpreadsheet;
      // !deleteAllowed || row.hasPreview || !row.hasSpreadsheet;
      const deleteTitle = row.hasPreview
      // !deleteAllowed
      // ? 'Anda tidak memiliki akses menghapus pengerjaan yang belum di-Press.'
        ? 'Simpan Preview Filling terlebih dahulu sebelum menghapus'
        : (!row.hasSpreadsheet
          ? 'Data ini belum disimpan.'
          : 'Hapus sisa dengan alasan');
          // : (!row.hasSpreadsheet ? 'Data ini belum tersimpan di Spreadsheet.' : 'Hapus sisa dengan alasan.');

      return `
      <tr>
        <td><strong>${esc(row.tanggalAsal || "—")}</strong></td>
        <td>
          <div class="press-product-name" title="${esc(row.produk)}">${esc(row.produk)}</div>
          ${!produkAktif ? '<div class="press-master-history">Produk historis</div>' : ""}
        </td>
        <td>${esc(row.botol || "—")}${!botolAktif ? '<div class="press-master-history">Botol historis</div>' : ""}</td>
        <td>${row.qtyBotolPerKardus.length ? row.qtyBotolPerKardus.map(value => Number(value).toLocaleString("id-ID")).join(" / ") : "—"}</td>
        <td>${Number(row.qtyFilling).toLocaleString("id-ID")}</td>
        <td>${Number(row.qtyPressTerpakai).toLocaleString("id-ID")}</td>
        <td><strong>${Number(row.remaining).toLocaleString("id-ID")}</strong></td>
        <td>${sourceLabel}</td>
        <td>
          <div class="press-balance-actions">
            <button type="button" class="btn btn-ghost press-balance-use"
              data-produk="${esc(row.produk)}" data-botol="${esc(row.botol)}"
              ${!produkAktif ? 'disabled title="Produk sudah tidak ada di Master."' : ""}>Gunakan</button>
            ${deleteAllowed ? `
            <button type="button" class="btn btn-danger press-balance-delete"
            data-produk="${esc(row.produk)}"
            data-botol="${esc(row.botol)}" ${deleteDisabled ? "disabled" : ""}
            title="${esc(deleteTitle)}"> Hapus </button>
              `:""
            }
          </div>
        </td>
      </tr>`;
    }).join("")
      : `<tr><td colspan="9" class="empty-row">${query ? "Nama produk tidak ditemukan." : "Tidak ada sisa Filling yang menunggu Press."}</td></tr>`;

    const remainingTotal = rows.reduce((sum, row) => sum + (Number(row.remaining) || 0), 0);
    const from = rows.length ? start + 1 : 0;
    const to = Math.min(start + CONFIG.PRESS_BALANCE_PAGE_SIZE, rows.length);
    if (summary) {
      const previewCount = rows.filter(row => row.hasPreview).length;
      summary.textContent =
        `${from}–${to} dari ${rows.length} kombinasi Produk + Botol · Sisa ${remainingTotal.toLocaleString("id-ID")} botol` +
        (query ? ` · Pencarian: ${state.pressBalance.search}` : "") +
        (previewCount ? ` · ${previewCount} kombinasi memuat Preview Filling` : "");
    }

    renderPagination(pagination, page, totalPages, nextPage => {
      state.pressBalance.page = nextPage;
      renderPressBalance();
      qs(".press-balance-panel", section)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    const form = qs(".form-panel", section);
    updatePressAvailabilityHint(form);
    renderDashboard();
  }

  function updatePressAvailabilityHint(form) {
    if (!form || form.dataset.line !== "press") return;
    const produk = qs(".f-produk", form)?.value || "";
    const editingId = qs(".f-editing-id", form)?.value || "";
    const hint = qs(".press-available-hint", form);
    if (!hint) return;

    if (!isMasterValue("produk", produk)) {
      hint.dataset.state = "empty";
      hint.textContent = "Pilih Nama Produk dari data master untuk melihat sisa Qty Filling.";
      return;
    }

    const available = getPressAvailable(produk, editingId, todayStr());
    const lots = getPressBalanceRows({ excludePreviewId: editingId })
      .filter(row =>
        String(row.produk || "").trim().toLowerCase() === String(produk).trim().toLowerCase() &&
        (!row.tanggalAsal || row.tanggalAsal <= todayStr())
      );
    const oldest = lots.length ? lots[0].tanggalAsal : "";

    hint.dataset.state = available > 0 ? "ok" : "empty";
    hint.textContent = available > 0
      ? `Sisa Qty Filling untuk ${produk}: ${available.toLocaleString("id-ID")} botol` +
        (oldest && oldest < todayStr() ? ` · termasuk tinggalan sejak ${oldest}` : "") + "."
      : `Produk ${produk} sudah balance atau belum memiliki Qty Filling.`;
  }

  function validatePressPayload(payload, editingId = "") {
    if (payload.line !== "press") return "";
    const requested = (Number(payload.qtyKardus) || 0) * (Number(payload.qtyBotolPerKardus) || 0);
    const available = getPressAvailable(payload.produk, editingId, payload.tanggal || todayStr());
    if (requested > available) {
      return `Qty Press ${requested.toLocaleString("id-ID")} botol melebihi sisa Filling ${Math.max(0, available).toLocaleString("id-ID")} botol untuk produk ${payload.produk}. Balance Press dihitung berdasarkan Nama Produk.`;
    }
    if (requested <= 0) return "Total Qty Press harus lebih dari 0 botol.";
    return "";
  }

  function renderEntryRow(entry) {
    const syncState = entry._syncState || "";
    const isPending = syncState === "pending";
    const isError = syncState === "error";
    const canEdit = !syncState && canEditEntry(entry);
    const canDelete = !syncState && canDeleteEntry(entry);

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

  function combinedWorkEntries(line) {
    const saved = filteredEntries(line).map(entry => ({ ...entry, _displaySource: "saved" }));
    const preview = filteredPreviewEntries(line).map(entry => ({ ...entry, _displaySource: "preview" }));

    // Preview dan data tersimpan hari ini ditampilkan pada satu tabel.
    // Pembeda visual sengaja hanya melalui kolom ID:
    // - preview  => PREVIEW
    // - tersimpan => reportId dari Spreadsheet
    return [...saved, ...preview].sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );
  }

  function renderPreviewRow(entry) {
    return `
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
      </tr>`;
  }

  // Dipertahankan sebagai compatibility wrapper karena beberapa alur lama
  // masih memanggil renderEntries(). Sekarang seluruh data dirender di tabel
  // yang sama melalui renderPreview().
  function renderEntries(line) {
    renderPreview(line);
  }

  function renderPreview(line) {
    const section = el("view-" + line);
    if (!section) return;

    const tbody = qs(".f-tbody", section);
    const summary = qs(".f-summary", section);
    const pagination = qs(".f-pagination", section);
    const saveBtn = qs(".f-save-btn", section);
    if (!tbody) return;

    const rows = combinedWorkEntries(line);
    const totalPages = Math.max(1, Math.ceil(rows.length / CONFIG.PAGE_SIZE));
    state.pages[line] = Math.min(Math.max(1, state.pages[line]), totalPages);
    const page = state.pages[line];
    const start = (page - 1) * CONFIG.PAGE_SIZE;
    const visibleRows = rows.slice(start, start + CONFIG.PAGE_SIZE);

    tbody.innerHTML = visibleRows.length
      ? visibleRows.map(entry => entry._displaySource === "preview"
          ? renderPreviewRow(entry)
          : renderEntryRow(entry)
        ).join("")
      : '<tr><td colspan="11" class="empty-row">Belum ada pengerjaan hari ini.</td></tr>';

    const totalQty = rows.reduce((sum, e) => sum + (Number(e.totalQty) || 0), 0);
    const totalPecah = rows.reduce((sum, e) => sum + (Number(e.qtyBotolPecah) || 0), 0);
    const from = rows.length ? start + 1 : 0;
    const to = Math.min(start + CONFIG.PAGE_SIZE, rows.length);
    if (summary) {
      summary.textContent = `${from}–${to} dari ${rows.length} data hari ini · Total Qty Botol: ${totalQty.toLocaleString("id-ID")} · Total Botol Pecah: ${totalPecah.toLocaleString("id-ID")}`;
    }

    if (saveBtn) {
      updateSaveButtonState(line);

      // Perubahan Preview Filling harus langsung memperbarui status tombol
      // Simpan pada Press tanpa mengubah alur preview yang sudah ada.
      if (line === "filling") updateSaveButtonState("press");
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
      editing.dataset.source = "";
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
          if (Array.isArray(response.remainders)) state.remainders = response.remainders;
          renderEntries(line);
          renderPressBalance();
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
      if (!can(line === "press" ? "accessPress" : "accessFilling")) {
        errorEl.textContent = `Anda tidak memiliki akses ${LINE_LABEL[line]}.`;
        errorEl.hidden = false;
        return;
      }
      const payload = {
        line,
        tanggal: tanggal.value || todayStr(),
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

      // UPDATE data yang sudah tersimpan langsung ke Spreadsheet.
      if (id && editing.dataset.source === "saved") {
        submitBtn.disabled = true;
        try {
          const response = await enqueueWrite(() => apiPost("entry.update", { id, data: payload }));
          if (response.entry) upsertEntry(response.entry);
          if (Array.isArray(response.remainders)) state.remainders = response.remainders;
          resetForm();
          renderEntries(line);
          renderPressBalance();
          toast("Data Spreadsheet berhasil diperbarui.");
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          submitBtn.disabled = false;
        }
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
          renderPressBalance();
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
      renderPressBalance();
      toast("Data ditambahkan ke preview. Belum disimpan ke Spreadsheet.");
    });

    const searchKeyword = qs(".f-search-keyword", section);
    const resetSearch = qs(".f-search-reset", section);

    searchKeyword.addEventListener("input", () => {
      state.search[line].query = searchKeyword.value.trim();
      state.pages[line] = 1;
      renderPreview(line);
      state.savedPages[line] = 1;
      renderEntries(line);
    });
    searchKeyword.addEventListener("change", () => {
      state.search[line].query = searchKeyword.value.trim();
      state.pages[line] = 1;
      state.savedPages[line] = 1;
      renderPreview(line);
      renderEntries(line);
    });
    resetSearch.addEventListener("click", () => {
      state.search[line] = { query: "" };
      state.pages[line] = 1;
      searchKeyword.value = "";
      state.savedPages[line] = 1;
      renderPreview(line);
      renderEntries(line);
    });

    const saveBtn = qs(".f-save-btn", section);
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        const previewRows = [...(state.preview[line] || [])];
        if (!previewRows.length) {
          toast("Belum ada data preview.", true);
          return;
        }

        // Pengaman kedua: walaupun event dipicu secara programatik, Press tidak
        // boleh dikirim sebelum Preview Filling selesai disimpan ke Spreadsheet.
        if (line === "press" && hasUnsavedFillingPreview()) {
          updateSaveButtonState("press");
          toast("Simpan data Filling terlebih dahulu sebelum menyimpan Press.", true);
          return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = `Menyimpan ${previewRows.length} data...`;

        // FAST SAVE: seluruh preview dikirim dalam SATU request.
        // Backend membaca Pengerjaan sekali, menulis setValues sekali,
        // lalu menghitung Sisa Press sekali untuk seluruh batch.
        const batchPayload = previewRows.map(item => ({
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
        }));

        try {
          const response = await enqueueWrite(() => apiPost("entry.batchCreate", {
            data: batchPayload
          }));

          const savedIds = new Set(Array.isArray(response.savedIds) ? response.savedIds : []);
          (response.entries || []).forEach(upsertEntry);
          if (Array.isArray(response.remainders)) state.remainders = response.remainders;

          // Hapus dari preview hanya ID yang sudah dikonfirmasi server.
          state.preview[line] = (state.preview[line] || []).filter(item => !savedIds.has(item.id));
          state.pages[line] = 1;
          persistPreview();
          renderPreview(line);
          renderEntries(line);
          renderPressBalance();

          const successCount = savedIds.size;
          const retryCount = state.preview[line].length;
          if (successCount) {
            toast(`${successCount} data berhasil disimpan ke Spreadsheet.`);
          }
          if (retryCount) {
            toast(`${retryCount} data belum tersimpan. Silakan klik Simpan lagi.`, true);
          }
        } catch (err) {
          // Batch bersifat aman: jika server menolak sebelum write, seluruh preview tetap ada.
          // Jika koneksi putus sesudah server menulis, clientRequestId membuat retry tidak duplikat.
          state.pages[line] = 1;
          persistPreview();
          renderPreview(line);
          renderPressBalance();
          toast(`Gagal menyimpan: ${err.message}`, true);
        }
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

    qs(".f-tbody", section).addEventListener("click", async event => {
      // Data tersimpan memakai tombol Update/Hapus seperti sebelumnya.
      const savedEditBtn = event.target.closest(".btn-edit");
      const savedDeleteBtn = event.target.closest(".btn-delete");

      if (savedEditBtn) {
        const entry = state.entries.find(x => x.id === savedEditBtn.dataset.id);
        if (!entry || !canEditEntry(entry)) return toast("Anda tidak memiliki akses mengedit data ini.", true);
        editing.value = entry.id;
        editing.dataset.source = "saved";
        tanggal.value = entry.tanggal;
        operator.value = entry.operator;
        produk.value = entry.produk;
        botol.value = entry.botol;
        qtyKardus.value = entry.qtyKardus;
        qtyBotol.value = entry.qtyBotolPerKardus;
        if (botolPecah) botolPecah.value = entry.botolPecahJenis || entry.botol || "-";
        qtyPecah.value = entry.qtyBotolPecah || 0;
        recalc();
        submitBtn.textContent = "Simpan Perubahan";
        cancelBtn.hidden = false;
        stamp.textContent = "EDIT DATA";
        form.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      if (savedDeleteBtn) {
        const entry = state.entries.find(x => x.id === savedDeleteBtn.dataset.id);
        if (!entry || !canDeleteEntry(entry)) return toast("Anda tidak memiliki akses menghapus data ini.", true);
        if (!confirm(`Hapus data ${entry.reportId}?`)) return;
        savedDeleteBtn.disabled = true;
        try {
          const response = await enqueueWrite(() => apiPost("entry.delete", { id: entry.id }));
          state.entries = state.entries.filter(x => x.id !== entry.id);
          if (Array.isArray(response.remainders)) state.remainders = response.remainders;
          renderPreview(line);
          renderPressBalance();
          toast("Data berhasil dihapus.");
        } catch (err) {
          savedDeleteBtn.disabled = false;
          toast(err.message, true);
        }
        return;
      }

      // Data yang belum disimpan tetap memakai aksi Edit/Hapus preview.
      const previewEditBtn = event.target.closest(".btn-preview-edit");
      const previewDeleteBtn = event.target.closest(".btn-preview-delete");

      if (previewEditBtn) {
        const entry = state.preview[line].find(x => x.id === previewEditBtn.dataset.id);
        if (!entry) return;
        editing.value = entry.id;
        editing.dataset.source = "preview";
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

      if (previewDeleteBtn) {
        state.preview[line] = state.preview[line].filter(x => x.id !== previewDeleteBtn.dataset.id);
        state.pages[line] = 1;
        persistPreview();
        renderPreview(line);
        renderPressBalance();
        toast("Data dihapus dari preview.");
      }
    });

  }

  /* ------------------------- DASHBOARD ------------------------- */
  function dashboardEntries() {
    const saved = (state.entries || []).filter(entry => entry && entry._syncState !== "error");
    const preview = [
      ...((state.preview && state.preview.filling) || []),
      ...((state.preview && state.preview.press) || [])
    ];
    return [...saved, ...preview];
  }

  function dashboardQty(value) {
    return (Number(value) || 0).toLocaleString("id-ID");
  }

  function dashboardDateParts(dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  function dashboardDateKey(date) {
    const p = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  }

  function dashboardShortDate(dateStr) {
    const date = dashboardDateParts(dateStr);
    if (!date) return String(dateStr || "—");
    return date.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
  }

  function dashboardAgeDays(dateStr) {
    const date = dashboardDateParts(dateStr);
    const today = dashboardDateParts(todayStr());
    if (!date || !today) return 0;
    return Math.max(0, Math.floor((today.getTime() - date.getTime()) / 86400000));
  }

  function dashboardSetText(id, value) {
    const node = el(id);
    if (node) node.textContent = value;
  }

  function dashboardPriorityLevel(row) {
    const age = dashboardAgeDays(row.tanggalAsal);
    if (age >= 2) return { key: "critical", label: "Kritis" };
    if (age >= 1) return { key: "warning", label: "Peringatan" };
    return { key: "normal", label: "Hari ini" };
  }

  /* =========================================================
   DASHBOARD CHART FILTER
   ========================================================= */

  function dashboardAddDays(date, amount) {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + amount
    );
  }


  function dashboardMonthKey(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");

    return `${date.getFullYear()}-${month}`;
  }


  function dashboardDaysBetween(start, end) {
    const diff = end.getTime() - start.getTime();

    return Math.floor(diff / 86400000) + 1;
  }


  function dashboardChartConfig() {
    const today =
      dashboardDateParts(todayStr()) ||
      new Date();

    const mode =
      state.dashboard?.chartMode ||
      "7days";


    /* =============================
      7 HARI TERAKHIR
      ============================= */
    if (mode === "7days") {

      return {
        mode,
        groupBy: "day",

        start: dashboardAddDays(today, -6),
        end: today,

        label: "7 Hari Terakhir"
      };
    }


    /* =============================
      30 HARI TERAKHIR
      ============================= */
    if (mode === "30days") {

      return {
        mode,
        groupBy: "day",

        start: dashboardAddDays(today, -29),
        end: today,

        label: "30 Hari Terakhir"
      };
    }


    /* =============================
      BERDASARKAN BULAN
      ============================= */
    if (mode === "month") {

      let monthValue =
        state.dashboard.chartMonth;

      if (!monthValue) {
        monthValue = dashboardMonthKey(today);
      }

      const parts = monthValue.split("-");

      const year = Number(parts[0]);
      const month = Number(parts[1]) - 1;

      const start =
        new Date(year, month, 1);

      const end =
        new Date(year, month + 1, 0);

      const label =
        start.toLocaleDateString("id-ID", {
          month: "long",
          year: "numeric"
        });

      return {
        mode,
        groupBy: "day",
        start,
        end,
        label
      };
    }


    /* =============================
      BERDASARKAN TAHUN
      ============================= */
    if (mode === "year") {

      const year =
        Number(state.dashboard.chartYear) ||
        today.getFullYear();

      return {
        mode,
        groupBy: "month",

        start: new Date(year, 0, 1),
        end: new Date(year, 11, 31),

        label: `Tahun ${year}`
      };
    }


    /* =============================
      RENTANG TANGGAL
      ============================= */
    if (mode === "range") {

      let start =
        dashboardDateParts(
          state.dashboard.chartStart
        );

      let end =
        dashboardDateParts(
          state.dashboard.chartEnd
        );


      if (!start) {
        start = dashboardAddDays(today, -6);
      }

      if (!end) {
        end = today;
      }


      /*
        Jika user secara tidak sengaja
        memilih tanggal akhir lebih kecil
        dari tanggal awal, otomatis dibalik.
      */
      if (start > end) {
        const temp = start;
        start = end;
        end = temp;
      }


      const totalDays =
        dashboardDaysBetween(start, end);


      /*
        Jika rentang <= 62 hari
        tampilkan per hari.

        Jika > 62 hari
        otomatis agregasi per bulan
        supaya chart tidak berisi
        ratusan batang.
      */
      const groupBy =
        totalDays <= 62
          ? "day"
          : "month";


      const startLabel =
        start.toLocaleDateString("id-ID", {
          day: "2-digit",
          month: "short",
          year: "numeric"
        });

      const endLabel =
        end.toLocaleDateString("id-ID", {
          day: "2-digit",
          month: "short",
          year: "numeric"
        });


      return {
        mode,
        groupBy,
        start,
        end,
        label: `${startLabel} – ${endLabel}`
      };
    }


    return {
      mode: "7days",
      groupBy: "day",
      start: dashboardAddDays(today, -6),
      end: today,
      label: "7 Hari Terakhir"
    };
  }


  /* =========================================================
    BUAT DATA CHART PER HARI
    ========================================================= */

  function dashboardDailyBuckets(
    entries,
    start,
    end
  ) {

    const buckets = [];

    for (
      let date = new Date(start);
      date <= end;
      date = dashboardAddDays(date, 1)
    ) {

      const key =
        dashboardDateKey(date);


      const filling =
        entries
          .filter(entry =>
            entry.tab === "filling" &&
            entry.tanggal === key
          )
          .reduce(
            (sum, entry) =>
              sum +
              (Number(entry.totalQty) || 0),
            0
          );


      const press =
        entries
          .filter(entry =>
            entry.tab === "press" &&
            entry.tanggal === key
          )
          .reduce(
            (sum, entry) =>
              sum +
              (Number(entry.totalQty) || 0),
            0
          );


      buckets.push({
        key,

        date: new Date(date),

        label:
          date.toLocaleDateString(
            "id-ID",
            {
              day: "2-digit",
              month: "short"
            }
          ),

        filling,
        press
      });
    }


    return buckets;
  }


  /* =========================================================
    BUAT DATA CHART PER BULAN
    ========================================================= */

  function dashboardMonthlyBuckets(
    entries,
    start,
    end
  ) {

    const buckets = [];

    let current =
      new Date(
        start.getFullYear(),
        start.getMonth(),
        1
      );


    const last =
      new Date(
        end.getFullYear(),
        end.getMonth(),
        1
      );


    while (current <= last) {

      const key =
        dashboardMonthKey(current);


      /*
        Tetap filter berdasarkan start-end asli.

        Jadi misalnya:
        15 Januari sampai 20 Maret,

        data tanggal 1-14 Januari
        tidak ikut dihitung.
      */
      const periodEntries =
        entries.filter(entry => {

          const date =
            dashboardDateParts(
              entry.tanggal
            );

          if (!date) return false;

          return (
            date >= start &&
            date <= end &&
            dashboardMonthKey(date) === key
          );
        });


      const filling =
        periodEntries
          .filter(
            entry =>
              entry.tab === "filling"
          )
          .reduce(
            (sum, entry) =>
              sum +
              (Number(entry.totalQty) || 0),
            0
          );


      const press =
        periodEntries
          .filter(
            entry =>
              entry.tab === "press"
          )
          .reduce(
            (sum, entry) =>
              sum +
              (Number(entry.totalQty) || 0),
            0
          );


      buckets.push({
        key,

        date: new Date(current),

        label:
          current.toLocaleDateString(
            "id-ID",
            {
              month: "short",
              year:
                start.getFullYear() !==
                end.getFullYear()
                  ? "2-digit"
                  : undefined
            }
          ),

        filling,
        press
      });


      current =
        new Date(
          current.getFullYear(),
          current.getMonth() + 1,
          1
        );
    }


    return buckets;
  }


  /* =========================================================
    RENDER CHART
    ========================================================= */

  function renderDashboardWeekly(entries) {

    const chart =
      el("dashboardWeeklyChart");

    if (!chart) return;


    const config =
      dashboardChartConfig();


    /*
      Ubah tulisan eyebrow secara otomatis
      mengikuti filter.
    */
    dashboardSetText(
      "dashboardChartPeriodLabel",
      config.label
    );


    const buckets =
      config.groupBy === "month"
        ? dashboardMonthlyBuckets(
            entries,
            config.start,
            config.end
          )
        : dashboardDailyBuckets(
            entries,
            config.start,
            config.end
          );


    const maxValue =
      Math.max(
        1,
        ...buckets.flatMap(
          item => [
            item.filling,
            item.press
          ]
        )
      );


    chart.innerHTML =
      buckets.map(item => {

        const fillingHeight =
          item.filling > 0
            ? Math.max(
                5,
                (
                  item.filling /
                  maxValue
                ) * 100
              )
            : 0;


        const pressHeight =
          item.press > 0
            ? Math.max(
                5,
                (
                  item.press /
                  maxValue
                ) * 100
              )
            : 0;


        return `
          <div class="dashboard-day-group">

            <div class="dashboard-bar-area">

              <div
                class="dashboard-vbar filling"
                style="height:${fillingHeight}%"
                title="Filling ${dashboardQty(item.filling)} pcs"
              >
                <span>
                  ${item.filling
                    ? dashboardQty(item.filling)
                    : "0"}
                </span>
              </div>


              <div
                class="dashboard-vbar press"
                style="height:${pressHeight}%"
                title="Press ${dashboardQty(item.press)} pcs"
              >
                <span>
                  ${item.press
                    ? dashboardQty(item.press)
                    : "0"}
                </span>
              </div>

            </div>

            <strong>
              ${esc(item.label)}
            </strong>

          </div>
        `;

      }).join("");
  }
  // function renderDashboardWeekly(entries) {
  //   const chart = el("dashboardWeeklyChart");
  //   if (!chart) return;

  //   const today = dashboardDateParts(todayStr()) || new Date();
  //   const days = [];
  //   for (let offset = 6; offset >= 0; offset--) {
  //     const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
  //     const key = dashboardDateKey(date);
  //     const filling = entries
  //       .filter(entry => entry.tab === "filling" && entry.tanggal === key)
  //       .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);
  //     const press = entries
  //       .filter(entry => entry.tab === "press" && entry.tanggal === key)
  //       .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);
  //     days.push({ key, date, filling, press });
  //   }

  //   const maxValue = Math.max(1, ...days.flatMap(day => [day.filling, day.press]));
  //   chart.innerHTML = days.map(day => {
  //     const fillingHeight = day.filling > 0 ? Math.max(5, (day.filling / maxValue) * 100) : 0;
  //     const pressHeight = day.press > 0 ? Math.max(5, (day.press / maxValue) * 100) : 0;
  //     const label = day.date.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
  //     return `
  //       <div class="dashboard-day-group">
  //         <div class="dashboard-bar-area">
  //           <div class="dashboard-vbar filling" style="height:${fillingHeight}%" title="Filling ${dashboardQty(day.filling)} pcs">
  //             <span>${day.filling ? dashboardQty(day.filling) : "0"}</span>
  //           </div>
  //           <div class="dashboard-vbar press" style="height:${pressHeight}%" title="Press ${dashboardQty(day.press)} pcs">
  //             <span>${day.press ? dashboardQty(day.press) : "0"}</span>
  //           </div>
  //         </div>
  //         <strong>${esc(label)}</strong>
  //       </div>`;
  //   }).join("");
  // }
  function updateDashboardChartFilterUI() {
    const mode = state.dashboard.chartMode || "7days";
    const monthWrap = el("dashboardChartMonthWrap");
    const yearWrap = el("dashboardChartYearWrap");
    const startWrap = el("dashboardChartStartWrap");
    const endWrap = el("dashboardChartEndWrap");

    if (monthWrap) {
      monthWrap.hidden = mode !== "month";
    }
    if (yearWrap) {
      yearWrap.hidden = mode !== "year";
    }
    const showRange = mode === "range";
    if (startWrap) {
      startWrap.hidden = !showRange;
    }
    if (endWrap) {
      endWrap.hidden = !showRange;
    }
  }

  function renderDashboardAlerts(balanceRows, brokenToday) {
    const wrap = el("dashboardAlerts");
    if (!wrap) return;

    const alerts = [];
    const sorted = balanceRows.slice().sort((a, b) =>
      dashboardAgeDays(b.tanggalAsal) - dashboardAgeDays(a.tanggalAsal) ||
      (Number(b.remaining) || 0) - (Number(a.remaining) || 0)
    );

    sorted.filter(row => dashboardAgeDays(row.tanggalAsal) >= 2).slice(0, 2).forEach(row => {
      alerts.push({
        type: "critical",
        label: "KRITIS",
        text: `${row.produk} — sisa Press ${dashboardQty(row.remaining)} pcs sejak ${dashboardShortDate(row.tanggalAsal)}`
      });
    });

    if (alerts.length < 3) {
      sorted.filter(row => dashboardAgeDays(row.tanggalAsal) === 1).slice(0, 3 - alerts.length).forEach(row => {
        alerts.push({
          type: "warning",
          label: "PERINGATAN",
          text: `${row.produk} — sisa Press ${dashboardQty(row.remaining)} pcs sejak kemarin`
        });
      });
    }

    if (brokenToday > 0 && alerts.length < 4) {
      alerts.push({
        type: "attention",
        label: "PERHATIAN",
        text: `Botol pecah hari ini: ${dashboardQty(brokenToday)} pcs`
      });
    }

    if (balanceRows.length > 0 && alerts.length < 4) {
      alerts.push({
        type: "attention",
        label: "PERHATIAN",
        text: `${balanceRows.length} kombinasi Produk + Botol masih menunggu Press`
      });
    }

    const activeAlerts = alerts.slice(0, 4);
    dashboardSetText("dashboardAlertCount", `${activeAlerts.length} alert`);

    if (!activeAlerts.length) {
      wrap.innerHTML = `
        <div class="dashboard-alert ok">
          <span class="dashboard-alert-icon">✓</span>
          <span class="dashboard-alert-text">Tidak ada alert produksi yang perlu ditindaklanjuti.</span>
          <span class="dashboard-alert-tag">AMAN</span>
        </div>`;
      return;
    }

    wrap.innerHTML = activeAlerts.map(item => `
      <div class="dashboard-alert ${item.type}">
        <span class="dashboard-alert-icon">${item.type === "critical" ? "!" : item.type === "warning" ? "!" : "•"}</span>
        <span class="dashboard-alert-text">${esc(item.text)}</span>
        <span class="dashboard-alert-tag">${item.label}</span>
      </div>`).join("");
  }

  function renderDashboardPriority(balanceRows) {
    const tbody = el("dashboardPriorityBody");
    const pagination = el("dashboardPriorityPagination");
    const summary = el("dashboardPrioritySummary");

    if (!tbody) return;
    /* =====================================
      URUTKAN FIFO / UMUR
      Logic lama tetap dipertahankan
      ===================================== */
    const allRows = balanceRows
        .slice()
        .sort((a, b) =>
          dashboardAgeDays(b.tanggalAsal) - dashboardAgeDays(a.tanggalAsal) ||
          String(a.tanggalAsal || "").localeCompare(String(b.tanggalAsal || "")) ||
          (Number(b.remaining) || 0) - (Number(a.remaining) || 0)
        );
    /* =====================================
      PAGINATION
      ===================================== */
    const pageSize = CONFIG.DASHBOARD_PRIORITY_PAGE_SIZE;
    const totalPages =
      Math.max(1, Math.ceil(allRows.length /pageSize));
      state.dashboard.priorityPage = Math.min(Math.max(1, state.dashboard.priorityPage || 1), totalPages);
    const page = state.dashboard.priorityPage;
    const start = (page - 1) * pageSize;
    const rows = allRows.slice(start, start + pageSize);
    /* =====================================
      DATA KOSONG
      ===================================== */
    if (!allRows.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="empty-row">
            Tidak ada sisa Filling yang menunggu Press.
          </td>
        </tr>
      `;
      if (summary) {
        summary.textContent = "0 data prioritas";
      }
      if (pagination) {
        pagination.innerHTML = "";
      }
      return;
    }
    /* =====================================
      RENDER ROW
      ===================================== */
    tbody.innerHTML =
      rows.map(row => {
        const level = dashboardPriorityLevel(row);
        const age = dashboardAgeDays(row.tanggalAsal);
        const canUse = can("accessPress") && 
            isMasterValue("produk", row.produk) && isMasterValue("botol", row.botol);
        const actionTitle = !can("accessPress")
            ? "Anda tidak memiliki akses Press."
            : !isMasterValue("produk", row.produk) || !isMasterValue("botol",row.botol)
            ? "Produk/Botol historis tidak tersedia di Master."
            : "Buka form Press dengan produk ini.";
        return `
          <tr>
            <td>
              <span class="dashboard-priority-dot ${level.key}"title="${esc(level.label)}"></span>
            </td>
            <td>
              <strong>${esc(dashboardShortDate(row.tanggalAsal))}</strong>
            </td>
            <td>${esc(row.produk)}</td>
            <td>${esc(row.botol || "—")}</td>
            <td>${dashboardQty(row.qtyFilling)}</td>
            <td>${dashboardQty(row.qtyPressTerpakai)}</td>
            <td>
              <strong class="dashboard-sisa-value">${dashboardQty(row.remaining)}</strong>
            </td>
            <td>
              <span class="dashboard-age ${level.key}">
                ${age === 0 ? "Hari ini": `${age} hari`}
              </span>
            </td>
            <td>
              <button type="button" class="btn btn-primary 
                dashboard-work-btn" data-produk="${esc(row.produk)}"
                data-botol="${esc(row.botol)}" ${canUse ? "" : "disabled"}
                title="${esc(actionTitle)}">
                Kerjakan ›
              </button>
            </td>
          </tr>
        `;
      }).join("");
    /* =====================================
      SUMMARY
      ===================================== */
    const from = start + 1;
    const to = Math.min(start + pageSize, allRows.length);
    if (summary) {
      summary.textContent =`${from}–${to} dari ${allRows.length} prioritas pengerjaan`;}
    /* =====================================
      TOMBOL PAGINATION
      ===================================== */
    renderPagination(pagination, page, totalPages, nextPage => {
        state.dashboard.priorityPage = nextPage;
        renderDashboardPriority(balanceRows);
        document.querySelector(".dashboard-priority-panel")
        ?.scrollIntoView({behavior: "smooth", block: "start"});
      }
    );
  }
  // function renderDashboardPriority(balanceRows) {
  //   const tbody = el("dashboardPriorityBody");
  //   if (!tbody) return;

  //   const rows = balanceRows.slice().sort((a, b) =>
  //     dashboardAgeDays(b.tanggalAsal) - dashboardAgeDays(a.tanggalAsal) ||
  //     String(a.tanggalAsal || "").localeCompare(String(b.tanggalAsal || "")) ||
  //     (Number(b.remaining) || 0) - (Number(a.remaining) || 0)
  //   ).slice(0, 6);

  //   if (!rows.length) {
  //     tbody.innerHTML = '<tr><td colspan="9" class="empty-row">Tidak ada sisa Filling yang menunggu Press.</td></tr>';
  //     return;
  //   }

  //   tbody.innerHTML = rows.map(row => {
  //     const level = dashboardPriorityLevel(row);
  //     const age = dashboardAgeDays(row.tanggalAsal);
  //     const canUse = can("accessPress") && isMasterValue("produk", row.produk) && isMasterValue("botol", row.botol);
  //     const actionTitle = !can("accessPress")
  //       ? "Anda tidak memiliki akses Press."
  //       : !isMasterValue("produk", row.produk) || !isMasterValue("botol", row.botol)
  //         ? "Produk/Botol historis tidak tersedia di Master."
  //         : "Buka form Press dengan produk ini.";
  //     return `
  //       <tr>
  //         <td><span class="dashboard-priority-dot ${level.key}" title="${esc(level.label)}"></span></td>
  //         <td><strong>${esc(dashboardShortDate(row.tanggalAsal))}</strong></td>
  //         <td>${esc(row.produk)}</td>
  //         <td>${esc(row.botol || "—")}</td>
  //         <td>${dashboardQty(row.qtyFilling)}</td>
  //         <td>${dashboardQty(row.qtyPressTerpakai)}</td>
  //         <td><strong class="dashboard-sisa-value">${dashboardQty(row.remaining)}</strong></td>
  //         <td><span class="dashboard-age ${level.key}">${age === 0 ? "Hari ini" : `${age} hari`}</span></td>
  //         <td><button type="button" class="btn btn-primary dashboard-work-btn" data-produk="${esc(row.produk)}" data-botol="${esc(row.botol)}" ${canUse ? "" : "disabled"} title="${esc(actionTitle)}">Kerjakan ›</button></td>
  //       </tr>`;
  //   }).join("");
  // }

  function renderDashboardRemaining(balanceRows) {
    const wrap = el("dashboardRemainingBars");
    if (!wrap) return;

    const grouped = new Map();
    balanceRows.forEach(row => {
      const key = String(row.produk || "").trim() || "Tanpa Produk";
      grouped.set(key, (grouped.get(key) || 0) + (Number(row.remaining) || 0));
    });

    const rows = Array.from(grouped.entries())
      .map(([produk, remaining]) => ({ produk, remaining }))
      .sort((a, b) => b.remaining - a.remaining)
      .slice(0, 10);

    if (!rows.length) {
      wrap.innerHTML = '<div class="dashboard-empty-state">Tidak ada sisa Press.</div>';
      return;
    }

    const max = Math.max(1, ...rows.map(row => row.remaining));
    wrap.innerHTML = rows.map(row => `
      <div class="dashboard-hbar-row">
        <span class="dashboard-hbar-label" title="${esc(row.produk)}">${esc(row.produk)}</span>
        <span class="dashboard-hbar-track"><i style="width:${Math.max(3, row.remaining / max * 100)}%"></i></span>
        <strong>${dashboardQty(row.remaining)}</strong>
      </div>`).join("");
  }

  function renderDashboardOperators(entries) {
    const tbody = el("dashboardOperatorBody");
    if (!tbody) return;
    const today = todayStr();
    const grouped = new Map();

    entries.filter(entry => entry.tanggal === today).forEach(entry => {
      const operator = String(entry.operator || "").trim() || "—";
      if (!grouped.has(operator)) grouped.set(operator, { operator, filling: 0, press: 0 });
      const item = grouped.get(operator);
      const qty = Number(entry.totalQty) || 0;
      if (entry.tab === "filling") item.filling += qty;
      if (entry.tab === "press") item.press += qty;
    });

    const rows = Array.from(grouped.values())
      .map(row => ({ ...row, total: row.filling + row.press }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);

    tbody.innerHTML = rows.length ? rows.map(row => `
      <tr>
        <td><strong>${esc(row.operator)}</strong></td>
        <td>${dashboardQty(row.filling)}</td>
        <td>${dashboardQty(row.press)}</td>
        <td><strong class="dashboard-total-value">${dashboardQty(row.total)}</strong></td>
      </tr>`).join("") : '<tr><td colspan="4" class="empty-row">Belum ada data produksi hari ini.</td></tr>';
  }

  function renderDashboard() {
    if (!el("view-dashboard")) return;

    const entries = dashboardEntries();
    const today = todayStr();
    const balanceRows = getPressBalanceRows();
    const fillingToday = entries
      .filter(entry => entry.tab === "filling" && entry.tanggal === today)
      .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);
    const pressToday = entries
      .filter(entry => entry.tab === "press" && entry.tanggal === today)
      .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);
    const brokenToday = entries
      .filter(entry => entry.tanggal === today)
      .reduce((sum, entry) => sum + (Number(entry.qtyBotolPecah) || 0), 0);
    const waiting = balanceRows.reduce((sum, row) => sum + (Number(row.remaining) || 0), 0);
    const oldestDays = balanceRows.length
      ? Math.max(...balanceRows.map(row => dashboardAgeDays(row.tanggalAsal)))
      : 0;
    const fillingAll = entries
      .filter(entry => entry.tab === "filling")
      .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);
    const pressAll = entries
      .filter(entry => entry.tab === "press")
      .reduce((sum, entry) => sum + (Number(entry.totalQty) || 0), 0);
    const donePercent = fillingAll > 0 ? Math.min(100, Math.max(0, pressAll / fillingAll * 100)) : 0;

    dashboardSetText("dashboardDate", new Date().toLocaleDateString("id-ID", {
      weekday: "long", day: "2-digit", month: "long", year: "numeric"
    }));
    dashboardSetText("dashFillingToday", dashboardQty(fillingToday));
    dashboardSetText("dashPressToday", dashboardQty(pressToday));
    dashboardSetText("dashPressRemaining", dashboardQty(waiting));
    dashboardSetText("dashActiveProducts", dashboardQty(masterValues("produk").length));
    dashboardSetText("dashBrokenToday", dashboardQty(brokenToday));
    dashboardSetText("dashOldestDays", dashboardQty(oldestDays));
    dashboardSetText("dashFlowFilling", `${dashboardQty(fillingToday)} pcs`);
    dashboardSetText("dashFlowWaiting", `${dashboardQty(waiting)} pcs tertunda`);
    dashboardSetText("dashFlowPress", `${dashboardQty(pressToday)} pcs`);
    dashboardSetText("dashFlowDone", `${donePercent.toLocaleString("id-ID", { maximumFractionDigits: 1 })}% selesai`);

    renderDashboardWeekly(entries);
    renderDashboardAlerts(balanceRows, brokenToday);
    renderDashboardPriority(balanceRows);
    renderDashboardRemaining(balanceRows);
    renderDashboardOperators(entries);
  }

  function initDashboard() {
  /* =====================================================
     FILTER CHART DASHBOARD
     ===================================================== */
    const today = dashboardDateParts(todayStr()) || new Date();
    const currentMonth = dashboardMonthKey(today);
    const currentYear = String(today.getFullYear());

    if (!state.dashboard.chartMonth) {
      state.dashboard.chartMonth = currentMonth;
    }
    if (!state.dashboard.chartYear) {
      state.dashboard.chartYear = currentYear;
    }
    const modeInput = el("dashboardChartMode");
    const monthInput = el("dashboardChartMonth");
    const yearInput = el("dashboardChartYear");
    const startInput = el("dashboardChartStart");
    const endInput = el("dashboardChartEnd");
    if (modeInput) {
      modeInput.value = state.dashboard.chartMode;
    }
    if (monthInput) {
      monthInput.value = state.dashboard.chartMonth;
    }
    if (yearInput) {
      yearInput.value = state.dashboard.chartYear;
    }
    updateDashboardChartFilterUI();
    modeInput?.addEventListener(
      "change", () => {
        state.dashboard.chartMode = modeInput.value;
        updateDashboardChartFilterUI();
        renderDashboardWeekly(dashboardEntries()
        );
      }
    );

    monthInput?.addEventListener(
      "change", () => {
        state.dashboard.chartMonth = monthInput.value;
        renderDashboardWeekly(dashboardEntries());
      }
    );

    yearInput?.addEventListener(
      "change", () => {
        state.dashboard.chartYear = yearInput.value;
        renderDashboardWeekly(dashboardEntries());
      }
    );

    startInput?.addEventListener(
      "change", () => {
        state.dashboard.chartStart = startInput.value;
        if (state.dashboard.chartMode === "range") {
          renderDashboardWeekly(dashboardEntries());
        }
      }
    );

    endInput?.addEventListener(
      "change", () => {
        state.dashboard.chartEnd = endInput.value;
        if (state.dashboard.chartMode === "range") {
          renderDashboardWeekly(dashboardEntries());
        }
      }
    );
    const refreshBtn = el("dashboardRefresh");
    refreshBtn?.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      const oldText = refreshBtn.textContent;
      refreshBtn.textContent = "Menyegarkan…";
      try {
        await loadAppData();
        renderDashboard();
        toast("Dashboard berhasil diperbarui.");
      } catch (err) {
        toast(`Gagal memperbarui dashboard: ${err.message}`, true);
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = oldText;
      }
    });

    el("dashboardPriorityBody")?.addEventListener("click", event => {
      const btn = event.target.closest(".dashboard-work-btn");
      if (!btn || btn.disabled) return;
      if (!can("accessPress")) return toast("Anda tidak memiliki akses Press.", true);

      const pressTab = qs('.tab-btn[data-view="press"]');
      if (!pressTab || pressTab.hidden) return toast("Tab Press tidak tersedia untuk user ini.", true);
      pressTab.click();

      const section = el("view-press");
      const form = section ? qs(".form-panel", section) : null;
      if (!form) return;
      const produk = qs(".f-produk", form);
      const botol = qs(".f-botol", form);
      if (produk) {
        produk.value = btn.dataset.produk || "";
        produk.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (botol) {
        botol.value = btn.dataset.botol || "";
        botol.dispatchEvent(new Event("change", { bubbles: true }));
      }
      updatePressAvailabilityHint(form);
      saveFormDraft("press", form);
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    renderDashboard();
  }

  function initTabs() {
    const tabbar = el("mainTabbar");
    if (!tabbar) return;
    tabbar.addEventListener("click", event => {
      const btn = event.target.closest(".tab-btn");
      if (!btn || !state.currentUser) return;
      const view = btn.dataset.view;
      const permissionMap = {
        dashboard : "accessDashboard",
        filling: "accessFilling",
        press: "accessPress",
        laporan: "accessReports",
        master: "accessMaster"
      };

      const permisson = permissionMap[view];
      if(!permisson || !can(permisson)){
        return;
      }
      // const allowed = view === "dashboard" ? can("accessDashboard")
      //   : view === "filling" ? can("accessFilling")
      //     : view === "press" ? can("accessPress")
      //       : view === "laporan" ? can("accessReports")
      //         : view === "master" ? can("accessMaster") : false;
      // if (!allowed) return;

      qsa(".tab-btn", tabbar).forEach(node => { 
        node.classList.toggle("active", node === btn);
      });
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

  function buildLaporanPrintHtml(options = {}) {
    if (!state.lastLaporan || !Array.isArray(state.lastLaporan.rows) || !state.lastLaporan.rows.length) {
      return "";
    }

    const rows = state.lastLaporan.rows;
    const reportId = state.lastLaporan.id || genLaporanId();
    const title = options.title || "Laporan Hasil Pengerjaan";
    const created = el("lap-created")?.textContent || fmtDateTime(nowIso());
    const by = el("lap-by")?.textContent || "—";
    const period = el("lap-period")?.textContent || "Semua tanggal";

    const totalKardus = rows.reduce((sum, e) => sum + (Number(e.qtyKardus) || 0), 0);
    const totalQty = rows.reduce((sum, e) => sum + (Number(e.totalQty) || 0), 0);
    const totalPecah = rows.reduce((sum, e) => sum + (Number(e.qtyBotolPecah) || 0), 0);

    const bodyRows = rows.map(e => `
      <tr>
        <td class="mono">${esc(e.reportId)}</td>
        <td>${esc(LINE_LABEL[e.tab] || e.tab)}</td>
        <td>${esc(e.tanggal)}</td>
        <td>${esc(e.operator)}</td>
        <td class="wrap">${esc(e.produk)}</td>
        <td class="wrap">${esc(e.botol)}</td>
        <td class="num">${(Number(e.qtyKardus) || 0).toLocaleString("id-ID")}</td>
        <td class="num">${(Number(e.totalQty) || 0).toLocaleString("id-ID")}</td>
        <td class="num">${(Number(e.qtyBotolPecah) || 0).toLocaleString("id-ID")}</td>
      </tr>`).join("");

    return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(reportId)}</title>
  <style>
    @page { size: A4 landscape; margin: 8mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #111827; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 9px; line-height: 1.35; }
    .report { width: 100%; }
    .header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 8px; }
    .company { font-size: 8px; font-weight: 700; letter-spacing: .08em; color: #8a4a0c; text-transform: uppercase; margin-bottom: 2px; }
    h1 { margin: 0; font-size: 16px; line-height: 1.2; }
    .report-id { margin-top: 4px; font-family: Consolas, monospace; font-weight: 700; font-size: 10px; }
    .meta { min-width: 260px; text-align: right; font-size: 8px; line-height: 1.55; }
    .meta div { white-space: nowrap; }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 0 0 8px; }
    .stat { border: 1px solid #d1d5db; padding: 5px 7px; text-align: center; border-radius: 4px; }
    .stat strong { display: block; font-size: 12px; }
    .stat span { display: block; margin-top: 1px; font-size: 7px; color: #4b5563; text-transform: uppercase; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th, td { border: 1px solid #cfd6dd; padding: 3px 4px; vertical-align: top; }
    th { background: #eef2f5; font-size: 7.4px; text-transform: uppercase; letter-spacing: .02em; text-align: left; }
    td { font-size: 7.8px; }
    .mono { font-family: Consolas, "Courier New", monospace; font-size: 7.2px; }
    .num { text-align: right; white-space: nowrap; }
    .wrap { overflow-wrap: anywhere; word-break: break-word; }
    th:nth-child(1), td:nth-child(1) { width: 14%; }
    th:nth-child(2), td:nth-child(2) { width: 7%; }
    th:nth-child(3), td:nth-child(3) { width: 9%; }
    th:nth-child(4), td:nth-child(4) { width: 13%; }
    th:nth-child(5), td:nth-child(5) { width: 20%; }
    th:nth-child(6), td:nth-child(6) { width: 15%; }
    th:nth-child(7), td:nth-child(7) { width: 7%; }
    th:nth-child(8), td:nth-child(8) { width: 8%; }
    th:nth-child(9), td:nth-child(9) { width: 7%; }
    .footer-note { margin-top: 6px; color: #6b7280; font-size: 7px; text-align: right; }
    @media print {
      html, body { width: 100%; }
      .report { break-after: auto; }
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  </style>
</head>
<body>
  <main class="report">
    <section class="header">
      <div>
        <div class="company">PT. ABSH FRAGRANCE CREATIONS</div>
        <h1>${esc(title)}</h1>
        <div class="report-id">${esc(reportId)}</div>
      </div>
      <div class="meta">
        <div><strong>Dibuat:</strong> ${esc(created)}</div>
        <div><strong>Oleh:</strong> ${esc(by)}</div>
        <div><strong>Periode:</strong> ${esc(period)}</div>
      </div>
    </section>

    <section class="stats">
      <div class="stat"><strong>${rows.length.toLocaleString("id-ID")}</strong><span>Total Entri</span></div>
      <div class="stat"><strong>${totalKardus.toLocaleString("id-ID")}</strong><span>Total Kardus</span></div>
      <div class="stat"><strong>${totalQty.toLocaleString("id-ID")}</strong><span>Total Qty Botol</span></div>
      <div class="stat"><strong>${totalPecah.toLocaleString("id-ID")}</strong><span>Total Botol Pecah</span></div>
    </section>

    <table>
      <thead>
        <tr>
          <th>ID</th><th>Line</th><th>Tanggal</th><th>Operator</th><th>Produk</th><th>Botol</th><th>Kardus</th><th>Total Qty</th><th>Qty Pecah</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <div class="footer-note">Total ${rows.length.toLocaleString("id-ID")} entri — seluruh data laporan dicetak tanpa pagination.</div>
  </main>
</body>
</html>`;
  }

  function openLaporanPrintDialog(mode = "pdf") {
    if (!state.lastLaporan || !state.lastLaporan.rows?.length) {
      toast("Buat laporan terlebih dahulu sebelum export/cetak.", true);
      return;
    }

    const html = buildLaporanPrintHtml({
      title: mode === "pdf" ? "Laporan Hasil Pengerjaan" : "Laporan Hasil Pengerjaan"
    });
    if (!html) {
      toast("Data laporan tidak tersedia.", true);
      return;
    }

    // Dibuka langsung dari event klik agar tidak dianggap popup oleh browser.
    const printWindow = window.open("", "_blank", "width=1280,height=860");
    if (!printWindow) {
      toast("Popup diblokir browser. Izinkan popup untuk melakukan Export PDF/Cetak.", true);
      return;
    }

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();

    const doPrint = () => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch (err) {
        toast(`Gagal membuka dialog cetak: ${err.message}`, true);
      }
    };

    if (printWindow.document.readyState === "complete") {
      setTimeout(doPrint, 250);
    } else {
      printWindow.addEventListener("load", () => setTimeout(doPrint, 250), { once: true });
    }

    if (mode === "pdf") {
      toast("Dialog PDF dibuka. Pilih 'Save as PDF' / 'Simpan sebagai PDF'.");
    }
  }

  function initLaporan() {
    const generate = el("lap-generate");
    if (!generate) return;

    generate.addEventListener("click", () => {
      if (!can("accessReports")) return toast("Anda tidak memiliki akses Laporan.", true);
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

    el("lap-pdf")?.addEventListener("click", () => openLaporanPrintDialog("pdf"));
    el("lap-print")?.addEventListener("click", () => openLaporanPrintDialog("print"));
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

  renderDashboard();
}

  function initMasterData() {
    qsa(".chip-list").forEach(wrap => {
      wrap.addEventListener("click", async event => {
        const btn = event.target.closest("button[data-cat]");
        if (!btn) return;
        if (!can("accessMaster")) return toast("Anda tidak memiliki akses Setting / Master Data.", true);
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
        if (!can("accessMaster")) return toast("Anda tidak memiliki akses Setting / Master Data.", true);
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
      if (!can("accessMaster")) return toast("Anda tidak memiliki akses Setting / Master Data.", true);
      const btn = event.currentTarget;
      btn.disabled = true;
      try { await loadBootstrap(); await loadAppData(); toast("Data terbaru sudah dimuat dari Spreadsheet."); }
      catch (err) { toast(err.message, true); }
      finally { btn.disabled = false; }
    });

    el("masterCsvExport")?.addEventListener("click", () => {
      if (!can("accessMaster")) return toast("Anda tidak memiliki akses Setting / Master Data.", true);
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
        <td class="row-actions">
          ${user.role === "user" ? `<button type="button" class="btn btn-ghost btn-access-user" data-username="${esc(user.username)}">Atur Akses</button>` : '<span class="permission-full">Akses penuh</span>'}
          ${user.username === state.currentUser.username ? "" : `<button type="button" class="btn btn-danger btn-del-user" data-username="${esc(user.username)}">Hapus</button>`}
        </td>
      </tr>`).join("");
  }

  function initUserManagement() {
    const form = el("userAddForm");
    const tbody = el("userTbody");
    if (!form || !tbody) return;
    const modal = el("permissionModal");
    const permissionGrid = el("permissionGrid");
    let permissionUsername = "";

    function closePermissionModal() {
      permissionUsername = "";
      if (modal) modal.hidden = true;
    }

    function openPermissionModal(user) {
      if (!modal || !permissionGrid || !user || user.role !== "user") return;
      permissionUsername = user.username;
      el("permissionUserLabel").textContent = `${user.name} (@${user.username})`;
      const perms = { ...DEFAULT_USER_PERMISSIONS, ...(user.permissions || {}) };
      qsa("input[data-permission]", permissionGrid).forEach(input => { input.checked = perms[input.dataset.permission] === true; });
      modal.hidden = false;
    }

    el("permissionClose")?.addEventListener("click", closePermissionModal);
    modal?.addEventListener("click", event => { if (event.target === modal) closePermissionModal(); });
    el("permissionSave")?.addEventListener("click", async () => {
      if (!permissionUsername || !state.currentUser || state.currentUser.role !== "superuser") return;
      const btn = el("permissionSave");
      btn.disabled = true;
      try {
        const permissions = {};
        qsa("input[data-permission]", permissionGrid).forEach(input => { permissions[input.dataset.permission] = input.checked; });
        const data = await apiPost("user.permissions.set", { username: permissionUsername, permissions });
        state.users = data.users || [];
        renderUsers();
        closePermissionModal();
        toast("Hak akses user berhasil disimpan.");
      } catch (err) { toast(err.message, true); }
      finally { btn.disabled = false; }
    });

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
      const accessBtn = event.target.closest(".btn-access-user");
      if (accessBtn) {
        const user = state.users.find(item => item.username === accessBtn.dataset.username);
        openPermissionModal(user);
        return;
      }
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
    initDashboard();
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
        renderEntries("filling");
        renderEntries("press");
        renderPressBalance();
        renderUserHeader();
        applyAccessControl();
        renderDashboard();
        el("appScreen").hidden = false;
        setConnection("loading", "Menyegarkan data…");
      }
    } catch (_) {}

    function initDashboardSlider() {
    const track = document.getElementById("dashboardSliderTrack");
    const prevBtn = document.getElementById("dashboardSliderPrev");
    const nextBtn = document.getElementById("dashboardSliderNext");

    if (!track || !prevBtn || !nextBtn) return;

    const slides = Array.from(
      track.querySelectorAll(".dashboard-slide")
    );

    let currentSlide = 0;

    function updateSlider() {
      track.style.transform =
        `translateX(-${currentSlide * 100}%)`;

      prevBtn.disabled = currentSlide === 0;
      nextBtn.disabled =
        currentSlide === slides.length - 1;
    }

    prevBtn.addEventListener("click", () => {
      if (currentSlide > 0) {
        currentSlide--;
        updateSlider();
      }
    });

    nextBtn.addEventListener("click", () => {
      if (currentSlide < slides.length - 1) {
        currentSlide++;
        updateSlider();
      }
    });

    updateSlider();
  }

  document.addEventListener("DOMContentLoaded", () => {
  initDashboardSlider();
  });
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
