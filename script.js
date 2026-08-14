/* =========================================================
   Laporan Produksi — script.js
   Semua data disimpan di localStorage (tanpa reload/server).
   ========================================================= */
(function () {
  "use strict";

  /* ---------------- storage keys ---------------- */
  const LS_USERS   = "ppr_users_v1";
  const LS_MASTER  = "ppr_master_v1";
  const LS_ENTRIES = "ppr_entries_v1";
  const LS_SESSION = "ppr_session_v1";
  const LS_SEQ     = "ppr_seq_v1";

  const LINE_LABEL = { filling: "Filling", press: "Press" };

  /* ---------------- storage helpers ---------------- */
  function lsGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  /* ================= role permissions ================= */
  const rolePermissions = {
    superuser: {
      canCreate: true,
      canUpdateOwn: true,
      canUpdateOthers: true,
      canDeleteOwn: true,
      canDeleteOthers: true,
      canManageMaster: true,
      canManageUsers: true
    },
    user: {
      canCreate: true,
      canUpdateOwn: true,
      canUpdateOthers: false,
      canDeleteOwn: false,  // dapat diubah sesuai konfigurasi
      canDeleteOthers: false,
      canManageMaster: false,
      canManageUsers: false
    }
  };

  /* ---------------- seed defaults ---------------- */
  function seedIfEmpty() {
    if (!localStorage.getItem(LS_USERS)) {
      lsSet(LS_USERS, [
        { name: "Administrator", username: "admin", password: "admin123", role: "superuser", permissions: rolePermissions.superuser },
        { name: "User Operator", username: "operator", password: "operator123", role: "user", permissions: rolePermissions.user }
      ]);
    } else {
      // Upgrade existing users dengan permissions jika belum ada
      const users = lsGet(LS_USERS, []);
      let updated = false;
      users.forEach(u => {
        if (!u.permissions) {
          u.permissions = rolePermissions[u.role] || rolePermissions.user;
          updated = true;
        }
      });
      if (updated) lsSet(LS_USERS, users);
    }
    if (!localStorage.getItem(LS_MASTER)) {
      const botolList = ["Botol PET 600ml", "Botol PET 1500ml", "Botol Kaca 620ml"];
      lsSet(LS_MASTER, {
        operator: ["Budi Santoso", "Siti Aminah", "Rudi Hartono", "Dewi Lestari"],
        produk: ["Air Mineral 600ml", "Air Mineral 1500ml", "Sirup Botol 620ml"],
        botol: botolList,
        botolpecah: botolList.slice()
      });
    }
    if (!localStorage.getItem(LS_ENTRIES)) lsSet(LS_ENTRIES, []);
    if (!localStorage.getItem(LS_SEQ)) lsSet(LS_SEQ, {});
  }
  seedIfEmpty();

  /* ---------------- small utils ---------------- */
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function todayStr() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function nowIso() { return new Date().toISOString(); }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function pad3(n) { return String(n).padStart(3, "0"); }
  function nextSeq(key) {
    const seq = lsGet(LS_SEQ, {});
    seq[key] = (seq[key] || 0) + 1;
    lsSet(LS_SEQ, seq);
    return seq[key];
  }
  function genEntryId(line) {
    const d = todayStr().replace(/-/g, "");
    const prefix = line === "filling" ? "FIL" : "PRS";
    return `${prefix}-${d}-${pad3(nextSeq(line + "-" + todayStr()))}`;
  }
  function genLaporanId() {
    const d = todayStr().replace(/-/g, "");
    return `LAP-${d}-${pad3(nextSeq("laporan-" + todayStr()))}`;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------------- toast ---------------- */
  const toastEl = document.createElement("div");
  toastEl.id = "toast";
  document.body.appendChild(toastEl);
  let toastTimer = null;
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.className = isErr ? "err show" : "show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = ""; }, 2600);
  }

  /* ---------------- CSV helpers ---------------- */
  function parseCSV(text) {
    const lines = text.replace(/\r/g, "").split("\n").map(l => l.trim()).filter(Boolean);
    const rows = [];
    lines.forEach(line => {
      const idx = line.indexOf(",");
      if (idx === -1) return;
      const a = line.slice(0, idx).trim().replace(/^"|"$/g, "");
      const b = line.slice(idx + 1).trim().replace(/^"|"$/g, "");
      if (a.toLowerCase() === "kategori") return; // skip header
      if (!a || !b) return;
      rows.push({ kategori: a.toLowerCase(), nilai: b });
    });
    return rows;
  }
  function toCSV(headers, rows) {
    const esc2 = v => {
      v = String(v == null ? "" : v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const lines = [headers.map(esc2).join(",")];
    rows.forEach(r => lines.push(r.map(esc2).join(",")));
    return lines.join("\n");
  }
  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  function normalizeCategory(raw) {
    const s = raw.toLowerCase().replace(/[^a-z]/g, "");
    if (s.includes("operator")) return "operator";
    if (s.includes("produk") || s.includes("product")) return "produk";
    if (s.includes("pecah")) return "botolpecah";
    if (s.includes("botol")) return "botol";
    return null;
  }

  /* ================= state ================= */
  let currentUser = null;
  const searchState = { filling: { operator: "", date: "" }, press: { operator: "", date: "" } };
  let lastLaporan = null;

  /* ================= DOM refs ================= */
  const appScreen = document.getElementById("appScreen");
  const deviceDateDisplay = document.getElementById("deviceDateDisplay");
  const userAvatar = document.getElementById("userAvatar");
  const userNameEl = document.getElementById("userName");
  const userRoleEl = document.getElementById("userRole");
  const logoutBtn = document.getElementById("logoutBtn");
  const masterTabBtn = document.getElementById("masterTabBtn");
  const mainTabbar = document.getElementById("mainTabbar");

  /* ================= build press view by cloning filling view ================= */
  function buildLineViews() {
    const fillingSection = document.getElementById("view-filling");
    fillingSection.querySelectorAll("[id]").forEach(el => el.removeAttribute("id")); // avoid dup ids on clone
    const pressClone = fillingSection.cloneNode(true);
    pressClone.id = "view-press";
    pressClone.dataset.line = "press";
    pressClone.hidden = true;
    pressClone.querySelectorAll("[data-line]").forEach(el => (el.dataset.line = "press"));
    pressClone.querySelectorAll("h2").forEach(h => (h.textContent = h.textContent.replace("Filling", "Press")));
    document.getElementById("view-press").replaceWith(pressClone);
  }
  buildLineViews();

  /* ================= dropdown refresh ================= */
  function refreshAllDropdowns() {
    const master = lsGet(LS_MASTER, {});
    document.querySelectorAll(".f-operator").forEach(s => fillSelectKeepPlaceholder(s, master.operator || [], "— Pilih operator —"));
    document.querySelectorAll(".f-produk").forEach(s => fillSelectKeepPlaceholder(s, master.produk || [], "— Pilih produk —"));
    document.querySelectorAll(".f-botol").forEach(s => fillSelectKeepPlaceholder(s, master.botol || [], "— Pilih jenis botol —"));
    document.querySelectorAll(".f-botol-pecah").forEach(s => fillSelectKeepPlaceholder(s, master.botolpecah || [], "— Pilih jenis —"));
    document.querySelectorAll(".f-search-operator").forEach(s => fillSelectKeepPlaceholder(s, master.operator || [], "Semua operator"));
    const lapOp = document.getElementById("lap-operator");
    if (lapOp) fillSelectKeepPlaceholder(lapOp, master.operator || [], "Semua operator");
  }
  function fillSelectKeepPlaceholder(select, list, placeholderText) {
    const cur = select.value;
    select.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = ""; ph.textContent = placeholderText;
    select.appendChild(ph);
    list.forEach(v => {
      const o = document.createElement("option");
      o.value = v; o.textContent = v;
      select.appendChild(o);
    });
    if (list.includes(cur)) select.value = cur;
  }

  /* ================= line view wiring (form + table) ================= */
  function wireLineView(line) {
    const section = document.getElementById("view-" + line);
    const form = section.querySelector(".form-panel");
    const editingIdInput = form.querySelector(".f-editing-id");
    const tanggalInput = form.querySelector(".f-tanggal");
    const totalInput = form.querySelector(".f-total");
    const qtyKardus = form.querySelector(".f-qty-kardus");
    const qtyBotol = form.querySelector(".f-qty-botol");
    const submitBtn = form.querySelector(".f-submit-btn");
    const cancelBtn = form.querySelector(".f-cancel-btn");
    const errorEl = form.querySelector(".f-error");
    const stampEl = form.querySelector(".stamp");

    tanggalInput.value = todayStr();

    function recalcTotal() {
      const k = parseFloat(qtyKardus.value) || 0;
      const b = parseFloat(qtyBotol.value) || 0;
      totalInput.value = (k * b).toLocaleString("id-ID");
    }
    qtyKardus.addEventListener("input", recalcTotal);
    qtyBotol.addEventListener("input", recalcTotal);

    function resetForm() {
      form.reset();
      editingIdInput.value = "";
      tanggalInput.value = todayStr();
      totalInput.value = "0";
      submitBtn.textContent = "+ Tambah List";
      cancelBtn.hidden = true;
      stampEl.textContent = "ID otomatis";
      errorEl.hidden = true;
      form.querySelector(".f-qty-pecah").value = "0";
    }
    cancelBtn.addEventListener("click", resetForm);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errorEl.hidden = true;
      const operator = form.querySelector(".f-operator").value;
      const produk = form.querySelector(".f-produk").value;
      const botol = form.querySelector(".f-botol").value;
      const kardus = parseFloat(qtyKardus.value);
      const botolPerKardus = parseFloat(qtyBotol.value);
      const botolPecahJenis = form.querySelector(".f-botol-pecah").value;
      const qtyPecah = parseFloat(form.querySelector(".f-qty-pecah").value) || 0;

      if (!operator || !produk || !botol || isNaN(kardus) || kardus < 0 || isNaN(botolPerKardus) || botolPerKardus < 0) {
        errorEl.textContent = "Lengkapi Operator, Produk, Botol, Qty Kardus, dan Qty Botol per Kardus dengan benar.";
        errorEl.hidden = false;
        return;
      }

      const editingId = editingIdInput.value;
      let entries = lsGet(LS_ENTRIES, []);

      if (editingId) {
        const idx = entries.findIndex(x => x.id === editingId);
        if (idx === -1) { toast("Data tidak ditemukan.", true); resetForm(); return; }
        const target = entries[idx];
        const userPerms = currentUser.permissions || rolePermissions[currentUser.role];
        const isOwner = target.createdBy === currentUser.username;
        const canUpdate = (isOwner && userPerms.canUpdateOwn) || (!isOwner && userPerms.canUpdateOthers);
        if (!canUpdate) {
          toast("Anda tidak berhak mengubah data ini.", true);
          return;
        }
        entries[idx] = {
          ...target,
          operator, produk, botol,
          qtyKardus: kardus, qtyBotolPerKardus: botolPerKardus,
          totalQty: kardus * botolPerKardus,
          botolPecahJenis, qtyBotolPecah: qtyPecah,
          updatedAt: nowIso()
        };
        lsSet(LS_ENTRIES, entries);
        
        // 📤 Kirim update ke Google Sheets jika webhook sudah dikonfigurasi
        const webhookUrl = window.SheetsIntegration.getWebhookUrl();
        if (webhookUrl) {
          window.SheetsIntegration.appendEntry(entries[idx], webhookUrl).catch(err => {
            console.warn("⚠️ Gagal update Google Sheets, tapi data sudah disimpan locally", err);
          });
        }
        
        toast("Perubahan disimpan.");
      } else {
        const entry = {
          id: uid(),
          reportId: genEntryId(line),
          tab: line,
          tanggal: todayStr(),
          operator, produk, botol,
          qtyKardus: kardus, qtyBotolPerKardus: botolPerKardus,
          totalQty: kardus * botolPerKardus,
          botolPecahJenis, qtyBotolPecah: qtyPecah,
          createdBy: currentUser.username,
          createdByName: currentUser.name,
          createdAt: nowIso(), updatedAt: nowIso()
        };
        entries.push(entry);
        lsSet(LS_ENTRIES, entries);
        
        // 📤 Kirim data ke Google Sheets jika webhook sudah dikonfigurasi
        const webhookUrl = window.SheetsIntegration.getWebhookUrl();
        if (webhookUrl) {
          window.SheetsIntegration.appendEntry(entry, webhookUrl).catch(err => {
            console.warn("⚠️ Gagal mengirim ke Google Sheets, tapi data sudah disimpan locally", err);
          });
        }
        
        toast(`Data ditambahkan — ID ${entry.reportId}`);
      }
      resetForm();
      renderEntries(line);
    });

    // search
    const searchOperator = section.querySelector(".f-search-operator");
    const searchDate = section.querySelector(".f-search-date");
    const searchReset = section.querySelector(".f-search-reset");
    searchOperator.addEventListener("change", () => { searchState[line].operator = searchOperator.value; renderEntries(line); });
    searchDate.addEventListener("change", () => { searchState[line].date = searchDate.value; renderEntries(line); });
    searchReset.addEventListener("click", () => {
      searchState[line] = { operator: "", date: "" };
      searchOperator.value = ""; searchDate.value = "";
      renderEntries(line);
    });

    // export
    section.querySelector(".f-export-btn").addEventListener("click", () => {
      const rows = filteredEntries(line);
      if (!rows.length) { toast("Tidak ada data untuk diexport.", true); return; }
      const csv = toCSV(
        ["ID Pengerjaan", "Line", "Tanggal", "Operator", "Produk", "Botol Digunakan", "Qty Kardus", "Qty Botol per Kardus", "Total Qty", "Jenis Botol Pecah", "Qty Botol Pecah", "Dibuat Oleh"],
        rows.map(e => [e.reportId, LINE_LABEL[e.tab], e.tanggal, e.operator, e.produk, e.botol, e.qtyKardus, e.qtyBotolPerKardus, e.totalQty, e.botolPecahJenis || "", e.qtyBotolPecah, e.createdByName || e.createdBy])
      );
      downloadText(`laporan-${line}-${todayStr()}.csv`, csv);
      toast("File CSV diunduh (tersimpan sebagai spreadsheet).");
    });

    // table action delegation
    const tbody = section.querySelector(".f-tbody");
    tbody.addEventListener("click", e => {
      const editBtn = e.target.closest(".btn-edit");
      const delBtn = e.target.closest(".btn-delete");
      if (editBtn) {
        const entries = lsGet(LS_ENTRIES, []);
        const entry = entries.find(x => x.id === editBtn.dataset.id);
        if (!entry) return;
        const userPerms = currentUser.permissions || rolePermissions[currentUser.role];
        const isOwner = entry.createdBy === currentUser.username;
        const canUpdate = (isOwner && userPerms.canUpdateOwn) || (!isOwner && userPerms.canUpdateOthers);
        if (!canUpdate) {
          toast("Anda tidak berhak mengubah data ini.", true); return;
        }
        editingIdInput.value = entry.id;
        tanggalInput.value = entry.tanggal;
        form.querySelector(".f-operator").value = entry.operator;
        form.querySelector(".f-produk").value = entry.produk;
        form.querySelector(".f-botol").value = entry.botol;
        qtyKardus.value = entry.qtyKardus;
        qtyBotol.value = entry.qtyBotolPerKardus;
        form.querySelector(".f-botol-pecah").value = entry.botolPecahJenis || "";
        form.querySelector(".f-qty-pecah").value = entry.qtyBotolPecah;
        recalcTotal();
        submitBtn.textContent = "Simpan Perubahan";
        cancelBtn.hidden = false;
        stampEl.textContent = entry.reportId;
        form.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (delBtn) {
        const entries = lsGet(LS_ENTRIES, []);
        const entry = entries.find(x => x.id === delBtn.dataset.id);
        const userPerms = currentUser.permissions || rolePermissions[currentUser.role];
        const isOwner = entry.createdBy === currentUser.username;
        const canDelete = (isOwner && userPerms.canDeleteOwn) || (!isOwner && userPerms.canDeleteOthers);
        if (!canDelete) { 
          toast("Anda tidak berhak menghapus data ini.", true); 
          return; 
        }
        if (!confirm("Hapus data pengerjaan ini? Tindakan tidak dapat dibatalkan.")) return;
        let allEntries = lsGet(LS_ENTRIES, []);
        allEntries = allEntries.filter(x => x.id !== delBtn.dataset.id);
        lsSet(LS_ENTRIES, allEntries);
        toast("Data dihapus.");
        renderEntries(line);
      }
    });
  }

  function filteredEntries(line) {
    const entries = lsGet(LS_ENTRIES, []).filter(e => e.tab === line);
    const f = searchState[line];
    return entries
      .filter(e => !f.operator || e.operator === f.operator)
      .filter(e => !f.date || e.tanggal === f.date)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  function renderEntries(line) {
    const section = document.getElementById("view-" + line);
    const tbody = section.querySelector(".f-tbody");
    const rows = filteredEntries(line);
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="11" class="empty-row">Belum ada data untuk kriteria ini.</td></tr>`;
    } else {
      const userPerms = currentUser.permissions || rolePermissions[currentUser.role];
      tbody.innerHTML = rows.map(e => {
        const isOwner = e.createdBy === currentUser.username;
        const canEdit = (isOwner && userPerms.canUpdateOwn) || (!isOwner && userPerms.canUpdateOthers);
        const canDelete = (isOwner && userPerms.canDeleteOwn) || (!isOwner && userPerms.canDeleteOthers);
        return `<tr>
          <td><span class="id-badge">${esc(e.reportId)}</span></td>
          <td>${esc(e.tanggal)}</td>
          <td>${esc(e.operator)}</td>
          <td>${esc(e.produk)}</td>
          <td>${esc(e.botol)}</td>
          <td>${e.qtyKardus}</td>
          <td>${e.qtyBotolPerKardus}</td>
          <td><strong>${e.totalQty}</strong></td>
          <td>${esc(e.botolPecahJenis || "—")}</td>
          <td class="${e.qtyBotolPecah > 0 ? "pecah-tag" : ""}">${e.qtyBotolPecah}</td>
          <td class="row-actions">
            ${canEdit ? `<button class="btn btn-ghost btn-edit" data-id="${e.id}">Ubah</button>` : ""}
            ${canDelete ? `<button class="btn btn-danger btn-delete" data-id="${e.id}">Hapus</button>` : ""}
          </td>
        </tr>`;
      }).join("");
    }
    const totalQty = rows.reduce((s, e) => s + e.totalQty, 0);
    const totalPecah = rows.reduce((s, e) => s + e.qtyBotolPecah, 0);
    section.querySelector(".f-summary").textContent =
      `${rows.length} entri ditampilkan · Total Qty Botol: ${totalQty.toLocaleString("id-ID")} · Total Botol Pecah: ${totalPecah.toLocaleString("id-ID")}`;
  }

  /* ================= tabs ================= */
  mainTabbar.addEventListener("click", e => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    const view = btn.dataset.view;
    if (view === "master" && currentUser.role !== "superuser") return;
    mainTabbar.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".content > .view").forEach(v => {
      v.hidden = v.id !== "view-" + view;
    });
  });

  /* ================= laporan ================= */
  function initLaporan() {
    document.getElementById("lap-generate").addEventListener("click", () => {
      const lineSel = document.getElementById("lap-line").value;
      const opSel = document.getElementById("lap-operator").value;
      const start = document.getElementById("lap-start").value;
      const end = document.getElementById("lap-end").value;

      let rows = lsGet(LS_ENTRIES, []);
      if (lineSel !== "all") rows = rows.filter(e => e.tab === lineSel);
      if (opSel) rows = rows.filter(e => e.operator === opSel);
      if (start) rows = rows.filter(e => e.tanggal >= start);
      if (end) rows = rows.filter(e => e.tanggal <= end);
      rows = rows.sort((a, b) => (a.tanggal < b.tanggal ? -1 : 1));

      const resultBlock = document.getElementById("lap-result");
      if (!rows.length) {
        resultBlock.hidden = true;
        toast("Tidak ada data yang cocok dengan kriteria laporan.", true);
        return;
      }

      const lapId = genLaporanId();
      lastLaporan = { id: lapId, rows };

      document.getElementById("lap-id").textContent = lapId;
      document.getElementById("lap-created").textContent = fmtDateTime(nowIso());
      document.getElementById("lap-by").textContent = `${currentUser.name} (${currentUser.role === "superuser" ? "Super User" : "User"})`;
      document.getElementById("lap-period").textContent = (start || end) ? `${start || "…"} s/d ${end || "…"}` : "Semua tanggal";

      document.getElementById("lap-total-entries").textContent = rows.length;
      document.getElementById("lap-total-kardus").textContent = rows.reduce((s, e) => s + e.qtyKardus, 0).toLocaleString("id-ID");
      document.getElementById("lap-total-qty").textContent = rows.reduce((s, e) => s + e.totalQty, 0).toLocaleString("id-ID");
      document.getElementById("lap-total-pecah").textContent = rows.reduce((s, e) => s + e.qtyBotolPecah, 0).toLocaleString("id-ID");

      document.getElementById("lap-tbody").innerHTML = rows.map(e => `<tr>
          <td><span class="id-badge">${esc(e.reportId)}</span></td>
          <td>${LINE_LABEL[e.tab]}</td>
          <td>${esc(e.tanggal)}</td>
          <td>${esc(e.operator)}</td>
          <td>${esc(e.produk)}</td>
          <td>${esc(e.botol)}</td>
          <td>${e.qtyKardus}</td>
          <td><strong>${e.totalQty}</strong></td>
          <td class="${e.qtyBotolPecah > 0 ? "pecah-tag" : ""}">${e.qtyBotolPecah}</td>
        </tr>`).join("");

      resultBlock.hidden = false;
      toast(`Laporan dibuat — ${lapId}`);
    });

    document.getElementById("lap-export").addEventListener("click", () => {
      if (!lastLaporan) return;
      const csv = toCSV(
        ["ID Laporan", "ID Pengerjaan", "Line", "Tanggal", "Operator", "Produk", "Botol", "Qty Kardus", "Total Qty", "Qty Pecah"],
        lastLaporan.rows.map(e => [lastLaporan.id, e.reportId, LINE_LABEL[e.tab], e.tanggal, e.operator, e.produk, e.botol, e.qtyKardus, e.totalQty, e.qtyBotolPecah])
      );
      downloadText(`${lastLaporan.id}.csv`, csv);
      toast("Laporan diexport ke CSV.");
    });
    document.getElementById("lap-print").addEventListener("click", () => window.print());
  }

  /* ================= master data (superuser) ================= */
  function renderMasterChips() {
    const master = lsGet(LS_MASTER, {});
    ["operator", "produk", "botol", "botolpecah"].forEach(cat => {
      const list = master[cat] || [];
      const wrap = document.querySelector(`.chip-list[data-cat="${cat}"]`);
      wrap.innerHTML = list.length
        ? list.map((v, i) => `<span class="chip">${esc(v)}<button data-cat="${cat}" data-idx="${i}" title="Hapus">✕</button></span>`).join("")
        : `<span style="color:var(--ink-faint); font-size:12px;">Belum ada data.</span>`;
    });
  }
  function initMasterData() {
    renderMasterChips();

    document.querySelectorAll(".chip-list").forEach(wrap => {
      wrap.addEventListener("click", e => {
        const btn = e.target.closest("button");
        if (!btn) return;
        const master = lsGet(LS_MASTER, {});
        master[btn.dataset.cat].splice(Number(btn.dataset.idx), 1);
        lsSet(LS_MASTER, master);
        renderMasterChips();
        refreshAllDropdowns();
        toast("Item master dihapus.");
      });
    });

    document.querySelectorAll(".chip-add").forEach(wrap => {
      const cat = wrap.dataset.cat;
      const input = wrap.querySelector("input");
      const btn = wrap.querySelector("button");
      function add() {
        const val = input.value.trim();
        if (!val) return;
        const master = lsGet(LS_MASTER, {});
        master[cat] = master[cat] || [];
        if (master[cat].some(v => v.toLowerCase() === val.toLowerCase())) {
          toast("Item sudah ada di daftar.", true); return;
        }
        master[cat].push(val);
        lsSet(LS_MASTER, master);
        input.value = "";
        renderMasterChips();
        refreshAllDropdowns();
        toast("Item master ditambahkan.");
      }
      btn.addEventListener("click", add);
      input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    });

    document.getElementById("masterCsvInput").addEventListener("change", function () {
      const file = this.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const rows = parseCSV(String(reader.result));
        const master = lsGet(LS_MASTER, {});
        let count = 0;
        rows.forEach(r => {
          const cat = normalizeCategory(r.kategori);
          if (!cat) return;
          master[cat] = master[cat] || [];
          if (!master[cat].some(v => v.toLowerCase() === r.nilai.toLowerCase())) {
            master[cat].push(r.nilai);
            count++;
          }
        });
        lsSet(LS_MASTER, master);
        renderMasterChips();
        refreshAllDropdowns();
        toast(`${count} item master diimpor dari CSV.`);
        this.value = "";
      };
      reader.readAsText(file);
    });

    document.getElementById("masterCsvExport").addEventListener("click", () => {
      const master = lsGet(LS_MASTER, {});
      const rows = [];
      Object.keys(master).forEach(cat => (master[cat] || []).forEach(v => rows.push([cat, v])));
      downloadText(`master-data-${todayStr()}.csv`, toCSV(["kategori", "nilai"], rows));
      toast("Data master diunduh sebagai CSV.");
    });
  }

  /* ================= user management (superuser) ================= */
  let editingUserForPerms = null;
  let tempPermissions = {};

  const permissionDescriptions = {
    canCreate: { label: "Buat Data", desc: "Membuat data baru" },
    canUpdateOwn: { label: "Update Milik Sendiri", desc: "Mengubah data sendiri" },
    canUpdateOthers: { label: "Update Milik Orang", desc: "Mengubah data orang lain" },
    canDeleteOwn: { label: "Hapus Milik Sendiri", desc: "Menghapus data sendiri" },
    canDeleteOthers: { label: "Hapus Milik Orang", desc: "Menghapus data orang lain" },
    canManageMaster: { label: "Kelola Master", desc: "Mengelola data master" },
    canManageUsers: { label: "Kelola User", desc: "Mengelola user sistem" }
  };

  function openPermissionModal(username) {
    const users = lsGet(LS_USERS, []);
    const user = users.find(u => u.username === username);
    if (!user) return;
    if (user.role === "superuser") {
      toast("Super User memiliki semua izin.", true);
      return;
    }

    editingUserForPerms = user;
    tempPermissions = JSON.parse(JSON.stringify(user.permissions || rolePermissions.user));

    const modal = document.getElementById("permissionModal");
    const userInfo = document.getElementById("permUserInfo");
    const permGrid = document.getElementById("permGrid");

    userInfo.innerHTML = `<strong>${esc(user.name)}</strong> (${esc(user.username)})`;

    permGrid.innerHTML = Object.entries(permissionDescriptions).map(([key, desc]) => {
      const checked = tempPermissions[key] || false;
      return `<label class="perm-item">
        <input type="checkbox" name="perm-${key}" value="${key}" ${checked ? "checked" : ""}>
        <div>
          <span class="perm-name">${desc.label}</span>
          <span class="perm-desc">${desc.desc}</span>
        </div>
      </label>`;
    }).join("");

    modal.hidden = false;
  }

  function closePermissionModal() {
    const modal = document.getElementById("permissionModal");
    modal.hidden = true;
    editingUserForPerms = null;
    tempPermissions = {};
  }

  function savePermissions() {
    if (!editingUserForPerms) return;

    const checkboxes = document.querySelectorAll("#permGrid input[type='checkbox']");
    checkboxes.forEach(cb => {
      const key = cb.value;
      tempPermissions[key] = cb.checked;
    });

    const users = lsGet(LS_USERS, []);
    const user = users.find(u => u.username === editingUserForPerms.username);
    if (user) {
      user.permissions = tempPermissions;
      lsSet(LS_USERS, users);
      renderUsers();
      closePermissionModal();
      toast(`Izin untuk "${user.name}" telah diperbarui.`);
    }
  }

  function renderUsers() {
    const users = lsGet(LS_USERS, []);
    document.getElementById("userTbody").innerHTML = users.map(u => {
      const perms = u.permissions || rolePermissions[u.role];
      const updateIcon = perms.canUpdateOwn ? "✓" : "✗";
      const deleteIcon = perms.canDeleteOwn ? "✓" : "✗";
      const permissionsInfo = `${updateIcon} Ubah | ${deleteIcon} Hapus`;
      return `<tr>
        <td>${esc(u.name)}</td>
        <td class="mono">${esc(u.username)}</td>
        <td><span class="role-tag ${u.role}">${u.role === "superuser" ? "Super User" : "User Biasa"}</span></td>
        <td><span class="role-permissions" title="Update Milik Sendiri | Hapus Milik Sendiri">${permissionsInfo}</span></td>
        <td>${u.username === currentUser.username ? "" : `<button class="btn btn-ghost btn-edit-perms" data-username="${esc(u.username)}">Atur Izin</button> <button class="btn btn-danger btn-del-user" data-username="${esc(u.username)}">Hapus</button>`}</td>
      </tr>`;
    }).join("");
  }

  function initUserManagement() {
    renderUsers();

    // Modal controls
    document.getElementById("closePermModal").addEventListener("click", closePermissionModal);
    document.getElementById("cancelPermModal").addEventListener("click", closePermissionModal);
    document.getElementById("savePermModal").addEventListener("click", savePermissions);

    // Close modal on backdrop click
    document.querySelector(".modal-backdrop").addEventListener("click", closePermissionModal);

    document.getElementById("userAddForm").addEventListener("submit", e => {
      e.preventDefault();
      const name = document.getElementById("newUserName").value.trim();
      const username = document.getElementById("newUserUsername").value.trim();
      const password = document.getElementById("newUserPassword").value;
      const role = document.getElementById("newUserRole").value;
      if (!name || !username || !password) return;
      const users = lsGet(LS_USERS, []);
      if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
        toast("Username sudah digunakan.", true); return;
      }
      users.push({ name, username, password, role, permissions: rolePermissions[role] });
      lsSet(LS_USERS, users);
      e.target.reset();
      renderUsers();
      refreshAllDropdowns();
      toast("User baru ditambahkan.");
    });

    document.getElementById("userTbody").addEventListener("click", e => {
      const delBtn = e.target.closest(".btn-del-user");
      const editBtn = e.target.closest(".btn-edit-perms");
      if (delBtn) {
        let users = lsGet(LS_USERS, []);
        const target = users.find(u => u.username === delBtn.dataset.username);
        const superusersLeft = users.filter(u => u.role === "superuser").length;
        if (target.role === "superuser" && superusersLeft <= 1) {
          toast("Minimal harus ada satu Super User.", true); return;
        }
        if (!confirm(`Hapus user "${target.name}"?`)) return;
        users = users.filter(u => u.username !== delBtn.dataset.username);
        lsSet(LS_USERS, users);
        renderUsers();
        toast("User dihapus.");
      } else if (editBtn) {
        openPermissionModal(editBtn.dataset.username);
      }
    });
  }

  /* ================= auth ================= */
  function showApp() {
    userAvatar.textContent = currentUser.name.trim().charAt(0).toUpperCase();
    userNameEl.textContent = currentUser.name;
    userRoleEl.textContent = currentUser.role === "superuser" ? "Super User" : "User Biasa";
    masterTabBtn.hidden = currentUser.role !== "superuser";
    deviceDateDisplay.textContent = new Date().toLocaleDateString("id-ID", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });

    refreshAllDropdowns();
    renderEntries("filling");
    renderEntries("press");
  }

  logoutBtn.addEventListener("click", () => {
    localStorage.removeItem(LS_SESSION);
    currentUser = null;
    window.location.href = "login.html";
  });

  /* ================= Google Sheets Integration Listener ================= */
  window.addEventListener('masterDataUpdated', (event) => {
    console.log("🔄 Master data dari Google Sheets received:", event.detail);
    // Update localStorage dengan data dari Google Sheets
    lsSet(LS_MASTER, event.detail);
    // Refresh semua dropdown dengan data terbaru
    refreshAllDropdowns();
    renderMasterChips();
    toast("📡 Data Master berhasil disinkronkan dari Google Sheets");
  });

  /* ================= init ================= */
  function init() {
    const session = lsGet(LS_SESSION, null);
    if (!session) {
      window.location.href = "login.html";
      return;
    }
    const users = lsGet(LS_USERS, []);
    const found = users.find(u => u.username === session.username);
    if (!found) {
      localStorage.removeItem(LS_SESSION);
      window.location.href = "login.html";
      return;
    }
    currentUser = found;
    wireLineView("filling");
    wireLineView("press");
    initLaporan();
    initMasterData();
    initUserManagement();
    showApp();
    
    // Initialize Google Sheets Integration (async)
    if (window.SheetsIntegration) {
      console.log("🚀 Initializing Google Sheets Integration...");
      window.SheetsIntegration.initialize().catch(err => {
        console.error("❌ Failed to initialize Google Sheets:", err);
        toast("⚠️ Tidak dapat terhubung ke Google Sheets, menggunakan data lokal", true);
      });
    }
  }
  init();
})();
