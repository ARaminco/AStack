import { CdpClient } from "./cdp-client.mjs";

/**
 * Ask the page itself about the element a browser tool is about to act on.
 *
 * The proxy cannot map a Playwright ref to a DOM node, so it matches by the
 * accessible name the snapshot showed for that ref, inside an isolated world
 * (the page's own scripts cannot fake the answer), across open shadow roots
 * and same-origin frames. It reports:
 * - secret: a matching field is a password or one-time-code field (input
 *   type, autocomplete current-password/new-password/one-time-code);
 * - postSubmit: a matching control submits a form with method POST;
 * - focused / focusedSecret: the element that has focus (for keys).
 *
 * A probe that fails returns { error } and never throws.
 */
const SCRIPT = (names) => `(() => {
  const wanted = ${JSON.stringify(names)}.map((name) => String(name).trim().toLowerCase()).filter(Boolean);
  const text = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const nameOf = (el) => {
    const by = el.getAttribute && el.getAttribute("aria-labelledby");
    const labelled = by ? by.split(/\\s+/).map((id) => text(el.ownerDocument.getElementById(id)?.textContent)).join(" ") : "";
    const labels = el.labels ? [...el.labels].map((label) => text(label.textContent)).join(" ") : "";
    return text(el.getAttribute && el.getAttribute("aria-label")) || labelled || labels ||
      (el.tagName === "INPUT" && ["submit", "button", "reset"].includes((el.type || "").toLowerCase()) ? text(el.value) : "") ||
      text(el.getAttribute && el.getAttribute("placeholder")) || text(el.getAttribute && el.getAttribute("title")) ||
      text(el.getAttribute && el.getAttribute("alt")) || text(el.textContent);
  };
  const secret = (el) => {
    if (!el || !el.tagName) return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    return (el.tagName === "INPUT" && type === "password") || /current-password|new-password|one-time-code/.test(auto);
  };
  const submitsPost = (el) => {
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const isSubmit = (tag === "BUTTON" && (type === "" || type === "submit")) || (tag === "INPUT" && (type === "submit" || type === "image"));
    const form = el.form || el.closest && el.closest("form");
    if (!isSubmit || !form) return false;
    const method = (el.getAttribute("formmethod") || form.getAttribute("method") || "get").toLowerCase();
    return method === "post";
  };
  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.tagName === "IFRAME") {
        try { if (el.contentDocument) walk(el.contentDocument); } catch (error) { /* another origin */ }
      }
    }
  };
  walk(document);
  const interactive = all.filter((el) => /^(INPUT|BUTTON|A|TEXTAREA|SELECT|LABEL)$/.test(el.tagName) || el.getAttribute("role") || el.isContentEditable);
  const matches = interactive.filter((el) => wanted.includes(nameOf(el).toLowerCase()));
  // A label names the control it is for.
  const resolved = matches.flatMap((el) => el.tagName === "LABEL" && el.control ? [el, el.control] : [el]);
  let focused = document.activeElement;
  while (focused && (focused.shadowRoot?.activeElement || (focused.tagName === "IFRAME" && (() => { try { return focused.contentDocument?.activeElement; } catch (error) { return null; } })()))) {
    focused = focused.shadowRoot?.activeElement || focused.contentDocument.activeElement;
  }
  return {
    matched: resolved.length,
    secret: resolved.some(secret),
    postSubmit: resolved.some(submitsPost) || resolved.some((el) => el.tagName === "LABEL" && submitsPost(el.control)),
    focused: focused && focused !== document.body ? (focused.tagName.toLowerCase() + " " + nameOf(focused)).slice(0, 160) : null,
    focusedSecret: secret(focused),
    url: location.href
  };
})()`;

export async function probePage(port, { pageUrl = null, names = [], timeoutMs = 4000 } = {}) {
  let client = null;
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(timeoutMs) });
    const pages = (await response.json()).filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
    const page = (pageUrl && pages.find((target) => String(target.url).startsWith(pageUrl))) || pages[0];
    if (!page) {
      return { error: "no page" };
    }
    client = new CdpClient(page.webSocketDebuggerUrl, { timeoutMs });
    await client.connect();
    const tree = await client.send("Page.getFrameTree");
    const world = await client.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "astack-probe", grantUniveralAccess: true });
    const result = await client.send("Runtime.evaluate", { expression: SCRIPT(names), contextId: world.executionContextId, returnByValue: true });
    return result.result?.value ?? { error: "no answer" };
  } catch (error) {
    return { error: error.message };
  } finally {
    try {
      client?.close();
    } catch {
      // Closing a probe never matters.
    }
  }
}
