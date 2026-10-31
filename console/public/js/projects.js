/* ============================================================================
   Aramis — Projects and sessions hub (Threadlines style)
   ----------------------------------------------------------------------------
   Talks to /api/projects*. When the endpoint is missing (older server) the
   screen says so. Over the internet listener the screen is read-only: the
   server refuses writes with 403 and this file never even tries.
   Route: #/projects?project=<slug>&q=&f=pinned|live|archived&tag=&sort=&page=
   ========================================================================== */
(function () {
  "use strict";
  var A = window.Aramis;
  if (!A) return;
  var html = A.html, raw = A.raw, t = A.t, icon = A.icon, ltr = A.ltr, api = A.api, out = A.out;

  var D = { projects: null, sessions: null, missing: false, detail: {} };
  var token = 0;
  var timer = null;
  var PAGE = 30;

  function ti(name) { return A.tIcon(name); }
  function readOnly() { return A.isRemote(); }

  // ----------------------------------------------------------------- state

  function query() {
    var q = A.state.route.query || {};
    return {
      project: q.project || "",
      q: q.q || "",
      f: ["pinned", "live", "archived"].indexOf(q.f) !== -1 ? q.f : "",
      tag: q.tag || "",
      sort: ["updated", "started", "turns"].indexOf(q.sort) !== -1 ? q.sort : "updated",
      page: Math.max(1, Number(q.page) || 1)
    };
  }
  function hashFor(changes) {
    var merged = Object.assign({}, A.state.route.query, changes);
    var parts = Object.keys(merged).filter(function (k) {
      var v = merged[k];
      return v !== "" && v !== null && v !== undefined && !(k === "page" && Number(v) <= 1) && !(k === "sort" && v === "updated");
    }).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(merged[k]); });
    return "#/projects" + (parts.length ? "?" + parts.join("&") : "");
  }
  /** Search, filters, sort and paging change the address without a new history entry. */
  function setQuery(changes) {
    Object.keys(changes).forEach(function (key) { A.state.route.query[key] = changes[key]; });
    history.replaceState(null, "", location.pathname + location.search + hashFor({}));
    refresh();
  }

  function sessionsUrl(s) {
    var params = ["size=" + PAGE, "page=" + s.page, "sort=" + s.sort, "archived=" + (s.f === "archived" ? "1" : "0")];
    if (s.project) params.push("project=" + encodeURIComponent(s.project));
    if (s.q) params.push("q=" + encodeURIComponent(s.q));
    if (s.tag) params.push("tag=" + encodeURIComponent(s.tag));
    if (s.f === "pinned") params.push("pinned=1");
    if (s.f === "live") params.push("live=1");
    return "/api/projects/sessions?" + params.join("&");
  }
  function orNull(promise) {
    return promise.catch(function (error) {
      if (error.status === 404) return null;
      throw error;
    });
  }
  function fetchAll(s) {
    return Promise.all([orNull(api("/api/projects")), orNull(api(sessionsUrl(s)))]).then(function (res) {
      if (!res[0] && !res[1]) return null;
      return { projects: Array.isArray(res[0]) ? res[0] : [], sessions: res[1] || { items: [], total: 0, page: 1, pages: 1 } };
    });
  }
  function projectOf(id) {
    return ((D.projects) || []).filter(function (p) { return p.id === id; })[0] || null;
  }
  function projectName(p) { return p ? (p.label || p.name) : ""; }
  function itemOf(id) {
    return ((D.sessions && D.sessions.items) || []).filter(function (x) { return x.id === id; })[0] || null;
  }

  // ------------------------------------------------------------- fragments

  function sideItem(p, current) {
    var on = current === p.id;
    return html`<div class="prj-row">
      <button type="button" class="prj-item" data-action="prj-project" data-id="${p.id}" aria-current="${on ? "true" : "false"}" title="${p.path || p.name}">
        <span class="prj-lead">${p.live ? html`<span class="prj-dot" title="${t("ui.projects.live")}"></span>` : ti("folder")}</span>
        <span class="prj-item-name">${projectName(p)}</span>
        <span class="prj-count">${ltr(p.sessions)}</span>
      </button>
      <button type="button" class="prj-pinbtn ${p.pinned ? "is-on" : ""}" data-action="prj-pin-project" data-id="${p.id}" aria-pressed="${p.pinned ? "true" : "false"}" aria-label="${p.pinned ? t("ui.projects.unpin") : t("ui.projects.pin")}" title="${p.pinned ? t("ui.projects.unpin") : t("ui.projects.pin")}">${ti("pin")}</button>
    </div>`;
  }
  function sideHtml(s) {
    var list = D.projects || [];
    var total = list.reduce(function (n, p) { return n + (p.sessions || 0); }, 0);
    var live = list.reduce(function (n, p) { return n + (p.live || 0); }, 0);
    var pinned = list.filter(function (p) { return p.pinned; });
    var rest = list.filter(function (p) { return !p.pinned; });
    return html`<div class="prj-row"><button type="button" class="prj-item" data-action="prj-project" data-id="" aria-current="${!s.project ? "true" : "false"}">
        <span class="prj-lead">${live ? html`<span class="prj-dot"></span>` : ti("layers")}</span>
        <span class="prj-item-name">${t("ui.projects.allProjects")}</span>
        <span class="prj-count">${ltr(total)}</span>
      </button></div>
      ${pinned.length ? html`<p class="prj-sep">${t("ui.projects.pinnedGroup")}</p>${pinned.map(function (p) { return sideItem(p, s.project); })}` : ""}
      ${rest.length ? html`${pinned.length ? html`<p class="prj-sep">${t("ui.projects.otherGroup")}</p>` : ""}${rest.map(function (p) { return sideItem(p, s.project); })}` : ""}`;
  }

  function headHtml(s) {
    var p = projectOf(s.project);
    var name = p ? projectName(p) : t("ui.projects.allProjects");
    var live = p ? p.live : (D.projects || []).reduce(function (n, x) { return n + (x.live || 0); }, 0);
    return html`<div class="prj-head">
      <div class="prj-headtext">
        <h2 class="prj-name">${name}</h2>
        <p class="prj-path">${p && p.path ? ltr(p.path, "mono") : t("ui.projects.allHint")}${live ? html` <span class="ses-live">${t("ui.projects.liveCount", { count: live })}</span>` : ""}${p && p.chatEnabled ? html` <span class="badge tone-info">${t("ui.projects.chatOn")}</span>` : ""}</p>
      </div>
      <div class="prj-head-actions">
        <button type="button" class="btn btn-ghost btn-sm prj-picker" data-action="prj-picker">${ti("folder")}${t("ui.projects.changeProject")}</button>
      </div>
    </div>`;
  }

  function chip(action, id, label, pressed, lead) {
    return html`<button type="button" class="prj-chip" data-action="${action}" data-id="${id}" aria-pressed="${pressed ? "true" : "false"}">${lead || ""}${label}</button>`;
  }
  function filtersHtml(s) {
    var seen = {};
    var tags = [];
    ((D.sessions && D.sessions.items) || []).forEach(function (item) {
      (item.tags || []).forEach(function (tag) { if (!seen[tag]) { seen[tag] = true; tags.push(tag); } });
    });
    if (s.tag && !seen[s.tag]) tags.unshift(s.tag);
    var total = D.sessions ? D.sessions.total : 0;
    return html`<div class="prj-filters">
        ${chip("prj-filter", "", t("ui.projects.fAll"), !s.f)}
        ${chip("prj-filter", "pinned", t("ui.projects.fPinned"), s.f === "pinned", ti("pin"))}
        ${chip("prj-filter", "live", t("ui.projects.fLive"), s.f === "live")}
        ${chip("prj-filter", "archived", t("ui.projects.fArchived"), s.f === "archived", ti("archive"))}
        ${tags.slice(0, 8).map(function (tag) { return chip("prj-tagfilter", tag, tag, s.tag === tag, ti("tag")); })}
        <span class="prj-tail">
          <span class="prj-total">${t("ui.projects.sessionsCount", { count: total })}</span>
          <select class="prj-sort" data-prj-sort aria-label="${t("ui.projects.sortLabel")}" title="${t("ui.projects.sortLabel")}">
            ${["updated", "started", "turns"].map(function (key) { return html`<option value="${key}" ${s.sort === key ? raw("selected") : ""}>${t("ui.projects.sort." + key)}</option>`; })}
          </select>
          <button type="button" class="ac-iconbtn prj-refresh" data-action="prj-refresh" aria-label="${t("common.refresh")}" title="${t("common.refresh")}">${ti("refresh-cw")}</button>
        </span>
      </div>`;
  }

  function fmtBytes(n) {
    if (!n) return "0 KB";
    if (n < 1048576) return Math.max(1, Math.round(n / 1024)) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function modelName(m) { return String(m || "").replace(/^claude-/, ""); }

  function rowHtml(item, index, showProject) {
    var title = item.chatEnabled
      ? html`<a class="ses-title" href="#/chats/${item.id}" data-key-item dir="auto">${item.title}</a>`
      : html`<button type="button" class="ses-title" data-action="prj-detail" data-id="${item.id}" data-key-item dir="auto">${item.title}</button>`;
    var prompt = item.firstPrompt && item.firstPrompt !== item.title && item.firstPrompt.indexOf(item.title) !== 0 ? item.firstPrompt : "";
    return html`<div class="ses-wrap" data-id="${item.id}">
      <div class="ses-swipe"><span class="ses-swipe-pin">${ti("pin")}${item.pinned ? t("ui.projects.unpin") : t("ui.projects.pin")}</span><span class="ses-swipe-arc">${ti("archive")}${item.archived ? t("ui.projects.unarchive") : t("ui.projects.archive")}</span></div>
      <article class="card ses" data-id="${item.id}" data-pinned="${item.pinned ? "true" : "false"}" data-archived="${item.archived ? "true" : "false"}" data-live="${item.live ? "true" : "false"}">
        <div class="ses-top">
          ${title}
          ${item.live ? html`<span class="ses-live">${t("ui.projects.live")}</span>` : ""}
          ${item.pinned ? html`<span class="prj-pin" title="${t("ui.projects.pinned")}">${ti("pin")}</span>` : ""}
        </div>
        ${prompt ? html`<p class="ses-prompt" dir="auto">${prompt}</p>` : ""}
        <div class="ses-meta">
          ${showProject ? html`<span>${ti("folder")}<bdi dir="auto">${item.projectName}</bdi></span>` : ""}
          <span>${ti("clock")}${A.when(item.updatedAt)}</span>
          <span>${ti("message-circle")}${t("ui.projects.turns", { count: (item.turnsApprox ? "~" : "") + item.turns })}</span>
          ${item.model ? html`<span>${ti("bot")}${ltr(modelName(item.model))}</span>` : ""}
          ${item.gitBranch ? html`<span>${ti("git-branch")}${ltr(item.gitBranch)}</span>` : ""}
          ${item.hasSubagents ? html`<span>${ti("network")}${t("ui.projects.subagents")}</span>` : ""}
        </div>
        ${(item.tags || []).length ? html`<div class="ses-tags">${item.tags.map(function (tag) { return html`<button type="button" class="ses-tag" data-action="prj-tagfilter" data-id="${tag}">${tag}</button>`; })}</div>` : ""}
        <div class="ses-actions">
          <div class="ses-acts-main">
            ${item.chatEnabled
              ? html`<a class="btn btn-primary btn-sm" href="#/chats/${item.id}">${ti("message-circle")}${t("ui.projects.continue")}</a>`
              : html`<button type="button" class="btn btn-primary btn-sm" data-action="prj-continue" data-id="${item.id}">${ti("message-circle")}${t("ui.projects.continue")}</button>`}
          </div>
          <div class="ses-acts-icons">
          <button type="button" class="btn btn-ghost btn-sm ses-ibtn ${item.pinned ? "is-on" : ""}" data-action="prj-pin" data-id="${item.id}" aria-pressed="${item.pinned ? "true" : "false"}" aria-label="${item.pinned ? t("ui.projects.unpin") : t("ui.projects.pin")}" title="${item.pinned ? t("ui.projects.unpin") : t("ui.projects.pin")}">${ti("pin")}</button>
          <button type="button" class="btn btn-ghost btn-sm ses-ibtn" data-action="prj-tags" data-id="${item.id}" aria-label="${t("ui.projects.tags")}" title="${t("ui.projects.tags")}">${ti("tag")}</button>
          <button type="button" class="btn btn-ghost btn-sm ses-ibtn" data-action="prj-rename" data-id="${item.id}" aria-label="${t("ui.projects.rename")}" title="${t("ui.projects.rename")}">${ti("pen-line")}</button>
          <button type="button" class="btn btn-ghost btn-sm ses-ibtn" data-action="prj-archive" data-id="${item.id}" aria-label="${item.archived ? t("ui.projects.unarchive") : t("ui.projects.archive")}" title="${item.archived ? t("ui.projects.unarchive") : t("ui.projects.archive")}">${ti("archive")}</button>
          </div>
        </div>
      </article>
    </div>`;
  }

  function listHtml(s) {
    var data = D.sessions || { items: [], total: 0, page: 1, pages: 1 };
    var items = data.items || [];
    if (!items.length) {
      var filtered = s.q || s.f || s.tag;
      var clear = filtered ? html`<button type="button" class="btn btn-ghost" data-action="prj-clear">${t("ui.projects.clearFilters")}</button>` : "";
      return html`<div class="card">${A.empty("search", filtered ? t("ui.projects.noMatch") : t("ui.projects.noSessions"), filtered ? t("ui.projects.noMatchBody") : t("ui.projects.noSessionsBody"), clear)}</div>`;
    }
    return html`<div class="prj-list">${items.map(function (item, index) { return rowHtml(item, index, !s.project); })}</div>
      ${data.pages > 1 ? html`<div class="pager">
        <button type="button" class="btn btn-ghost" data-action="prj-page" data-id="${data.page - 1}" ${data.page <= 1 ? raw("disabled") : ""}>${icon("chevron", "flip-ltr")}${t("common.prev")}</button>
        <span class="muted small">${t("common.page", { page: data.page, pages: data.pages })}</span>
        <button type="button" class="btn btn-ghost" data-action="prj-page" data-id="${data.page + 1}" ${data.page >= data.pages ? raw("disabled") : ""}>${t("common.next")}${icon("chevron", "flip-rtl")}</button>
      </div>` : ""}`;
  }

  function paint() {
    var s = query();
    var side = A.$("[data-prj-side]");
    var head = A.$("[data-prj-head]");
    var filters = A.$("[data-prj-filters]");
    var list = A.$("[data-prj-list]");
    if (!list) return;
    // Repaint only what changed: an open sort menu or a half-typed search survives the 20 s refresh.
    function put(node, markup) {
      var text = out(markup);
      if (node.__prjHtml === text) return;
      node.__prjHtml = text;
      node.innerHTML = text;
    }
    if (side) put(side, sideHtml(s));
    if (head) put(head, headHtml(s));
    if (filters) put(filters, filtersHtml(s));
    put(list, listHtml(s));
  }

  function refresh(quiet) {
    var mine = ++token;
    var s = query();
    return fetchAll(s).then(function (data) {
      if (mine !== token || A.state.route.name !== "projects") return;
      if (!data) return;
      D.projects = data.projects;
      D.sessions = data.sessions;
      if (s.page > 1 && data.sessions.page !== s.page) A.state.route.query.page = data.sessions.page;
      paint();
    }).catch(function (error) {
      if (!quiet && !error.silent) A.toast(t("common.error"), "danger", error.message);
    });
  }

  // ---------------------------------------------------------------- writes

  function write(path, body) {
    if (readOnly()) {
      A.toast(t("ui.projects.remoteReadOnly"), "warning");
      return Promise.reject(Object.assign(new Error("read-only"), { handled: true }));
    }
    return api(path, { method: "POST", body: body }).catch(function (error) {
      if (error.status === 403) {
        A.toast(t("ui.projects.remoteReadOnly"), "warning");
        error.handled = true;
      }
      throw error;
    });
  }
  function fail(error) {
    if (!error || error.handled) return;
    A.toast(t("common.error"), "danger", error.message);
  }

  A.actions["prj-project"] = function (target, event, id) {
    var next = { project: id || "", tag: "", page: 1 };
    A.go(hashFor(next));
    A.closeSheet();
  };
  A.actions["prj-picker"] = function () {
    var s = query();
    var list = D.projects || [];
    A.openSheet(html`<div class="project-pick">
      <h3 class="sheet-title">${ti("folder")}${t("ui.projects.pickProject")}</h3>
      <div class="list">
        <a class="row" href="${hashFor({ project: "", tag: "", page: 1 })}" data-action="close-sheet">
          <span class="row-icon tone-${!s.project ? "success" : "neutral"}">${ti("layers")}</span>
          <span class="row-main"><span class="row-title">${t("ui.projects.allProjects")}</span></span>
          ${!s.project ? html`<span class="badge tone-success">${t("ui.projects.current")}</span>` : ""}
        </a>
        ${list.map(function (p) {
          return html`<a class="row" href="${hashFor({ project: p.id, tag: "", page: 1 })}" data-action="close-sheet">
            <span class="row-icon tone-${p.live ? "success" : "neutral"}">${p.pinned ? ti("pin") : ti("folder")}</span>
            <span class="row-main"><span class="row-title" dir="auto">${projectName(p)}</span><span class="row-sub">${t("ui.projects.sessionsCount", { count: p.sessions })}${p.live ? " · " + t("ui.projects.liveCount", { count: p.live }) : ""}</span></span>
            ${s.project === p.id ? html`<span class="badge tone-success">${t("ui.projects.current")}</span>` : ""}
          </a>`;
        })}
      </div>
    </div>`);
  };
  A.actions["prj-refresh"] = function (target) {
    if (target) target.classList.add("is-spinning");
    refresh().then(function () { if (target) target.classList.remove("is-spinning"); });
  };
  A.actions["prj-filter"] = function (target, event, id) { setQuery({ f: id || "", page: 1 }); };
  A.actions["prj-tagfilter"] = function (target, event, id) {
    var s = query();
    setQuery({ tag: s.tag === id ? "" : id, page: 1 });
  };
  A.actions["prj-clear"] = function () {
    var input = A.$("[data-prj-q]");
    if (input) input.value = "";
    setQuery({ q: "", f: "", tag: "", page: 1 });
  };
  A.actions["prj-page"] = function (target, event, id) {
    setQuery({ page: Number(id) || 1 });
    window.scrollTo(0, 0);
  };
  A.actions["prj-pin-project"] = function (target, event, id) {
    var p = projectOf(id);
    if (!p) return;
    write("/api/projects/meta", { id: id, pinned: !p.pinned }).then(function () {
      A.toast(!p.pinned ? t("ui.projects.projectPinned") : t("ui.projects.projectUnpinned"), "success");
      return refresh();
    }).catch(fail);
  };

  function setMeta(id, patch, message) {
    return write("/api/projects/session/meta", Object.assign({ id: id }, patch)).then(function () {
      if (message) A.toast(message, "success");
      return refresh(true);
    }).catch(fail);
  }
  A.actions["prj-pin"] = function (target, event, id) {
    var item = itemOf(id);
    if (!item) return;
    setMeta(id, { pinned: !item.pinned }, item.pinned ? t("ui.projects.unpinnedDone") : t("ui.projects.pinnedDone"));
  };
  A.actions["prj-archive"] = function (target, event, id) {
    var item = itemOf(id);
    if (!item) return;
    setMeta(id, { archived: !item.archived }, item.archived ? t("ui.projects.restoredDone") : t("ui.projects.archivedDone"));
  };

  // ---- rename
  A.actions["prj-rename"] = function (target, event, id) {
    if (readOnly()) { A.toast(t("ui.projects.remoteReadOnly"), "warning"); return; }
    var item = itemOf(id) || {};
    A.closeSheet();
    A.openSheet(html`<form class="decision" data-form="prj-rename" data-id="${id}">
      <div class="decision-head is-approve"><span class="decision-icon">${ti("pen-line")}</span><div><h3>${t("ui.projects.renameTitle")}</h3><p>${t("ui.projects.renameHint")}</p></div></div>
      <label class="field"><span class="field-label">${t("ui.projects.titleField")}</span>
        <input class="input input-lg" name="title" data-prj-title maxlength="120" value="${item.title || ""}" dir="auto" autofocus></label>
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
        <button type="submit" class="btn btn-primary btn-lg" data-submit>${t("ui.projects.save")}</button>
      </div>
    </form>`);
  };

  // ---- tags
  function parseTags(text) {
    var seen = {};
    return String(text || "").split(/[,،\n]+/).map(function (x) { return x.trim().replace(/^#/, ""); }).filter(function (x) {
      if (!x || seen[x.toLowerCase()]) return false;
      seen[x.toLowerCase()] = true;
      return true;
    }).slice(0, 12);
  }
  function knownTags() {
    var seen = {};
    var list = [];
    ((D.sessions && D.sessions.items) || []).forEach(function (item) {
      (item.tags || []).forEach(function (tag) { if (!seen[tag]) { seen[tag] = true; list.push(tag); } });
    });
    return list.slice(0, 12);
  }
  A.actions["prj-tags"] = function (target, event, id) {
    if (readOnly()) { A.toast(t("ui.projects.remoteReadOnly"), "warning"); return; }
    var item = itemOf(id) || {};
    var known = knownTags();
    A.openSheet(html`<form class="decision" data-form="prj-tags" data-id="${id}">
      <div class="decision-head is-approve"><span class="decision-icon">${ti("tag")}</span><div><h3>${t("ui.projects.tagsTitle")}</h3><p dir="auto">${item.title || ""}</p></div></div>
      <label class="field"><span class="field-label">${t("ui.projects.tagsField")}</span>
        <input class="input input-lg" name="tags" data-prj-tags maxlength="200" value="${(item.tags || []).join("، ")}" placeholder="${t("ui.projects.tagsPlaceholder")}" dir="auto" autofocus></label>
      ${known.length ? html`<div class="prj-filters">${known.map(function (tag) { return html`<button type="button" class="prj-chip" data-action="prj-tag-add" data-id="${tag}">${ti("plus")}${tag}</button>`; })}</div>` : ""}
      <p class="muted small">${t("ui.projects.tagsHint")}</p>
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.cancel")}</button>
        <button type="submit" class="btn btn-primary btn-lg" data-submit>${t("ui.projects.save")}</button>
      </div>
    </form>`);
  };
  A.actions["prj-tag-add"] = function (target, event, id) {
    var input = A.$("[data-prj-tags]");
    if (!input) return;
    var tags = parseTags(input.value);
    if (tags.map(function (x) { return x.toLowerCase(); }).indexOf(String(id).toLowerCase()) === -1) tags.push(id);
    input.value = tags.join("، ");
    input.focus();
  };

  document.addEventListener("submit", function (event) {
    var form = event.target;
    var kind = form.getAttribute && form.getAttribute("data-form");
    if (kind !== "prj-rename" && kind !== "prj-tags") return;
    event.preventDefault();
    event.stopPropagation();
    var id = form.getAttribute("data-id");
    var submit = A.$("[data-submit]", form);
    if (submit) submit.disabled = true;
    var request;
    if (kind === "prj-rename") {
      var title = (form.elements.title.value || "").trim();
      if (!title) { if (submit) submit.disabled = false; return; }
      request = write("/api/projects/session/rename", { id: id, title: title }).then(function () { A.toast(t("ui.projects.renamed"), "success"); });
    } else {
      request = write("/api/projects/session/meta", { id: id, tags: parseTags(form.elements.tags.value) }).then(function () { A.toast(t("ui.projects.tagsSaved"), "success"); });
    }
    request.then(function () { A.closeSheet(); return refresh(true); }).catch(function (error) {
      if (submit) submit.disabled = false;
      fail(error);
    });
  }, true);

  // ---- details and resume command
  function detailOf(id) {
    if (D.detail[id]) return Promise.resolve(D.detail[id]);
    return api("/api/projects/session?id=" + encodeURIComponent(id)).then(function (detail) {
      D.detail[id] = detail;
      return detail;
    });
  }
  function resumeLine(detail) {
    var resume = detail.resume || {};
    var command = resume.command || ("claude --resume " + detail.id);
    return resume.cwd ? 'cd "' + resume.cwd + '" && ' + command : command;
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error("no clipboard"));
  }
  function resumeSheet(detail) {
    var line = resumeLine(detail);
    A.openSheet(html`<div class="decision">
      <div class="decision-head is-approve"><span class="decision-icon">${ti("terminal")}</span><div><h3>${t("ui.projects.resumeTitle")}</h3><p>${t("ui.projects.resumeHint")}</p></div></div>
      <pre class="code" dir="ltr">${line}</pre>
      <div class="sheet-actions"><button type="button" class="btn btn-primary btn-lg" data-action="close-sheet">${t("common.close")}</button></div>
    </div>`);
  }
  A.actions["prj-copy"] = function (target, event, id) {
    detailOf(id).then(function (detail) {
      var line = resumeLine(detail);
      return copyText(line).then(function () {
        A.toast(t("ui.projects.resumeCopied"), "success", line);
      }).catch(function () { resumeSheet(detail); });
    }).catch(fail);
  };
  // "Continue": the chat opens right here. A project that is not yet allowed asks once, then the whole system is opened for the administrator.
  A.actions["prj-continue"] = function (target, event, id) {
    if (readOnly()) { A.toast(t("ui.projects.remoteReadOnly"), "warning"); return; }
    A.openSheet(html`<div class="decision">
      <div class="decision-head is-approve"><span class="decision-icon">${ti("message-circle")}</span><div><h3>${t("ui.projects.continueTitle")}</h3><p>${t("ui.projects.continueBody")}</p></div></div>
      <div class="decision-actions"><button type="button" class="btn btn-primary" data-action="prj-continue-go" data-id="${id}">${t("ui.projects.continueConfirm")}</button><button type="button" class="btn btn-ghost" data-action="close-sheet">${t("common.cancel")}</button></div>
    </div>`);
  };
  A.actions["prj-continue-go"] = function (target, event, id) {
    write("/api/projects/chat-scope", { all: true }).then(function () {
      return api("/api/projects/session?id=" + encodeURIComponent(id));
    }).then(function (detail) {
      A.closeSheet();
      if (detail && detail.chatEnabled) { A.go("#/chats/" + id); return; }
      A.toast(t("ui.projects.continueGone"), "warning");
      return refresh(true);
    }).catch(fail);
  };
  A.actions["prj-detail"] = function (target, event, id) {
    detailOf(id).then(function (d) {
      var p = projectOf(d.project);
      var rows = [
        [t("ui.projects.fProject"), p ? projectName(p) : d.projectName],
        [t("ui.projects.fPath"), (d.resume && d.resume.cwd) ? ltr(d.resume.cwd, "mono") : null],
        [t("ui.projects.fStarted"), d.startedAt ? A.fmtDate(d.startedAt) : null],
        [t("ui.projects.fUpdated"), A.fmtDate(d.updatedAt)],
        [t("ui.projects.fTurns"), (d.turnsApprox ? "~" : "") + d.turns],
        [t("ui.projects.fModel"), d.model ? ltr(modelName(d.model)) : null],
        [t("ui.projects.fBranch"), d.gitBranch ? ltr(d.gitBranch) : null],
        [t("ui.projects.fSize"), ltr(fmtBytes(d.sizeBytes))],
        [t("ui.projects.fId"), ltr(d.id, "mono")]
      ].filter(function (r) { return r[1] !== null && r[1] !== undefined && r[1] !== ""; });
      A.openSheet(html`<div class="decision">
        <div class="decision-head is-approve"><span class="decision-icon">${ti("message-circle")}</span><div><h3 dir="auto">${d.title}</h3><p>${d.chatEnabled ? t("ui.projects.chatOn") : t("ui.projects.chatOff")}</p></div></div>
        ${d.firstPrompt ? html`<p class="sheet-text" dir="auto">${d.firstPrompt}</p>` : ""}
        <dl class="kv">${rows.map(function (r) { return html`<div class="kv-row"><dt>${r[0]}</dt><dd>${r[1]}</dd></div>`; })}</dl>
        <pre class="code" dir="ltr">${resumeLine(d)}</pre>
        <div class="sheet-actions">
          <button type="button" class="btn btn-ghost btn-lg" data-action="close-sheet">${t("common.close")}</button>
          <button type="button" class="btn btn-primary btn-lg" data-action="prj-copy" data-id="${d.id}">${ti("copy")}${t("ui.projects.copyResume")}</button>
        </div>
      </div>`);
    }).catch(fail);
  };

  // ------------------------------------------------------- inputs (live)

  var onSearch = A.debounce(function (value) {
    if (A.state.route.name !== "projects") return;
    setQuery({ q: value.trim(), page: 1 });
  }, 260);
  document.addEventListener("input", function (event) {
    if (event.target && event.target.hasAttribute && event.target.hasAttribute("data-prj-q")) onSearch(event.target.value);
  });
  document.addEventListener("change", function (event) {
    if (event.target && event.target.hasAttribute && event.target.hasAttribute("data-prj-sort")) setQuery({ sort: event.target.value, page: 1 });
  });

  // ------------------------------------------------------- swipe (phone)

  var swipe = null;
  var THRESHOLD = 84;
  function resetCard(card) {
    if (!card) return;
    card.classList.remove("dragging", "armed");
    card.style.transform = "";
    var wrap = card.parentNode;
    if (wrap && wrap.removeAttribute) wrap.removeAttribute("data-dir");
  }
  document.addEventListener("touchstart", function (event) {
    if (A.state.route.name !== "projects" || event.touches.length !== 1) { swipe = null; return; }
    var card = event.target.closest && event.target.closest(".ses");
    if (!card) { swipe = null; return; }
    swipe = { card: card, x: event.touches[0].clientX, y: event.touches[0].clientY, dx: 0, mode: null };
  }, { passive: true });
  document.addEventListener("touchmove", function (event) {
    if (!swipe || event.touches.length !== 1) return;
    var dx = event.touches[0].clientX - swipe.x;
    var dy = event.touches[0].clientY - swipe.y;
    if (!swipe.mode && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) swipe.mode = Math.abs(dx) > Math.abs(dy) * 1.5 ? "h" : "v";
    if (swipe.mode !== "h") return;
    swipe.dx = dx;
    var shown = Math.max(-150, Math.min(150, dx));
    swipe.card.classList.add("dragging");
    swipe.card.style.transform = "translateX(" + shown + "px)";
    swipe.card.parentNode.setAttribute("data-dir", dx > 0 ? "pin" : "archive");
    swipe.card.classList.toggle("armed", Math.abs(dx) >= THRESHOLD);
  }, { passive: true });
  function endSwipe(cancel) {
    if (!swipe) return;
    var current = swipe;
    swipe = null;
    var done = current.mode === "h" && !cancel && Math.abs(current.dx) >= THRESHOLD;
    resetCard(current.card);
    if (!done) return;
    var id = current.card.getAttribute("data-id");
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (error) { /* optional */ } }
    if (current.dx > 0) A.actions["prj-pin"](null, null, id);
    else A.actions["prj-archive"](null, null, id);
  }
  document.addEventListener("touchend", function () { endSwipe(false); });
  document.addEventListener("touchcancel", function () { endSwipe(true); });

  // -------------------------------------------------------------- the view

  A.VIEWS.projects = {
    title: function () { return t("nav.projects"); },
    subtitle: function () { return t("ui.projects.subtitle"); },
    skeleton: "list",
    load: function (route) {
      return fetchAll(query()).then(function (data) {
        if (!data) { D.missing = true; return null; }
        D.missing = false;
        D.projects = data.projects;
        D.sessions = data.sessions;
        D.detail = {};
        return data;
      });
    },
    render: function (data) {
      if (!data) {
        return html`<div class="card">${A.empty("folder", t("ui.projects.missingTitle"), t("ui.projects.missingBody"))}</div>`;
      }
      var s = query();
      if (!data.projects.length && !data.sessions.items.length && !s.q && !s.f) {
        return html`<div class="card">${A.empty("folder", t("ui.projects.noProjects"), t("ui.projects.noProjectsBody"))}</div>`;
      }
      return html`
        ${readOnly() ? html`<p class="ar-note ar-note--info">${icon("lock")}<span>${t("ui.projects.remoteReadOnly")}</span></p>` : ""}
        <div class="prj">
          <aside class="card prj-side" data-prj-side aria-label="${t("nav.projects")}">${sideHtml(s)}</aside>
          <div class="prj-main">
            <div data-prj-head>${headHtml(s)}</div>
            <div class="prj-toolbar">
              <div class="searchbar">${ti("search")}<input class="input" type="search" data-prj-q value="${s.q}" placeholder="${t("ui.projects.searchPlaceholder")}" autocomplete="off" enterkeyhint="search"></div>
            </div>
            <div data-prj-filters>${filtersHtml(s)}</div>
            <div data-prj-list>${listHtml(s)}</div>
          </div>
        </div>`;
    },
    mount: function (container, data) {
      if (!data) return;
      if (timer) return;
      timer = setInterval(function () {
        if (A.state.route.name !== "projects") { clearInterval(timer); timer = null; return; }
        if (document.hidden || document.body.classList.contains("locked") || swipe) return;
        refresh(true);
      }, 20000);
    }
  };

  // The palette and the shell hooks may already be used by another script: chain, never replace.
  var previousPalette = A.hooks.palette;
  A.hooks.palette = function () {
    var items = previousPalette ? previousPalette() : [];
    (D.projects || []).slice(0, 8).forEach(function (p) {
      items = items.concat([{ group: "actions", icon: "file", label: t("ui.projects.openProject", { name: projectName(p) }), hash: "#/projects?project=" + encodeURIComponent(p.id) }]);
    });
    return items;
  };
})();
