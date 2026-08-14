/* =========================================================
   Google Sheets Integration
   Mengambil Master Data dari Google Sheets untuk dropdown
   ========================================================= */

(function () {
  "use strict";

  // Configuration
  const SHEET_ID = "1nrYP9ce2yH9IUjsOOYt90RoTMCoy2WC0CpL5qigO8gE";
  const DEFAULT_WEBAPP_URL = "PASTE_WEBAPP_URL_HERE";
  const SHEET_NAMES = {
    operator: "Operator",
    produk: "Produk",
    botol: "Botol"
  };

  // Cache untuk mengurangi API calls
  let sheetsCache = {
    timestamp: 0,
    data: {}
  };
  const CACHE_DURATION = 5 * 60 * 1000; // 5 menit

  /**
   * Konversi Sheet ID ke format yang cocok untuk Google Sheets API
   */
  function extractSheetId(url) {
    const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
  }

  /**
   * Fetch data dari Google Sheets menggunakan Google Visualization API
   * API ini tidak memerlukan API key untuk sheet yang public
   */
  async function fetchSheetData(sheetName) {
    try {
      // URL untuk Google Visualization API Query
      const query = "SELECT A WHERE A IS NOT NULL";
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${sheetName}&tq=${encodeURIComponent(query)}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const text = await response.text();
      
      // Parse response dari Google Visualization API
      // Format: google.visualization.Query.setResponse({...})
      const jsonMatch = text.match(/google\.visualization\.Query\.setResponse\((.*)\)/);
      if (!jsonMatch) {
        console.warn(`⚠️ Invalid response format from sheet: ${sheetName}`);
        return [];
      }

      const jsonStr = jsonMatch[1];
      const data = JSON.parse(jsonStr);

      // Check for errors in response
      if (data.status === 'error') {
        console.error(`❌ Sheet error for "${sheetName}":`, data.message);
        return [];
      }

      // Extract data rows
      const rows = [];
      if (data.table && data.table.rows) {
        data.table.rows.forEach(row => {
          if (row.c && row.c[0]) {
            const value = row.c[0].v;
            if (value && value.toString().trim()) {
              rows.push(value.toString().trim());
            }
          }
        });
      }

      console.log(`✅ Sheet "${sheetName}" loaded: ${rows.length} items`);
      return rows;
    } catch (error) {
      console.error(`❌ Error fetching sheet "${sheetName}":`, error.message);
      return [];
    }
  }

  /**
   * Fetch semua master data dari Google Sheets
   */
  async function fetchAllMasterData() {
    const now = Date.now();
    
    // Gunakan cache jika masih valid
    if (sheetsCache.timestamp && (now - sheetsCache.timestamp) < CACHE_DURATION) {
      console.log("📦 Using cached sheets data (next update in", Math.round((CACHE_DURATION - (now - sheetsCache.timestamp)) / 1000), "seconds)");
      return sheetsCache.data;
    }

    console.log("🔄 Fetching data from Google Sheets...");
    
    try {
      const [operatorData, produkData, botolData] = await Promise.all([
        fetchSheetData(SHEET_NAMES.operator),
        fetchSheetData(SHEET_NAMES.produk),
        fetchSheetData(SHEET_NAMES.botol)
      ]);

      const masterData = {
        operator: operatorData,
        produk: produkData,
        botol: botolData,
        botolpecah: botolData // Botol yang pecah menggunakan daftar yang sama
      };

      // Validasi data
      const totalItems = operatorData.length + produkData.length + botolData.length;
      if (totalItems === 0) {
        console.warn("⚠️ No data found in sheets, check sheet names and data");
      }

      // Update cache
      sheetsCache = {
        timestamp: now,
        data: masterData
      };

      console.log("✅ Master data loaded from Google Sheets:", {
        operators: operatorData.length,
        products: produkData.length,
        bottles: botolData.length
      });
      
      return masterData;
    } catch (error) {
      console.error("❌ Error loading master data:", error.message);
      return {
        operator: [],
        produk: [],
        botol: [],
        botolpecah: []
      };
    }
  }

  /**
   * Sync master data: ambil dari Sheets, simpan ke localStorage
   */
  async function syncMasterDataFromSheets() {
    try {
      const masterData = await fetchAllMasterData();
      
      // Simpan ke localStorage untuk fallback
      const LS_MASTER = "ppr_master_v1";
      localStorage.setItem(LS_MASTER, JSON.stringify(masterData));
      
      // Trigger event untuk update UI
      window.dispatchEvent(new CustomEvent('masterDataUpdated', { detail: masterData }));
      
      return masterData;
    } catch (error) {
      console.error("❌ Sync failed:", error);
      throw error;
    }
  }

  /**
   * Cek koneksi ke Google Sheets
   */
  async function checkSheetsConnection() {
    try {
      // Try fetching a single sheet to verify connection
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${SHEET_NAMES.operator}&tq=SELECT%20A%20WHERE%20A%20IS%20NOT%20NULL`;
      const response = await fetch(url, { method: 'HEAD' });
      return response.ok;
    } catch (error) {
      console.warn("⚠️ Connection check failed:", error.message);
      return false;
    }
  }

  /**
   * Initialize: Load data dari Sheets saat aplikasi start
   */
  async function initializeSheetsIntegration() {
    try {
      console.log("🔗 Checking Google Sheets connection...");
      const isConnected = await checkSheetsConnection();
      
      if (isConnected) {
        console.log("✅ Google Sheets accessible");
        await syncMasterDataFromSheets();
        
        // Set up periodic refresh every 5 minutes
        setInterval(async () => {
          console.log("🔄 Periodic sync check...");
          await syncMasterDataFromSheets();
        }, CACHE_DURATION);
        
      } else {
        console.warn("⚠️ Cannot reach Google Sheets, will use localStorage fallback");
        // Dispatch event dengan empty data, let app use its default
        window.dispatchEvent(new CustomEvent('sheetsConnectionFailed'));
      }
    } catch (error) {
      console.error("❌ Initialization failed:", error);
    }
  }

  /**
   * Append entry data ke Google Sheets via webhook
   * Memerlukan Google Apps Script webhook yang sudah dikonfigurasi
   */
  async function appendEntryToSheet(entryData, webhookUrl) {
    // Jika webhook belum dikonfigurasi, skip dengan graceful
    if (!webhookUrl) {
      console.warn("⚠️ Webhook URL tidak dikonfigurasi. Data hanya disimpan di localStorage.");
      return { success: false, message: "Webhook tidak dikonfigurasi" };
    }

    try {
      console.log("📤 Mengirim data ke Google Sheets...");
      
      const payload = {
        reportId: entryData.reportId,
        tab: entryData.tab,
        tanggal: entryData.tanggal,
        operator: entryData.operator,
        produk: entryData.produk,
        botol: entryData.botol,
        qtyKardus: entryData.qtyKardus,
        qtyBotolPerKardus: entryData.qtyBotolPerKardus,
        totalQty: entryData.totalQty,
        botolPecahJenis: entryData.botolPecahJenis || "",
        qtyBotolPecah: entryData.qtyBotolPecah || 0,
        createdBy: entryData.createdByName || entryData.createdBy,
        createdAt: entryData.createdAt
      };

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      
      if (result.success) {
        console.log("✅ Data berhasil ditambahkan ke Google Sheets!");
        return { success: true, message: "Data tersimpan di Google Sheets" };
      } else {
        console.warn("⚠️ Webhook response error:", result.message);
        return { success: false, message: result.message || "Error dari webhook" };
      }
    } catch (error) {
      console.error("❌ Error mengirim ke Google Sheets:", error.message);
      console.warn("💾 Data sudah tersimpan di localStorage.");
      return { success: false, message: error.message };
    }
  }

  /**
   * Get configured webhook URL
   */
  function getWebhookUrl() {
    const savedUrl = localStorage.getItem("ppr_webhook_url");
    if (savedUrl) return savedUrl;
    if (DEFAULT_WEBAPP_URL && !DEFAULT_WEBAPP_URL.includes("PASTE_WEBAPP_URL_HERE")) {
      return DEFAULT_WEBAPP_URL;
    }
    return null;
  }

  /**
   * Set webhook URL
   */
  function setWebhookUrl(url) {
    if (url) {
      localStorage.setItem("ppr_webhook_url", url);
      console.log("✅ Webhook URL disimpan");
    } else {
      localStorage.removeItem("ppr_webhook_url");
      console.log("🗑️ Webhook URL dihapus");
    }
  }

  /**
   * Expose functions ke global scope
   */
  window.SheetsIntegration = {
    initialize: initializeSheetsIntegration,
    sync: syncMasterDataFromSheets,
    checkConnection: checkSheetsConnection,
    clearCache: () => { 
      console.log("🗑️ Cache cleared");
      sheetsCache = { timestamp: 0, data: {} }; 
    },
    getStatus: () => ({
      cacheValid: Date.now() - sheetsCache.timestamp < CACHE_DURATION,
      cacheAge: Date.now() - sheetsCache.timestamp,
      lastSync: new Date(sheetsCache.timestamp),
      sheetId: SHEET_ID,
      sheetNames: SHEET_NAMES
    }),
    appendEntry: appendEntryToSheet,
    getWebhookUrl: getWebhookUrl,
    setWebhookUrl: setWebhookUrl
  };

  // Log initialization
  console.log("📡 Google Sheets Integration loaded. SHEET_ID:", SHEET_ID);

})();
