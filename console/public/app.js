/* ============================================================================
   Aramin — the AStack console (vanilla JS, no build step, no dependencies)
   ----------------------------------------------------------------------------
   One hash-routed app shell: side rail on desktop, bottom tab bar on phones,
   command palette (Ctrl/⌘-K), bottom sheets, toasts, live updates over SSE.
   Every value from the server is escaped on the way into the DOM; inbound
   text (messages, skills, memory) is data and is only ever displayed.
   ========================================================================== */
(function () {
  "use strict";

  // ------------------------------------------------------------ tiny helpers

  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }
  function Raw(text) { this.text = text; }
  function raw(text) { return new Raw(text); }
  function out(value) {
    if (value instanceof Raw) return value.text;
    if (Array.isArray(value)) return value.map(out).join("");
    if (value === null || value === undefined || value === false) return "";
    return esc(value);
  }
  function html(strings) {
    var values = Array.prototype.slice.call(arguments, 1);
    var text = "";
    for (var i = 0; i < strings.length; i += 1) {
      text += strings[i];
      if (i < values.length) text += out(values[i]);
    }
    return raw(text);
  }
  function icon(name, cls) {
    return raw('<svg class="i ' + (cls || "") + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>');
  }
  function $(selector, scope) { return (scope || document).querySelector(selector); }
  function $all(selector, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(selector)); }
  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }
  function ltr(value, cls) {
    return html`<bdi class="ltr ${cls || ""}" dir="ltr">${value}</bdi>`;
  }

  // ------------------------------------------------------------------ state

  var state = {
    authenticated: false,
    csrf: null,
    locale: "fa",
    strings: {},
    features: {},
    counts: { approvals: 0, missionsActive: 0, incidents: 0, runsActive: 0 },
    notifications: [],
    unread: 0,
    route: { name: "home", id: null, query: {} },
    renderId: 0,
    source: null,
    installPrompt: null,
    cache: {},
    login: { methods: ["token"], totp: "off", remote: false },
    session: {},
    chat: null,
    chatBacklog: [],
    chatProjects: null
  };

  function t(key, vars) {
    var value = key.split(".").reduce(function (node, part) { return node && node[part]; }, state.strings);
    if (typeof value !== "string") return key.split(".").pop();
    return value.replace(/\{(\w+)\}/g, function (_, name) { return vars && vars[name] !== undefined ? String(vars[name]) : ""; });
  }

  // ------------------------------------------------------------- formatting

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  /** DD/MM/YYYY HH:mm with Latin digits, the owner's format. */
  function fmtDate(iso, withTime) {
    if (!iso) return t("common.none");
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var text = pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear();
    return withTime === false ? text : text + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  /** A date as an isolated left-to-right run, so RTL text never reorders its parts. */
  function dt(iso, withTime) {
    return ltr(fmtDate(iso, withTime));
  }
  var rtf = null;
  function relTime(iso) {
    if (!iso) return t("common.never");
    var d = new Date(iso).getTime();
    if (isNaN(d)) return String(iso);
    if (!rtf) {
      try {
        rtf = new Intl.RelativeTimeFormat(state.locale === "fa" ? "fa-u-nu-latn" : "en", { numeric: "auto" });
      } catch (error) {
        rtf = null;
      }
    }
    var diff = (d - Date.now()) / 1000;
    var units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];
    for (var i = 0; i < units.length; i += 1) {
      if (Math.abs(diff) >= units[i][1] || units[i][0] === "second") {
        var value = Math.round(diff / units[i][1]);
        if (units[i][0] === "second" && Math.abs(value) < 45) value = 0;
        return rtf ? rtf.format(value, units[i][0]) : fmtDate(iso);
      }
    }
    return fmtDate(iso);
  }
  function when(iso) {
    return html`<time datetime="${iso || ""}" title="${fmtDate(iso)}">${relTime(iso)}</time>`;
  }
  function stateLabel(value) {
    var label = state.strings.states && state.strings.states[value];
    return label || value || t("states.unknown");
  }
  var TONES = {
    pending: "warning", "waiting-approval": "warning", "awaiting-approval": "warning", paused: "neutral", blocked: "danger",
    running: "info", queued: "info", created: "neutral", completed: "success", done: "success", ok: "success", approved: "success",
    consumed: "neutral", failed: "danger", rejected: "danger", expired: "neutral", cancelled: "neutral", skipped: "neutral",
    high: "danger", medium: "warning", low: "success", idle: "neutral", disabled: "neutral",
    refused: "danger", "dry-run": "info", stopped: "neutral"
  };
  function badge(value, label, extra) {
    return html`<span class="badge tone-${TONES[value] || "neutral"} ${extra || ""}">${label || stateLabel(value)}</span>`;
  }
  function levelBadge(level) {
    if (!level) return "";
    var n = Number(String(level).replace(/\D/g, ""));
    var tone = n >= 4 ? "danger" : n === 3 ? "warning" : "neutral";
    return html`<span class="badge tone-${tone}">${ltr(level)}</span>`;
  }

  // -------------------------------------------------------------------- api

  function api(path, options) {
    options = options || {};
    var headers = { accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.method && options.method !== "GET" && state.csrf) headers["x-csrf-token"] = state.csrf;
    return fetch(path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
      cache: "no-store"
    }).then(function (response) {
      return response.json().catch(function () { return { ok: false, error: "HTTP " + response.status }; }).then(function (body) {
        if (response.status === 401 && path !== "/api/login") {
          state.authenticated = false;
          renderLogin();
          throw Object.assign(new Error(body.error || "login required"), { status: 401, silent: true });
        }
        if (!response.ok || body.ok === false) {
          throw Object.assign(new Error(body.error || "HTTP " + response.status), { status: response.status, body: body });
        }
        return body.data !== undefined ? body.data : body;
      });
    });
  }

  // ------------------------------------------------------------ preferences

  function getPref(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (error) { return fallback; }
  }
  function setPref(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* ignore */ }
  }
  var darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function applyTheme(choice) {
    var dark = choice === "dark" || (choice === "system" && darkQuery && darkQuery.matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    document.documentElement.setAttribute("data-theme-choice", choice);
    var meta = document.getElementById("theme-color");
    if (meta) meta.setAttribute("content", dark ? "#0b0d15" : "#f4f5f7");
  }
  function setTheme(choice) {
    setPref("aramin-theme", choice);
    applyTheme(choice);
    updateChrome();
  }
  function cycleTheme() {
    var current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "dark" ? "light" : "dark");
  }
  if (darkQuery && darkQuery.addEventListener) {
    darkQuery.addEventListener("change", function () { applyTheme(getPref("aramin-theme", "system")); });
  }

  function loadStrings(locale) {
    return api("/api/i18n?lang=" + encodeURIComponent(locale)).then(function (bundle) {
      state.locale = bundle.meta && bundle.meta.locale ? bundle.meta.locale : locale;
      state.strings = bundle.strings || {};
      rtf = null;
      var dir = state.locale === "fa" ? "rtl" : "ltr";
      document.documentElement.setAttribute("lang", state.locale);
      document.documentElement.setAttribute("dir", dir);
    });
  }
  function setLanguage(locale) {
    setPref("aramin-lang", locale);
    return loadStrings(locale).then(function () {
      if (state.authenticated) {
        renderShell();
        navigate(true);
      } else {
        renderLogin();
      }
    });
  }

  // ------------------------------------------------------------- navigation

  var NAV = [
    { group: "groupMain", items: [
      { id: "chats", icon: "chat", feature: "chats" },
      { id: "home", icon: "home" },
      { id: "approvals", icon: "shield", count: "approvals" },
      { id: "missions", icon: "flag", count: "missionsActive" },
      { id: "memory", icon: "brain" }
    ] },
    { group: "groupOps", items: [
      { id: "runs", icon: "zap", count: "runsActive" },
      { id: "jobs", icon: "calendar", count: "incidents" },
      { id: "audit", icon: "activity" }
    ] },
    { group: "groupKnowledge", items: [
      { id: "skills", icon: "book" },
      { id: "board", icon: "columns" }
    ] },
    { group: "groupSystem", items: [
      { id: "gateway", icon: "send" },
      { id: "system", icon: "cpu" },
      { id: "settings", icon: "settings" }
    ] }
  ];
  var BASE_TABS = [
    { id: "home", icon: "home" },
    { id: "approvals", icon: "shield", count: "approvals" },
    { id: "missions", icon: "flag", count: "missionsActive" },
    { id: "memory", icon: "brain" },
    { id: "more", icon: "grid", count: "incidents" }
  ];
  var BASE_MORE = ["runs", "jobs", "audit", "skills", "board", "gateway", "system", "settings"];
  var TABS = BASE_TABS;
  var MORE_PAGES = BASE_MORE;
  /** With conversations on, they take the first tab and memory moves under "more". */
  function layoutTabs() {
    if (chatsOn()) {
      TABS = [{ id: "chats", icon: "chat" }].concat(BASE_TABS.filter(function (tab) { return tab.id !== "memory"; }));
      MORE_PAGES = ["memory"].concat(BASE_MORE);
    } else {
      TABS = BASE_TABS;
      MORE_PAGES = BASE_MORE;
    }
  }
  var ICONS = { chats: "chat", home: "home", approvals: "shield", missions: "flag", memory: "brain", more: "grid", runs: "zap", jobs: "calendar", audit: "activity", skills: "book", board: "columns", gateway: "send", system: "cpu", settings: "settings" };

  function parseRoute() {
    var hash = location.hash.replace(/^#\/?/, "");
    var queryIndex = hash.indexOf("?");
    var query = {};
    if (queryIndex !== -1) {
      hash.slice(queryIndex + 1).split("&").forEach(function (pair) {
        var parts = pair.split("=");
        if (parts[0]) query[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || "");
      });
      hash = hash.slice(0, queryIndex);
    }
    var parts = hash.split("/").filter(Boolean);
    var name = parts[0] || "home";
    if (!VIEWS[name]) name = "home";
    return { name: name, id: parts[1] ? decodeURIComponent(parts[1]) : null, query: query };
  }
  function go(hash) {
    if (location.hash === hash) navigate(true);
    else location.hash = hash;
  }

  function countBadge(key, cls) {
    var value = key ? state.counts[key] || 0 : 0;
    return html`<span class="${cls}" data-count="${key || ""}" ${value ? "" : raw("hidden")}>${value > 99 ? "99+" : value}</span>`;
  }

  function renderShell() {
    layoutTabs();
    var root = document.getElementById("ar-root");
    root.innerHTML = out(html`
      <aside class="rail" aria-label="${t("brand")}">
        <a class="rail-brand" href="#/home">
          <svg class="rail-mark"><use href="#i-mark"/></svg>
          <span class="rail-brand-text"><strong>${t("brand")}</strong><small>${t("tagline")}</small></span>
        </a>
        <button type="button" class="rail-search" data-action="palette">
          ${icon("search")}<span>${t("common.search")}…</span><kbd>Ctrl K</kbd>
        </button>
        <nav class="rail-nav">
          ${NAV.map(function (group) {
            return html`<p class="rail-group">${t("nav." + group.group)}</p>
              ${group.items.filter(function (item) { return !item.feature || chatsOn(); }).map(function (item) {
                return html`<a class="rail-link" href="#/${item.id}" data-nav="${item.id}">
                  ${icon(item.icon)}<span class="rail-label">${t("nav." + item.id)}</span>${item.count ? countBadge(item.count, "rail-count") : ""}
                </a>`;
              })}`;
          })}
        </nav>
        <div class="rail-foot">
          <span class="live-dot" data-live></span><span class="rail-foot-text" data-live-text>${t("common.live")}</span>
        </div>
      </aside>
      <div class="main">
        <header class="appbar">
          <div class="appbar-inner">
            <a class="appbar-back" href="#/home" data-back hidden aria-label="${t("common.back")}">${icon("chevron", "flip-rtl")}</a>
            <a class="appbar-mark" href="#/home" data-brand aria-label="${t("brand")}"><svg><use href="#i-mark"/></svg></a>
            <div class="appbar-titles">
              <h1 class="appbar-title" data-title>${t("brand")}</h1>
              <p class="appbar-sub" data-subtitle></p>
            </div>
            <button type="button" class="appbar-search" data-action="palette">${icon("search")}<span>${t("palette.placeholder")}</span><kbd>Ctrl K</kbd></button>
            <button type="button" class="icon-btn only-phone" data-action="palette" aria-label="${t("common.search")}">${icon("search")}</button>
            <button type="button" class="icon-btn" data-action="notifications" aria-label="${t("nav.notifications")}">${icon("bell")}<span class="dot-count" data-unread hidden></span></button>
            <button type="button" class="icon-btn" data-action="theme" aria-label="${t("settings.theme")}">${icon("moon", "theme-dark-icon")}${icon("sun", "theme-light-icon")}</button>
          </div>
        </header>
        <main class="content" id="view" tabindex="-1"></main>
      </div>
      <nav class="tabbar" aria-label="${t("brand")}">
        ${TABS.map(function (tab) {
          return html`<a class="tab" href="#/${tab.id}" data-tab="${tab.id}">
            <span class="tab-icon">${icon(tab.icon)}${tab.count ? countBadge(tab.count, "tab-badge") : ""}</span>
            <span class="tab-label">${t("nav." + tab.id)}</span>
          </a>`;
        })}
      </nav>`);
    updateChrome();
  }

  function updateChrome() {
    var route = state.route;
    var tab = MORE_PAGES.indexOf(route.name) !== -1 ? "more" : route.name;
    $all("[data-tab]").forEach(function (el) {
      if (el.getAttribute("data-tab") === tab) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
    $all("[data-nav]").forEach(function (el) {
      var active = el.getAttribute("data-nav") === route.name || (route.name === "more" && false);
      if (active) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
    $all("[data-count]").forEach(function (el) {
      var key = el.getAttribute("data-count");
      if (!key) return;
      var value = state.counts[key] || 0;
      el.textContent = value > 99 ? "99+" : String(value);
      el.hidden = !value;
    });
    var unread = $("[data-unread]");
    if (unread) {
      unread.textContent = state.unread > 9 ? "9+" : String(state.unread);
      unread.hidden = !state.unread;
    }
    document.body.classList.toggle("chat-mode", route.name === "chats" && Boolean(route.id));
    var back = $("[data-back]");
    var brand = $("[data-brand]");
    if (back && brand) {
      var detail = Boolean(route.id) || MORE_PAGES.indexOf(route.name) !== -1;
      back.hidden = !detail;
      brand.hidden = detail;
      back.setAttribute("href", route.id ? "#/" + route.name : "#/more");
    }
    if (navigator.setAppBadge) {
      try {
        if (state.counts.approvals) navigator.setAppBadge(state.counts.approvals);
        else navigator.clearAppBadge();
      } catch (error) { /* unsupported */ }
    }
    document.title = (state.counts.approvals ? "(" + state.counts.approvals + ") " : "") + t("brand");
  }

  function setTitle(title, subtitle) {
    var el = $("[data-title]");
    var sub = $("[data-subtitle]");
    if (el) el.textContent = title;
    if (sub) {
      sub.textContent = subtitle || "";
      sub.hidden = !subtitle;
    }
  }

  // --------------------------------------------------------------- building blocks

  function skeleton(kind) {
    var row = html`<div class="sk-row"><span class="sk sk-circle"></span><span class="sk-lines"><span class="sk sk-line w60"></span><span class="sk sk-line w35"></span></span></div>`;
    if (kind === "home") {
      return html`<div class="sk sk-hero"></div>
        <div class="stats">${[1, 2, 3, 4].map(function () { return html`<div class="stat"><span class="sk sk-line w35"></span><span class="sk sk-num"></span></div>`; })}</div>
        <div class="card">${[1, 2, 3].map(function () { return row; })}</div>`;
    }
    return html`<div class="card">${[1, 2, 3, 4, 5].map(function () { return row; })}</div>`;
  }
  function empty(iconName, title, body, action) {
    return html`<div class="empty">
      <span class="empty-icon">${icon(iconName)}</span>
      <p class="empty-title">${title}</p>
      ${body ? html`<p class="empty-body">${body}</p>` : ""}
      ${action || ""}
    </div>`;
  }
  function notInstalled(engine, iconName) {
    return html`<div class="card not-installed">
      <span class="ni-icon">${icon(iconName || "sparkles")}</span>
      <div>
        <p class="ni-title">${t("common.notInstalled")}</p>
        <p class="ni-body">${t("common.notInstalledBody", { engine: engine })}</p>
      </div>
    </div>`;
  }
  function section(title, body, extra) {
    return html`<section class="section">
      <div class="section-head"><h2>${title}</h2>${extra || ""}</div>
      ${body}
    </section>`;
  }
  function kv(rows) {
    return html`<dl class="kv">${rows.filter(Boolean).map(function (row) {
      return html`<div class="kv-row"><dt>${row[0]}</dt><dd>${row[1] === null || row[1] === undefined || row[1] === "" ? t("common.none") : row[1]}</dd></div>`;
    })}</dl>`;
  }
  function valueView(value) {
    if (value === null || value === undefined) return html`<span class="muted">null</span>`;
    if (typeof value === "object") return html`<pre class="code" dir="ltr">${JSON.stringify(value, null, 2)}</pre>`;
    return ltr(String(value), "mono");
  }
  function segmented(name, options, current) {
    return html`<div class="segmented" role="tablist">${options.map(function (option) {
      return html`<button type="button" role="tab" class="seg" data-seg="${name}" data-value="${option[0]}" aria-selected="${String(option[0] === current)}">${option[1]}${option[2] !== undefined && option[2] !== null ? html` <span class="seg-count">${option[2]}</span>` : ""}</button>`;
    })}</div>`;
  }
  function progress(done, total) {
    var pct = total ? Math.round((done / total) * 100) : 0;
    return html`<div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span class="progress-bar w-${Math.round(pct / 5) * 5}"></span></div>`;
  }
  function errorCard(error) {
    return html`<div class="card error-card">${icon("alert")}<div><p class="ni-title">${t("common.error")}</p><p class="ni-body">${error && error.message ? error.message : ""}</p></div>
      <button type="button" class="btn btn-ghost" data-action="reload">${icon("refresh")}${t("common.retry")}</button></div>`;
  }

  // ---------------------------------------------------------------- toasts

  function toast(message, tone, body) {
    var root = document.getElementById("ar-toasts");
    var el = document.createElement("div");
    el.className = "toast tone-" + (tone || "neutral");
    el.innerHTML = out(html`<span class="toast-icon">${icon(tone === "danger" ? "x-circle" : tone === "warning" ? "alert" : tone === "success" ? "check-circle" : "bell")}</span>
      <div class="toast-text"><strong>${message}</strong>${body ? html`<span>${body}</span>` : ""}</div>`);
    root.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("in"); });
    setTimeout(function () {
      el.classList.remove("in");
      setTimeout(function () { el.remove(); }, 300);
    }, 4600);
  }

  // ---------------------------------------------------------------- sheets

  var sheetStack = null;
  function openSheet(content, options) {
    options = options || {};
    var root = document.getElementById("ar-sheet-root");
    root.innerHTML = out(html`<div class="sheet ${options.wide ? "sheet-wide" : ""}" role="dialog" aria-modal="true">
      <div class="sheet-backdrop" data-action="close-sheet"></div>
      <div class="sheet-panel">
        <div class="sheet-grip"></div>
        <div class="sheet-body">${content}</div>
      </div>
    </div>`);
    document.body.classList.add("locked");
    sheetStack = options;
    requestAnimationFrame(function () {
      var sheet = $(".sheet", root);
      if (sheet) sheet.classList.add("open");
      var focus = $("[autofocus]", root) || $(".sheet-panel button", root);
      if (focus && !options.noFocus) focus.focus();
    });
  }
  function closeSheet() {
    var root = document.getElementById("ar-sheet-root");
    var sheet = $(".sheet", root);
    document.body.classList.remove("locked");
    sheetStack = null;
    if (!sheet) return;
    sheet.classList.remove("open");
    setTimeout(function () { root.innerHTML = ""; }, 220);
  }
  function setSheet(content) {
    var body = $("#ar-sheet-root .sheet-body");
    if (body) body.innerHTML = out(content);
  }

  // ----------------------------------------------------------------- login

  function renderLogin(message) {
    stopEvents();
    closeSheet();
    state.chat = null;
    document.body.classList.remove("chat-mode");
    var options = state.login || { methods: ["token"], totp: "off" };
    var methods = options.methods || ["token"];
    var mode = state.loginMode && methods.indexOf(state.loginMode) !== -1 ? state.loginMode : methods[0];
    state.loginMode = mode;
    var withCode = mode === "password" && options.totp !== "off";
    var root = document.getElementById("ar-root");
    root.innerHTML = out(html`<div class="login">
      <div class="login-glow"></div>
      <form class="login-card" data-form="login" data-mode="${mode}" autocomplete="on">
        <svg class="login-mark"><use href="#i-mark"/></svg>
        <h1 class="login-title">${t("login.title")}</h1>
        <p class="login-sub">${options.remote ? t("login.subtitleRemote") : t("login.subtitle")}</p>
        ${methods.length > 1 ? html`<div class="login-tabs">${segmented("login-mode", [["password", html`${icon("user")}${t("login.withPassword")}`], ["token", html`${icon("key")}${t("login.withToken")}`]], mode)}</div>` : ""}
        ${mode === "password" ? html`
          <label class="field">
            <span class="field-label">${icon("user")}${t("login.usernameLabel")}</span>
            <input class="input input-lg ltr" dir="ltr" type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" required autofocus>
          </label>
          <label class="field">
            <span class="field-label">${icon("lock")}${t("login.passwordLabel")}</span>
            <input class="input input-lg ltr" dir="ltr" type="password" name="password" autocomplete="current-password" maxlength="256" required>
          </label>
          ${withCode ? html`<label class="field">
            <span class="field-label">${icon("shield")}${t("login.codeLabel")}${options.totp === "optional" ? html` <span class="field-note">${t("login.codeOptional")}</span>` : ""}</span>
            <input class="input input-lg ltr otp-input" dir="ltr" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="••••••" ${options.totp === "required" ? raw("required") : ""}>
          </label>` : ""}` : html`
          <label class="field">
            <span class="field-label">${icon("key")}${t("login.tokenLabel")}</span>
            <input class="input input-lg ltr" dir="ltr" type="password" name="token" placeholder="${t("login.tokenPlaceholder")}" autocomplete="current-password" spellcheck="false" autofocus required>
          </label>`}
        <p class="login-error" data-login-error ${message ? "" : raw("hidden")}>${message || ""}</p>
        <button class="btn btn-primary btn-lg btn-block" type="submit">${icon("lock")}${t("login.submit")}</button>
        ${mode === "token" ? html`<div class="login-hint">
          <span>${t("login.hint")}</span>
          <code dir="ltr">astack console token</code>
        </div>` : ""}
        <p class="login-secure">${icon("shield")}${options.remote ? t("login.secureRemote") : t("login.secure")}</p>
        <div class="login-switch">
          <button type="button" class="link" data-action="lang" data-value="${state.locale === "fa" ? "en" : "fa"}">${icon("globe")}${state.locale === "fa" ? "English" : "فارسی"}</button>
          <button type="button" class="link" data-action="theme">${icon("moon", "theme-dark-icon")}${icon("sun", "theme-light-icon")}${t("settings.theme")}</button>
        </div>
      </form>
    </div>`);
    var input = $("input[autofocus]", root);
    if (input) input.focus();
  }

  function login(body) {
    return api("/api/login", { method: "POST", body: body }).then(function (result) {
      state.csrf = result.csrf;
      return boot();
    });
  }

  // ----------------------------------------------------------------- views

  var VIEWS = {};

  function greeting() {
    var hour = new Date().getHours();
    return hour < 5 ? t("home.night") : hour < 12 ? t("home.morning") : hour < 17 ? t("home.day") : hour < 21 ? t("home.evening") : t("home.night");
  }

  function approvalCard(item, compact) {
    var values = item.parameters && typeof item.parameters === "object" ? Object.keys(item.parameters) : [];
    return html`<article class="approval ${compact ? "approval-compact" : ""} risk-${item.risk}" data-approval="${item.id}">
      <header class="approval-head">
        <span class="approval-icon">${icon(item.irreversible ? "alert" : "shield")}</span>
        <div class="approval-titles">
          <a class="approval-title" dir="auto" href="#/approvals/${item.id}">${item.summary || item.action}</a>
          <p class="approval-action">${ltr(item.action, "mono")}</p>
        </div>
        ${badge(item.risk, t("risk." + item.risk))}
      </header>
      ${compact ? "" : html`<div class="approval-grid">
        ${item.target ? html`<div class="ag"><span class="ag-k">${t("approvals.target")}</span><span class="ag-v">${ltr(item.target, "mono")}</span></div>` : ""}
        <div class="ag"><span class="ag-k">${t("approvals.level")}</span><span class="ag-v">${levelBadge(item.level)}</span></div>
        <div class="ag"><span class="ag-k">${t("approvals.requestedBy")}</span><span class="ag-v">${ltr(item.requestedBy || "astack")}</span></div>
        ${item.mission ? html`<div class="ag"><span class="ag-k">${t("approvals.mission")}</span><span class="ag-v"><a href="#/missions/${item.mission}">${ltr(item.mission, "mono")}</a></span></div>` : ""}
      </div>
      ${values.length ? html`<div class="values">
        <p class="values-title">${t("approvals.values")}</p>
        ${values.slice(0, 6).map(function (key) { return html`<div class="value-row"><span class="value-k">${ltr(key, "mono")}</span><span class="value-v">${valueView(item.parameters[key])}</span></div>`; })}
      </div>` : ""}`}
      <footer class="approval-foot">
        <span class="approval-meta">${icon("clock")}${when(item.createdAt)}${item.expiresAt && item.state === "pending" ? html` · ${t("approvals.expiresIn", { time: relTime(item.expiresAt) })}` : ""}</span>
        ${item.state === "pending" ? html`<div class="approval-actions">
          <button type="button" class="btn btn-deny" data-action="deny" data-id="${item.id}">${icon("x")}${t("approvals.deny")}</button>
          <button type="button" class="btn btn-approve" data-action="approve" data-id="${item.id}">${icon("check")}${t("approvals.approve")}</button>
        </div>` : badge(item.state)}
      </footer>
    </article>`;
  }

  function missionRow(mission) {
    return html`<a class="row" href="#/missions/${mission.id}">
      <span class="row-icon tone-${TONES[mission.state] || "neutral"}">${icon(mission.state === "completed" ? "check-circle" : mission.state === "failed" ? "x-circle" : mission.state === "paused" ? "pause" : "flag")}</span>
      <span class="row-main">
        <span class="row-title" dir="auto">${mission.title}</span>
        <span class="row-sub">${ltr(mission.id, "mono")} · ${t("missions.progress", { done: mission.done, total: mission.steps })}${mission.domain ? " · " + mission.domain : ""}</span>
        ${progress(mission.done, mission.steps)}
      </span>
      ${badge(mission.state)}
    </a>`;
  }

  function auditRow(entry) {
    return html`<div class="row row-static">
      <span class="row-icon tone-${entry.approval === "granted" ? "success" : entry.approval === "rejected" ? "danger" : "neutral"}">${icon(entry.approval === "granted" ? "check-circle" : entry.approval === "rejected" ? "x-circle" : "activity")}</span>
      <span class="row-main">
        <span class="row-title">${ltr(entry.action, "mono")}</span>
        ${entry.target ? html`<span class="row-sub">${ltr(entry.target, "mono")}</span>` : ""}
        <span class="row-sub">${ltr(entry.actor)} · ${when(entry.timestamp)}${entry.result ? html` · ${ltr(String(entry.result).slice(0, 80), "mono")}` : ""}</span>
      </span>
      ${levelBadge(entry.riskLevel)}
    </div>`;
  }

  VIEWS.home = {
    title: function () { return t("nav.home"); },
    skeleton: "home",
    load: function () { return api("/api/home"); },
    render: function (data) {
      state.counts.approvals = data.counts.approvals;
      state.counts.missionsActive = data.counts.missionsActive;
      state.counts.incidents = data.counts.incidents;
      var ownerLine = (data.owner || []).filter(function (line) { return /^- owner:/.test(line); })[0];
      var owner = ownerLine ? ownerLine.replace(/^- owner:\s*/, "") : "";
      var engines = [
        ["runner", "zap", "home.engineRunner"], ["gateway", "send", "home.engineGateway"], ["search", "search", "home.engineSearch"],
        ["skillHub", "book", "home.engineSkillHub"], ["board", "columns", "home.engineBoard"], ["daemon", "cpu", "home.engineDaemon"]
      ];
      return html`
        <section class="hero">
          <div class="hero-text">
            <p class="hero-date">${dt(new Date().toISOString(), false)}</p>
            <h2 class="hero-title">${greeting()}${owner ? html`، ${owner}` : ""}</h2>
            <p class="hero-sub">${data.counts.approvals ? t("home.summaryApprovals", { count: data.counts.approvals }) : t("home.summaryClear")}</p>
            <div class="hero-actions">
              ${data.counts.approvals ? html`<a class="btn btn-on-hero" href="#/approvals">${icon("shield")}${t("home.reviewNow")}</a>` : ""}
              <button type="button" class="btn btn-hero-ghost" data-action="palette">${icon("search")}${t("home.openPalette")}</button>
            </div>
          </div>
          <svg class="hero-art" aria-hidden="true"><use href="#i-sparkles"/></svg>
        </section>

        <div class="stats">
          <a class="stat stat-accent" href="#/approvals"><span class="stat-head"><span class="stat-label">${t("home.statApprovals")}</span><span class="stat-icon">${icon("shield")}</span></span><span class="stat-value">${data.counts.approvals}</span></a>
          <a class="stat" href="#/missions"><span class="stat-head"><span class="stat-label">${t("home.statMissions")}</span><span class="stat-icon">${icon("flag")}</span></span><span class="stat-value">${data.counts.missionsActive}</span><span class="stat-foot">${t("common.items", { count: data.counts.missionsTotal })}</span></a>
          <a class="stat ${data.counts.incidents ? "stat-danger" : ""}" href="#/jobs"><span class="stat-head"><span class="stat-label">${t("home.statIncidents")}</span><span class="stat-icon">${icon("alert")}</span></span><span class="stat-value">${data.counts.incidents}</span><span class="stat-foot">${t("home.jobsLine", { jobs: data.counts.jobs, failing: data.counts.jobsFailing })}</span></a>
          <a class="stat" href="#/audit"><span class="stat-head"><span class="stat-label">${t("home.statAudit")}</span><span class="stat-icon">${icon("activity")}</span></span><span class="stat-value">${data.counts.auditToday}</span><span class="stat-foot">${t("home.skills", { count: data.counts.skills })}</span></a>
        </div>

        <div class="cols">
          <div class="col-main">
            ${section(t("home.needsYou"), data.approvals.length
              ? html`<div class="stack">${data.approvals.slice(0, 3).map(function (item) { return approvalCard(item, true); })}</div>`
              : html`<div class="card">${empty("check-circle", t("home.allClearTitle"), t("home.allClearBody"))}</div>`,
              data.approvals.length > 3 ? html`<a class="link" href="#/approvals">${t("common.viewAll")} ${icon("chevron", "flip-rtl small")}</a>` : "")}
            ${section(t("home.activeMissions"), data.missions.length
              ? html`<div class="card list">${data.missions.map(missionRow)}</div>`
              : html`<div class="card">${empty("flag", t("home.noMissions"))}</div>`,
              html`<a class="link" href="#/missions">${t("common.viewAll")} ${icon("chevron", "flip-rtl small")}</a>`)}
          </div>
          <div class="col-side">
            ${data.runs ? section(t("home.recentRuns"), data.runs.length ? html`<div class="card list">${data.runs.map(runRow)}</div>` : html`<div class="card">${empty("zap", t("runs.emptyTitle"))}</div>`) : ""}
            ${section(t("home.background"), html`<div class="card pad">
              ${kv([
                [t("nav.jobs"), data.scheduler ? html`${data.scheduler.enabled}/${data.scheduler.jobs}` : "0"],
                [t("home.nextDue"), data.scheduler && data.scheduler.nextDue ? when(data.scheduler.nextDue) : t("common.none")],
                [t("jobs.hooks"), String(data.counts.hooks)]
              ])}
              ${data.incidents.length ? html`<div class="incident-list">${data.incidents.map(function (incident) {
                return html`<a class="incident" href="#/jobs?tab=incidents">${icon("alert")}<span><strong>${incident.job}</strong><small>${incident.summary || ""}</small></span></a>`;
              })}</div>` : ""}
            </div>`)}
            ${section(t("home.engines"), html`<div class="card pad engines">${engines.map(function (engine) {
              var on = data.features[engine[0]];
              return html`<span class="engine ${on ? "on" : "off"}">${icon(engine[1])}<span>${t(engine[2])}</span><em>${on ? t("common.installed") : t("common.notInstalled")}</em></span>`;
            })}</div>`)}
            ${section(t("home.recentActivity"), data.activity.length ? html`<div class="card list">${data.activity.map(auditRow)}</div>` : html`<div class="card">${empty("activity", t("home.noActivity"))}</div>`,
              html`<a class="link" href="#/audit">${t("common.viewAll")} ${icon("chevron", "flip-rtl small")}</a>`)}
          </div>
        </div>`;
    }
  };

  VIEWS.approvals = {
    title: function (route) { return route.id ? route.id : t("approvals.title"); },
    subtitle: function (route) { return route.id ? t("approvals.title") : t("approvals.subtitle"); },
    load: function (route) {
      if (route.id) return api("/api/approvals/" + encodeURIComponent(route.id));
      return api("/api/approvals?state=" + (route.query.state === "all" ? "all" : "pending"));
    },
    render: function (data, route) {
      if (route.id) {
        var item = data;
        state.cache["approval:" + item.id] = item;
        return html`<div class="narrow">
          ${approvalCard(item, false)}
          ${section(t("common.details"), html`<div class="card pad">${kv([
            [t("approvals.action"), ltr(item.action, "mono")],
            [t("approvals.tool"), item.tool ? ltr(item.tool, "mono") : null],
            [t("approvals.target"), item.target ? ltr(item.target, "mono") : null],
            [t("approvals.risk"), badge(item.risk, t("risk." + item.risk))],
            [t("approvals.level"), levelBadge(item.level)],
            [t("approvals.requestedBy"), ltr(item.requestedBy || "astack")],
            [t("approvals.project"), item.project ? ltr(item.project) : null],
            [t("approvals.created"), dt(item.createdAt)],
            [t("approvals.expires"), dt(item.expiresAt)],
            item.decidedAt ? [t("approvals.decided"), html`${badge(item.state)} ${dt(item.decidedAt)}`] : null,
            item.decidedBy ? [t("approvals.decidedBy"), ltr(item.decidedBy)] : null,
            item.receipt ? [t("approvals.receipt"), ltr(item.receipt.id, "mono")] : null
          ])}</div>`)}
          ${section(t("approvals.values"), html`<div class="card pad">${Object.keys(item.parameters || {}).length ? html`<pre class="code" dir="ltr">${JSON.stringify(item.parameters, null, 2)}</pre>` : html`<p class="muted">${t("approvals.noValues")}</p>`}</div>`)}
          ${item.evidence && item.evidence.length ? section(t("approvals.evidence"), html`<div class="card pad"><pre class="code" dir="ltr">${JSON.stringify(item.evidence, null, 2)}</pre></div>`) : ""}
        </div>`;
      }
      data.items.forEach(function (entry) { state.cache["approval:" + entry.id] = entry; });
      var current = route.query.state === "all" ? "all" : "pending";
      return html`<div class="narrow">
        <div class="toolbar">${segmented("approvals-state", [["pending", t("approvals.pending"), data.pending], ["all", t("approvals.all")]], current)}</div>
        ${data.items.length
          ? html`<div class="stack">${data.items.map(function (entry) { return approvalCard(entry, false); })}</div>`
          : html`<div class="card">${empty("shield", t("approvals.emptyTitle"), t("approvals.emptyBody"))}</div>`}
      </div>`;
    }
  };

  function decisionSheet(id, decision) {
    var item = state.cache["approval:" + id];
    if (!item) {
      api("/api/approvals/" + encodeURIComponent(id)).then(function (loaded) {
        state.cache["approval:" + id] = loaded;
        decisionSheet(id, decision);
      }).catch(function (error) { toast(t("common.error"), "danger", error.message); });
      return;
    }
    var approve = decision === "approve";
    var needsCode = approve && item.irreversible;
    var needsTotp = approve && Boolean(state.session.stepUp) && (item.irreversible || item.action === "claude.tool");
    openSheet(html`<form class="decision" data-form="decide" data-id="${id}" data-decision="${decision}">
      <div class="decision-head ${approve ? "is-approve" : "is-deny"}">
        <span class="decision-icon">${icon(approve ? "shield" : "x-circle")}</span>
        <div><h3>${approve ? t("approvals.approveTitle") : t("approvals.denyTitle")}</h3><p>${item.summary || item.action}</p></div>
      </div>
      <div class="recap">
        <div class="recap-row"><span>${t("approvals.action")}</span>${ltr(item.action, "mono strong")}</div>
        ${item.target ? html`<div class="recap-row"><span>${t("approvals.target")}</span>${ltr(item.target, "mono")}</div>` : ""}
        <div class="recap-row"><span>${t("approvals.risk")}</span><span>${badge(item.risk, t("risk." + item.risk))} ${levelBadge(item.level)}</span></div>
        ${Object.keys(item.parameters || {}).length ? html`<div class="recap-values"><span>${t("approvals.values")}</span>${Object.keys(item.parameters).map(function (key) { return html`<div class="value-row"><span class="value-k">${ltr(key, "mono")}</span><span class="value-v">${valueView(item.parameters[key])}</span></div>`; })}</div>` : ""}
      </div>
      ${approve && item.irreversible ? html`<p class="warn">${icon("alert")}${t("approvals.irreversible")}</p>` : ""}
      ${needsCode ? html`<label class="field">
        <span class="field-label">${t("approvals.typeCode")}: <b class="code-chip" dir="ltr">${item.confirmCode}</b></span>
        <input class="input input-lg ltr code-input" dir="ltr" name="confirm" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="8" placeholder="${item.confirmCode}" autofocus>
      </label>` : ""}
      ${needsTotp ? html`<label class="field">
        <span class="field-label">${icon("shield")}${t("approvals.stepUp")}</span>
        <input class="input input-lg ltr otp-input" dir="ltr" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="••••••" required ${needsCode ? "" : raw("autofocus")}>
      </label>` : ""}
      <label class="field">
        <span class="field-label">${approve ? t("approvals.note") : t("approvals.denyReason")}</span>
        <textarea class="input" name="note" rows="2" maxlength="500" placeholder="${t("approvals.notePlaceholder")}"></textarea>
      </label>
      <p class="form-error" data-form-error hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
        <button type="submit" class="btn btn-lg ${approve ? "btn-approve" : "btn-deny-solid"}" data-submit ${needsCode ? raw("disabled") : ""}>${icon(approve ? "check" : "x")}${approve ? t("approvals.confirmApprove") : t("approvals.confirmDeny")}</button>
      </div>
    </form>`, { noFocus: !needsCode && !needsTotp });
  }

  function receiptSheet(item) {
    var approved = item.state === "approved";
    setSheet(html`<div class="receipt ${approved ? "is-approve" : "is-deny"}">
      <span class="receipt-icon">${icon(approved ? "check" : "x")}</span>
      <h3>${approved ? t("approvals.approved") : t("approvals.denied")}</h3>
      <p class="muted">${approved ? t("approvals.approvedBody") : t("approvals.deniedBody")}</p>
      ${approved && item.receipt ? html`<div class="receipt-box">
        <div class="recap-row"><span>${t("approvals.receipt")}</span>${ltr(item.receipt.id, "mono strong")}</div>
        <div class="recap-row"><span>${t("approvals.action")}</span>${ltr(item.action, "mono")}</div>
        <div class="recap-row"><span>${t("approvals.scope")}</span><span>${t("approvals.scopeSingle")}</span></div>
        <div class="recap-row"><span>${t("approvals.receiptValid")}</span>${dt(item.receipt.expiresAt)}</div>
        <div class="recap-row"><span>${t("approvals.decidedBy")}</span>${ltr(item.decidedBy)}</div>
      </div>` : ""}
      <div class="sheet-actions">
        ${approved && item.mission ? html`<button type="button" class="btn btn-primary btn-lg" data-action="mission-resume-now" data-id="${item.mission}">${icon("play")}${t("approvals.resumeMission")}</button>` : ""}
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.close")}</button>
      </div>
    </div>`);
  }

  VIEWS.missions = {
    title: function (route) { return route.id ? t("missions.title") : t("missions.title"); },
    subtitle: function (route) { return route.id ? route.id : t("missions.subtitle"); },
    load: function (route) {
      if (route.id) return api("/api/missions/" + encodeURIComponent(route.id));
      return api("/api/missions?state=" + encodeURIComponent(route.query.state || "all"));
    },
    render: function (data, route) {
      if (route.id) return missionDetail(data);
      var current = route.query.state || "all";
      var by = data.byState || {};
      var activeCount = (by.running || 0) + (by["waiting-approval"] || 0) + (by.paused || 0) + (by.blocked || 0);
      return html`<div class="narrow">
        <div class="toolbar scroll-x">${segmented("missions-state", [["all", t("missions.all"), data.total], ["active", t("missions.active"), activeCount], ["completed", t("missions.completed"), by.completed || 0], ["failed", t("missions.failed"), by.failed || 0]], current)}</div>
        ${data.items.length ? html`<div class="card list">${data.items.map(missionRow)}</div>` : html`<div class="card">${empty("flag", t("missions.emptyTitle"), t("missions.emptyBody"))}</div>`}
      </div>`;
    }
  };

  function missionDetail(m) {
    var canPause = ["running", "waiting-approval", "blocked", "created"].indexOf(m.state) !== -1;
    var canResume = ["paused", "waiting-approval", "blocked", "failed"].indexOf(m.state) !== -1;
    var canCancel = ["completed", "cancelled"].indexOf(m.state) === -1;
    return html`<div class="narrow">
      <section class="card pad mission-head">
        <div class="mission-top">
          <span class="row-icon big tone-${TONES[m.state] || "neutral"}">${icon("flag")}</span>
          <div class="mission-titles"><h2 dir="auto">${m.title}</h2><p class="muted">${ltr(m.id, "mono")}${m.domain ? " · " + m.domain : ""}</p></div>
          ${badge(m.state)}
        </div>
        ${m.goal && m.goal !== m.title ? html`<p class="mission-goal">${m.goal}</p>` : ""}
        <div class="mission-progress"><span>${t("missions.progress", { done: m.done, total: m.steps })}</span>${progress(m.done, m.steps)}</div>
        <div class="mission-actions">
          ${canResume ? html`<button type="button" class="btn btn-primary" data-action="mission" data-op="resume" data-id="${m.id}">${icon("play")}${t("missions.resume")}</button>` : ""}
          ${canPause ? html`<button type="button" class="btn btn-ghost" data-action="mission" data-op="pause" data-id="${m.id}">${icon("pause")}${t("missions.pause")}</button>` : ""}
          ${canCancel ? html`<button type="button" class="btn btn-ghost danger-text" data-action="mission" data-op="cancel" data-id="${m.id}">${icon("stop")}${t("missions.cancel")}</button>` : ""}
        </div>
      </section>
      ${m.approvalList.length ? section(t("missions.approvals"), html`<div class="stack">${m.approvalList.map(function (a) { if (a.id) state.cache["approval:" + a.id] = a; return a.action ? approvalCard(a, true) : ""; })}</div>`) : ""}
      ${section(t("missions.steps"), m.stepList.length ? html`<ol class="steps">${m.stepList.map(function (step) {
        return html`<li class="step step-${step.state}">
          <span class="step-dot">${step.state === "done" ? icon("check") : step.state === "failed" ? icon("x") : step.state === "waiting-approval" ? icon("shield") : step.state === "running" ? icon("play") : html`<b>${step.order}</b>`}</span>
          <div class="step-body">
            <div class="step-top"><strong>${step.title}</strong>${badge(step.state)}</div>
            ${step.tool ? html`<p class="step-tool">${ltr(step.tool + (step.action ? "." + step.action : ""), "mono")}${step.authority ? html` ${levelBadge(step.authority)}` : ""}</p>` : ""}
            ${step.result && step.result.summary ? html`<p class="step-result">${step.result.summary}</p>` : ""}
            ${step.approvalId ? html`<a class="link small" href="#/approvals/${step.approvalId}">${icon("shield")}${ltr(step.approvalId, "mono")}</a>` : ""}
            ${step.finishedAt ? html`<p class="step-time">${dt(step.finishedAt)}${step.attempts > 1 ? " · " + t("missions.attempts", { count: step.attempts }) : ""}</p>` : ""}
          </div>
        </li>`;
      })}</ol>` : html`<div class="card">${empty("flag", t("missions.noSteps"))}</div>`)}
      ${m.report ? section(t("missions.report"), html`<div class="card pad"><p>${m.report.summary}</p><p class="muted small">${dt(m.report.at)} · ${badge(m.report.outcome === "done" ? "completed" : "failed")}</p></div>`) : ""}
      ${m.findings.length ? section(t("missions.findings"), html`<div class="card pad"><ul class="bullets">${m.findings.map(function (f) { return html`<li>${f}</li>`; })}</ul></div>`) : ""}
      ${m.artifacts.length ? section(t("missions.artifacts"), html`<div class="card pad"><pre class="code" dir="ltr">${JSON.stringify(m.artifacts, null, 2)}</pre></div>`) : ""}
      ${section(t("missions.timeline"), html`<div class="card pad"><ol class="timeline">${m.timeline.map(function (event) {
        return html`<li><span class="tl-dot"></span><div><strong>${ltr(event.event, "mono")}</strong> <span class="muted small">${dt(event.at)}</span>
          ${event.details && Object.keys(event.details).length ? html`<p class="small muted">${ltr(Object.keys(event.details).map(function (k) { return k + ": " + (typeof event.details[k] === "object" ? JSON.stringify(event.details[k]) : event.details[k]); }).join(" · "))}</p>` : ""}</div></li>`;
      })}</ol></div>`)}
      ${section(t("common.details"), html`<div class="card pad">${kv([
        [t("missions.priority"), m.priority],
        [t("missions.deadline"), m.deadline ? dt(m.deadline) : null],
        [t("approvals.project"), m.project ? ltr(m.project) : null],
        [t("approvals.created"), dt(m.createdAt)],
        [t("missions.updated"), dt(m.updatedAt)]
      ])}</div>`)}
    </div>`;
  }

  function missionSheet(id, op) {
    openSheet(html`<form class="decision" data-form="mission" data-id="${id}" data-op="${op}">
      <div class="decision-head ${op === "cancel" ? "is-deny" : "is-approve"}">
        <span class="decision-icon">${icon(op === "resume" ? "play" : op === "pause" ? "pause" : "stop")}</span>
        <div><h3>${t("missions." + op + "Title")}</h3><p>${ltr(id, "mono")}</p></div>
      </div>
      <p class="sheet-text">${t("missions." + op + "Body")}</p>
      <label class="field"><span class="field-label">${t("missions.reason")}</span><textarea class="input" name="reason" rows="2" maxlength="300"></textarea></label>
      <p class="form-error" data-form-error hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
        <button type="submit" class="btn btn-lg ${op === "cancel" ? "btn-deny-solid" : "btn-primary"}">${icon(op === "resume" ? "play" : op === "pause" ? "pause" : "stop")}${t("missions." + op)}</button>
      </div>
    </form>`, { noFocus: true });
  }

  VIEWS.memory = {
    title: function () { return t("memory.title"); },
    subtitle: function () { return t("memory.subtitle"); },
    load: function (route) {
      var tab = route.query.tab || "search";
      if (tab === "entity") return route.query.q ? api("/api/memory/entity?q=" + encodeURIComponent(route.query.q)) : Promise.resolve({ items: [], query: "" });
      if (tab === "stats") return api("/api/memory/stats");
      return api("/api/memory?q=" + encodeURIComponent(route.query.q || ""));
    },
    render: function (data, route) {
      var tab = route.query.tab || "search";
      var q = route.query.q || "";
      var body;
      if (tab === "stats") {
        var facets = data.memory ? data.memory.byFacet : {};
        var max = Math.max.apply(null, [1].concat(Object.keys(facets).map(function (k) { return facets[k].records; })));
        body = html`<div class="stats stats-3">
            <div class="stat"><span class="stat-label">${t("memory.records")}</span><span class="stat-value">${data.memory ? data.memory.total : 0}</span></div>
            <div class="stat"><span class="stat-label">${t("memory.nodes")}</span><span class="stat-value">${data.graph ? data.graph.nodes : 0}</span></div>
            <div class="stat"><span class="stat-label">${t("memory.edges")}</span><span class="stat-value">${data.graph ? data.graph.edges : 0}</span></div>
          </div>
          ${section(t("memory.facets"), html`<div class="card pad bars">${Object.keys(facets).map(function (k) {
            var pct = Math.round((facets[k].records / max) * 100);
            return html`<div class="bar-row"><span class="bar-k">${ltr(k)}</span><span class="bar"><span class="bar-fill w-${Math.round(pct / 5) * 5}"></span></span><span class="bar-v">${facets[k].records}</span></div>`;
          })}</div>`)}
          <p class="muted small center">${data.engine === "search" ? t("memory.engineSearch") : t("memory.engineMemory")}</p>`;
      } else if (tab === "entity") {
        body = data.items.length ? html`<div class="stack">${data.items.map(function (entity) {
          return html`<article class="card pad entity">
            <div class="entity-head"><span class="avatar">${(entity.name || "?").slice(0, 1)}</span><div><h3>${entity.name}</h3><p class="muted small">${ltr(entity.type)} · ${ltr(entity.id, "mono")}</p></div></div>
            ${entity.neighbours.length ? html`<p class="values-title">${t("memory.relations")}</p><div class="relations">${entity.neighbours.map(function (n) {
              return html`<span class="relation" dir="ltr"><span class="mono">${n.relation}</span> <span class="muted">${n.direction === "out" ? "→" : "←"}</span> <strong><bdi>${n.name}</bdi></strong> <em>${n.type}</em></span>`;
            })}</div>` : ""}
          </article>`;
        })}</div>` : html`<div class="card">${empty("user", q ? t("memory.emptyTitle") : t("memory.entityHint"), q ? t("memory.emptyBody") : "")}</div>`;
      } else {
        body = data.items.length ? html`
          ${!q ? html`<p class="hint-line">${t("memory.recent")}</p>` : ""}
          <div class="stack">${data.items.map(function (record) {
          return html`<article class="card pad memory-card">
            <div class="memory-top">${record.facet ? html`<span class="chip">${ltr(record.facet)}</span>` : ""}<span class="muted small">${record.at ? dt(record.at, false) : ""}</span>
              ${record.confidence !== null && record.confidence !== undefined ? html`<span class="muted small push">${t("memory.confidence")} ${ltr(Math.round(record.confidence * 100) + "%")}</span>` : ""}</div>
            <h3 class="memory-title" dir="auto">${record.title}</h3>
            ${record.body ? html`<p class="memory-body" dir="auto">${record.body}</p>` : ""}
            ${record.tags && record.tags.length ? html`<div class="chips">${record.tags.map(function (tag) { return html`<span class="chip chip-soft">${ltr("#" + tag)}</span>`; })}</div>` : ""}
          </article>`;
        })}</div>
          <p class="muted small center">${data.engine === "search" ? t("memory.engineSearch") : t("memory.engineMemory")}</p>` : html`<div class="card">${empty("brain", t("memory.emptyTitle"), t("memory.emptyBody"))}</div>`;
      }
      return html`<div class="narrow">
        <div class="toolbar">${segmented("memory-tab", [["search", t("memory.tabSearch")], ["entity", t("memory.tabEntity")], ["stats", t("memory.tabStats")]], tab)}</div>
        ${tab !== "stats" ? html`<form class="searchbar" data-form="memory-search" data-tab="${tab}">
          ${icon("search")}<input class="input" name="q" value="${q}" placeholder="${tab === "entity" ? t("memory.entityPlaceholder") : t("memory.placeholder")}" autocomplete="off">
          <button class="btn btn-primary" type="submit">${t("common.search")}</button>
        </form>` : ""}
        ${body}
      </div>`;
    }
  };

  VIEWS.more = {
    title: function () { return t("more.title"); },
    subtitle: function () { return t("more.subtitle"); },
    load: function () { return Promise.resolve({}); },
    render: function () {
      var chatsNote = state.features.chats && !state.features.chats.enabled && state.features.chats.reason === "remote"
        ? html`<p class="hint-line chats-note">${icon("lock")}${t("chats.unavailableRemote")}</p>` : "";
      return html`${chatsNote}<div class="tiles">${MORE_PAGES.map(function (page) {
        var count = page === "jobs" ? state.counts.incidents : page === "runs" ? state.counts.runsActive : 0;
        var available = page === "runs" ? state.features.runner : page === "board" ? state.features.board : page === "gateway" ? state.features.gateway : true;
        return html`<a class="tile" href="#/${page}">
          <span class="tile-icon">${icon(ICONS[page])}${count ? html`<span class="tab-badge">${count}</span>` : ""}</span>
          <span class="tile-title">${t("nav." + page)}</span>
          <span class="tile-sub">${t("more." + page)}</span>
          ${available ? "" : html`<span class="tile-tag">${t("common.notInstalled")}</span>`}
        </a>`;
      })}</div>
      <p class="muted small center about">${t("settings.about")}</p>`;
    }
  };

  function runRow(run) {
    return html`<a class="row" href="#/runs/${run.id}">
      <span class="row-icon tone-${TONES[run.status] || "neutral"}">${icon("zap")}</span>
      <span class="row-main"><span class="row-title" dir="auto">${run.objective || run.summary || run.id}</span>
      <span class="row-sub">${ltr(run.id, "mono")}${run.source ? html` · ${ltr(run.source)}` : ""} · ${when(run.startedAt)}</span>
      ${run.reason ? html`<span class="row-sub danger-text">${t("runs.reason")}: ${ltr(run.reason)}</span>` : ""}</span>
      ${badge(run.status)}
    </a>`;
  }

  VIEWS.runs = {
    title: function () { return t("runs.title"); },
    subtitle: function (route) { return route.id ? route.id : t("runs.subtitle"); },
    load: function (route) {
      if (!state.features.runner) return Promise.resolve({ installed: false });
      return route.id ? api("/api/runs/" + encodeURIComponent(route.id)) : api("/api/runs");
    },
    render: function (data, route) {
      if (!state.features.runner || data.installed === false) return html`<div class="narrow">${notInstalled("runner-engine", "zap")}</div>`;
      if (route.id) {
        return html`<div class="narrow"><section class="card pad">
          <div class="mission-top"><span class="row-icon big tone-${TONES[data.status] || "neutral"}">${icon("zap")}</span><div class="mission-titles"><h2 dir="auto">${data.objective || data.id}</h2><p class="muted">${ltr(data.id, "mono")}</p></div>${badge(data.status)}</div>
          ${data.reason ? html`<p class="warn">${icon("alert")}${t("runs.refusedBecause")}: ${ltr(data.reason)}</p>` : ""}
          ${kv([[t("runs.source"), data.source ? ltr(data.source) : null], [t("runs.engine"), data.engine ? ltr(data.engine) : null], [t("approvals.mission"), data.missionId ? html`<a href="#/missions/${data.missionId}">${ltr(data.missionId, "mono")}</a>` : null], [t("approvals.created"), dt(data.startedAt)], [t("runs.cost"), data.cost !== null && data.cost !== undefined ? ltr(typeof data.cost === "object" ? JSON.stringify(data.cost) : String(data.cost)) : null]])}
          ${data.approvals && data.approvals.length ? html`<div class="chips">${data.approvals.map(function (id) { return html`<a class="chip" href="#/approvals/${id}">${icon("shield")}${ltr(id, "mono")}</a>`; })}</div>` : ""}
        </section>
        ${data.summary ? section(t("missions.report"), html`<div class="card pad"><p dir="auto">${data.summary}</p></div>`) : ""}
        ${data.output ? section(t("runs.output"), html`<div class="card pad"><pre class="code" dir="ltr">${data.output}</pre></div>`) : ""}</div>`;
      }
      return html`<div class="narrow">
        <form class="card pad run-form" data-form="run">
          <label class="field"><span class="field-label">${icon("sparkles")}${t("runs.newRun")}</span>
            <textarea class="input" name="objective" rows="3" maxlength="2000" placeholder="${t("runs.objectivePlaceholder")}" required></textarea></label>
          <p class="muted small">${t("runs.dryRunFirst")}</p>
          <div class="run-preview" data-run-preview hidden></div>
          <p class="form-error" data-form-error hidden></p>
          <div class="row-actions">
            <button type="submit" class="btn btn-primary" data-run-preview-btn>${icon("search")}${t("runs.preview")}</button>
            <button type="button" class="btn btn-approve" data-action="run-real" hidden>${icon("play")}${t("runs.runForReal")}</button>
          </div>
        </form>
        ${data.status ? section(t("runs.status"), html`<div class="card pad">${kv(Object.keys(data.status).filter(function (k) { return data.status[k] === null || typeof data.status[k] !== "object"; }).slice(0, 12).map(function (k) { return [ltr(k, "mono"), ltr(String(data.status[k]))]; }))}</div>`) : ""}
        ${section(t("runs.title"), data.items.length ? html`<div class="card list">${data.items.map(runRow)}</div>` : html`<div class="card">${empty("zap", t("runs.emptyTitle"), t("runs.emptyBody"))}</div>`)}
      </div>`;
    }
  };

  VIEWS.jobs = {
    title: function () { return t("jobs.title"); },
    subtitle: function () { return t("jobs.subtitle"); },
    load: function (route) {
      return (route.query.tab === "hooks" ? api("/api/hooks") : api("/api/jobs"));
    },
    render: function (data, route) {
      var tab = route.query.tab || "jobs";
      var body;
      if (tab === "hooks") {
        body = html`${data.items.length ? html`<div class="card list">${data.items.map(function (hook) {
            return html`<div class="row row-static">
              <span class="row-icon tone-${hook.enabled ? "info" : "neutral"}">${icon("webhook")}</span>
              <span class="row-main"><span class="row-title">${hook.name}</span>
                <span class="row-sub">${ltr(hook.path, "mono")} · ${ltr(hook.source)} · ${hook.rules} ${t("jobs.rules")}${hook.requireSignature ? html` · ${t("jobs.signature")}` : ""}</span>
                <span class="row-sub">${t("jobs.received")} ${hook.received} · ${t("jobs.processed")} ${hook.processed} · ${when(hook.lastAt)}</span></span>
              ${badge(hook.enabled ? "ok" : "disabled", hook.enabled ? t("states.enabled") : t("states.disabled"))}
            </div>`;
          })}</div>` : html`<div class="card">${empty("webhook", t("jobs.emptyHooks"))}</div>`}
          ${data.inbox.length ? section(t("jobs.inbox"), html`<div class="card list">${data.inbox.map(function (event) {
            return html`<div class="row row-static"><span class="row-icon tone-neutral">${icon("inbox")}</span>
              <span class="row-main"><span class="row-title" dir="auto">${event.text || event.id}</span><span class="row-sub">${ltr(event.hook || "")} · ${when(event.at)}</span></span>${badge(event.state)}</div>`;
          })}</div><p class="muted small">${t("jobs.inboxNote")}</p>`) : ""}`;
      } else if (tab === "incidents") {
        body = data.incidents.length ? html`<div class="card list">${data.incidents.map(function (incident) {
          return html`<div class="row row-static"><span class="row-icon tone-${incident.closedAt ? "success" : "danger"}">${icon(incident.closedAt ? "check-circle" : "alert")}</span>
            <span class="row-main"><span class="row-title">${incident.job}</span><span class="row-sub">${incident.summary || ""}</span><span class="row-sub">${ltr(incident.id, "mono")} · ${dt(incident.openedAt || incident.closedAt)}</span></span>
            ${badge(incident.closedAt ? "ok" : "failed", incident.closedAt ? t("jobs.closed") : t("jobs.open"))}</div>`;
        })}</div>` : html`<div class="card">${empty("check-circle", t("jobs.emptyIncidents"))}</div>`;
      } else {
        body = html`<p class="daemon-line ${data.daemon && data.daemon.running ? "on" : "off"}"><span class="live-dot"></span>${data.daemon && data.daemon.running ? t("jobs.daemonOn") : t("jobs.daemonOff")}</p>
          ${data.items.length ? html`<div class="stack">${data.items.map(function (job) {
            var status = !job.enabled ? "disabled" : job.lastStatus || "idle";
            return html`<article class="card pad job">
              <div class="job-top"><span class="row-icon tone-${TONES[status] || "neutral"}">${icon("calendar")}</span>
                <div class="job-titles"><strong>${job.name}</strong><p class="muted small">${ltr(job.kind, "mono")} · ${ltr(job.schedule, "mono")}</p></div>
                ${badge(status)}</div>
              <p class="small muted">${job.kindLabel}</p>
              ${job.target ? html`<p class="small">${ltr(job.target, "mono")}</p>` : ""}
              <div class="job-meta">
                <span>${t("jobs.next")}: ${job.next ? when(job.next) : t("common.none")}</span>
                <span>${t("jobs.last")}: ${job.last ? when(job.last) : t("common.never")}</span>
                ${job.failures ? html`<span class="danger-text">${t("jobs.failures")}: ${job.failures}</span>` : ""}
              </div>
              ${job.history.length ? html`<div class="spark">${job.history.slice().reverse().map(function (h) { return html`<span class="spark-dot tone-${h.status === "ok" ? "success" : "danger"}" title="${fmtDate(h.at)} ${h.status}"></span>`; })}</div>` : ""}
              <div class="row-actions">${job.runnable
                ? html`<button type="button" class="btn btn-ghost" data-action="job-run" data-id="${job.id}">${icon("play")}${t("jobs.runNow")}</button>`
                : html`<span class="muted small">${icon("lock")}${t("jobs.notRunnable")}</span>`}</div>
            </article>`;
          })}</div>` : html`<div class="card">${empty("calendar", t("jobs.emptyJobs"), t("jobs.emptyJobsBody"))}</div>`}`;
      }
      return html`<div class="narrow">
        <div class="toolbar">${segmented("jobs-tab", [["jobs", t("jobs.jobs"), tab === "hooks" ? null : data.items.length], ["hooks", t("jobs.hooks")], ["incidents", t("jobs.incidents"), state.counts.incidents || null]], tab)}</div>
        ${body}
      </div>`;
    }
  };

  VIEWS.audit = {
    title: function () { return t("audit.title"); },
    subtitle: function () { return t("audit.subtitle"); },
    load: function (route) {
      var q = route.query;
      var params = ["page=" + encodeURIComponent(q.page || 1), "size=25"];
      ["action", "risk", "month", "q"].forEach(function (key) { if (q[key]) params.push(key + "=" + encodeURIComponent(q[key])); });
      return api("/api/audit?" + params.join("&"));
    },
    render: function (data, route) {
      var q = route.query;
      function select(name, label, values, current) {
        return html`<select class="input select" data-filter="${name}" aria-label="${label}"><option value="">${label}</option>${values.map(function (v) { return html`<option value="${v}" ${v === current ? raw("selected") : ""}>${v}</option>`; })}</select>`;
      }
      return html`<div class="narrow">
        <form class="filters" data-form="audit">
          <div class="searchbar">${icon("search")}<input class="input" name="q" value="${q.q || ""}" placeholder="${t("audit.search")}"></div>
          <div class="filter-row">
            ${select("action", t("audit.allActions"), data.actions, q.action)}
            ${select("risk", t("audit.allRisks"), data.risks, q.risk)}
            ${select("month", t("audit.allMonths"), data.months, q.month)}
          </div>
        </form>
        <p class="muted small">${t("audit.records", { count: data.total })}</p>
        ${data.items.length ? html`<div class="card list">${data.items.map(auditRow)}</div>` : html`<div class="card">${empty("activity", t("audit.emptyTitle"))}</div>`}
        ${data.pages > 1 ? html`<div class="pager">
          <button type="button" class="btn btn-ghost" data-action="page" data-page="${data.page - 1}" ${data.page <= 1 ? raw("disabled") : ""}>${icon("chevron", "flip-ltr")}${t("common.prev")}</button>
          <span class="muted small">${t("common.page", { page: data.page, pages: data.pages })}</span>
          <button type="button" class="btn btn-ghost" data-action="page" data-page="${data.page + 1}" ${data.page >= data.pages ? raw("disabled") : ""}>${t("common.next")}${icon("chevron", "flip-rtl")}</button>
        </div>` : ""}
      </div>`;
    }
  };

  VIEWS.skills = {
    title: function () { return t("skills.title"); },
    subtitle: function () { return t("skills.subtitle"); },
    load: function (route) {
      var params = [];
      if (route.query.q) params.push("q=" + encodeURIComponent(route.query.q));
      if (route.query.source) params.push("source=" + encodeURIComponent(route.query.source));
      return api("/api/skills" + (params.length ? "?" + params.join("&") : ""));
    },
    render: function (data, route) {
      var source = route.query.source || "";
      var bySource = data.stats ? data.stats.bySource || {} : {};
      return html`<div class="narrow">
        <form class="searchbar" data-form="skills">${icon("search")}<input class="input" name="q" value="${route.query.q || ""}" placeholder="${t("skills.search")}"><button class="btn btn-primary" type="submit">${t("common.search")}</button></form>
        <div class="toolbar scroll-x">${segmented("skills-source", [["", t("common.all"), data.stats ? data.stats.skills : null], ["builtin", t("skills.builtin"), bySource.builtin || 0], ["learned", t("skills.learned"), bySource.learned || 0], ["pack", t("skills.pack"), Object.keys(bySource).filter(function (k) { return k.indexOf("pack") === 0; }).reduce(function (s, k) { return s + bySource[k]; }, 0)]], source)}</div>
        ${data.hub && data.hub.installed ? (data.hub.packs && data.hub.packs.length ? section(t("skills.packs"), html`<div class="chips">${data.hub.packs.map(function (pack) { return html`<span class="chip">${icon("book")}${pack.name}${pack.skills !== null ? html` <em>${pack.skills}</em>` : ""}</span>`; })}</div>`) : "") : html`<p class="hint-line">${icon("sparkles")}${t("skills.hubMissing")}</p>`}
        ${data.items.length ? html`<div class="grid-cards">${data.items.map(function (skill) {
          return html`<button type="button" class="card pad skill" data-action="skill" data-id="${skill.id}">
            <span class="skill-top"><span class="skill-icon">${icon("book")}</span><span class="chip chip-soft">${ltr(skill.source)}</span>${skill.status ? badge(skill.status === "trusted" || skill.status === "active" ? "ok" : skill.status === "deprecated" ? "failed" : "pending", skill.status) : ""}</span>
            <strong class="skill-name" dir="auto">${skill.name}</strong>
            <span class="skill-desc" dir="auto">${skill.description || skill.id}</span>
            <span class="skill-foot">${ltr(skill.id, "mono")}${skill.confidence !== null ? html` · ${ltr(Math.round(skill.confidence * 100) + "%")}` : ""}</span>
          </button>`;
        })}</div>` : html`<div class="card">${empty("book", t("skills.emptyTitle"))}</div>`}
      </div>`;
    }
  };

  VIEWS.board = {
    title: function () { return t("board.title"); },
    subtitle: function () { return t("board.subtitle"); },
    load: function () { return api("/api/board"); },
    render: function (data) {
      if (!data.installed) return html`<div class="narrow">${notInstalled(t("board.engine"), "columns")}</div>`;
      if (!data.cards.length) return html`<div class="card">${empty("columns", t("board.empty"))}</div>`;
      return html`<div class="board">${data.columns.map(function (column) {
        var cards = data.cards.filter(function (card) { return card.column === column; });
        return html`<section class="board-col"><header><strong>${ltr(column)}</strong><span class="seg-count">${cards.length}</span></header>
          ${cards.map(function (card) { return html`<article class="card pad board-card"><strong dir="auto">${card.title}</strong><p class="muted small">${ltr(card.id, "mono")}${card.assignee ? html` · ${ltr(card.assignee)}` : ""}${card.attempts ? " · " + card.attempts : ""}</p></article>`; })}</section>`;
      })}</div>`;
    }
  };

  VIEWS.gateway = {
    title: function () { return t("gateway.title"); },
    subtitle: function () { return t("gateway.subtitle"); },
    load: function () { return api("/api/gateway"); },
    render: function (data) {
      if (!data.installed) return html`<div class="narrow">${notInstalled(t("gateway.engine"), "send")}</div>`;
      return html`<div class="narrow"><div class="card pad"><pre class="code" dir="ltr">${JSON.stringify(data.status, null, 2)}</pre></div></div>`;
    }
  };

  VIEWS.system = {
    title: function () { return t("system.title"); },
    subtitle: function () { return t("system.subtitle"); },
    load: function () { return api("/api/system"); },
    render: function (data) {
      var featureNames = { runner: "runner-engine", gateway: "gateway-engine", search: "search-engine", skillHub: "skill-hub", board: "board-engine", sandbox: "sandbox-engine", daemon: "daemon-engine" };
      return html`<div class="narrow">
        <div class="stats stats-3">
          <div class="stat"><span class="stat-label">AStack</span><span class="stat-value">${ltr(data.versions.astack || "?")}</span></div>
          <div class="stat"><span class="stat-label">Node.js</span><span class="stat-value">${ltr(data.versions.node)}</span></div>
          <div class="stat"><span class="stat-label">${t("system.build")}</span><span class="stat-value small-value">${ltr(data.console ? data.console.build : "-", "mono")}</span></div>
        </div>
        ${section(t("system.features"), html`<div class="card pad engines">${Object.keys(data.features).map(function (key) {
          return html`<span class="engine ${data.features[key] ? "on" : "off"}">${icon(data.features[key] ? "check-circle" : "x-circle")}<span>${ltr(featureNames[key] || key)}</span><em>${data.features[key] ? t("system.present") : t("system.absent")}</em></span>`;
        })}</div>`)}
        ${section(t("system.services"), html`<div class="card list">${data.services.map(function (service) {
          return html`<div class="row row-static"><span class="row-icon tone-${service.present ? "success" : "neutral"}">${icon("cpu")}</span><span class="row-main"><span class="row-title">${ltr(service.id + "/service.mjs", "mono")}</span></span>${badge(service.present ? "ok" : "disabled", service.present ? t("system.present") : t("system.absent"))}</div>`;
        })}</div>`)}
        ${data.daemonState ? section(t("system.daemon"), html`<div class="card list">
          <div class="row row-static"><span class="row-icon tone-${data.daemonState.alive ? "success" : "neutral"}">${icon("cpu")}</span><span class="row-main"><span class="row-title">astack daemon</span><span class="row-sub">${data.daemonState.pid ? html`pid ${ltr(String(data.daemonState.pid))} · ` : ""}${when(data.daemonState.startedAt || data.daemonState.updatedAt)}</span></span>${badge(data.daemonState.alive ? "running" : "stopped")}</div>
          ${data.daemonState.services.map(function (svc) {
            return html`<div class="row row-static"><span class="row-icon tone-${TONES[svc.status] || (svc.status === "running" || svc.status === "started" ? "success" : "neutral")}">${icon(ICONS[svc.name] || "cpu")}</span><span class="row-main"><span class="row-title">${ltr(svc.name, "mono")}</span>${svc.error ? html`<span class="row-sub danger-text">${ltr(svc.error)}</span>` : ""}</span>${badge(svc.status === "started" ? "running" : svc.status || "unknown")}</div>`;
          })}
        </div>`) : ""}
        ${data.daemon ? section(t("system.daemon"), html`<div class="card pad"><pre class="code" dir="ltr">${JSON.stringify(data.daemon, null, 2)}</pre></div>`) : ""}
        ${section(t("system.console"), html`<div class="card pad">${kv(data.console ? [
          [t("system.address"), ltr(data.console.url, "mono")],
          [t("system.loopback"), data.console.loopback ? badge("ok", t("system.loopback")) : badge("high", t("system.exposed"))],
          [t("system.sessions"), String(data.console.sessions)],
          [t("approvals.created"), dt(data.console.startedAt)]
        ] : [])}</div>`)}
        ${section(t("system.runtimes"), html`<div class="card list">${data.runtimes.map(function (rt) {
          return html`<div class="row row-static"><span class="row-icon tone-${rt.available ? "success" : "neutral"}">${icon("monitor")}</span><span class="row-main"><span class="row-title">${ltr(rt.id, "mono")}</span><span class="row-sub">${ltr(rt.status || "")}</span></span>${badge(rt.available ? "ok" : "disabled", rt.available ? t("system.available") : t("system.unavailable"))}</div>`;
        })}</div>`)}
        ${section(t("system.doctor"), html`<div class="card pad">${kv(data.doctor.map(function (line) { return [ltr(line.key, "mono"), ltr(String(line.value))]; }))}</div>`)}
        ${section(t("system.versions"), html`<div class="card pad">${kv([["AStack", ltr(data.versions.astack)], ["core", ltr(data.versions.core)], ["Node.js", ltr(data.versions.node)], ["platform", ltr(data.versions.platform)], ["scheduler daemon", data.scheduler && data.scheduler.running ? badge("ok", t("jobs.daemonOn")) : badge("disabled", t("jobs.daemonOff"))]])}</div>`)}
      </div>`;
    }
  };

  function notificationState() {
    if (!("Notification" in window)) return "unsupported";
    return Notification.permission;
  }

  VIEWS.settings = {
    title: function () { return t("settings.title"); },
    subtitle: function () { return t("settings.subtitle"); },
    load: function () { return Promise.resolve({}); },
    render: function () {
      var theme = getPref("aramin-theme", "system");
      var perm = notificationState();
      var standalone = document.documentElement.getAttribute("data-display") === "standalone";
      return html`<div class="narrow">
        ${section(t("settings.theme"), html`<div class="card pad">${segmented("theme", [["light", html`${icon("sun")}${t("settings.themeLight")}`], ["dark", html`${icon("moon")}${t("settings.themeDark")}`], ["system", html`${icon("monitor")}${t("settings.themeSystem")}`]], theme)}</div>`)}
        ${section(t("settings.language"), html`<div class="card pad">${segmented("lang", [["fa", "فارسی"], ["en", "English"]], state.locale)}</div>`)}
        ${section(t("settings.notifications"), html`<div class="card pad setting">
          <p class="muted">${t("settings.notificationsBody")}</p>
          ${perm === "granted" ? html`<p class="ok-line">${icon("check-circle")}${t("settings.notificationsOn")}</p>`
            : perm === "denied" ? html`<p class="danger-text">${icon("x-circle")}${t("settings.notificationsBlocked")}</p>`
            : perm === "unsupported" ? html`<p class="muted">${t("settings.notificationsUnsupported")}</p>`
            : html`<button type="button" class="btn btn-primary" data-action="enable-notifications">${icon("bell")}${t("settings.notificationsEnable")}</button>`}
        </div>`)}
        ${section(t("settings.install"), html`<div class="card pad setting">
          <p class="muted">${t("settings.installBody")}</p>
          ${standalone ? html`<p class="ok-line">${icon("check-circle")}${t("settings.installed")}</p>`
            : state.installPrompt ? html`<button type="button" class="btn btn-primary" data-action="install">${icon("download")}${t("settings.installButton")}</button>`
            : html`<p class="muted small">${t("settings.installManual")}</p>`}
        </div>`)}
        ${section(t("settings.account"), html`<div class="card pad setting">
          <p class="account-line">${icon(state.session.user ? "user" : "key")}<span>${state.session.user ? t("settings.signedInAs", { user: state.session.user }) : t("settings.signedInToken")}</span>${state.session.remote ? html`<span class="badge tone-info">${t("settings.viaInternet")}</span>` : ""}</p>
          <p class="muted small">${t("settings.logoutAllHint")}</p>
          <button type="button" class="btn btn-ghost danger-text" data-action="logout-all">${icon("logout")}${t("settings.logoutAll")}</button>
        </div>`)}
        <button type="button" class="btn btn-ghost btn-block danger-text logout" data-action="logout">${icon("logout")}${t("settings.logout")}</button>
        <p class="muted small center about">${t("settings.about")}</p>
      </div>`;
    }
  };

  // ----------------------------------------------------------- conversations

  function chatsOn() {
    return Boolean(state.features.chats && state.features.chats.enabled);
  }

  /** Right-to-left when the first strong letter is Persian/Arabic/Hebrew. */
  var RTL_CHAR = /[֐-ࣿיִ-﷽ﹰ-ﻼ]/;
  var LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
  function textDir(text) {
    var value = String(text || "").replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ");
    for (var i = 0; i < value.length; i += 1) {
      var c = value.charAt(i);
      if (RTL_CHAR.test(c)) return "rtl";
      if (LTR_CHAR.test(c)) return "ltr";
    }
    return state.locale === "fa" ? "rtl" : "ltr";
  }

  // ---- safe markdown: everything is escaped first, then a small set of
  // block and inline forms is recognised. No raw HTML ever survives.

  function mdInline(text) {
    var parts = String(text).split(/(`[^`\n]+`)/g);
    return parts.map(function (part) {
      if (/^`[^`\n]+`$/.test(part)) return '<code class="md-ic" dir="ltr">' + esc(part.slice(1, -1)) + "</code>";
      var value = esc(part);
      value = value.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2000})\)/g, function (_, label, href) {
        return '<a class="md-link" href="' + href + '" target="_blank" rel="noopener noreferrer nofollow">' + label + "</a>";
      });
      value = value.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
      value = value.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?،؛]|$)/g, "$1<em>$2</em>");
      value = value.replace(/~~([^~\n]+?)~~/g, "<del>$1</del>");
      return value;
    }).join("");
  }

  function mdTableRow(line) {
    var cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
    return cells.map(function (cell) { return cell.trim(); });
  }

  function markdown(source) {
    var lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
    var htmlOut = [];
    var i = 0;
    var paragraph = [];
    function flush() {
      if (paragraph.length) {
        var text = paragraph.join("\n");
        htmlOut.push('<p dir="' + textDir(text) + '">' + mdInline(text).replace(/\n/g, "<br>") + "</p>");
        paragraph = [];
      }
    }
    while (i < lines.length) {
      var line = lines[i];
      var fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        flush();
        var code = [];
        i += 1;
        while (i < lines.length && lines[i].trim().indexOf(fence[1]) !== 0) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1;
        htmlOut.push('<div class="md-code"><div class="md-code-head"><span>' + esc(fence[2] || "code") + '</span><button type="button" class="md-copy" data-action="copy-code">' + out(icon("copy")) + "<span>" + esc(t("chats.copy")) + '</span></button></div><pre dir="ltr"><code>' + esc(code.join("\n")) + "</code></pre></div>");
        continue;
      }
      if (/^\s*$/.test(line)) {
        flush();
        i += 1;
        continue;
      }
      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        var level = Math.min(6, heading[1].length + 2);
        htmlOut.push("<h" + level + ' class="md-h" dir="' + textDir(heading[2]) + '">' + mdInline(heading[2]) + "</h" + level + ">");
        i += 1;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        htmlOut.push('<hr class="md-hr">');
        i += 1;
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush();
        var head = mdTableRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          rows.push(mdTableRow(lines[i]));
          i += 1;
        }
        var tableDir = textDir(head.join(" ") + " " + (rows[0] || []).join(" "));
        htmlOut.push('<div class="md-table-wrap"><table class="md-table" dir="' + tableDir + '"><thead><tr>' + head.map(function (cell) { return "<th>" + mdInline(cell) + "</th>"; }).join("") + "</tr></thead><tbody>" +
          rows.map(function (row) { return "<tr>" + row.map(function (cell) { return '<td dir="' + textDir(cell) + '">' + mdInline(cell) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table></div>");
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        flush();
        var quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        var quoteText = quote.join("\n");
        htmlOut.push('<blockquote class="md-quote" dir="' + textDir(quoteText) + '">' + mdInline(quoteText).replace(/\n/g, "<br>") + "</blockquote>");
        continue;
      }
      var listMatch = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
      if (listMatch) {
        flush();
        var ordered = /\d/.test(listMatch[2]);
        var itemsHtml = [];
        var listText = [];
        while (i < lines.length) {
          var m = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[i]);
          if (m && /\d/.test(m[2]) === ordered) {
            var task = /^\[( |x|X)\]\s+(.*)$/.exec(m[3]);
            var body = task ? task[2] : m[3];
            listText.push(body);
            itemsHtml.push('<li dir="' + textDir(body) + '"' + (m[1].length >= 2 ? ' class="md-sub"' : "") + ">" + (task ? '<span class="md-task' + (task[1] !== " " ? " done" : "") + '"></span>' : "") + mdInline(body) + "</li>");
            i += 1;
          } else if (lines[i] && /^\s{2,}\S/.test(lines[i]) && itemsHtml.length) {
            itemsHtml[itemsHtml.length - 1] = itemsHtml[itemsHtml.length - 1].replace(/<\/li>$/, "<br>" + mdInline(lines[i].trim()) + "</li>");
            i += 1;
          } else {
            break;
          }
        }
        var tag = ordered ? "ol" : "ul";
        htmlOut.push("<" + tag + ' class="md-list" dir="' + textDir(listText.join(" ")) + '">' + itemsHtml.join("") + "</" + tag + ">");
        continue;
      }
      paragraph.push(line);
      i += 1;
    }
    flush();
    return raw(htmlOut.join(""));
  }

  // ---- list

  function chatRow(item) {
    return html`<a class="chat-row" href="#/chats/${item.id}">
      <span class="chat-avatar ${item.active ? "is-live" : ""}">${icon(item.active ? "sparkles" : "chat")}</span>
      <span class="chat-row-main">
        <span class="chat-row-top">
          <span class="chat-row-title" dir="${textDir(item.title)}">${item.title || t("chats.untitled")}</span>
          <span class="chat-row-time">${ltr(fmtDate(item.lastAt))}</span>
        </span>
        <span class="chat-row-meta">
          <span>${t("chats.messages", { count: item.messages })}</span>
          ${item.branch ? html`<span class="chat-branch">${icon("branch")}${ltr(item.branch, "mono")}</span>` : ""}
          ${item.subagents ? html`<span class="chat-sub">${icon("grid")}${t("chats.subagents", { count: item.subagents })}</span>` : ""}
          ${item.active ? html`<span class="chat-live">${t("chats.answering")}</span>` : ""}
        </span>
      </span>
    </a>`;
  }

  function spendLine(today, budget) {
    if (!today) return "";
    return html`<p class="chat-spend">${icon("activity")}<span>${t("chats.today")}</span>${ltr("$" + Number(today.usd || 0).toFixed(2), "strong")}<span class="muted">· ${t("chats.turns", { count: today.turns || 0 })}</span>${budget ? html`<span class="muted">· ${t("chats.budget")}</span>${ltr("$" + Number(budget).toFixed(2))}` : ""}</p>`;
  }

  function chatsUnavailable() {
    var reason = state.features.chats && state.features.chats.reason;
    return html`<div class="narrow"><div class="card">${empty("lock", t("chats.unavailableTitle"), reason === "remote" ? t("chats.unavailableRemote") : t("chats.unavailableOff"))}</div></div>`;
  }

  VIEWS.chats = {
    title: function (route) {
      if (route.id === "new") return t("chats.newTitle");
      if (route.id && state.chat && state.chat.id === route.id) return state.chat.title || t("chats.title");
      return t("chats.title");
    },
    subtitle: function (route) {
      if (route.id && state.chat && state.chat.id === route.id && state.chat.project) return state.chat.project.name + (state.chat.branch ? " · " + state.chat.branch : "");
      return route.id ? "" : t("chats.subtitle");
    },
    load: function (route) {
      if (!chatsOn()) return Promise.resolve({ unavailable: true });
      if (route.id === "new") {
        return api("/api/chats?size=5").then(function (list) { return { isNew: true, projects: list.projects, today: list.today, budget: list.budget }; });
      }
      if (route.id) return api("/api/chats/" + encodeURIComponent(route.id) + (route.query.agent ? "?agent=" + encodeURIComponent(route.query.agent) : ""));
      var params = ["page=" + encodeURIComponent(route.query.page || 1)];
      if (route.query.q) params.push("q=" + encodeURIComponent(route.query.q));
      if (route.query.project) params.push("project=" + encodeURIComponent(route.query.project));
      return api("/api/chats?" + params.join("&"));
    },
    render: function (data, route) {
      if (data.unavailable) return chatsUnavailable();
      if (route.id) return chatView(data, route);
      state.chatProjects = data.projects;
      var groups = [];
      var byProject = {};
      data.items.forEach(function (item) {
        var key = String(item.project.index);
        if (!byProject[key]) {
          byProject[key] = { project: item.project, items: [] };
          groups.push(byProject[key]);
        }
        byProject[key].items.push(item);
      });
      var current = route.query.project || "";
      return html`<div class="narrow chats-list">
        <form class="chat-search" data-form="chat-search" role="search">
          ${icon("search")}
          <input class="chat-search-input" type="search" name="q" value="${route.query.q || ""}" placeholder="${t("chats.search")}" autocomplete="off" data-chat-search>
          <button type="button" class="btn btn-primary chat-new" data-action="chat-new">${icon("plus")}<span>${t("chats.new")}</span></button>
        </form>
        ${data.projects.length > 1 ? html`<div class="toolbar scroll-x">${segmented("chat-project", [[""].concat([t("common.all")]).concat([null])].concat(data.projects.map(function (p) { return [String(p.index), p.name, p.sessions]; })), current)}</div>` : ""}
        ${spendLine(data.today, data.budget)}
        ${data.items.length ? groups.map(function (group) {
          return html`<section class="chat-group">
            ${data.projects.length > 1 ? html`<p class="chat-group-title">${icon("file")}${group.project.name}</p>` : ""}
            <div class="card list chat-list">${group.items.map(chatRow)}</div>
          </section>`;
        }) : html`<div class="card">${empty("chat", route.query.q ? t("common.noResults") : t("chats.emptyTitle"), route.query.q ? "" : t("chats.emptyBody"), html`<button type="button" class="btn btn-primary" data-action="chat-new">${icon("plus")}${t("chats.new")}</button>`)}</div>`}
        ${data.pages > 1 ? html`<div class="pager">
          <button type="button" class="btn btn-ghost" data-action="page" data-page="${data.page - 1}" ${data.page <= 1 ? raw("disabled") : ""}>${icon("chevron", "flip-ltr")}${t("common.prev")}</button>
          <span class="muted small">${ltr(data.page + " / " + data.pages)}</span>
          <button type="button" class="btn btn-ghost" data-action="page" data-page="${data.page + 1}" ${data.page >= data.pages ? raw("disabled") : ""}>${t("common.next")}${icon("chevron", "flip-rtl")}</button>
        </div>` : ""}
      </div>`;
    },
    mount: function (container, data, route) {
      if (route.id && !data.unavailable) mountChat(container);
    }
  };

  function newChatSheet() {
    var projects = state.chatProjects || [];
    if (projects.length <= 1) {
      go("#/chats/new?project=" + (projects[0] ? projects[0].index : 0));
      return;
    }
    openSheet(html`<div class="project-pick">
      <h3 class="sheet-title">${icon("plus")}${t("chats.pickProject")}</h3>
      <div class="list">${projects.map(function (p) {
        return html`<a class="row" href="#/chats/new?project=${p.index}" data-action="close-sheet-nav">
          <span class="row-icon tone-info">${icon("file")}</span>
          <span class="row-main"><span class="row-title">${p.name}</span><span class="row-sub">${p.exists ? t("chats.sessionsCount", { count: p.sessions || 0 }) : t("chats.projectMissing")}</span></span>
        </a>`;
      })}</div>
      <div class="sheet-actions"><button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.close")}</button></div>
    </div>`, { noFocus: true });
  }

  // ---- one conversation

  function toolIcon(name) {
    if (/^(Read|NotebookRead)$/.test(name)) return "file";
    if (/^(Grep|Glob|LS|WebSearch)$/.test(name)) return "search";
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return "edit";
    if (/^(Bash|PowerShell|BashOutput|KillShell)$/.test(name)) return "terminal";
    if (/^(WebFetch)$/.test(name)) return "globe";
    if (/^(Task|Agent)$/.test(name)) return "grid";
    if (/^mcp__/.test(name)) return "link";
    return "cpu";
  }

  function toolName(name) {
    var match = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name || "");
    return match ? match[1] + " · " + match[2] : name;
  }

  function toolChip(item) {
    var status = item.result ? (item.result.error ? "error" : "ok") : item.running ? "running" : "none";
    return html`<details class="tool-chip status-${status}" data-tool="${item.id || ""}">
      <summary>
        <span class="tool-icon">${icon(toolIcon(item.name))}</span>
        <span class="tool-name">${toolName(item.name)}</span>
        ${item.target ? html`<bdi class="tool-target" dir="ltr">${item.target}</bdi>` : ""}
        <span class="tool-state" aria-hidden="true"></span>
      </summary>
      <div class="tool-body">
        ${item.input && Object.keys(item.input).length ? html`<p class="tool-label">${t("chats.toolInput")}</p><pre class="code" dir="ltr">${JSON.stringify(item.input, null, 2)}</pre>` : ""}
        <div data-tool-result>${toolResult(item.result)}</div>
      </div>
    </details>`;
  }

  function toolResult(result) {
    if (!result) return "";
    return html`<p class="tool-label ${result.error ? "danger-text" : ""}">${result.error ? t("chats.toolError") : t("chats.toolResult")}</p>${result.preview ? html`<pre class="code" dir="ltr">${result.preview}</pre>` : html`<p class="muted small">${t("common.none")}</p>`}`;
  }

  function messageHtml(item) {
    if (item.kind === "user") {
      return html`<div class="msg msg-user" data-at="${item.at || ""}"><div class="bubble" dir="${textDir(item.text)}">${item.text ? markdown(item.text) : ""}${item.images ? html`<p class="msg-images">${icon("file")}${t("chats.images", { count: item.images })}</p>` : ""}</div>${item.at ? html`<time class="msg-time">${ltr(fmtDate(item.at))}</time>` : ""}</div>`;
    }
    if (item.kind === "assistant") {
      return html`<div class="msg msg-assistant"><span class="msg-mark">${icon("sparkles")}</span><div class="answer" dir="${textDir(item.text)}">${markdown(item.text)}</div></div>`;
    }
    if (item.kind === "tool") {
      return html`<div class="msg msg-tool">${toolChip(item)}</div>`;
    }
    if (item.kind === "divider") {
      return html`<div class="msg-divider"><span>${t("chats.compacted")}</span></div>`;
    }
    return "";
  }

  function permissionCard(approval) {
    var pending = approval.state === "pending";
    var needsCode = approval.irreversible;
    var needsTotp = Boolean(state.session.stepUp);
    var input = approval.parameters && approval.parameters.input;
    return html`<div class="perm-card ${pending ? "is-pending" : "is-" + approval.state}" data-perm="${approval.id}">
      <div class="perm-head">
        <span class="perm-icon">${icon(pending ? "shield" : approval.state === "approved" || approval.state === "consumed" ? "check-circle" : "x-circle")}</span>
        <div class="perm-titles">
          <p class="perm-title">${t("chats.permTitle", { tool: toolName(approval.tool || "") })}</p>
          ${approval.target && approval.target !== approval.tool ? html`<bdi class="perm-target" dir="ltr">${approval.target}</bdi>` : ""}
        </div>
        ${badge(approval.risk, t("risk." + approval.risk))}
      </div>
      ${input && typeof input === "object" && Object.keys(input).length ? html`<details class="perm-more"><summary>${t("chats.permDetails")}</summary><pre class="code" dir="ltr">${JSON.stringify(input, null, 2)}</pre></details>` : ""}
      ${pending ? html`<form class="perm-form" data-form="perm" data-id="${approval.id}">
        ${needsCode ? html`<label class="perm-field"><span>${t("approvals.typeCode")}: <b class="code-chip" dir="ltr">${approval.confirmCode}</b></span><input class="input ltr" dir="ltr" name="confirm" autocomplete="off" maxlength="8" required></label>` : ""}
        ${needsTotp ? html`<label class="perm-field"><span>${t("login.codeLabel")}</span><input class="input ltr otp-input" dir="ltr" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>` : ""}
        <div class="perm-actions">
          <button type="button" class="btn btn-deny" data-action="perm-deny" data-id="${approval.id}">${icon("x")}${t("approvals.deny")}</button>
          <button type="submit" class="btn btn-approve">${icon("check")}${t("chats.allow")}</button>
        </div>
        <p class="form-error" data-form-error hidden></p>
      </form>` : html`<p class="perm-state">${badge(approval.state === "consumed" ? "approved" : approval.state)}${approval.decidedBy ? html` <span class="muted small">${ltr(approval.decidedBy)}</span>` : ""}</p>`}
    </div>`;
  }

  function composerHtml(chat) {
    var busy = Boolean(chat.active && chat.active.status === "running") || chat.sending;
    return html`<form class="composer" data-form="chat-send">
      ${chat.isNew && chat.projects && chat.projects.length > 1 ? html`<div class="composer-project scroll-x">${segmented("new-chat-project", chat.projects.map(function (p) { return [String(p.index), html`${icon("file")}${p.name}`]; }), String(chat.projectIndex))}</div>` : ""}
      <div class="composer-box">
        <textarea class="composer-input" name="prompt" rows="1" dir="auto" placeholder="${chat.isNew ? t("chats.placeholderNew") : t("chats.placeholder")}" data-composer ${busy ? raw("disabled") : ""}></textarea>
        <button type="button" class="composer-btn composer-stop" data-action="chat-stop" ${busy ? "" : raw("hidden")} aria-label="${t("chats.stop")}">${icon("stop")}</button>
        <button type="submit" class="composer-btn composer-send" ${busy ? raw("hidden") : ""} aria-label="${t("chats.send")}" data-send disabled>${icon("send", "flip-rtl")}</button>
      </div>
      <p class="composer-hint">${t("chats.hint")}</p>
    </form>`;
  }

  function chatView(data, route) {
    if (data.isNew) {
      var projectIndex = route.query.project || (data.projects[0] ? data.projects[0].index : 0);
      var project = data.projects.filter(function (p) { return String(p.index) === String(projectIndex); })[0] || data.projects[0];
      state.chat = { id: "new", isNew: true, items: [], projects: data.projects, projectIndex: projectIndex, project: project, today: data.today, budget: data.budget, approvals: {} };
      return html`<div class="chat">
        <div class="chat-stream" data-chat-stream>
          <div class="chat-hello">
            <span class="chat-hello-mark">${icon("chat")}</span>
            <h2>${t("chats.newHello")}</h2>
            <p class="muted">${t("chats.newBody", { project: project ? project.name : "" })}</p>
            <p class="chat-hello-safe">${icon("shield")}${t("chats.permNote")}</p>
          </div>
        </div>
        ${composerHtml(state.chat)}
      </div>`;
    }
    state.chat = {
      id: data.id,
      title: data.title,
      project: data.project,
      branch: data.branch,
      items: data.items,
      start: data.start,
      hasMore: data.hasMore,
      agent: data.agent,
      subagents: data.subagents || [],
      active: data.active,
      approvals: {},
      liveText: ""
    };
    var agentBar = data.agent ? html`<div class="chat-agentbar">${icon("grid")}<span>${t("chats.viewingAgent")}</span><a class="link" href="#/chats/${data.id}">${t("chats.backToMain")}</a></div>` : "";
    return html`<div class="chat ${data.agent ? "is-readonly" : ""}">
      ${agentBar}
      <div class="chat-stream" data-chat-stream>
        ${!data.agent && data.subagents && data.subagents.length ? html`<details class="chat-agents"><summary>${icon("grid")}${t("chats.subagents", { count: data.subagents.length })}</summary><div class="list">${data.subagents.map(function (a) {
          return html`<a class="row" href="#/chats/${data.id}?agent=${encodeURIComponent(a.id)}"><span class="row-icon tone-neutral">${icon("grid")}</span><span class="row-main"><span class="row-title" dir="auto">${a.description || a.id}</span><span class="row-sub">${ltr(a.type || a.id, "mono")}</span></span></a>`;
        })}</div></details>` : ""}
        ${data.hasMore ? html`<div class="chat-earlier"><button type="button" class="btn btn-ghost" data-action="chat-earlier">${icon("chevron", "rot-up")}${t("chats.earlier")}</button></div>` : html`<div class="chat-start">${icon("chat")}<span>${t("chats.start")}</span></div>`}
        <div data-chat-items>${data.items.map(messageHtml)}</div>
        <div data-chat-live></div>
        <div class="chat-status" data-chat-status hidden></div>
      </div>
      ${data.agent ? "" : composerHtml(state.chat)}
    </div>`;
  }

  function chatScroll(force) {
    var nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 220;
    if (force || nearBottom) window.scrollTo(0, document.body.scrollHeight);
  }

  function mountChat(container) {
    var chat = state.chat;
    if (!chat) return;
    var input = $("[data-composer]", container);
    if (input && chat.isNew && state.chatDraft) {
      input.value = state.chatDraft;
      state.chatDraft = "";
      var sendButton = $("[data-send]", container);
      if (sendButton) sendButton.disabled = !input.value.trim();
    }
    if (input) autosize(input);
    if (chat.active && chat.active.events) {
      chat.active.events.forEach(function (event) { applyChatEvent(event, true); });
      if (chat.active && chat.active.status === "running") setChatBusy(true);
    }
    // Events that arrived while this view was loading.
    var backlog = (state.chatBacklog || []).filter(function (event) { return event.sessionId === chat.id; });
    state.chatBacklog = [];
    backlog.forEach(function (event) { applyChatEvent(event, false); });
    requestAnimationFrame(function () { chatScroll(true); });
    if (input && !window.matchMedia("(pointer: coarse)").matches) input.focus();
  }

  function autosize(input) {
    input.style.height = "auto";
    var max = Math.round(window.innerHeight * 0.4);
    input.style.height = Math.min(max, input.scrollHeight) + "px";
  }

  var chatTimer = null;
  function setChatBusy(busy, label) {
    var form = $("[data-form=chat-send]");
    var status = $("[data-chat-status]");
    if (form) {
      var input = $("[data-composer]", form);
      $(".composer-send", form).hidden = busy;
      $(".composer-stop", form).hidden = !busy;
      if (input) input.disabled = busy;
    }
    clearInterval(chatTimer);
    if (status) {
      status.hidden = !busy;
      if (busy) {
        var started = state.chat && state.chat.active && state.chat.active.startedAt ? new Date(state.chat.active.startedAt).getTime() : Date.now();
        var paint = function () {
          var seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
          status.innerHTML = out(html`<span class="typing"><i></i><i></i><i></i></span><span>${label || t("chats.working")}</span><span class="muted">${ltr(seconds + "s")}</span>`);
        };
        paint();
        chatTimer = setInterval(paint, 1000);
      }
    }
  }

  function appendChatHtml(fragment) {
    var host = $("[data-chat-items]");
    if (!host) return;
    host.insertAdjacentHTML("beforeend", out(fragment));
  }

  function renderLive(text) {
    var live = $("[data-chat-live]");
    if (!live) return;
    live.innerHTML = text ? out(html`<div class="msg msg-assistant is-live"><span class="msg-mark">${icon("sparkles")}</span><div class="answer" dir="${textDir(text)}">${markdown(text)}<span class="caret"></span></div></div>`) : "";
  }

  function loadPermission(id) {
    var chat = state.chat;
    api("/api/approvals/" + encodeURIComponent(id)).then(function (approval) {
      state.cache["approval:" + approval.id] = approval;
      if (!state.chat || state.chat !== chat) return;
      var existing = $('[data-perm="' + id + '"]');
      if (existing) {
        existing.outerHTML = out(permissionCard(approval));
      } else {
        appendChatHtml(html`<div class="msg msg-perm">${permissionCard(approval)}</div>`);
      }
      chatScroll(approval.state === "pending");
      if (approval.state === "pending" && navigator.vibrate) navigator.vibrate([20, 40, 20]);
    }).catch(function () {});
  }

  /** One streamed event of the running turn, applied to the open conversation. */
  function applyChatEvent(event, replay) {
    var chat = state.chat;
    if (!chat || chat.id !== event.sessionId) return;
    chat.seq = chat.seq || {};
    if (event.seq) {
      if (chat.seq[event.turnId] >= event.seq) return;
      chat.seq[event.turnId] = event.seq;
    }
    switch (event.type) {
      case "start":
        chat.active = chat.active || { turnId: event.turnId, startedAt: event.at, status: "running" };
        if (!replay) chat.active.startedAt = event.at;
        if (event.prompt && !chat.sentLocally) appendChatHtml(messageHtml({ kind: "user", text: event.prompt, at: event.at }));
        chat.sentLocally = false;
        setChatBusy(true);
        break;
      case "init":
        break;
      case "partial":
        chat.liveText = event.text;
        renderLive(event.text);
        chatScroll();
        break;
      case "assistant":
        chat.liveText = "";
        renderLive("");
        appendChatHtml(messageHtml({ kind: "assistant", text: event.text }));
        chatScroll();
        break;
      case "tool":
        renderLive("");
        appendChatHtml(messageHtml({ kind: "tool", id: event.id, name: event.name, target: event.target, input: event.input, running: true }));
        setChatBusy(true, t("chats.usingTool", { tool: toolName(event.name) }));
        chatScroll();
        break;
      case "tool-result": {
        var chip = $('[data-tool="' + event.id + '"]');
        if (chip) {
          chip.classList.remove("status-running", "status-none");
          chip.classList.add(event.error ? "status-error" : "status-ok");
          var holder = $("[data-tool-result]", chip);
          if (holder) holder.innerHTML = out(toolResult({ error: event.error, preview: event.preview }));
        }
        setChatBusy(true);
        break;
      }
      case "permission":
      case "permission-decided":
        loadPermission(event.approvalId);
        if (event.type === "permission" && event.state === "pending") setChatBusy(true, t("chats.waitingYou"));
        break;
      case "stopping":
        setChatBusy(true, t("chats.stopping"));
        break;
      case "done":
        renderLive(chat.liveText && event.status !== "completed" ? chat.liveText : "");
        chat.active = null;
        setChatBusy(false);
        appendChatHtml(html`<div class="turn-meta tone-${event.status === "completed" ? "success" : event.status === "stopped" ? "neutral" : "danger"}">
          ${icon(event.status === "completed" ? "check-circle" : event.status === "stopped" ? "stop" : "alert")}
          <span>${stateLabel(event.status)}</span>
          ${event.durationMs ? html`<span>${ltr((event.durationMs / 1000).toFixed(1) + "s")}</span>` : ""}
          ${ltr("$" + Number(event.costUsd || 0).toFixed(4))}
          ${event.today ? html`<span class="muted">${t("chats.today")} ${ltr("$" + Number(event.today.usd || 0).toFixed(2))}</span>` : ""}
          ${event.error ? html`<span class="turn-error" dir="auto">${event.error}</span>` : ""}
        </div>`);
        chatScroll();
        if (!replay && event.status === "failed") toast(t("chats.failed"), "danger", event.error || "");
        if (!replay) {
          api("/api/chats/" + encodeURIComponent(chat.id) + "?turns=1").then(function (fresh) {
            if (state.chat !== chat) return;
            chat.title = fresh.title;
            chat.project = fresh.project;
            chat.branch = fresh.branch;
            setTitle(VIEWS.chats.title(state.route), VIEWS.chats.subtitle(state.route));
          }).catch(function () {});
        }
        var input = $("[data-composer]");
        if (input && !replay && !window.matchMedia("(pointer: coarse)").matches) input.focus();
        break;
      default:
        break;
    }
  }

  function sendChat(form) {
    var chat = state.chat;
    var input = $("[data-composer]", form);
    var prompt = input ? input.value : "";
    if (!chat || !prompt.trim() || chat.sending) return;
    chat.sending = true;
    var body = { prompt: prompt };
    var path;
    if (chat.isNew) {
      body.project = chat.projectIndex;
      path = "/api/chats";
    } else {
      path = "/api/chats/" + encodeURIComponent(chat.id) + "/messages";
    }
    setChatBusy(true, t("chats.starting"));
    var bubble = null;
    if (!chat.isNew) {
      // Shown at once; the turn's "start" event then knows it is already here.
      chat.sentLocally = true;
      appendChatHtml(html`<div class="local-send" data-local-send>${messageHtml({ kind: "user", text: prompt, at: new Date().toISOString() })}</div>`);
      var sent = $all("[data-local-send]");
      bubble = sent[sent.length - 1] || null;
      input.value = "";
      autosize(input);
      chatScroll(true);
    }
    api(path, { method: "POST", body: body }).then(function (result) {
      chat.sending = false;
      if (chat.isNew) {
        history.replaceState(null, "", location.pathname + "#/chats/" + result.sessionId);
        navigate();
        return;
      }
      chat.active = chat.active || { turnId: result.turnId, startedAt: new Date().toISOString(), status: "running" };
      setChatBusy(true);
    }).catch(function (error) {
      chat.sending = false;
      chat.sentLocally = false;
      if (bubble) bubble.remove();
      if (input && !input.value) input.value = prompt;
      setChatBusy(false);
      toast(t("chats.sendFailed"), "danger", error.message);
    });
  }

  // ------------------------------------------------------------ rendering

  function navigate(soft) {
    var route = parseRoute();
    var sameView = state.route.name === route.name && state.route.id === route.id;
    state.route = route;
    if (!sameView && (route.name !== "chats" || !route.id)) {
      state.chat = null;
      clearInterval(chatTimer);
    }
    var view = VIEWS[route.name];
    var container = document.getElementById("view");
    if (!container) return;
    setTitle(view.title(route), view.subtitle ? view.subtitle(route) : "");
    updateChrome();
    var renderId = ++state.renderId;
    if (!soft || !sameView) {
      container.innerHTML = out(skeleton(view.skeleton));
      container.scrollTop = 0;
      if (!soft) window.scrollTo(0, 0);
    }
    view.load(route).then(function (data) {
      if (renderId !== state.renderId) return;
      var scroll = window.scrollY;
      container.innerHTML = out(view.render(data, route));
      if (view.mount) view.mount(container, data, route);
      container.classList.remove("enter");
      void container.offsetWidth;
      if (!soft) container.classList.add("enter");
      if (soft && !(route.name === "chats" && route.id)) window.scrollTo(0, scroll);
      setTitle(view.title(route), view.subtitle ? view.subtitle(route) : "");
      updateChrome();
    }).catch(function (error) {
      if (renderId !== state.renderId || error.silent) return;
      container.innerHTML = out(error.status === 404 ? html`<div class="card">${empty("search", t("common.noResults"), error.message)}</div>` : errorCard(error));
    });
  }
  var softRefresh = debounce(function () {
    if (!state.authenticated || sheetStack || $(".palette.open")) return;
    if (["home", "approvals", "missions", "jobs", "audit", "runs"].indexOf(state.route.name) !== -1 || (state.route.name === "chats" && !state.route.id)) navigate(true);
  }, 900);

  // -------------------------------------------------------------- palette

  var palette = { items: [], cursor: 0, query: "", remote: null };
  function staticPaletteItems() {
    var pages = NAV.reduce(function (all, group) { return all.concat(group.items); }, []).filter(function (item) { return !item.feature || chatsOn(); }).map(function (item) {
      return { group: "pages", icon: item.icon, label: t("nav." + item.id), hash: "#/" + item.id };
    });
    var actions = [
      { group: "actions", icon: "moon", label: t("palette.toggleTheme"), run: cycleTheme },
      { group: "actions", icon: "globe", label: t("palette.switchLanguage"), run: function () { setLanguage(state.locale === "fa" ? "en" : "fa"); } },
      { group: "actions", icon: "bell", label: t("palette.enableNotifications"), run: enableNotifications },
      { group: "actions", icon: "shield", label: t("home.reviewNow"), hash: "#/approvals" }
    ];
    if (state.features.runner) actions.push({ group: "actions", icon: "zap", label: t("runs.newRun"), hash: "#/runs" });
    return actions.concat(pages);
  }
  function openPalette() {
    var root = document.getElementById("ar-palette-root");
    root.innerHTML = out(html`<div class="palette" role="dialog" aria-modal="true">
      <div class="palette-backdrop" data-action="close-palette"></div>
      <div class="palette-panel">
        <div class="palette-input">${icon("search")}<input type="text" data-palette-input placeholder="${t("palette.placeholder")}" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
        <div class="palette-list" data-palette-list></div>
        <div class="palette-foot"><span>${t("palette.hint")}</span><span class="palette-brand"><svg><use href="#i-mark"/></svg>${t("brand")}</span></div>
      </div>
    </div>`);
    palette.query = "";
    palette.remote = null;
    palette.cursor = 0;
    renderPaletteList();
    requestAnimationFrame(function () {
      var el = $(".palette", root);
      if (el) el.classList.add("open");
      var input = $("[data-palette-input]", root);
      if (input) input.focus();
    });
  }
  function closePalette() {
    var root = document.getElementById("ar-palette-root");
    var el = $(".palette", root);
    if (!el) return;
    el.classList.remove("open");
    setTimeout(function () { root.innerHTML = ""; }, 160);
  }
  function renderPaletteList() {
    var q = palette.query.trim().toLowerCase();
    var items = staticPaletteItems().filter(function (item) { return !q || item.label.toLowerCase().indexOf(q) !== -1; });
    if (palette.remote) {
      var r = palette.remote;
      r.approvals.forEach(function (a) { items.push({ group: "approvals", icon: "shield", label: a.label, meta: a.id, hash: "#/approvals/" + a.id, state: a.state }); });
      r.missions.forEach(function (m) { items.push({ group: "missions", icon: "flag", label: m.label, meta: m.id, hash: "#/missions/" + m.id, state: m.state }); });
      (r.runs || []).forEach(function (m) { items.push({ group: "runs", icon: "zap", label: m.label, meta: m.id, hash: "#/runs/" + m.id, state: m.meta }); });
      r.memory.forEach(function (m) { items.push({ group: "memory", icon: "brain", label: m.label, meta: m.meta, hash: "#/memory?q=" + encodeURIComponent(palette.query) }); });
      r.skills.forEach(function (s) { items.push({ group: "skills", icon: "book", label: s.label, meta: s.id, skill: s.id }); });
    }
    palette.items = items;
    if (palette.cursor >= items.length) palette.cursor = Math.max(0, items.length - 1);
    var list = $("[data-palette-list]");
    if (!list) return;
    var lastGroup = null;
    list.innerHTML = out(items.length ? items.map(function (item, index) {
      var head = item.group !== lastGroup ? html`<p class="palette-group">${t("palette." + item.group)}</p>` : "";
      lastGroup = item.group;
      return html`${head}<button type="button" class="palette-item" data-palette-index="${index}" aria-selected="${String(index === palette.cursor)}">
        <span class="palette-icon">${icon(item.icon)}</span><span class="palette-label" dir="auto">${item.label}</span>
        ${item.state ? badge(item.state) : ""}${item.meta ? html`<span class="palette-meta">${ltr(item.meta, "mono")}</span>` : ""}
      </button>`;
    }) : html`<p class="palette-empty">${palette.loading ? t("palette.searching") : t("common.noResults")}</p>`);
    var active = $(".palette-item[aria-selected=true]", list);
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }
  var paletteSearch = debounce(function () {
    var q = palette.query.trim();
    if (q.length < 2) {
      palette.remote = null;
      renderPaletteList();
      return;
    }
    palette.loading = true;
    api("/api/search?q=" + encodeURIComponent(q)).then(function (result) {
      palette.loading = false;
      if (result.query !== palette.query.trim()) return;
      palette.remote = result;
      renderPaletteList();
    }).catch(function () { palette.loading = false; });
  }, 180);
  function runPaletteItem(item) {
    if (!item) return;
    closePalette();
    if (item.run) item.run();
    else if (item.skill) openSkill(item.skill);
    else if (item.hash) go(item.hash);
  }

  // ------------------------------------------------------- notifications

  function enableNotifications() {
    if (!("Notification" in window)) {
      toast(t("settings.notificationsUnsupported"), "warning");
      return;
    }
    Notification.requestPermission().then(function (permission) {
      toast(permission === "granted" ? t("settings.notificationsOn") : t("settings.notificationsBlocked"), permission === "granted" ? "success" : "warning");
      if (state.route.name === "settings") navigate(true);
    });
  }
  function systemNotify(entry) {
    if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
    var title = t("notify." + entry.kind) + " — " + (entry.title || "");
    var options = { body: entry.body || "", tag: entry.ref || entry.id, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { link: entry.link || "#/home" } };
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then(function (registration) { registration.showNotification(title, options); }).catch(function () {});
    } else {
      try { new Notification(title, options); } catch (error) { /* ignore */ }
    }
  }
  function notificationsSheet() {
    state.unread = 0;
    updateChrome();
    openSheet(html`<div class="notif">
      <h3 class="sheet-title">${icon("bell")}${t("notify.title")}</h3>
      ${state.notifications.length ? html`<div class="list">${state.notifications.map(function (entry) {
        var tone = entry.level === "error" ? "danger" : entry.level === "warning" ? "warning" : entry.level === "success" ? "success" : "info";
        return html`<a class="row" href="${entry.link || "#/home"}" data-action="close-sheet-nav">
          <span class="row-icon tone-${tone}">${icon(entry.kind === "approval" ? "shield" : entry.kind === "incident" ? "alert" : entry.kind === "run" ? "zap" : "flag")}</span>
          <span class="row-main"><span class="row-title" dir="auto">${t("notify." + entry.kind)} — ${entry.title}</span><span class="row-sub">${entry.body ? html`${ltr(entry.body)} · ` : ""}${when(entry.at)}</span></span>
        </a>`;
      })}</div>` : empty("bell", t("notify.empty"))}
      <div class="sheet-actions"><button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.close")}</button></div>
    </div>`, { noFocus: true });
  }

  // ------------------------------------------------------------------ SSE

  function startEvents() {
    stopEvents();
    if (!window.EventSource) return;
    var source = new EventSource("/api/events");
    state.source = source;
    source.addEventListener("hello", function (event) {
      setOnline(true);
      try {
        var data = JSON.parse(event.data);
        Object.assign(state.counts, data.counts || {});
        updateChrome();
      } catch (error) { /* ignore */ }
    });
    source.addEventListener("counts", function (event) {
      try { Object.assign(state.counts, JSON.parse(event.data)); } catch (error) { return; }
      updateChrome();
      softRefresh();
    });
    source.addEventListener("notification", function (event) {
      var entry;
      try { entry = JSON.parse(event.data); } catch (error) { return; }
      state.notifications.unshift(entry);
      state.notifications = state.notifications.slice(0, 50);
      state.unread += 1;
      updateChrome();
      var tone = entry.level === "error" ? "danger" : entry.level === "warning" ? "warning" : entry.level === "success" ? "success" : "neutral";
      var inChat = entry.body === "claude.tool" && state.route.name === "chats" && state.route.id && state.chat && state.chat.id === state.route.id;
      if (!inChat) toast(t("notify." + entry.kind) + " — " + (entry.title || ""), tone, entry.body ? stateLabel(entry.body) : "");
      systemNotify(entry);
      softRefresh();
    });
    source.addEventListener("chat", function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (error) { return; }
      if (state.route.name === "chats" && state.route.id === data.sessionId && (!state.chat || state.chat.id !== data.sessionId)) {
        state.chatBacklog.push(data);
        return;
      }
      if (state.chat && state.chat.id === data.sessionId) {
        applyChatEvent(data, false);
        return;
      }
      if (state.route.name === "chats" && !state.route.id && (data.type === "start" || data.type === "done")) softRefresh();
    });
    source.addEventListener("activity", function () {
      if (state.route.name === "audit" || state.route.name === "home") softRefresh();
    });
    source.onerror = function () {
      setOnline(false);
      fetch("/api/session", { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
        if (s && s.authenticated === false) {
          state.authenticated = false;
          renderLogin();
        }
      }).catch(function () {});
    };
    source.onopen = function () { setOnline(true); };
  }
  function stopEvents() {
    if (state.source) {
      state.source.close();
      state.source = null;
    }
  }
  function setOnline(online) {
    var bar = document.getElementById("ar-offline");
    if (bar) {
      bar.textContent = t("common.offline");
      bar.hidden = online;
    }
    $all("[data-live]").forEach(function (el) { el.classList.toggle("off", !online); });
  }

  // ------------------------------------------------------------- actions

  function openSkill(id) {
    openSheet(html`<div class="center pad">${skeleton()}</div>`, { wide: true, noFocus: true });
    api("/api/skills/" + encodeURIComponent(id)).then(function (skill) {
      setSheet(html`<div class="skill-sheet">
        <div class="decision-head is-approve"><span class="decision-icon">${icon("book")}</span><div><h3 dir="auto">${skill.name}</h3><p>${ltr(skill.id, "mono")} · ${ltr(skill.source)}${skill.status ? " · " + skill.status : ""}</p></div></div>
        <p class="values-title">${t("skills.content")}</p>
        <pre class="code skill-content" dir="auto">${skill.content}</pre>
        <div class="sheet-actions"><button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.close")}</button></div>
      </div>`);
    }).catch(function (error) { setSheet(errorCard(error)); });
  }

  function formError(form, message) {
    var el = $("[data-form-error]", form);
    if (el) {
      el.textContent = message;
      el.hidden = !message;
    }
  }

  function updateQuery(changes) {
    var route = state.route;
    var query = Object.assign({}, route.query, changes);
    var parts = Object.keys(query).filter(function (k) { return query[k] !== "" && query[k] !== null && query[k] !== undefined; }).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(query[k]); });
    go("#/" + route.name + (route.id ? "/" + encodeURIComponent(route.id) : "") + (parts.length ? "?" + parts.join("&") : ""));
  }

  var lastPreview = null;

  document.addEventListener("click", function (event) {
    var target = event.target.closest("[data-action], [data-seg], [data-palette-index]");
    if (!target) return;
    if (target.hasAttribute("data-palette-index")) {
      runPaletteItem(palette.items[Number(target.getAttribute("data-palette-index"))]);
      return;
    }
    if (target.hasAttribute("data-seg")) {
      var seg = target.getAttribute("data-seg");
      var value = target.getAttribute("data-value");
      if (seg === "approvals-state" || seg === "missions-state") updateQuery({ state: value });
      else if (seg === "memory-tab") go("#/memory?tab=" + value);
      else if (seg === "jobs-tab") go("#/jobs?tab=" + value);
      else if (seg === "skills-source") updateQuery({ source: value });
      else if (seg === "theme") { setTheme(value); navigate(true); }
      else if (seg === "lang") setLanguage(value);
      else if (seg === "chat-project") updateQuery({ project: value, page: 1 });
      else if (seg === "new-chat-project" && state.chat && state.chat.isNew) {
        var draft = $("[data-composer]");
        state.chatDraft = draft ? draft.value : "";
        history.replaceState(null, "", location.pathname + "#/chats/new?project=" + encodeURIComponent(value));
        navigate(true);
      }
      else if (seg === "login-mode") {
        state.loginMode = value;
        renderLogin();
      }
      return;
    }
    var action = target.getAttribute("data-action");
    var id = target.getAttribute("data-id");
    switch (action) {
      case "palette": openPalette(); break;
      case "close-palette": closePalette(); break;
      case "theme": cycleTheme(); break;
      case "lang": setLanguage(target.getAttribute("data-value")); break;
      case "notifications": notificationsSheet(); break;
      case "close-sheet": closeSheet(); break;
      case "close-sheet-nav": closeSheet(); break;
      case "reload": navigate(); break;
      case "approve": decisionSheet(id, "approve"); break;
      case "deny": decisionSheet(id, "deny"); break;
      case "mission": missionSheet(id, target.getAttribute("data-op")); break;
      case "mission-resume-now":
        api("/api/missions/" + encodeURIComponent(id) + "/resume", { method: "POST", body: { reason: "approved from the console" } }).then(function () {
          closeSheet();
          toast(t("missions.resumeDone"), "success");
          go("#/missions/" + id);
        }).catch(function (error) { toast(t("common.error"), "danger", error.message); });
        break;
      case "job-run":
        target.disabled = true;
        api("/api/jobs/" + encodeURIComponent(id) + "/run", { method: "POST", body: {} }).then(function (result) {
          toast(t("jobs.ran", { status: stateLabel(result.status) }), result.status === "ok" ? "success" : "danger", result.summary);
          navigate(true);
        }).catch(function (error) { target.disabled = false; toast(t("common.error"), "danger", error.message); });
        break;
      case "skill": openSkill(id); break;
      case "chat-new": newChatSheet(); break;
      case "chat-stop":
        if (!state.chat) break;
        target.disabled = true;
        api("/api/chats/" + encodeURIComponent(state.chat.id) + "/stop", { method: "POST", body: {} }).then(function () {
          target.disabled = false;
        }).catch(function (error) { target.disabled = false; toast(t("common.error"), "danger", error.message); });
        break;
      case "chat-earlier": {
        var chat = state.chat;
        if (!chat || !chat.hasMore) break;
        target.disabled = true;
        api("/api/chats/" + encodeURIComponent(chat.id) + "?before=" + chat.start + "&turns=12" + (chat.agent ? "&agent=" + encodeURIComponent(chat.agent) : "")).then(function (page) {
          if (state.chat !== chat) return;
          var before = document.body.scrollHeight;
          var host = $("[data-chat-items]");
          host.insertAdjacentHTML("afterbegin", out(page.items.map(messageHtml)));
          chat.start = page.start;
          chat.hasMore = page.hasMore;
          var holder = target.parentNode;
          if (!page.hasMore) holder.innerHTML = out(html`${icon("chat")}<span>${t("chats.start")}</span>`), holder.className = "chat-start";
          else target.disabled = false;
          window.scrollTo(0, window.scrollY + document.body.scrollHeight - before);
        }).catch(function (error) { target.disabled = false; toast(t("common.error"), "danger", error.message); });
        break;
      }
      case "copy-code": {
        var pre = target.closest(".md-code");
        var codeText = pre ? $("pre", pre).textContent : "";
        var done = function () {
          target.classList.add("copied");
          setTimeout(function () { target.classList.remove("copied"); }, 1400);
          toast(t("chats.copied"), "success");
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(codeText).then(done).catch(function () {});
        break;
      }
      case "perm-deny":
        target.disabled = true;
        api("/api/approvals/" + encodeURIComponent(id) + "/decide", { method: "POST", body: { decision: "deny", note: "denied in the conversation" } }).then(function () {
          loadPermission(id);
        }).catch(function (error) { target.disabled = false; toast(t("common.error"), "danger", error.message); });
        break;
      case "logout-all":
        openSheet(html`<div class="decision">
          <div class="decision-head is-deny"><span class="decision-icon">${icon("logout")}</span><div><h3>${t("settings.logoutAllTitle")}</h3><p>${t("settings.logoutAllBody")}</p></div></div>
          <div class="sheet-actions">
            <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
            <button type="button" class="btn btn-lg btn-deny-solid" data-action="logout-all-confirm">${icon("logout")}${t("settings.logoutAll")}</button>
          </div>
        </div>`, { noFocus: true });
        break;
      case "logout-all-confirm":
        api("/api/logout-all", { method: "POST", body: {} }).then(function (result) {
          toast(t("settings.loggedOutAll", { count: result.ended }), "success");
        }).catch(function () {}).finally(function () {
          state.authenticated = false;
          state.csrf = null;
          closeSheet();
          renderLogin();
        });
        break;
      case "page": updateQuery({ page: target.getAttribute("data-page") }); break;
      case "enable-notifications": enableNotifications(); break;
      case "install":
        if (state.installPrompt) {
          state.installPrompt.prompt();
          state.installPrompt.userChoice.finally(function () { state.installPrompt = null; navigate(true); });
        }
        break;
      case "logout":
        api("/api/logout", { method: "POST", body: {} }).finally(function () {
          state.authenticated = false;
          state.csrf = null;
          renderLogin();
        });
        break;
      case "run-real": {
        var form = target.closest("form");
        if (!form || !lastPreview) return;
        target.disabled = true;
        api("/api/runs", { method: "POST", body: { objective: lastPreview.objective, dryRun: false, previewId: lastPreview.previewId } }).then(function (result) {
          lastPreview = null;
          toast(t("runs.started"), "success", stateLabel(result.result && result.result.status));
          navigate(true);
        }).catch(function (error) { target.disabled = false; formError(form, error.message); });
        break;
      }
      default:
        break;
    }
  });

  document.addEventListener("submit", function (event) {
    var form = event.target;
    var kind = form.getAttribute("data-form");
    if (!kind) return;
    event.preventDefault();
    var data = new FormData(form);
    if (kind === "login") {
      var error = $("[data-login-error]", form);
      var button = $("button[type=submit]", form);
      button.disabled = true;
      var credentials = form.getAttribute("data-mode") === "password"
        ? { username: String(data.get("username") || ""), password: String(data.get("password") || ""), code: String(data.get("code") || "").replace(/\s+/g, "") }
        : { token: String(data.get("token") || "") };
      login(credentials).catch(function (err) {
        button.disabled = false;
        var codeInput = $("input[name=code]", form);
        if (codeInput) codeInput.value = "";
        if (error) {
          error.textContent = err.status === 429 ? t("login.tooMany") : err.status === 403 ? t("login.methodRefused") : form.getAttribute("data-mode") === "password" ? t("login.invalidPassword") : t("login.invalid");
          error.hidden = false;
        }
        form.classList.remove("shake");
        void form.offsetWidth;
        form.classList.add("shake");
      });
      return;
    }
    if (kind === "decide") {
      var submit = $("[data-submit]", form);
      submit.disabled = true;
      var decisionId = form.getAttribute("data-id");
      api("/api/approvals/" + encodeURIComponent(decisionId) + "/decide", {
        method: "POST",
        body: { decision: form.getAttribute("data-decision"), note: String(data.get("note") || "") || null, confirm: data.get("confirm") ? String(data.get("confirm")) : null, totp: data.get("totp") ? String(data.get("totp")) : null }
      }).then(function (item) {
        state.cache["approval:" + item.id] = item;
        if (navigator.vibrate) navigator.vibrate(18);
        receiptSheet(item);
        softRefresh();
      }).catch(function (err) {
        submit.disabled = false;
        formError(form, err.status === 422 ? (err.body && err.body.stepUpRequired ? t("approvals.stepUpFailed") : t("approvals.codeMismatch")) : err.message);
      });
      return;
    }
    if (kind === "mission") {
      var op = form.getAttribute("data-op");
      var missionId = form.getAttribute("data-id");
      api("/api/missions/" + encodeURIComponent(missionId) + "/" + op, { method: "POST", body: { reason: String(data.get("reason") || "") || null } }).then(function () {
        closeSheet();
        toast(t("missions." + op + "Done"), op === "cancel" ? "warning" : "success");
        navigate(true);
      }).catch(function (err) { formError(form, err.message); });
      return;
    }
    if (kind === "chat-send") {
      sendChat(form);
      return;
    }
    if (kind === "chat-search") {
      updateQuery({ q: String(data.get("q") || ""), page: 1 });
      return;
    }
    if (kind === "perm") {
      var permId = form.getAttribute("data-id");
      var permButton = $("button[type=submit]", form);
      permButton.disabled = true;
      formError(form, "");
      api("/api/approvals/" + encodeURIComponent(permId) + "/decide", {
        method: "POST",
        body: { decision: "approve", note: "allowed in the conversation", confirm: data.get("confirm") ? String(data.get("confirm")) : null, totp: data.get("totp") ? String(data.get("totp")) : null }
      }).then(function () {
        if (navigator.vibrate) navigator.vibrate(18);
        loadPermission(permId);
      }).catch(function (err) {
        permButton.disabled = false;
        formError(form, err.status === 422 ? (err.body && err.body.stepUpRequired ? t("approvals.stepUpFailed") : t("approvals.codeMismatch")) : err.message);
      });
      return;
    }
    if (kind === "memory-search") {
      go("#/memory?tab=" + (form.getAttribute("data-tab") || "search") + "&q=" + encodeURIComponent(String(data.get("q") || "")));
      return;
    }
    if (kind === "skills") {
      updateQuery({ q: String(data.get("q") || "") });
      return;
    }
    if (kind === "audit") {
      updateQuery({ q: String(data.get("q") || ""), page: 1 });
      return;
    }
    if (kind === "run") {
      var objective = String(data.get("objective") || "").trim();
      var previewBox = $("[data-run-preview]", form);
      var realButton = $("[data-action=run-real]", form);
      formError(form, "");
      api("/api/runs", { method: "POST", body: { objective: objective, dryRun: true } }).then(function (result) {
        lastPreview = { objective: objective, previewId: result.previewId };
        previewBox.innerHTML = out(html`<p class="values-title">${t("runs.plan")}</p><div class="kv-inline">${badge(result.result.status)}${result.result.summary ? html` <span dir="auto">${result.result.summary}</span>` : ""}${result.result.reason ? html` <span class="danger-text">${t("runs.refusedBecause")}: ${ltr(result.result.reason)}</span>` : ""}</div>${result.plan && result.plan !== "null" ? html`<pre class="code" dir="ltr">${result.plan}</pre>` : ""}`);
        previewBox.hidden = false;
        realButton.hidden = false;
        realButton.disabled = false;
      }).catch(function (err) { formError(form, err.message); });
    }
  });

  document.addEventListener("input", function (event) {
    var target = event.target;
    if (target.hasAttribute("data-palette-input")) {
      palette.query = target.value;
      palette.cursor = 0;
      renderPaletteList();
      paletteSearch();
      return;
    }
    if (target.hasAttribute("data-composer")) {
      autosize(target);
      var send = $("[data-send]", target.closest("form"));
      if (send) send.disabled = !target.value.trim();
      return;
    }
    if (target.hasAttribute("data-chat-search")) {
      chatSearch(target.value);
      return;
    }
    if (target.classList.contains("code-input")) {
      var form = target.closest("form");
      var item = state.cache["approval:" + form.getAttribute("data-id")];
      var match = item && target.value.trim().toUpperCase() === item.confirmCode;
      $("[data-submit]", form).disabled = !match;
      target.classList.toggle("is-valid", Boolean(match));
    }
  });
  var chatSearch = debounce(function (value) {
    if (state.route.name === "chats" && !state.route.id && String(value) !== String(state.route.query.q || "")) {
      updateQuery({ q: value, page: 1 });
    }
  }, 350);

  document.addEventListener("change", function (event) {
    var target = event.target;
    if (target.hasAttribute("data-filter")) {
      var change = { page: 1 };
      change[target.getAttribute("data-filter")] = target.value;
      updateQuery(change);
    }
  });

  document.addEventListener("keydown", function (event) {
    var paletteOpen = Boolean($(".palette.open"));
    if ((event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K")) {
      if (!state.authenticated) return;
      event.preventDefault();
      if (paletteOpen) closePalette();
      else openPalette();
      return;
    }
    if (event.key === "Enter" && event.target && event.target.hasAttribute && event.target.hasAttribute("data-composer") && !event.shiftKey && !event.isComposing && !(window.matchMedia && window.matchMedia("(pointer: coarse)").matches)) {
      event.preventDefault();
      var composerForm = event.target.closest("form");
      if (composerForm && event.target.value.trim()) sendChat(composerForm);
      return;
    }
    if (event.key === "Escape") {
      if (paletteOpen) closePalette();
      else if (sheetStack) closeSheet();
      return;
    }
    if (paletteOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      var length = palette.items.length;
      if (!length) return;
      palette.cursor = (palette.cursor + (event.key === "ArrowDown" ? 1 : -1) + length) % length;
      renderPaletteList();
      return;
    }
    if (paletteOpen && event.key === "Enter") {
      event.preventDefault();
      runPaletteItem(palette.items[palette.cursor]);
      return;
    }
    if (!paletteOpen && !sheetStack && event.key === "/" && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      event.preventDefault();
      openPalette();
    }
  });

  window.addEventListener("hashchange", function () {
    if (state.authenticated) {
      if (sheetStack) closeSheet();
      navigate();
    }
  });
  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    state.installPrompt = event;
  });
  window.addEventListener("online", function () { if (state.authenticated) startEvents(); });

  // ----------------------------------------------------------------- boot

  function boot() {
    return fetch("/api/session", { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.json(); }).then(function (session) {
      if (session.login) state.login = session.login;
      if (!session.authenticated) {
        state.authenticated = false;
        var ticket = /(?:^|[#&])ticket=([A-Za-z0-9_-]+)/.exec(location.hash);
        if (ticket && !(state.login && state.login.remote)) {
          history.replaceState(null, "", location.pathname + "#/home");
          return login({ ticket: ticket[1] }).catch(function () { renderLogin(t("login.ticketFailed")); });
        }
        renderLogin();
        return null;
      }
      state.authenticated = true;
      state.csrf = session.csrf;
      state.features = session.features || {};
      state.session = { user: session.user || null, method: session.method || "token", stepUp: Boolean(session.stepUp), remote: Boolean(session.server && session.server.remote) };
      renderShell();
      navigate();
      startEvents();
      return api("/api/notifications?limit=30").then(function (result) {
        state.notifications = result.items || [];
      }).catch(function () {});
    });
  }

  function start() {
    applyTheme(getPref("aramin-theme", "system"));
    var preferred = getPref("aramin-lang", "");
    fetch("/api/session", { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return {}; }).then(function (session) {
      return loadStrings(preferred || session.locale || "fa");
    }).then(boot).catch(function (error) {
      document.getElementById("ar-root").innerHTML = out(html`<div class="login"><div class="login-card">${errorCard(error)}</div></div>`);
    });
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
      navigator.serviceWorker.addEventListener("message", function (event) {
        if (event.data && event.data.link) go(event.data.link);
      });
    }
  }

  start();
})();
