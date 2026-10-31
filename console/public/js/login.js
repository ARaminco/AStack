/* Aramis sign-in: API-driven state, no runtime dependencies or persisted secrets. */
(function () {
  "use strict";
  var template = `
<div class="field-dots" aria-hidden="true"></div>

<div class="shell">
  <header class="topbar">
    <a class="brand" href="#" aria-label="Aramis">
      <img src="/icons/logo-mark.svg" alt="" class="login-brand-mark"><span class="wordmark"><span data-t="wordmark"></span><small>Aramis</small></span>
      <span class="brand-tag" data-t="brandTag">کنسول AStack</span>
    </a>
    <div class="tools">
      <button class="tool" type="button" id="langBtn" data-ta="langAria" aria-label="Switch to English"><span class="lang-label" data-t="langBtn">EN</span></button>
      <button class="tool" type="button" id="themeBtn" data-ta="themeAria" aria-label="تغییر پوسته">
        <svg class="ic-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>
        <svg class="ic-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>
      </button>
    </div>
  </header>

  <main class="stage">
    <!-- node-link traces: every line ends under the panel, as if plugged into it -->
    <svg class="traces" viewBox="0 0 1200 760" aria-hidden="true" focusable="false">
      <path d="M48 144 H216 L264 192 H400"/>
      <path d="M96 384 H400"/>
      <path d="M24 624 H168 L216 576 H400"/>
      <path d="M216 144 V96 H312"/>
      <path d="M1152 120 H1000 L920 200 H800"/>
      <path d="M1176 432 H1008 L960 480 H800"/>
      <path d="M1080 664 H960 L856 560 H800"/>
      <path d="M1008 432 V312 H1104"/>
      <path class="pulse" d="M48 144 H216 L264 192 H400"/>
      <path class="pulse p2" d="M1176 432 H1008 L960 480 H800"/>
      <circle class="pad" cx="48" cy="144" r="4"/>
      <circle class="pad" cx="96" cy="384" r="4"/>
      <circle class="pad" cx="24" cy="624" r="4"/>
      <circle class="pad" cx="312" cy="96" r="4"/>
      <circle class="pad" cx="1152" cy="120" r="4"/>
      <circle class="pad" cx="1080" cy="664" r="4"/>
      <circle class="pad" cx="1104" cy="312" r="4"/>
      <circle class="node" cx="216" cy="144" r="2"/>
      <circle class="node" cx="168" cy="624" r="2"/>
      <circle class="node" cx="1000" cy="120" r="2"/>
      <circle class="node" cx="960" cy="664" r="2"/>
      <circle class="node" cx="1008" cy="432" r="2"/>
      <g class="term"><rect x="381" y="189" width="6" height="6" rx="1"/><rect x="381" y="381" width="6" height="6" rx="1"/><rect x="381" y="573" width="6" height="6" rx="1"/><rect x="813" y="197" width="6" height="6" rx="1"/><rect x="813" y="477" width="6" height="6" rx="1"/><rect x="813" y="557" width="6" height="6" rx="1"/></g>
      <!-- the one amber node: the AI sparkle -->
      <path class="spark" transform="translate(1176 432) scale(.62) translate(-24 -11.2)" d="M24 2Q25.56 9.64 33.2 11.2Q25.56 12.76 24 20.4Q22.44 12.76 14.8 11.2Q22.44 9.64 24 2Z"/>
    </svg>

    <div class="dock">
    <svg class="mtrace mt-top" viewBox="0 0 200 96" aria-hidden="true" focusable="false"><path d="M100 96 V44 L76 20 H28"/><circle class="pad" cx="24" cy="20" r="4"/><circle class="node" cx="100" cy="44" r="2"/></svg>
    <svg class="mtrace mt-bot" viewBox="0 0 200 96" aria-hidden="true" focusable="false"><path d="M100 0 V40 L124 64 H166"/><circle class="node" cx="100" cy="40" r="2"/><path class="spark" transform="translate(176 64) scale(.62) translate(-24 -11.2)" d="M24 2Q25.56 9.64 33.2 11.2Q25.56 12.76 24 20.4Q22.44 12.76 14.8 11.2Q22.44 9.64 24 2Z"/></svg>
    <section class="panel" aria-labelledby="ttl">
      <div class="strip" role="status" aria-live="polite">
        <span class="live" aria-hidden="true"></span>
        <span class="src local" data-t="connLocal">اتصال محلی روی همین دستگاه</span>
        <span class="src remote" data-t="connRemote">اتصال اینترنتی با تأیید دومرحله‌ای</span>
        <span class="sep" aria-hidden="true"></span>
        <span data-t="enc">رمزنگاری‌شده</span>
        <span class="sep x-sess-sep" aria-hidden="true"></span>
        <span class="x-sess" data-t="sess">نشست ۳۰ روزه</span>
      </div>

      <div class="body">
        <!-- step 1: credentials -->
        <div class="v-cred">
          <div class="head">
            <h1 class="title" id="ttl" data-t="title">ورود به آرامیس</h1>
            <p class="lede" data-t="lede">کنسول عملیات شخصی شما روی AStack</p>
          </div>

          <div class="notice info n-first" role="note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7Z"/><path d="M19 17v4M17 19h4"/></svg>
            <span><b data-t="firstTitle">اولین اجراست؛ با توکن وارد شوید و حساب مدیر بسازید</b><span class="sub" data-t="firstSub">بعد از ورود، نام کاربری و رمز را می‌سازید.</span></span>
          </div>

          <div class="notice warn n-locked" role="alert">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>
            <span><b data-t="lockTitle">تلاش‌های زیاد؛ ۱۵ دقیقهٔ دیگر دوباره امتحان کنید</b><span class="sub" data-t="lockSub">ورود از این نشانی موقتاً بسته است.</span></span>
          </div>

          

          <form id="credForm" novalidate>
            <div class="fields m-pass">
              <div class="fld">
                <label class="lbl" for="u" data-t="user">نام کاربری</label>
                <div class="ctl"><input class="inp" id="u" name="username" type="text" dir="ltr" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
              </div>
              <div class="fld">
                <div class="lbl-row">
                  <label class="lbl" for="p" data-t="pass">رمز عبور</label>
                  <p class="caps" id="caps" role="status"><i aria-hidden="true"></i><span data-t="caps">Caps Lock روشن است</span></p>
                </div>
                <div class="ctl">
                  <input class="inp has-btn" id="p" name="password" type="password" dir="ltr" autocomplete="current-password" required aria-describedby="caps">
                  <button class="eye" type="button" data-for="p" aria-pressed="false" data-ta="showPass" aria-label="نمایش رمز">
                    <svg class="ic-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>
                    <svg class="ic-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.7M6.6 6.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>
                  </button>
                </div>
              </div>
            </div>

            <div class="fields m-token">
              <div class="fld">
                <label class="lbl" for="t" data-t="tokenLbl">توکن دسترسی</label>
                <div class="ctl">
                  <input class="inp mono has-btn" id="t" name="token" type="password" dir="ltr" autocomplete="off" spellcheck="false"  aria-describedby="tHint">
                  <button class="eye" type="button" data-for="t" aria-pressed="false" data-ta="showToken" aria-label="نمایش توکن">
                    <svg class="ic-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>
                    <svg class="ic-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.7M6.6 6.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>
                  </button>
                </div>
                <p class="hint" id="tHint" data-t="tokenHint">توکن را از ترمینال همین دستگاه کپی کنید.</p>
                <div class="howto" id="tHow">
                  <p class="howto-title" data-t="howTitle">توکن را چطور بگیرم؟</p>
                  <ol class="howto-steps">
                    <li data-t="howStep1">روی همین کامپیوتر PowerShell یا ترمینال را باز کنید.</li>
                    <li><span data-t="howStep2">این دستور را بزنید:</span>
                      <span class="cmd"><code dir="ltr">astack console token</code><button class="copy" type="button" data-copy="astack console token" data-t="copy">کپی</button></span></li>
                    <li data-t="howStep3">متنی که چاپ می‌شود (با «ar_» شروع می‌شود) را اینجا بچسبانید.</li>
                  </ol>
                  <p class="hint" data-t="howOpen">راه سریع‌تر: دستور «astack console open» مرورگر را باز می‌کند و بدون توکن واردتان می‌کند.</p>
                </div>
              </div>
            </div>

            

            <div class="err" id="err" role="alert">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>
              <span data-t="err">نام کاربری یا رمز درست نیست</span>
            </div>
            <button class="primary" type="submit" id="go">
              <span class="t-idle" data-t="submit">ورود</span>
              <svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>
              <span class="spin" aria-hidden="true"></span>
              <span class="t-loading" data-t="loading">در حال بررسی…</span>
              <span class="t-locked"><span data-t="lockedBtn">ورود دوباره در</span> <span class="clock" >۱۴:۵۹</span></span>
            </button>
          </form>
        </div>

        <!-- step 2: TOTP -->
        <div class="v-totp">
          <div class="head">
            <h2 id="totpTitle" class="title" data-t="totpTitle">تأیید دومرحله‌ای</h2>
            <p class="lede" data-t="totpLede">کد ۶ رقمی برنامهٔ احراز هویت را وارد کنید.</p>
          </div>
          <div class="who">
            <span class="id"><span class="av" aria-hidden="true"></span><span><span class="k" data-t="as">ورود با</span> <span class="name" dir="ltr"></span></span></span>
            <button class="linkbtn" type="button" id="backBtn" data-t="back">تغییر حساب</button>
          </div>
          <form id="totpForm" novalidate>
            <label class="sr" for="code" data-t="codeLbl">کد یک‌بارمصرف</label>
            <div class="code-wrap">
              <div class="cells" aria-hidden="true" id="cells">
                <span class="cell"></span><span class="cell"></span><span class="cell"></span><span class="cell"></span><span class="cell"></span><span class="cell"></span>
              </div>
              <input class="code-inp" id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" dir="ltr">
            </div>
            <button type="button" class="linkbtn" id="skipCode" data-t="skipCode"></button><div class="totp-meta">
              <p class="hint" data-t="totpNote">کد هر ۳۰ ثانیه عوض می‌شود.</p>
            </div>
            <button class="primary" type="submit" id="verify">
              <span class="t-idle" data-t="submit">ورود</span>
              <svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>
              <span class="spin" aria-hidden="true"></span>
              <span class="t-loading" data-t="loading">در حال بررسی…</span>
              <span class="t-locked"><span data-t="lockedBtn">ورود دوباره در</span> <span class="clock" >۱۴:۵۹</span></span>
            </button>
          </form>
        </div>


        <p class="meta">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6Z"/><path d="M9 12l2 2 4-4"/></svg>
          <span data-t="cookie">کوکی نشست فقط روی همین مرورگر می‌ماند.</span>
        </p>
      </div>
    <button class="linkbtn alt" id="altBtn" type="button" aria-controls="credForm"></button></section>
    </div>
  </main>

  <footer class="foot">
    <span data-t="foot">آرامیس · کنسول AStack · نسخهٔ ۴</span>
    <span class="air"><i aria-hidden="true"></i>Powered by <b>AIR</b></span>
  </footer>
</div>

`;
  var dispose = function () {};
  var digits = function (value) { return value.replace(/[۰-۹٠-٩]/g, function (c) { return String(c.charCodeAt(0) - (c >= "۰" ? 1776 : 1632)); }); };
  window.AramisLogin = {
    unmount: function () { dispose(); dispose = function () {}; document.documentElement.removeAttribute("data-login"); },
    mount: function (ctx) {
      dispose();
      var html = document.documentElement, root = ctx.root, options = ctx.options || {}, methods = options.methods || ["token"];
      var first = Boolean(options.firstRun), mode = !first && methods.includes("password") ? "password" : "token";
      var step = "credentials", status = first ? "firstrun" : "default", pending = false, until = 0, timer, locale = ctx.locale, credentials = null, alive = true;
      html.setAttribute("data-login", "");
      root.innerHTML = template;
      var $ = function (s) { return root.querySelector(s); }, all = function (s) { return Array.from(root.querySelectorAll(s)); };
      var tr = function (k, vars) { return ctx.t("login." + k, vars); };
      var display = function (s) { return locale === "fa" ? String(s).replace(/[0-9]/g, function(c) { return "۰۱۲۳۴۵۶۷۸۹"[c]; }) : String(s); };
      function paintCode() {
        var value = $("#code").value;
        all(".cell").forEach(function (cell, i) { cell.textContent = display(value[i] || ""); cell.classList.toggle("cur", document.activeElement === $("#code") && i === value.length); });
      }
      function update() {
        html.dataset.state = status; html.dataset.step = step; html.dataset.method = mode;
        html.dataset.conn = options.remote || step === "totp" ? "remote" : "local";
        html.lang = locale; html.dir = locale === "fa" ? "rtl" : "ltr";
        document.title = tr("pageTitle");
        all("[data-t]").forEach(function (el) { el.textContent = tr(el.dataset.t); });
        all("[data-ta]").forEach(function (el) { el.setAttribute("aria-label", tr(el.dataset.ta)); });
        $(".wordmark span").textContent = tr("wordmark");
        $("#langBtn").lang = locale === "fa" ? "en" : "fa";
        $(".login-brand-mark").src = html.dataset.theme === "dark" ? "/icons/logo-mark-dark.svg" : "/icons/logo-mark.svg";
        $("#altBtn").textContent = tr(mode === "token" ? "usePassword" : "useToken");
        $("#altBtn").hidden = first || methods.length < 2 || step === "totp";
        $("#altBtn").disabled = pending || until > Date.now();
        $("#backBtn").disabled = pending || until > Date.now();
        $("#skipCode").hidden = options.totp !== "optional";
        $("#skipCode").disabled = pending || until > Date.now();
        $("#go .t-idle").textContent = tr(first ? "firstSubmit" : "submit");
        $("#verify .t-idle").textContent = tr("totpSubmit");
        all("form").forEach(function (form) { form.setAttribute("aria-busy", String(pending)); });
        all("input").forEach(function (input) { input.readOnly = pending; input.disabled = until > Date.now(); });
        all(".eye, .primary").forEach(function (button) { button.disabled = pending || until > Date.now(); });
        $(".panel").setAttribute("aria-labelledby", step === "totp" ? "totpTitle" : "ttl");
        all(".eye").forEach(function(b) { b.setAttribute("aria-label", tr((b.getAttribute("aria-pressed") === "true" ? "hide" : "show") + (b.dataset.for === "t" ? "Token" : "Pass"))); });
        paintCode();
        tick();
      }
      function tick() {
        if (!until) return;
        var seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
        all(".clock").forEach(function (el) { el.textContent = display(Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0")); });
        $("[data-t=lockTitle]").textContent = tr("lockTitle", { minutes: display(Math.ceil(seconds / 60)) });
        if (!seconds) { until = 0; clearInterval(timer); status = first ? "firstrun" : "default"; update(); }
      }
      function clearSecrets() { credentials = null; $("#p").value = ""; $("#t").value = ""; $("#code").value = ""; }
      function error(err) {
        pending = false; clearSecrets(); step = "credentials";
        status = err.status === 429 ? "locked" : first ? "firstrun" : "error";
        $("#err").classList.toggle("visible", err.status !== 429);
        all("#u,#p,#t").forEach(function (input) { if (err.status !== 429) { input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", "err"); } });
        if (err.status === 429) {
          var value = Number(err.retryAfter), date = Date.parse(err.retryAfter);
          var seconds = value > 0 ? value : Number.isFinite(date) ? Math.max(1, (date - Date.now()) / 1000) : Number(err.body && err.body.retryAfterSeconds) || 60;
          until = Date.now() + seconds * 1000; clearInterval(timer); timer = setInterval(tick, 250);
        }
        update();
        if (!until) $(mode === "password" ? "#p" : "#t").focus();
      }
      async function send(body) {
        if (pending || until > Date.now()) return;
        pending = true; status = "loading"; $("#err").classList.remove("visible"); update();
        try {
          var result = await ctx.api("/api/login", { method: "POST", body: body });
          clearSecrets();
          if (!alive) return;
          html.setAttribute("data-success", "");
          if (!matchMedia("(prefers-reduced-motion: reduce)").matches) await new Promise(function(resolve) { setTimeout(resolve, 500); });
          if (alive) await ctx.success(result);
        } catch (err) { if (alive) error(err); }
      }
      $("#credForm").addEventListener("submit", function (e) {
        e.preventDefault(); if (pending || until > Date.now()) return;
        if (mode === "token") { if ($("#t").value) send({token: $("#t").value}); return; }
        $("#u").value = digits($("#u").value);
        if (!$("#u").value.trim() || !$("#p").value) return;
        credentials = { username: $("#u").value.trim(), password: $("#p").value, code: "" };
        if (options.totp && options.totp !== "off") {
          step = "totp"; status = "totp"; $(".name").textContent = credentials.username; $(".av").textContent = credentials.username[0].toUpperCase(); update(); $("#code").focus();
        } else send(credentials);
      });
      function verify() { if (credentials && /^\d{6}$/.test($("#code").value)) send(Object.assign({}, credentials, {code: $("#code").value})); }
      $("#totpForm").addEventListener("submit", function (e) { e.preventDefault(); verify(); });
      $("#code").addEventListener("input", function () { this.value = digits(this.value).replace(/\D/g, "").slice(0,6); paintCode(); if (this.value.length === 6) verify(); });
      $("#code").addEventListener("focus", paintCode); $("#code").addEventListener("blur", paintCode);
      $("#u").addEventListener("input", function () { var pos = this.selectionStart; this.value = digits(this.value); this.setSelectionRange(pos,pos); });
      $("#backBtn").addEventListener("click", function () { if (pending || until > Date.now()) return; clearSecrets(); step = "credentials"; status = "default"; update(); $("#u").focus(); });
      $("#skipCode").addEventListener("click", function () { if (credentials) send(credentials); });
      $("#altBtn").addEventListener("click", function () { if (pending || until > Date.now()) return; clearSecrets(); mode = mode === "password" ? "token" : "password"; status = "default"; $("#err").classList.remove("visible"); all("input").forEach(function(i) { i.removeAttribute("aria-invalid"); }); update(); $(mode === "token" ? "#t" : "#u").focus(); });
      all(".copy").forEach(function (button) { button.addEventListener("click", function () { var text = button.dataset.copy || ""; var done = function () { button.textContent = tr("copied"); setTimeout(function () { button.textContent = tr("copy"); }, 1600); }; try { navigator.clipboard.writeText(text).then(done, function () {}); } catch (e) {} }); });
      all(".eye").forEach(function (button) { button.addEventListener("click", function () { var input = $("#" + button.dataset.for), show = input.type === "password"; input.type = show ? "text" : "password"; button.setAttribute("aria-pressed", String(show)); update(); }); });
      ["keydown","keyup","focus"].forEach(function (name) { $("#p").addEventListener(name, function (e) { $("#caps").classList.toggle("on", Boolean(e.getModifierState && e.getModifierState("CapsLock"))); }); });
      $("#p").addEventListener("blur", function () { $("#caps").classList.remove("on"); });
      $("#themeBtn").addEventListener("click", function () { ctx.theme(); update(); });
      $("#langBtn").addEventListener("click", async function () { this.disabled = true; try { var next = locale === "fa" ? "en" : "fa"; await ctx.language(next); if (alive) {locale = next; update();} } finally {this.disabled = false;} });
      function pads() {
        // SVG geometry uses presentation attributes, never CSP-blocked style attributes.
        var height = $(".panel").getBoundingClientRect().height, top = 380 - height / 2;
        var paths = all(".traces > path:not(.spark)"), terms = all(".term rect");
        var ys = [.16,.53,.9,.18,.72,.88].map(function (fraction) { return top + height * fraction; });
        var ds = ["M48 144 H216 L264 " + ys[0] + " H384", "M96 " + ys[1] + " H384", "M24 624 H168 L216 " + ys[2] + " H384", "M1152 120 H1000 L920 " + ys[3] + " H816", "M1176 432 H1008 L960 " + ys[4] + " H816", "M1080 664 H960 L856 " + ys[5] + " H816"];
        [0,1,2,4,5,6].forEach(function (index,i) { paths[index].setAttribute("d", ds[i]); terms[i].setAttribute("y", ys[i]-3); });
        paths[8].setAttribute("d",ds[0]); paths[9].setAttribute("d",ds[4]);
        $(".traces circle[cx='96']").setAttribute("cy",ys[1]);
      }
      var observer = new ResizeObserver(pads); observer.observe($(".panel"));
      var themeObserver = new MutationObserver(function () { $(".login-brand-mark").src = html.dataset.theme === "dark" ? "/icons/logo-mark-dark.svg" : "/icons/logo-mark.svg"; });
      themeObserver.observe(html,{attributes:true,attributeFilter:["data-theme"]});
      dispose = function () { alive = false; clearInterval(timer); observer.disconnect(); themeObserver.disconnect(); clearSecrets(); ["data-state","data-step","data-method","data-conn","data-success"].forEach(function(k) {html.removeAttribute(k);}); };
      update(); pads();
      if (ctx.message) error({});
    }
  };
})();
