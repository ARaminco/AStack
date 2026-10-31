/* ============================================================================
   Aramis — Claude accounts (screen, quick switcher, palette entries)
   ----------------------------------------------------------------------------
   Talks to /api/accounts*. When the endpoint is missing (older server) the
   screen says so and the switcher stays hidden. Over the internet listener the
   screen is read-only: switching and saving are refused by the server anyway.
   Nothing here ever sees a token: the server only returns emails and labels.
   ========================================================================== */
(function () {
  "use strict";
  var A = window.Aramis;
  if (!A) return;
  var html = A.html, raw = A.raw, t = A.t, icon = A.icon, ltr = A.ltr, api = A.api, out = A.out;

  var cache = { data: null, at: 0, missing: false, usage: {} };

  function load(force) {
    if (!force && cache.data && Date.now() - cache.at < 15000) return Promise.resolve(cache.data);
    return api("/api/accounts").then(function (data) {
      cache.data = data;
      cache.at = Date.now();
      cache.missing = false;
      return data;
    }).catch(function (error) {
      if (error.status === 404) {
        cache.missing = true;
        cache.data = null;
        return null;
      }
      throw error;
    });
  }

  function initial(text) {
    return String(text || "?").trim().charAt(0).toUpperCase();
  }
  function shortName(account) {
    if (!account) return "";
    return account.label || String(account.email || "").split("@")[0];
  }
  function activeAccount(data) {
    if (!data) return null;
    var found = (data.accounts || []).filter(function (a) { return a.active; })[0];
    if (found) return found;
    return data.active && data.active.email ? { id: data.active.profileId, email: data.active.email, label: "", active: true } : null;
  }
  function readOnly() { return A.isRemote(); }

  // --------------------------------------------------------- top bar chip

  function paintChip() {
    var chip = A.$("[data-acct-chip]");
    if (!chip) return;
    var acc = activeAccount(cache.data);
    if (!acc) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    chip.innerHTML = out(html`<span class="ar-acct__dot">${initial(acc.label || acc.email)}</span><span class="ar-acct__text"><strong>${shortName(acc)}</strong><small>${t("ui.accounts.activeShort")}</small></span>`);
  }
  function refreshChip() {
    load(false).then(paintChip).catch(function () { var chip = A.$("[data-acct-chip]"); if (chip) chip.hidden = true; });
  }
  A.hooks.shell = refreshChip;

  /** Inside a conversation: which account the next message runs on, with a way to change it. */
  A.hooks.chrome = function () {
    paintChip();
    var route = A.state.route;
    if (route.name !== "chats" || !route.id) return;
    var chat = A.$("#view .chat");
    if (!chat || A.$(".chat-acct-bar", chat) || !cache.data) return;
    var acc = activeAccount(cache.data);
    if (!acc) return;
    chat.insertAdjacentHTML("afterbegin", out(html`<div class="chat-acct-bar"><span class="chat-acct">${icon("user")}${t("ui.accounts.nextOn", { account: shortName(acc) })}</span><button type="button" class="btn btn-ghost btn-sm" data-action="accounts-switcher">${t("ui.accounts.change")}</button></div>`));
  };

  // ------------------------------------------------------------ switching

  function doSwitch(id, force) {
    return api("/api/accounts/switch", { method: "POST", body: { id: id, force: Boolean(force) } }).then(function (result) {
      cache.at = 0;
      cache.usage = {};
      return load(true).then(function () {
        paintChip();
        var warnings = result && result.warnings ? result.warnings : [];
        A.toast(t("ui.accounts.switched"), "success", warnings.length ? warnings.join(" · ") : t("ui.accounts.switchedNote"));
        if (A.state.route.name === "accounts") A.navigate(true);
        A.closeSheet();
      });
    });
  }

  function confirmSheet(account, data) {
    var running = (data && data.running) || [];
    var busy = (data && data.chatTurnsRunning) || 0;
    A.openSheet(html`<div class="decision">
      <div class="decision-head is-approve"><span class="decision-icon">${icon("user")}</span><div><h3>${t("ui.accounts.switchTitle", { account: shortName(account) })}</h3><p>${ltr(account.email)}</p></div></div>
      <p class="sheet-text">${t("ui.accounts.switchExplain")}</p>
      <p class="ar-note ar-note--info">${icon("alert")}<span>${t("ui.accounts.terminalNote")}</span></p>
      ${running.length ? html`<p class="ar-note">${icon("terminal")}<span>${t("ui.accounts.runningNote", { count: running.length })}</span></p>` : ""}
      ${busy ? html`<p class="ar-note">${icon("alert")}<span>${t("ui.accounts.busyNote", { count: busy })}</span></p>` : ""}
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
        <button type="button" class="btn btn-primary btn-lg" data-action="acct-switch-go" data-id="${account.id}" data-force="${busy ? "1" : ""}">${busy ? t("ui.accounts.switchAnyway") : t("ui.accounts.switchNow")}</button>
      </div>
    </div>`);
  }

  A.actions["acct-switch"] = function (target, event, id) {
    if (readOnly()) { A.toast(t("ui.accounts.remoteReadOnly"), "warning"); return; }
    load(true).then(function (data) {
      var account = ((data && data.accounts) || []).filter(function (a) { return a.id === id; })[0];
      if (account) confirmSheet(account, data);
    }).catch(function (error) { A.toast(t("common.error"), "danger", error.message); });
  };
  A.actions["acct-switch-go"] = function (target, event, id) {
    target.disabled = true;
    doSwitch(id, target.getAttribute("data-force") === "1").catch(function (error) {
      target.disabled = false;
      A.toast(t("common.error"), "danger", error.message);
    });
  };

  /** App-bar chip and the "change" button in a chat: pick an account in two taps. */
  A.actions.accountSwitcher = function () {
    load(true).then(function (data) {
      if (!data) { A.go("#/accounts"); return; }
      var accounts = data.accounts || [];
      A.openSheet(html`<div class="decision">
        <div class="decision-head is-approve"><span class="decision-icon">${icon("users")}</span><div><h3>${t("ui.accounts.switcher")}</h3><p>${t("ui.accounts.switcherHint")}</p></div></div>
        ${accounts.length ? html`<div class="list">${accounts.map(function (acc) {
          return html`<button type="button" class="row" data-action="${acc.active ? "close-sheet" : "acct-quick"}" data-id="${acc.id}">
            <span class="row-icon tone-${acc.active ? "success" : "neutral"}">${acc.active ? icon("check") : icon("user")}</span>
            <span class="row-main"><span class="row-title">${shortName(acc)}</span><span class="row-sub">${ltr(acc.email)}</span></span>
            ${acc.active ? html`<span class="badge tone-success">${t("ui.accounts.active")}</span>` : ""}
          </button>`;
        })}</div>` : html`<p class="muted">${t("ui.accounts.none")}</p>`}
        <div class="sheet-actions">
          <a class="btn btn-ghost btn-lg" href="#/accounts" data-action="close-sheet">${t("ui.accounts.manage")}</a>
        </div>
      </div>`);
    }).catch(function (error) { A.toast(t("common.error"), "danger", error.message); });
  };
  A.actions["acct-quick"] = function (target, event, id) {
    if (readOnly()) { A.toast(t("ui.accounts.remoteReadOnly"), "warning"); return; }
    target.disabled = true;
    doSwitch(id, false).catch(function (error) {
      target.disabled = false;
      var acc = ((cache.data && cache.data.accounts) || []).filter(function (a) { return a.id === id; })[0];
      if (acc && error.status === 409) confirmSheet(acc, cache.data);
      else A.toast(t("common.error"), "danger", error.message);
    });
  };

  // ------------------------------------------------------------- save etc.

  A.actions["acct-save"] = function () {
    if (readOnly()) { A.toast(t("ui.accounts.remoteReadOnly"), "warning"); return; }
    A.openSheet(html`<div class="decision">
      <div class="decision-head is-approve"><span class="decision-icon">${icon("plus")}</span><div><h3>${t("ui.accounts.saveTitle")}</h3><p>${t("ui.accounts.saveHint")}</p></div></div>
      <label class="field"><span class="field-label">${t("ui.accounts.labelField")}</span>
        <input class="input input-lg" data-acct-label maxlength="40" placeholder="${t("ui.accounts.labelPlaceholder")}" autofocus></label>
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
        <button type="button" class="btn btn-primary btn-lg" data-action="acct-save-go">${t("ui.accounts.saveNow")}</button>
      </div>
    </div>`);
  };
  A.actions["acct-save-go"] = function (target) {
    var input = A.$("[data-acct-label]");
    target.disabled = true;
    api("/api/accounts/save", { method: "POST", body: { label: input ? input.value.trim() : "" } }).then(function () {
      cache.at = 0;
      A.closeSheet();
      A.toast(t("ui.accounts.saved"), "success");
      return load(true).then(function () { paintChip(); A.navigate(true); });
    }).catch(function (error) { target.disabled = false; A.toast(t("common.error"), "danger", error.message); });
  };
  A.actions["acct-label"] = function (target, event, id) {
    if (readOnly()) { A.toast(t("ui.accounts.remoteReadOnly"), "warning"); return; }
    var acc = ((cache.data && cache.data.accounts) || []).filter(function (a) { return a.id === id; })[0] || {};
    A.openSheet(html`<div class="decision">
      <div class="decision-head is-approve"><span class="decision-icon">${icon("edit")}</span><div><h3>${t("ui.accounts.renameTitle")}</h3><p>${ltr(acc.email || "")}</p></div></div>
      <label class="field"><span class="field-label">${t("ui.accounts.labelField")}</span>
        <input class="input input-lg" data-acct-label maxlength="40" value="${acc.label || ""}" autofocus></label>
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
        <button type="button" class="btn btn-primary btn-lg" data-action="acct-label-go" data-id="${id}">${t("common.save")}</button>
      </div>
    </div>`);
  };
  A.actions["acct-label-go"] = function (target, event, id) {
    var input = A.$("[data-acct-label]");
    target.disabled = true;
    api("/api/accounts/label", { method: "POST", body: { id: id, label: input ? input.value.trim() : "" } }).then(function () {
      cache.at = 0;
      A.closeSheet();
      return load(true).then(function () { paintChip(); A.navigate(true); });
    }).catch(function (error) { target.disabled = false; A.toast(t("common.error"), "danger", error.message); });
  };
  A.actions["acct-remove"] = function (target, event, id) {
    if (readOnly()) { A.toast(t("ui.accounts.remoteReadOnly"), "warning"); return; }
    var acc = ((cache.data && cache.data.accounts) || []).filter(function (a) { return a.id === id; })[0] || {};
    A.openSheet(html`<div class="decision">
      <div class="decision-head is-deny"><span class="decision-icon">${icon("x-circle")}</span><div><h3>${t("ui.accounts.removeTitle")}</h3><p>${ltr(acc.email || "")}</p></div></div>
      <p class="sheet-text">${t("ui.accounts.removeExplain")}</p>
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
        <button type="button" class="btn btn-lg btn-deny-solid" data-action="acct-remove-go" data-id="${id}">${t("ui.accounts.removeNow")}</button>
      </div>
    </div>`);
  };
  A.actions["acct-remove-go"] = function (target, event, id) {
    target.disabled = true;
    api("/api/accounts/remove", { method: "POST", body: { id: id } }).then(function () {
      cache.at = 0;
      A.closeSheet();
      A.toast(t("ui.accounts.removed"), "success");
      return load(true).then(function () { paintChip(); A.navigate(true); });
    }).catch(function (error) { target.disabled = false; A.toast(t("common.error"), "danger", error.message); });
  };
  A.actions["acct-usage"] = function () { cache.usage = {}; A.navigate(true); };

  // -------------------------------------------------------------- the screen

  function ringHtml(label, entry, key) {
    if (!entry || typeof entry.pct !== "number") {
      return html`<div class="acct-ring"><div class="ac-ring ac-ring--sm" data-ac="ring" data-value="0"><span class="ac-ring__label">–</span></div><div class="acct-ring-text"><strong>${label}</strong><small>${t("ui.accounts.usageUnknown")}</small></div></div>`;
    }
    var pct = Math.max(0, Math.min(100, Math.round(entry.pct)));
    var tone = pct >= 90 ? "danger" : pct >= 70 ? "warning" : "success";
    return html`<div class="acct-ring" data-ring="${key}"><div class="ac-ring ac-ring--sm" data-ac="ring" data-value="${pct}" data-tone="${tone}"><span class="ac-ring__label">${ltr(pct + "%")}</span></div>
      <div class="acct-ring-text"><strong>${label}</strong><small>${entry.resetsAt ? t("ui.accounts.resets", { when: A.relTime(entry.resetsAt) }) : t("ui.accounts.used")}</small></div></div>`;
  }
  function usageBlock(id) {
    var u = cache.usage[id];
    if (!u) return html`<div class="acct-rings" data-usage="${id}"><div class="sk sk-line w60"></div><div class="sk sk-line w35"></div></div>`;
    if (u.error) return html`<p class="muted small" data-usage="${id}">${t("ui.accounts.usageFailed")}</p>`;
    return html`<div class="acct-rings" data-usage="${id}">${ringHtml(t("ui.accounts.fiveHour"), u.fiveHour, "5h")}${ringHtml(t("ui.accounts.sevenDay"), u.sevenDay, "7d")}</div>`;
  }
  function accountCard(acc, data) {
    var ro = readOnly();
    return html`<article class="card acct-card" data-active="${acc.active ? "true" : "false"}">
      <div class="acct-head">
        <span class="acct-avatar">${initial(acc.label || acc.email)}</span>
        <div class="acct-titles"><div class="acct-name">${shortName(acc)}</div><div class="acct-mail">${ltr(acc.email)}</div></div>
        ${acc.active ? html`<span class="badge tone-success">${t("ui.accounts.active")}</span>` : ""}
      </div>
      ${usageBlock(acc.id)}
      <div class="acct-actions">
        ${acc.active ? "" : html`<button type="button" class="btn btn-primary" data-action="acct-switch" data-id="${acc.id}" ${ro ? raw("disabled") : ""}>${icon("refresh")}${t("ui.accounts.switchTo")}</button>`}
        <button type="button" class="btn btn-ghost" data-action="acct-label" data-id="${acc.id}" ${ro ? raw("disabled") : ""}>${icon("edit")}${t("ui.accounts.rename")}</button>
        <button type="button" class="btn btn-ghost danger-text" data-action="acct-remove" data-id="${acc.id}" ${ro ? raw("disabled") : ""}>${t("ui.accounts.remove")}</button>
      </div>
      <p class="muted small">${acc.savedAt ? t("ui.accounts.savedAt", { when: A.relTime(acc.savedAt) }) : ""}</p>
    </article>`;
  }

  A.VIEWS.accounts = {
    title: function () { return t("nav.accounts"); },
    subtitle: function () { return t("ui.accounts.subtitle"); },
    skeleton: "list",
    load: function () { return load(true); },
    render: function (data) {
      if (!data) {
        return html`<div class="card">${A.empty("users", t("ui.accounts.missingTitle"), t("ui.accounts.missingBody"))}</div>`;
      }
      var accounts = data.accounts || [];
      var running = data.running || [];
      var ro = readOnly();
      return html`
        ${ro ? html`<p class="ar-note ar-note--info">${icon("lock")}<span>${t("ui.accounts.remoteReadOnly")}</span></p>` : ""}
        <div class="ar-actions">
          <button type="button" class="btn btn-primary" data-action="acct-save" ${ro ? raw("disabled") : ""}>${icon("plus")}${t("ui.accounts.saveCurrent")}</button>
          <button type="button" class="btn btn-ghost" data-action="acct-usage">${icon("refresh")}${t("ui.accounts.refreshUsage")}</button>
        </div>
        <p class="muted small acct-running">${data.active && data.active.email ? html`${t("ui.accounts.currentLogin")}: ${ltr(data.active.email)}${data.active.plan ? html` ${ltr("(" + data.active.plan + ")")}` : ""}` : t("ui.accounts.noLogin")}</p>
        ${running.length ? html`<p class="muted small acct-running">${t("ui.accounts.runningNote", { count: running.length })}</p>` : ""}
        ${accounts.length ? html`<div class="ar-grid">${accounts.map(function (acc) { return accountCard(acc, data); })}</div>`
          : html`<div class="card">${A.empty("users", t("ui.accounts.none"), t("ui.accounts.noneBody"))}</div>`}
        <p class="muted small">${t("ui.accounts.privacy")}</p>`;
    },
    mount: function (container, data) {
      if (!data) return;
      var queue = (data.accounts || []).filter(function (a) { return !cache.usage[a.id]; });
      (function next() {
        var acc = queue.shift();
        if (!acc || A.state.route.name !== "accounts") return;
        api("/api/accounts/usage?id=" + encodeURIComponent(acc.id)).then(function (u) { cache.usage[acc.id] = u || { error: "empty" }; }).catch(function () { cache.usage[acc.id] = { error: "failed" }; }).then(function () {
          var slot = A.$('[data-usage="' + acc.id + '"]', container);
          if (slot) {
            slot.outerHTML = out(usageBlock(acc.id));
            if (window.AC && window.AC.scan) window.AC.scan(container);
          }
          next();
        });
      })();
    }
  };

  A.hooks.palette = function () {
    var items = [{ group: "actions", icon: "users", label: t("ui.accounts.switcher"), run: A.actions.accountSwitcher }];
    ((cache.data && cache.data.accounts) || []).filter(function (a) { return !a.active; }).forEach(function (acc) {
      items.push({ group: "actions", icon: "user", label: t("ui.accounts.switchTitle", { account: shortName(acc) }), run: function () { A.actions["acct-switch"](null, null, acc.id); } });
    });
    return items;
  };
})();
