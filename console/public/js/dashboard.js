/* Aramis dashboard: numbers, charts, services and models in one page. Plain SVG, no library. */
(function () {
  "use strict";
  var A = window.Aramis;
  if (!A) return;
  var t = A.t, html = A.html, raw = A.raw, out = A.out, ltr = A.ltr;
  var NS = "http://www.w3.org/2000/svg";

  // ---------------------------------------------------------------- helpers

  function compact(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(Math.round(n));
  }
  function dayLabel(iso, short) {
    try {
      return new Intl.DateTimeFormat(A.state.locale === "fa" ? "fa-IR-u-ca-persian" : "en", short ? { weekday: "short" } : { month: "short", day: "numeric" }).format(new Date(iso + "T12:00:00Z"));
    } catch (error) { return iso.slice(5); }
  }
  function level(pct) { return pct >= 85 ? "hot" : pct >= 60 ? "warn" : "ok"; }
  function untilReset(epochSeconds) {
    var ms = epochSeconds * 1000 - Date.now();
    if (!isFinite(ms) || ms <= 0) return "";
    var hours = Math.floor(ms / 3600000);
    return hours >= 48 ? t("ui.dashboard.days", { n: Math.round(hours / 24) }) : hours >= 1 ? t("ui.dashboard.hours", { n: hours }) : t("ui.dashboard.minutes", { n: Math.max(1, Math.round(ms / 60000)) });
  }

  // ----------------------------------------------------------------- charts

  /** Ring gauge: a circle drawn with stroke-dasharray (attributes only, so it stays CSP clean). */
  function ring(pct, label, sub, stale) {
    var r = 34, c = 2 * Math.PI * r, value = Math.max(0, Math.min(100, Number(pct) || 0));
    var dash = (c * value / 100).toFixed(1) + " " + c.toFixed(1);
    return html`<div class="dash-ring ${stale ? "is-stale" : ""}" role="img" aria-label="${label}: ${Math.round(value)}%">
      <svg viewBox="0 0 88 88" aria-hidden="true"><circle class="ring-bg" cx="44" cy="44" r="34"></circle><circle class="ring-fg lv-${level(value)}" cx="44" cy="44" r="34" stroke-dasharray="${dash}" transform="rotate(-90 44 44)"></circle></svg>
      <strong>${Math.round(value)}%</strong>
      <span class="ring-label">${label}</span>
      ${sub ? html`<small>${sub}</small>` : ""}
    </div>`;
  }

  /** Stacked bars per day: input and output tokens, cache reads as a thin line above. */
  function barChart(rows) {
    var W = 560, H = 190, padL = 6, padR = 6, padT = 14, padB = 30;
    var max = Math.max.apply(null, rows.map(function (r) { return r.input + r.output; }).concat([1]));
    var bw = (W - padL - padR) / rows.length, gap = Math.min(18, bw * 0.28);
    var parts = [];
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      var y = padT + (H - padT - padB) * (1 - f);
      parts.push('<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"></line>');
    });
    rows.forEach(function (r, i) {
      var x = padL + i * bw + gap / 2, w = bw - gap, base = H - padB, chartH = H - padT - padB;
      var hIn = chartH * r.input / max, hOut = chartH * r.output / max;
      var title = dayLabel(r.date, false) + " — " + t("ui.dashboard.in") + " " + compact(r.input) + " · " + t("ui.dashboard.outT") + " " + compact(r.output) + " · " + t("ui.dashboard.cache") + " " + compact(r.cacheRead);
      parts.push('<g class="bar" tabindex="0"><title>' + A.esc(title) + '</title>' +
        '<rect class="b-in" x="' + x.toFixed(1) + '" y="' + (base - hIn).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(0, hIn).toFixed(1) + '" rx="4"></rect>' +
        '<rect class="b-out" x="' + x.toFixed(1) + '" y="' + (base - hIn - hOut).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(0, hOut).toFixed(1) + '" rx="4"></rect>' +
        '</g>');
      parts.push('<text class="axis" x="' + (x + w / 2).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle">' + A.esc(dayLabel(r.date, true)) + '</text>');
      if (r.input + r.output > 0) parts.push('<text class="val" x="' + (x + w / 2).toFixed(1) + '" y="' + (base - hIn - hOut - 5).toFixed(1) + '" text-anchor="middle">' + compact(r.input + r.output) + '</text>');
    });
    return raw('<svg class="dash-bars" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + A.esc(t("ui.dashboard.tokensTitle")) + '" preserveAspectRatio="xMidYMid meet">' + parts.join("") + '</svg>');
  }

  /** Donut of models in use. */
  function donut(items) {
    var total = items.reduce(function (s, i) { return s + i.count; }, 0) || 1;
    var r = 38, c = 2 * Math.PI * r, offset = 0, parts = [];
    items.slice(0, 6).forEach(function (item, i) {
      var len = c * item.count / total;
      parts.push('<circle class="seg seg-' + (i % 6) + '" cx="50" cy="50" r="38" stroke-dasharray="' + len.toFixed(2) + " " + (c - len).toFixed(2) + '" stroke-dashoffset="' + (-offset).toFixed(2) + '" transform="rotate(-90 50 50)"><title>' + A.esc(item.model + ": " + item.count) + '</title></circle>');
      offset += len;
    });
    return raw('<svg class="dash-donut" viewBox="0 0 100 100" aria-hidden="true"><circle class="seg-bg" cx="50" cy="50" r="38"></circle>' + parts.join("") + '<text x="50" y="48" text-anchor="middle" class="d-num">' + total + '</text><text x="50" y="62" text-anchor="middle" class="d-sub">' + A.esc(t("ui.dashboard.chats")) + '</text></svg>');
  }

  /** Small line for activity per day. */
  function sparkline(rows) {
    var W = 220, H = 48, max = Math.max.apply(null, rows.map(function (r) { return r.count; }).concat([1]));
    var step = W / Math.max(1, rows.length - 1);
    var pts = rows.map(function (r, i) { return (i * step).toFixed(1) + "," + (H - 6 - (H - 14) * r.count / max).toFixed(1); });
    return raw('<svg class="dash-spark" viewBox="0 0 ' + W + " " + H + '" aria-hidden="true"><polyline class="line" points="' + pts.join(" ") + '"></polyline>' + rows.map(function (r, i) { return '<circle class="dot" cx="' + (i * step).toFixed(1) + '" cy="' + (H - 6 - (H - 14) * r.count / max).toFixed(1) + '" r="2.6"><title>' + A.esc(dayLabel(r.date, false) + ": " + r.count) + '</title></circle>'; }).join("") + '</svg>');
  }

  // ------------------------------------------------------------------ parts

  function kpi(icon, value, label, sub, link) {
    var inner = html`<span class="kpi-ic">${icon === "folder" ? A.tIcon("folder") : A.icon(icon)}</span><span class="kpi-v">${value}</span><span class="kpi-l">${label}</span>${sub ? html`<small class="kpi-s">${sub}</small>` : ""}`;
    return link ? html`<a class="dash-kpi card" href="${link}">${inner}</a>` : html`<div class="dash-kpi card">${inner}</div>`;
  }

  function serviceTile(service) {
    var name = t("ui.dashboard.svc." + service.id);
    return html`<div class="svc is-${service.state}"><span class="svc-dot" aria-hidden="true"></span><span class="svc-name">${name}</span><span class="svc-state">${t("ui.dashboard.state." + service.state)}</span></div>`;
  }

  function render(data) {
    if (!data) return html`<div class="card">${A.empty("activity", t("ui.dashboard.emptyTitle"), t("ui.dashboard.emptyBody"))}</div>`;
    var k = data.kpis || {}, m = data.models || {}, rows = data.tokensByDay || [];
    var total = rows.reduce(function (s, r) { return s + r.input + r.output; }, 0);
    var best = rows.reduce(function (b, r) { return r.input + r.output > b.v ? { v: r.input + r.output, d: r.date } : b; }, { v: 0, d: "" });
    var cl = m.claude, cx = m.codex;
    var staleNote = cl && cl.stale ? html`<span class="dash-badge">${t("ui.dashboard.stale")}</span>` : "";
    return html`
      <div class="dash">
        <div class="dash-hero card">
          <div><h2>${t("ui.dashboard.heroTitle")}</h2><p class="muted">${m.account ? html`${t("ui.dashboard.account")}: <bdi dir="ltr">${m.account}</bdi> · ` : ""}${t("ui.dashboard.updated")} ${A.when(data.generatedAt)}</p></div>
          <button type="button" class="btn btn-ghost btn-sm" data-action="dash-refresh">${A.icon("refresh")}${t("ui.dashboard.refresh")}</button>
        </div>
        <div class="dash-kpis">
          ${kpi("folder", k.projects, t("ui.dashboard.kProjects"), "", "#/projects")}
          ${kpi("chat", k.sessions, t("ui.dashboard.kSessions"), k.live ? t("ui.dashboard.liveNow", { n: k.live }) : "", "#/projects")}
          ${kpi("zap", compact(k.tokens7d), t("ui.dashboard.kTokens"), t("ui.dashboard.last7"))}
          ${kpi("shield", k.approvals, t("ui.dashboard.kApprovals"), "", "#/approvals")}
          ${kpi("flag", k.missions, t("ui.dashboard.kMissions"), "", "#/missions")}
          ${kpi("calendar", k.jobs, t("ui.dashboard.kJobs"), k.incidents ? t("ui.dashboard.incidents", { n: k.incidents }) : "", "#/jobs")}
        </div>
        <div class="dash-cols">
          <section class="card dash-card dash-wide">
            <header><h3>${t("ui.dashboard.tokensTitle")}</h3><div class="dash-legend"><span class="lg lg-in">${t("ui.dashboard.in")}</span><span class="lg lg-out">${t("ui.dashboard.outT")}</span></div></header>
            ${barChart(rows)}
            <p class="muted small">${t("ui.dashboard.tokensSum", { total: compact(total) })}${best.v ? " · " + t("ui.dashboard.bestDay", { day: dayLabel(best.d, false), n: compact(best.v) }) : ""}</p>
          </section>
          <section class="card dash-card">
            <header><h3>${t("ui.dashboard.limits")}</h3>${staleNote}</header>
            <div class="dash-rings">
              ${cl && cl.fiveHour ? ring(cl.fiveHour.pct, t("ui.dashboard.fiveHour"), untilReset(cl.fiveHour.resetsAt), cl.stale) : ""}
              ${cl && cl.sevenDay ? ring(cl.sevenDay.pct, t("ui.dashboard.sevenDay"), untilReset(cl.sevenDay.resetsAt), cl.stale) : ""}
              ${cx ? ring(cx.pct, "Codex", untilReset(cx.resetsAt) || cx.plan || "", false) : ""}
            </div>
            ${!cl && !cx ? html`<p class="muted small">${t("ui.dashboard.noLimits")}</p>` : ""}
          </section>
        </div>
        <div class="dash-cols">
          <section class="card dash-card">
            <header><h3>${t("ui.dashboard.modelsTitle")}</h3></header>
            ${(m.seen || []).length ? html`<div class="dash-models">${donut(m.seen)}<ul class="legend">${m.seen.slice(0, 6).map(function (i, idx) { return html`<li><span class="sw seg-${idx % 6}"></span><bdi dir="ltr">${i.model}</bdi><b>${i.count}</b></li>`; })}</ul></div>` : html`<p class="muted small">${t("ui.dashboard.noModels")}</p>`}
            <h4>${t("ui.dashboard.routes")}</h4>
            <ul class="routes">${Object.keys(m.routes || {}).map(function (task) { return html`<li><span>${task}</span><span class="chip">${m.routes[task]}</span></li>`; })}</ul>
            <h4>${t("ui.dashboard.local")}</h4>
            ${(m.local || []).length ? html`<div class="chips">${m.local.map(function (name) { return html`<span class="chip chip-local" dir="ltr">${name}</span>`; })}</div>` : html`<p class="muted small">${t("ui.dashboard.noLocal")}</p>`}
          </section>
          <section class="card dash-card">
            <header><h3>${t("ui.dashboard.servicesTitle")}</h3></header>
            <div class="svc-grid">${(data.services || []).map(serviceTile)}</div>
            <h4>${t("ui.dashboard.activity")}</h4>
            ${sparkline(data.activityByDay || [])}
            <p class="muted small">${t("ui.dashboard.auditToday", { n: k.auditToday })}</p>
          </section>
        </div>
        ${(data.topProjects || []).length ? html`<section class="card dash-card">
          <header><h3>${t("ui.dashboard.topProjects")}</h3></header>
          <ul class="topp">${(function () { var max = Math.max.apply(null, data.topProjects.map(function (p) { return p.tokens; }).concat([1])); return data.topProjects.map(function (p) { return html`<li><span class="tp-name"><bdi dir="auto">${p.name}</bdi></span><span class="tp-bar"><i class="tp-fill" data-w="${Math.round(100 * p.tokens / max)}"></i></span><b>${compact(p.tokens)}</b></li>`; }); })()}</ul>
        </section>` : ""}
      </div>`;
  }

  // Bar widths come from data-w: set through CSSOM (a style attribute would break the page's CSP).
  function paintWidths() {
    A.$all(".tp-fill[data-w]").forEach(function (el) { el.style.width = el.getAttribute("data-w") + "%"; });
  }

  A.VIEWS.dashboard = {
    title: function () { return t("nav.dashboard"); },
    subtitle: function () { return t("ui.dashboard.subtitle"); },
    skeleton: "home",
    load: function () { return A.api("/api/overview"); },
    render: function (data) { setTimeout(paintWidths, 0); return render(data); }
  };

  A.actions["dash-refresh"] = function () {
    A.api("/api/overview?fresh=1").then(function () { A.navigate(true); }).catch(function () { A.toast(t("common.error"), "danger"); });
  };
})();
