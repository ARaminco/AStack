/* ============================================================================
   Aramis — keyboard shortcuts
   ----------------------------------------------------------------------------
   Ctrl/Cmd+K   command palette (app.js; here only a fallback for non-Latin layouts)
   Ctrl/Cmd+1-9 jump to the Nth session row on the Projects screen, else to the Nth page
   Ctrl/Cmd+[   back in the route history      Ctrl/Cmd+]   forward
   ?            list of shortcuts
   Keys are read from event.code, so they work on the Persian layout too. Nothing
   fires while the owner is typing in a field, a sheet is open, or the palette is.
   ========================================================================== */
(function () {
  "use strict";
  var A = window.Aramis;
  if (!A) return;
  var html = A.html, t = A.t, ltr = A.ltr;

  var mac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
  var MOD = mac ? "⌘" : "Ctrl";
  A.keys = { mod: MOD };

  function typing(target) {
    if (!target || !target.tagName) return false;
    var tag = target.tagName.toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") {
      var type = (target.getAttribute("type") || "text").toLowerCase();
      return ["checkbox", "radio", "button", "submit", "range", "color"].indexOf(type) === -1;
    }
    return Boolean(target.isContentEditable);
  }
  function paletteOpen() { return Boolean(A.$(".palette.open")); }
  function sheetOpen() { return document.body.classList.contains("locked"); }

  /** The pages in the order the rail shows them. */
  function pages() {
    var list = [];
    A.NAV.forEach(function (group) {
      group.items.forEach(function (item) {
        if (item.feature && !A.chatsOn()) return;
        list.push(item.id);
      });
    });
    return list;
  }
  function digitOf(event) {
    var m = /^(?:Digit|Numpad)([1-9])$/.exec(event.code || "");
    if (m) return Number(m[1]);
    return /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
  }

  function jump(n) {
    if (A.state.route.name === "projects") {
      var rows = A.$all("#view [data-key-item]");
      var row = rows[n - 1];
      if (row) {
        row.scrollIntoView({ block: "nearest" });
        row.click();
        return true;
      }
      return false;
    }
    var id = pages()[n - 1];
    if (!id) return false;
    A.go("#/" + id);
    return true;
  }

  function shortcutsSheet() {
    var rows = [
      [MOD + " K", t("ui.keys.palette")],
      [MOD + " 1 – 9", A.state.route.name === "projects" ? t("ui.keys.jumpRows") : t("ui.keys.jumpPages")],
      [MOD + " [", t("ui.keys.back")],
      [MOD + " ]", t("ui.keys.forward")],
      ["/", t("ui.keys.slash")],
      ["?", t("ui.keys.help")],
      ["Esc", t("ui.keys.close")]
    ];
    A.openSheet(html`<div class="decision">
      <div class="decision-head is-approve"><span class="decision-icon">${A.tIcon("command")}</span><div><h3>${t("ui.keys.title")}</h3><p>${t("ui.keys.hint")}</p></div></div>
      <dl class="kv keys-list">${rows.map(function (r) { return html`<div class="kv-row"><dt>${ltr(r[0], "keys-combo")}</dt><dd>${r[1]}</dd></div>`; })}</dl>
      <div class="sheet-actions"><button type="button" class="btn btn-primary btn-lg" data-action="close-sheet">${t("common.close")}</button></div>
    </div>`);
  }
  A.actions["keys-help"] = shortcutsSheet;

  document.addEventListener("keydown", function (event) {
    if (!A.state.authenticated || event.defaultPrevented || event.isComposing) return;
    var mod = (event.ctrlKey || event.metaKey) && !event.altKey;

    // Ctrl/Cmd+K on a layout where the key does not produce "k" (Persian): app.js handles the Latin case.
    if (mod && event.code === "KeyK" && String(event.key).toLowerCase() !== "k") {
      event.preventDefault();
      if (paletteOpen()) {
        var close = A.$('.palette [data-action="close-palette"]');
        if (close) close.click();
      } else A.openPalette();
      return;
    }

    if (paletteOpen() || sheetOpen()) return;

    if (mod && !event.shiftKey) {
      // history keys also work while the chat box has focus; the digits stay with the text field
      var n = typing(event.target) ? 0 : digitOf(event);
      if (n) {
        if (jump(n)) event.preventDefault();
        return;
      }
      if (event.code === "BracketLeft" || event.key === "[") {
        event.preventDefault();
        history.back();
        return;
      }
      if (event.code === "BracketRight" || event.key === "]") {
        event.preventDefault();
        history.forward();
        return;
      }
      return;
    }

    if (!mod && !event.metaKey && (event.key === "?" || (event.code === "Slash" && event.shiftKey)) && !typing(event.target)) {
      event.preventDefault();
      shortcutsSheet();
    }
  });

  var previousPalette = A.hooks.palette;
  A.hooks.palette = function () {
    var items = previousPalette ? previousPalette() : [];
    return items.concat([{ group: "actions", icon: "command", label: t("ui.keys.title"), run: shortcutsSheet }]);
  };
})();
