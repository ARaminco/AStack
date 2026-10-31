/* ============================================================================
   Aramis — console users (sign-in with username and password)
   ----------------------------------------------------------------------------
   Talks to /api/users*. The first administrator is created here (Settings card
   and a banner on Home) from a token session on this computer; after that the
   Users screen (#/users) lists accounts, changes your own password, turns the
   authenticator code on or off, removes users and switches the console to
   password-only sign-in. Over the internet listener everything here is
   refused by the server (403) and the screen says so.
   A password is typed, sent once over loopback and forgotten: it is never
   stored, logged or written to the page. Nothing here touches a token.
   ========================================================================== */
(function () {
  "use strict";
  var A = window.Aramis;
  if (!A) return;
  var html = A.html, raw = A.raw, t = A.t, icon = A.icon, ltr = A.ltr, api = A.api, out = A.out;

  var MIN_LENGTH = 12;
  var KNOWN_REASONS = ["short", "long", "username", "digits", "repeated", "common", "mismatch", "same", "current", "exists", "username-format", "last-admin", "no-admin", "role"];
  var cache = { data: null, at: 0, status: "idle" }; // status: ok | missing | forbidden | idle
  var pending = null; // the first-administrator values between the form and its confirm sheet
  var pendingTimer = null;

  // ------------------------------------------------------------------ data

  function load(force) {
    if (!force && cache.status !== "idle" && Date.now() - cache.at < 10000) return Promise.resolve(cache);
    return api("/api/users").then(function (data) {
      cache = { data: data, at: Date.now(), status: "ok" };
      return cache;
    }).catch(function (error) {
      if (error.silent) throw error;
      cache = { data: null, at: Date.now(), status: error.status === 404 ? "missing" : error.status === 403 ? "forbidden" : "idle" };
      if (cache.status === "idle") throw error;
      return cache;
    });
  }
  function readOnly() { return A.isRemote() || cache.status === "forbidden"; }
  function setPending(values) {
    clearTimeout(pendingTimer);
    pending = values;
    if (values) pendingTimer = setTimeout(function () { pending = null; }, 180000);
  }

  /** One literal key per reason, so the translations stay checkable. */
  function reasonText(reason) {
    var min = { min: MIN_LENGTH };
    switch (reason) {
      case "short": return t("ui.users.err.short", min);
      case "long": return t("ui.users.err.long");
      case "username": return t("ui.users.err.username");
      case "digits": return t("ui.users.err.digits");
      case "repeated": return t("ui.users.err.repeated");
      case "common": return t("ui.users.err.common");
      case "mismatch": return t("ui.users.err.mismatch");
      case "same": return t("ui.users.err.same");
      case "current": return t("ui.users.err.current");
      case "exists": return t("ui.users.err.exists");
      case "username-format": return t("ui.users.err.username-format");
      case "last-admin": return t("ui.users.err.last-admin");
      case "no-admin": return t("ui.users.err.no-admin");
      case "role": return t("ui.users.err.role");
      default: return "";
    }
  }
  function errorText(error) {
    var body = error && error.body ? error.body : {};
    if (error && error.status === 429) return t("ui.users.err.tooMany");
    if (error && error.status === 403) return t("ui.users.err.forbidden");
    if (body.reason && KNOWN_REASONS.indexOf(body.reason) !== -1) return reasonText(body.reason);
    return (error && error.message) || t("common.error");
  }
  function levelText(n) {
    return n === 1 ? t("ui.users.level1") : n === 2 ? t("ui.users.level2") : n === 3 ? t("ui.users.level3") : n === 4 ? t("ui.users.level4") : "";
  }
  function modeText(mode) {
    if (mode === "password") return { title: t("ui.users.mode_password"), note: t("ui.users.modeNote_password") };
    if (mode === "both") return { title: t("ui.users.mode_both"), note: t("ui.users.modeNote_both") };
    return { title: t("ui.users.mode_token"), note: t("ui.users.modeNote_token") };
  }
  function showError(scope, error) {
    var line = A.$("[data-usr-error]", scope);
    var text = typeof error === "string" ? error : errorText(error);
    if (line) { line.textContent = text; line.hidden = !text; }
    else A.toast(t("common.error"), "danger", text);
  }

  // ------------------------------------------------------------- strength

  function rules(password, username, confirm) {
    var plain = String(password || "");
    var name = String(username || "").trim().toLowerCase();
    var lowered = plain.toLowerCase();
    var sameAsName = Boolean(name) && (lowered === name || lowered.replace(/[^a-z0-9]/g, "") === name.replace(/[^a-z0-9]/g, ""));
    var distinct = new Set(plain.split("")).size;
    return {
      len: plain.length >= MIN_LENGTH,
      name: plain.length > 0 && !sameAsName,
      kind: plain.length > 0 && !/^[0-9]+$/.test(plain) && distinct > 2,
      match: plain.length > 0 && confirm === plain
    };
  }
  function level(password, ok) {
    if (!password) return 0;
    if (!(ok.len && ok.name && ok.kind)) return 1;
    var classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(function (re) { return re.test(password); }).length;
    if (password.length >= 20 && classes >= 3) return 4;
    if (password.length >= 16 && classes >= 3) return 3;
    return 2;
  }
  function paintRules(form) {
    var password = form.elements.password ? form.elements.password.value : "";
    var confirm = form.elements.confirm ? form.elements.confirm.value : "";
    var username = form.elements.username ? form.elements.username.value : form.getAttribute("data-user") || "";
    var ok = rules(password, username, confirm);
    var meter = A.$("[data-usr-meter]", form);
    var lvl = level(password, ok);
    if (meter) {
      meter.setAttribute("data-level", String(lvl));
      var label = A.$("[data-usr-level]", form);
      if (label) label.textContent = levelText(lvl);
    }
    ["len", "name", "kind", "match"].forEach(function (key) {
      var item = A.$('[data-rule="' + key + '"]', form);
      if (!item) return;
      var started = key === "match" ? Boolean(confirm) : Boolean(password);
      item.setAttribute("data-state", !started ? "idle" : ok[key] ? "ok" : "bad");
    });
    return ok;
  }
  document.addEventListener("input", function (event) {
    var form = event.target.closest && event.target.closest("[data-usr-form]");
    if (form) paintRules(form);
  });

  // ------------------------------------------------------------- markup

  function secretField(name, label, autocomplete, extra) {
    return html`<label class="field">
      <span class="field-label">${icon("lock")}${label}</span>
      <span class="pw" dir="ltr">
        <input class="input input-lg ltr" dir="ltr" type="password" name="${name}" autocomplete="${autocomplete}" maxlength="256" required ${extra ? raw(extra) : ""}>
        <button type="button" class="pw-eye" data-action="toggle-secret" aria-label="${t("login.showPassword")}" aria-pressed="false">${icon("eye", "pw-on")}${icon("eye-off", "pw-off")}</button>
      </span>
    </label>`;
  }
  function usernameField() {
    return html`<label class="field">
      <span class="field-label">${icon("user")}${t("login.usernameLabel")}</span>
      <input class="input input-lg ltr" dir="ltr" type="text" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" minlength="2" maxlength="32" required>
      <span class="field-hint">${t("ui.users.usernameHint")}</span>
    </label>`;
  }
  function strengthBlock() {
    return html`<div class="usr-strength">
      <div class="usr-meter" data-usr-meter data-level="0"><i></i><i></i><i></i><i></i></div>
      <span class="usr-level" data-usr-level></span>
    </div>
    <ul class="usr-rules">
      <li data-rule="len" data-state="idle">${icon("check-circle")}<span>${t("ui.users.ruleLen", { min: MIN_LENGTH })}</span></li>
      <li data-rule="name" data-state="idle">${icon("check-circle")}<span>${t("ui.users.ruleName")}</span></li>
      <li data-rule="kind" data-state="idle">${icon("check-circle")}<span>${t("ui.users.ruleKind")}</span></li>
      <li data-rule="match" data-state="idle">${icon("check-circle")}<span>${t("ui.users.ruleMatch")}</span></li>
    </ul>`;
  }
  function errorLine() {
    return html`<p class="login-error" data-usr-error role="alert" hidden></p>`;
  }

  function setupForm(inSheet) {
    return html`<form class="usr-form ${inSheet ? "decision" : ""}" data-form="usr-setup" data-usr-form autocomplete="on">
      ${usernameField()}
      ${secretField("password", t("ui.users.newPassword"), "new-password")}
      ${secretField("confirm", t("ui.users.confirmPassword"), "new-password")}
      ${strengthBlock()}
      ${errorLine()}
      <button type="submit" class="btn btn-primary btn-lg btn-block" data-submit>${icon("user-plus")}${t("ui.users.setupSubmit")}</button>
    </form>`;
  }

  // ------------------------------------------------------ first administrator

  function setupCard(data) {
    if (!data || !data.setup || !data.setup.needed) return "";
    if (!data.setup.canCreate) {
      return html`<section class="section usr-setup" data-usr-setup>
        <div class="card pad usr-card-first">
          <div class="usr-first-head"><span class="usr-first-icon">${icon("shield-alert")}</span><div><h3>${t("ui.users.setupTitle")}</h3><p>${t("ui.users.setupNoToken")}</p></div></div>
          <p class="login-hint"><span>${t("ui.users.cliHint")}</span><code dir="ltr">astack console user set &lt;name&gt;</code></p>
        </div>
      </section>`;
    }
    return html`<section class="section usr-setup" data-usr-setup>
      <div class="card pad usr-card-first">
        <div class="usr-first-head"><span class="usr-first-icon">${icon("user-plus")}</span><div><h3>${t("ui.users.setupTitle")}</h3><p>${t("ui.users.setupBody")}</p></div></div>
        ${setupForm(false)}
      </div>
    </section>`;
  }

  A.actions["usr-setup-go"] = function (target) {
    if (!pending) { A.closeSheet(); return; }
    var values = pending;
    target.disabled = true;
    api("/api/users", { method: "POST", body: { username: values.username, password: values.password, confirm: values.confirm } }).then(function (result) {
      setPending(null);
      cache.at = 0;
      return load(true).then(function () {
        afterSetup(result);
      });
    }).catch(function (error) {
      target.disabled = false;
      var scope = A.$("#ar-sheet-root .sheet-body") || document;
      showError(scope, error);
    });
  };
  A.actions["usr-cancel"] = function () { setPending(null); A.closeSheet(); };

  function afterSetup(result) {
    var canLock = cache.data && cache.data.canRequirePassword;
    A.openSheet(html`<div class="decision">
      <div class="decision-head is-approve"><span class="decision-icon">${icon("check-circle")}</span><div><h3>${t("ui.users.createdTitle")}</h3><p>${ltr(result.username)}</p></div></div>
      <p class="sheet-text">${t("ui.users.createdBody")}</p>
      ${canLock ? html`<p class="ar-note ar-note--info">${icon("lock")}<span>${t("ui.users.createdLockHint")}</span></p>` : ""}
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("ui.users.later")}</button>
        ${canLock ? html`<button type="button" class="btn btn-primary btn-lg" data-action="usr-require">${t("ui.users.requirePassword")}</button>` : ""}
      </div>
    </div>`);
    A.navigate(true);
  }

  // -------------------------------------------------------------- forms

  document.addEventListener("submit", function (event) {
    var form = event.target;
    var kind = form.getAttribute && form.getAttribute("data-form");
    if (!kind || kind.indexOf("usr-") !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    var submit = A.$("[data-submit]", form);
    var els = form.elements;
    var ok;
    if (kind === "usr-setup") {
      var username = String(els.username.value || "").trim().toLowerCase();
      ok = paintRules(form);
      if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(username)) { showError(form, t("ui.users.err.username-format")); return; }
      if (!(ok.len && ok.name && ok.kind)) { showError(form, t("ui.users.err.weak", { min: MIN_LENGTH })); return; }
      if (!ok.match) { showError(form, t("ui.users.err.mismatch")); return; }
      setPending({ username: username, password: els.password.value, confirm: els.confirm.value });
      els.password.value = "";
      els.confirm.value = "";
      paintRules(form);
      showError(form, "");
      A.openSheet(html`<div class="decision">
        <div class="decision-head is-approve"><span class="decision-icon">${icon("user-plus")}</span><div><h3>${t("ui.users.confirmTitle")}</h3><p>${ltr(username)}</p></div></div>
        <p class="sheet-text">${t("ui.users.confirmBody")}</p>
        <p class="ar-note ar-note--info">${icon("shield")}<span>${t("ui.users.confirmNote")}</span></p>
        ${errorLine()}
        <div class="sheet-actions">
          <button type="button" class="btn btn-ghost btn-lg" data-action="usr-cancel">${t("common.cancel")}</button>
          <button type="button" class="btn btn-primary btn-lg" data-action="usr-setup-go">${t("ui.users.confirmGo")}</button>
        </div>
      </div>`);
      return;
    }
    if (submit) submit.disabled = true;
    var request;
    if (kind === "usr-add") {
      var newName = String(els.username.value || "").trim().toLowerCase();
      ok = paintRules(form);
      if (!(ok.len && ok.name && ok.kind) || !ok.match) { if (submit) submit.disabled = false; showError(form, ok.match ? t("ui.users.err.weak", { min: MIN_LENGTH }) : t("ui.users.err.mismatch")); return; }
      request = api("/api/users", { method: "POST", body: { username: newName, password: els.password.value, confirm: els.confirm.value, role: els.role.value } }).then(function () { A.toast(t("ui.users.added"), "success", newName); });
    } else if (kind === "usr-password") {
      ok = paintRules(form);
      if (!(ok.len && ok.name && ok.kind) || !ok.match) { if (submit) submit.disabled = false; showError(form, ok.match ? t("ui.users.err.weak", { min: MIN_LENGTH }) : t("ui.users.err.mismatch")); return; }
      request = api("/api/users/password", { method: "POST", body: { current: els.current.value, password: els.password.value, confirm: els.confirm.value } }).then(function (result) {
        A.toast(t("ui.users.passwordChanged"), "success", result.otherSessionsEnded ? t("ui.users.otherEnded", { count: result.otherSessionsEnded }) : "");
      });
    } else if (kind === "usr-totp") {
      var enable = form.getAttribute("data-action-kind") === "enable";
      request = api("/api/users/totp", { method: "POST", body: { current: els.current.value, action: enable ? "enable" : "disable" } }).then(function (result) {
        if (enable) { totpSecretSheet(result); return "keep"; }
        A.toast(t("ui.users.totpOffDone"), "success");
        return null;
      });
    } else {
      return;
    }
    request.then(function (keep) {
      ["current", "password", "confirm"].forEach(function (name) { if (els[name]) els[name].value = ""; });
      cache.at = 0;
      if (keep !== "keep") A.closeSheet();
      return load(true).then(function () { A.navigate(true); });
    }).catch(function (error) {
      if (submit) submit.disabled = false;
      if (els.current) { els.current.value = ""; }
      showError(form, error);
    });
  }, true);

  // -------------------------------------------------------------- sheets

  A.actions["usr-add"] = function () {
    if (readOnly()) { A.toast(t("ui.users.remoteOnly"), "warning"); return; }
    A.openSheet(html`<form class="decision usr-form" data-form="usr-add" data-usr-form autocomplete="on">
      <div class="decision-head is-approve"><span class="decision-icon">${icon("user-plus")}</span><div><h3>${t("ui.users.addTitle")}</h3><p>${t("ui.users.addHint")}</p></div></div>
      ${usernameField()}
      ${secretField("password", t("ui.users.newPassword"), "new-password")}
      ${secretField("confirm", t("ui.users.confirmPassword"), "new-password")}
      ${strengthBlock()}
      <label class="field">
        <span class="field-label">${icon("shield")}${t("ui.users.roleLabel")}</span>
        <select class="input input-lg select" name="role"><option value="user">${t("ui.users.roleUser")}</option><option value="admin">${t("ui.users.roleAdmin")}</option></select>
        <span class="field-hint">${t("ui.users.roleHint")}</span>
      </label>
      ${errorLine()}
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
        <button type="submit" class="btn btn-primary btn-lg" data-submit>${t("ui.users.addSubmit")}</button>
      </div>
    </form>`);
  };

  A.actions["usr-password"] = function (target, event, name) {
    if (readOnly()) { A.toast(t("ui.users.remoteOnly"), "warning"); return; }
    A.openSheet(html`<form class="decision usr-form" data-form="usr-password" data-usr-form data-user="${name}" autocomplete="on">
      <div class="decision-head is-approve"><span class="decision-icon">${icon("key-round")}</span><div><h3>${t("ui.users.passwordTitle")}</h3><p>${t("ui.users.passwordHint")}</p></div></div>
      <input type="text" name="username" value="${name}" autocomplete="username" hidden tabindex="-1" aria-hidden="true">
      ${secretField("current", t("ui.users.currentPassword"), "current-password")}
      ${secretField("password", t("ui.users.newPassword"), "new-password")}
      ${secretField("confirm", t("ui.users.confirmPassword"), "new-password")}
      ${strengthBlock()}
      ${errorLine()}
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
        <button type="submit" class="btn btn-primary btn-lg" data-submit>${t("ui.users.passwordSubmit")}</button>
      </div>
    </form>`);
  };

  function totpSheet(enable) {
    if (readOnly()) { A.toast(t("ui.users.remoteOnly"), "warning"); return; }
    A.openSheet(html`<form class="decision usr-form" data-form="usr-totp" data-action-kind="${enable ? "enable" : "disable"}" autocomplete="off">
      <div class="decision-head ${enable ? "is-approve" : "is-deny"}"><span class="decision-icon">${icon("shield-check")}</span><div><h3>${t(enable ? "ui.users.totpOnTitle" : "ui.users.totpOffTitle")}</h3><p>${t(enable ? "ui.users.totpOnHint" : "ui.users.totpOffHint")}</p></div></div>
      ${secretField("current", t("ui.users.currentPassword"), "current-password")}
      ${errorLine()}
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
        <button type="submit" class="btn ${enable ? "btn-primary" : "btn-deny"} btn-lg" data-submit>${t(enable ? "ui.users.totpOnSubmit" : "ui.users.totpOffSubmit")}</button>
      </div>
    </form>`);
  }
  A.actions["usr-totp-on"] = function () { totpSheet(true); };
  A.actions["usr-totp-off"] = function () { totpSheet(false); };

  function groups(secret) {
    return String(secret || "").replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
  }
  function totpSecretSheet(result) {
    A.openSheet(html`<div class="decision">
      <div class="decision-head is-approve"><span class="decision-icon">${icon("shield-check")}</span><div><h3>${t("ui.users.totpSecretTitle")}</h3><p>${t("ui.users.totpSecretHint")}</p></div></div>
      <p class="field-label">${t("ui.users.totpSecretKey")}</p>
      <p class="usr-secret" dir="ltr" data-usr-copy="${String(result.secret || "").replace(/\s+/g, "")}">${groups(result.secret)}</p>
      <p class="field-label">${t("ui.users.totpSecretUri")}</p>
      <p class="usr-uri" dir="ltr" data-usr-copy-uri="${result.uri || ""}">${result.uri || ""}</p>
      <p class="ar-note">${icon("alert")}<span>${t("ui.users.totpSecretOnce")}</span></p>
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="usr-copy" data-id="key">${icon("copy")}${t("ui.users.copyKey")}</button>
        <button type="button" class="btn btn-primary btn-lg" data-action="close-sheet">${t("ui.users.done")}</button>
      </div>
    </div>`);
  }
  A.actions["usr-copy"] = function (target, event, which) {
    var holder = which === "uri" ? A.$("[data-usr-copy-uri]") : A.$("[data-usr-copy]");
    var text = holder ? holder.getAttribute(which === "uri" ? "data-usr-copy-uri" : "data-usr-copy") : target.getAttribute("data-copy") || "";
    if (!text) return;
    var done = function () { A.toast(t("ui.users.copied"), "success"); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { A.toast(t("ui.users.copyFailed"), "warning"); });
    else A.toast(t("ui.users.copyFailed"), "warning");
  };

  A.actions["usr-remove"] = function (target, event, name) {
    if (readOnly()) { A.toast(t("ui.users.remoteOnly"), "warning"); return; }
    var self = cache.data && cache.data.me && cache.data.me.username === name;
    A.openSheet(html`<div class="decision">
      <div class="decision-head is-deny"><span class="decision-icon">${icon("trash-2")}</span><div><h3>${t("ui.users.removeTitle")}</h3><p>${ltr(name)}</p></div></div>
      <p class="sheet-text">${t("ui.users.removeBody")}</p>
      ${self ? html`<p class="ar-note">${icon("alert")}<span>${t("ui.users.removeSelf")}</span></p>` : ""}
      ${errorLine()}
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
        <button type="button" class="btn btn-deny btn-lg" data-action="usr-remove-go" data-id="${name}">${t("ui.users.removeGo")}</button>
      </div>
    </div>`);
  };
  A.actions["usr-remove-go"] = function (target, event, name) {
    target.disabled = true;
    api("/api/users/remove", { method: "POST", body: { username: name } }).then(function (result) {
      A.closeSheet();
      if (result && result.self) { location.reload(); return; }
      A.toast(t("ui.users.removed"), "success", name);
      cache.at = 0;
      return load(true).then(function () { A.navigate(true); });
    }).catch(function (error) {
      target.disabled = false;
      showError(A.$("#ar-sheet-root .sheet-body") || document, error);
    });
  };

  A.actions["usr-role"] = function (target, event, name) {
    if (readOnly()) { A.toast(t("ui.users.remoteOnly"), "warning"); return; }
    var role = target.getAttribute("data-role");
    target.disabled = true;
    api("/api/users/role", { method: "POST", body: { username: name, role: role } }).then(function () {
      A.toast(t("ui.users.roleChanged"), "success", name + " · " + t(role === "admin" ? "ui.users.roleAdmin" : "ui.users.roleUser"));
      cache.at = 0;
      return load(true).then(function () { A.navigate(true); });
    }).catch(function (error) {
      target.disabled = false;
      A.toast(t("common.error"), "danger", errorText(error));
    });
  };

  // ----------------------------------------------------- password-only mode

  A.actions["usr-require"] = function () {
    if (readOnly()) { A.toast(t("ui.users.remoteOnly"), "warning"); return; }
    A.closeSheet();
    setTimeout(function () {
      A.openSheet(html`<div class="decision">
        <div class="decision-head is-approve"><span class="decision-icon">${icon("lock")}</span><div><h3>${t("ui.users.requireTitle")}</h3><p>${t("ui.users.requireHint")}</p></div></div>
        <p class="sheet-text">${t("ui.users.requireBody")}</p>
        <p class="ar-note ar-note--info">${icon("key")}<span>${t("ui.users.requireRecover")} <code dir="ltr">astack console user set &lt;name&gt;</code></span></p>
        ${errorLine()}
        <div class="sheet-actions">
          <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
          <button type="button" class="btn btn-primary btn-lg" data-action="usr-require-go">${t("ui.users.requireGo")}</button>
        </div>
      </div>`);
    }, 260);
  };
  A.actions["usr-require-go"] = function (target) {
    target.disabled = true;
    api("/api/users/auth-mode", { method: "POST", body: { mode: "password" } }).then(function (result) {
      cache.at = 0;
      return load(true).then(function () {
        A.navigate(true);
        if (result && result.persisted === false) {
          A.openSheet(html`<div class="decision">
            <div class="decision-head is-deny"><span class="decision-icon">${icon("alert")}</span><div><h3>${t("ui.users.notSavedTitle")}</h3><p>${t("ui.users.notSavedHint")}</p></div></div>
            <p class="sheet-text">${t("ui.users.notSavedBody")}</p>
            <pre class="usr-line" dir="ltr" data-usr-copy="${result.line || ""}">${result.line || ""}</pre>
            <div class="sheet-actions">
              <button type="button" class="btn btn-ghost btn-lg" data-action="usr-copy" data-id="key">${icon("copy")}${t("ui.users.copyLine")}</button>
              <button type="button" class="btn btn-primary btn-lg" data-action="close-sheet">${t("ui.users.done")}</button>
            </div>
          </div>`);
        } else {
          A.closeSheet();
          A.toast(t("ui.users.requireDone"), "success", t("ui.users.requireDoneNote"));
        }
      });
    }).catch(function (error) {
      target.disabled = false;
      showError(A.$("#ar-sheet-root .sheet-body") || document, error);
    });
  };

  // ------------------------------------------------------------- the screen

  function initial(text) { return String(text || "?").trim().charAt(0).toUpperCase(); }

  function userCard(user, data) {
    var me = data.me || {};
    var mine = Boolean(user.current);
    var admin = me.admin;
    return html`<article class="card usr-card" data-user-card="${user.username}">
      <div class="usr-head">
        <span class="usr-avatar ${user.role === "admin" ? "is-admin" : ""}">${initial(user.username)}</span>
        <div class="usr-id">
          <strong class="usr-name">${ltr(user.username)}</strong>
          <span class="usr-badges">
            <span class="badge tone-${user.role === "admin" ? "info" : "neutral"}">${t(user.role === "admin" ? "ui.users.roleAdmin" : "ui.users.roleUser")}</span>
            ${mine ? html`<span class="badge tone-success">${t("ui.users.you")}</span>` : ""}
          </span>
        </div>
      </div>
      <dl class="usr-facts">
        <div><dt>${t("ui.users.lastLogin")}</dt><dd>${user.lastLoginAt ? A.when(user.lastLoginAt) : t("ui.users.neverLogin")}</dd></div>
        <div><dt>${t("ui.users.totp")}</dt><dd>${user.totp ? html`<span class="ok-line">${icon("shield-check")}${t("ui.users.totpOn")}</span>` : html`<span class="muted">${t("ui.users.totpOff")}</span>`}</dd></div>
      </dl>
      <div class="usr-actions">
        ${mine ? html`
          <button type="button" class="btn btn-ghost" data-action="usr-password" data-id="${user.username}">${icon("key-round")}${t("ui.users.changePassword")}</button>
          ${user.totp
            ? html`<button type="button" class="btn btn-ghost" data-action="usr-totp-off">${icon("shield")}${t("ui.users.totpDisable")}</button>`
            : html`<button type="button" class="btn btn-ghost" data-action="usr-totp-on">${icon("shield-check")}${t("ui.users.totpEnable")}</button>`}` : ""}
        ${admin ? html`
          <button type="button" class="btn btn-ghost" data-action="usr-role" data-id="${user.username}" data-role="${user.role === "admin" ? "user" : "admin"}">${icon("user-cog")}${t(user.role === "admin" ? "ui.users.makeUser" : "ui.users.makeAdmin")}</button>
          <button type="button" class="btn btn-ghost danger-text" data-action="usr-remove" data-id="${user.username}">${icon("trash-2")}${t("ui.users.remove")}</button>` : ""}
      </div>
    </article>`;
  }

  function modeCard(data) {
    var mode = data.authMode || "token";
    var words = modeText(mode);
    return html`<section class="section">
      <div class="section-head"><h2>${t("ui.users.signInTitle")}</h2></div>
      <div class="card pad usr-mode">
        <p class="usr-mode-line">${icon(mode === "password" ? "lock" : "key")}<span><strong>${words.title}</strong><small>${words.note}</small></span></p>
        ${data.canRequirePassword ? html`<button type="button" class="btn btn-primary" data-action="usr-require">${icon("lock")}${t("ui.users.requirePassword")}</button>` : ""}
        ${mode !== "password" && !data.canRequirePassword && (data.users || []).length === 0 ? html`<p class="muted small">${t("ui.users.requireNeedsAdmin")}</p>` : ""}
      </div>
    </section>`;
  }

  A.VIEWS.users = {
    title: function () { return t("nav.users"); },
    subtitle: function () { return t("ui.users.subtitle"); },
    skeleton: "list",
    load: function () { return A.isRemote() ? Promise.resolve({ status: "forbidden", data: null }) : load(true); },
    render: function (box) {
      if (!box || box.status === "forbidden") {
        return html`<div class="card">${A.empty("lock", t("ui.users.remoteTitle"), t("ui.users.remoteBody"))}</div>`;
      }
      if (box.status === "missing" || !box.data) {
        return html`<div class="card">${A.empty("user-cog", t("ui.users.missingTitle"), t("ui.users.missingBody"))}</div>`;
      }
      var data = box.data;
      var me = data.me || {};
      var users = data.users || [];
      return html`<div class="narrow usr-page">
        ${setupCard(data)}
        ${!data.setup.needed ? html`<section class="section">
          <div class="section-head"><h2>${t("ui.users.listTitle")}</h2>${me.admin ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="usr-add">${icon("user-plus")}${t("ui.users.add")}</button>` : ""}</div>
          ${me.username ? "" : html`<p class="ar-note ar-note--info">${icon("key")}<span>${t("ui.users.tokenSession")} <code dir="ltr">astack console user set &lt;name&gt;</code></span></p>`}
          <div class="usr-list">${users.map(function (user) { return userCard(user, data); })}</div>
        </section>` : ""}
        ${modeCard(data)}
        <p class="muted small">${t("ui.users.privacy")}</p>
      </div>`;
    }
  };

  // ------------------------------------------- Settings card and Home banner

  function paintExtras() {
    var route = A.state.route;
    var view = A.$("#view");
    if (!view || (route.name !== "home" && route.name !== "settings")) return;
    if (A.isRemote()) return;
    load(false).then(function (box) {
      if (A.state.route.name !== route.name) return;
      var data = box && box.data;
      var needed = Boolean(data && data.setup && data.setup.needed);
      var viewNow = A.$("#view");
      if (!viewNow) return;
      if (route.name === "home") {
        var banner = A.$("[data-usr-banner]", viewNow);
        if (!needed) { if (banner) banner.remove(); return; }
        if (banner || !A.$(".hero", viewNow)) return;
        A.$(".hero", viewNow).insertAdjacentHTML("beforebegin", out(html`<a class="usr-banner" href="#/settings" data-usr-banner>
          <span class="usr-banner-icon">${icon("user-plus")}</span>
          <span class="usr-banner-text"><strong>${t("ui.users.bannerTitle")}</strong><small>${t("ui.users.bannerBody")}</small></span>
          <span class="usr-banner-go">${icon("chevron-left")}</span>
        </a>`));
      } else if (needed) {
        var narrow = A.$(".narrow", viewNow);
        if (!narrow || A.$("[data-usr-setup]", narrow)) return;
        narrow.insertAdjacentHTML("afterbegin", out(setupCard(data)));
      }
    }).catch(function () { /* the card is optional */ });
  }
  var previousChrome = A.hooks.chrome;
  A.hooks.chrome = function () {
    if (previousChrome) previousChrome();
    paintExtras();
  };
})();
