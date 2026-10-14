/* Aramin — runs before first paint so the app never flashes the wrong theme or direction. */
(function () {
  var root = document.documentElement;
  var theme = "system";
  var lang = "";
  try {
    theme = localStorage.getItem("aramin-theme") || "system";
    lang = localStorage.getItem("aramin-lang") || "";
  } catch (error) {
    /* storage blocked: defaults */
  }
  var dark = theme === "dark" || (theme === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.setAttribute("data-theme-choice", theme);
  if (lang === "en") {
    root.setAttribute("lang", "en");
    root.setAttribute("dir", "ltr");
  }
  var meta = document.getElementById("theme-color");
  if (meta) {
    meta.setAttribute("content", dark ? "#0b0d15" : "#f4f5f7");
  }
  var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  root.setAttribute("data-display", standalone ? "standalone" : "browser");
})();
