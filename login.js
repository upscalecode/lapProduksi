/* =========================================================
   Laporan Produksi — login.js
   Standalone login page script
   ========================================================= */
(function () {
  "use strict";

  /* Storage keys */
  const LS_USERS = "ppr_users_v1";
  const LS_SESSION = "ppr_session_v1";

  /* Storage helpers */
  function lsGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  /* Role permissions */
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
      canDeleteOwn: false,
      canDeleteOthers: false,
      canManageMaster: false,
      canManageUsers: false
    }
  };

  /* Initialize default users if not present */
  function seedUsersIfEmpty() {
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
  }
  seedUsersIfEmpty();

  /* Toast notification */
  const toastEl = document.getElementById("toast");
  let toastTimer = null;
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.className = isErr ? "err show" : "show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = ""; }, 2600);
  }

  /* DOM References */
  const loginForm = document.getElementById("loginForm");
  const loginError = document.getElementById("loginError");
  const loginRole = document.getElementById("loginRole");

  /* Login Form Handler */
  loginForm.addEventListener("submit", e => {
    e.preventDefault();
    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;
    const selectedRole = loginRole.value;
    const users = lsGet(LS_USERS, []);
    const found = users.find(u =>
      u.username.toLowerCase() === username.toLowerCase() &&
      u.password === password &&
      u.role === selectedRole
    );

    if (!found) {
      const roleMatch = users.find(u =>
        u.username.toLowerCase() === username.toLowerCase() &&
        u.password === password
      );

      if (roleMatch && roleMatch.role !== selectedRole) {
        loginError.textContent = `Akses yang dipilih tidak cocok. Gunakan akun ${roleMatch.role === "superuser" ? "Super User" : "User Biasa"}.`;
      } else {
        loginError.textContent = "Username atau password salah.";
      }
      loginError.hidden = false;
      return;
    }

    loginError.hidden = true;
    lsSet(LS_SESSION, {
      username: found.username,
      name: found.name,
      role: found.role,
      permissions: found.permissions || rolePermissions[found.role]
    });
    loginForm.reset();
    loginRole.value = "superuser";

    toast("Login berhasil, mengalihkan...");
    setTimeout(() => {
      window.location.href = "index.html";
    }, 500);
  });

  /* Check if already logged in */
  function checkSession() {
    const session = lsGet(LS_SESSION, null);
    if (session) {
      const users = lsGet(LS_USERS, []);
      const found = users.find(u => u.username === session.username);
      if (found) {
        window.location.href = "index.html";
      }
    }
  }
  checkSession();
})();
