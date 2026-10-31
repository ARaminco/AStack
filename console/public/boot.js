/* Aramis — runs before first paint so the app never flashes the wrong theme or direction.
   Preferences live under aramis-* keys; the old aramin-* keys are read once as a fallback. */
(function () {
  var root = document.documentElement;
  function read(name) {
    try {
      var value = localStorage.getItem("aramis-" + name);
      if (value) return value;
      var old = localStorage.getItem("aramin-" + name);
      if (old) {
        localStorage.setItem("aramis-" + name, old);
        return old;
      }
    } catch (error) {
      /* storage blocked: defaults */
    }
    return "";
  }
  var theme = read("theme") || "system";
  var lang = read("lang");
  var dark = theme === "dark" || (theme === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.setAttribute("data-theme-choice", theme);
  root.setAttribute("data-accent", "air");
  try {
    // keep the template's own store in step so its runtime never flips the theme back
    localStorage.setItem("ac:theme", JSON.stringify(theme === "system" ? "auto" : theme));
  } catch (error) { /* ignore */ }
  if (lang === "en") {
    root.setAttribute("lang", "en");
    root.setAttribute("dir", "ltr");
  }
  var meta = document.getElementById("theme-color");
  if (meta) meta.setAttribute("content", dark ? "#0b0b0c" : "#f2f2f3");
  var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  root.setAttribute("data-display", standalone ? "standalone" : "browser");
})();
