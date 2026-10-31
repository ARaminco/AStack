/* Aramis: "sync everything" button. One tap refreshes projects and sessions, AStack memory, the phone titles and the account list. */
(function () {
  "use strict";
  var A = window.Aramis;
  if (!A) return;
  var t = A.t, html = A.html, out = A.out;
  var busy = false;

  var STEP_ICON = { projects: "folder", claudeMemory: "brain", memory: "brain", phoneTitles: "message-circle", accounts: "users" };

  function stepLine(step) {
    var label = t("ui.sync.step." + step.id);
    var state = step.skipped ? "skipped" : step.ok ? "ok" : "failed";
    var detail = "";
    var d = step.detail || {};
    if (step.skipped) detail = t("ui.sync.skipped." + (d.reason || "disabled"));
    else if (!step.ok) detail = step.error || "";
    else if (step.id === "projects") detail = t("ui.sync.d.projects", { projects: d.projects, sessions: d.sessions });
    else if (step.id === "claudeMemory" || step.id === "memory") detail = t("ui.sync.d.memory", { imported: d.imported || 0, updated: d.updated || 0 });
    else if (step.id === "phoneTitles") detail = t("ui.sync.d.phone", { pushed: d.pushed || 0, sessions: d.sessions || 0 });
    else if (step.id === "accounts") detail = t("ui.sync.d.accounts", { accounts: d.accounts || 0 });
    return html`<li class="sync-step is-${state}"><span class="sync-mark" aria-hidden="true">${state === "ok" ? "✓" : state === "skipped" ? "–" : "!"}</span><span class="sync-text"><strong>${label}</strong><small>${detail}</small></span></li>`;
  }

  function panel(body) {
    A.openSheet(html`<div class="decision sync-sheet">
      <div class="decision-head"><span class="decision-icon">${A.icon("refresh")}</span><div><h3>${t("ui.sync.title")}</h3><p>${t("ui.sync.body")}</p></div></div>
      ${body}
    </div>`);
  }

  function showResult(result) {
    var account = result.account ? html`<p class="muted small sync-account">${t("ui.sync.accountLabel")} <bdi dir="ltr">${result.account}</bdi><br>${t("ui.sync.accountNote")}</p>` : "";
    panel(html`<ul class="sync-steps">${result.steps.map(stepLine)}</ul>
      ${account}
      <p class="muted small">${result.ok ? t("ui.sync.done", { seconds: Math.max(1, Math.round(result.took / 1000)) }) : t("ui.sync.partial", { failed: result.failed })}</p>
      <div class="decision-actions"><button type="button" class="btn btn-primary" data-action="close-sheet">${t("common.close")}</button><button type="button" class="btn btn-ghost" data-action="sync-all">${t("ui.sync.again")}</button></div>`);
  }

  A.actions["sync-all"] = function () {
    if (A.isRemote()) {
      A.toast(t("ui.sync.remote"));
      return;
    }
    if (busy) return;
    busy = true;
    var button = A.$("[data-action='sync-all']");
    if (button) button.setAttribute("aria-busy", "true");
    panel(html`<p class="sync-working" role="status">${t("ui.sync.working")}</p>`);
    A.api("/api/sync", { method: "POST", body: {} })
      .then(function (result) {
        showResult(result);
        if (A.hooks.afterSync) A.hooks.afterSync(result);
      })
      .catch(function (error) {
        panel(html`<p class="muted">${t("ui.sync.failed")}</p><p class="muted small">${error && error.message ? error.message : ""}</p><div class="decision-actions"><button type="button" class="btn btn-primary" data-action="close-sheet">${t("common.close")}</button></div>`);
      })
      .then(function () {
        busy = false;
        var again = A.$("[data-action='sync-all']");
        if (again) again.removeAttribute("aria-busy");
      });
  };

  var previousPalette = A.hooks.palette;
  A.hooks.palette = function () {
    var items = previousPalette ? previousPalette() || [] : [];
    return items.concat([{ group: "actions", icon: "refresh", label: t("ui.sync.title"), run: function () { A.actions["sync-all"](); } }]);
  };
})();
