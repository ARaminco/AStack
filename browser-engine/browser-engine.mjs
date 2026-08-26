import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeExternalContent } from "../lib/text.mjs";
import { attachToPage } from "./cdp-client.mjs";
import { EvidenceLedger } from "./evidence.mjs";
import { findBrowserBinary, launchBrowser } from "./launcher.mjs";
import { SessionStore } from "./session-store.mjs";

// Steps that commit are the ones that always stop for an owner decision.
export const COMMIT_STEPS = ["submit", "confirm", "pay", "delete", "approve"];

const STEP_AUTHORITY = {
  goto: "L1", wait: "L1", waitFor: "L1", extract: "L1", screenshot: "L1", pdf: "L1", scroll: "L1", assert: "L1", cookies: "L1",
  fill: "L3", type: "L3", select: "L3", check: "L3", click: "L3", upload: "L3",
  submit: "L4", confirm: "L4", pay: "L4", delete: "L4", approve: "L4"
};

/**
 * External page text is data, never instruction. The shared sanitizer
 * quarantines anything shaped like a command before it can reach memory, a
 * skill or another agent.
 */
export function sanitizeUntrusted(text, options = {}) {
  return sanitizeExternalContent(text, options);
}

function stepAuthority(step) {
  return STEP_AUTHORITY[step.action] ?? "L3";
}

function cssArgument(selector) {
  return JSON.stringify(String(selector));
}

/**
 * The Browser Operator.
 *
 * It drives a real Chromium profile through the DevTools protocol, keeps the
 * owner's logins in persistent profiles, captures chained evidence, refuses to
 * commit a high authority step without approval, and treats every byte of page
 * content as untrusted input.
 */
export class BrowserEngine {
  constructor(root, { clock, eventBus, policy = null, audit = null, authority = null, memory = null } = {}) {
    this.root = root;
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus ?? null;
    this.sessions = new SessionStore(root, { clock: this.clock });
    this.evidence = new EvidenceLedger(root, { clock: this.clock });
    this.policy = policy;
    this.audit = audit;
    this.authority = authority;
    this.memory = memory;
    this.directory = join(root, ".astack", "browser");
  }

  now() {
    return this.clock().toISOString();
  }

  available() {
    return Boolean(findBrowserBinary()) && typeof WebSocket !== "undefined";
  }

  status() {
    const binary = findBrowserBinary();
    const socketSupport = typeof WebSocket !== "undefined";
    return {
      driver: binary && socketSupport ? "cdp" : "none",
      binary,
      socketSupport,
      profiles: this.sessions.list().map((profile) => ({
        id: profile.id,
        sites: profile.sites.length,
        lastUsedAt: profile.lastUsedAt,
        headless: profile.headless
      })),
      note: !socketSupport
        ? "This Node.js build has no global WebSocket. Browser sessions need Node 22 or newer; the rest of AStack runs on Node 20."
        : binary
          ? "Chromium based browser found; the internal operator is ready."
          : "No Chromium based browser found. Install Chrome or Edge, or set ASTACK_BROWSER_PATH."
    };
  }

  profiles() {
    return this.sessions.list();
  }

  createProfile(options) {
    const profile = this.sessions.create(options);
    this.eventBus?.emit("browser.profile.created", { id: profile.id });
    return profile;
  }

  removeProfile(id) {
    return this.sessions.remove(id);
  }

  cookieHeader(profileId, url) {
    try {
      return this.sessions.cookieHeader(profileId, url);
    } catch {
      return null;
    }
  }

  health(profileId) {
    return this.sessions.health(profileId);
  }

  /**
   * Attended login. A visible window opens on the requested site with the
   * owner's own profile; when the owner signals they are done, the session is
   * snapshotted so later automated runs are already authenticated.
   */
  async login(profileId, { url, waitForSelector = null, timeoutMs = 300000, confirm = null } = {}) {
    const profile = this.sessions.exists(profileId) ? this.sessions.get(profileId) : this.sessions.create({ id: profileId });
    if (!url) {
      throw new Error("A login needs the site url");
    }
    const verdict = this.policy?.allowHost(url) ?? { allowed: true };
    if (!verdict.allowed) {
      throw new Error("blocked by automation policy: " + verdict.reason);
    }
    const launched = await launchBrowser({ userDataDir: profile.userDataDir, headless: false, url });
    const { client } = await attachToPage(launched.port, { timeoutMs: 30000 });
    await client.send("Page.enable");
    await client.send("Network.enable");
    const started = Date.now();
    let signedIn = false;
    try {
      while (Date.now() - started < timeoutMs) {
        if (confirm && (await confirm())) {
          signedIn = true;
          break;
        }
        if (waitForSelector) {
          const found = await client.evaluate("!!document.querySelector(" + cssArgument(waitForSelector) + ")");
          if (found) {
            signedIn = true;
            break;
          }
        }
        if (!confirm && !waitForSelector) {
          signedIn = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const cookies = (await client.send("Network.getAllCookies")).cookies ?? [];
      const saved = this.sessions.saveSession(profile.id, cookies);
      this.audit?.record({
        actor: "browser-operator",
        tool: "browser",
        action: "login",
        target: url,
        riskLevel: "L2",
        approval: "owner-present",
        result: signedIn ? "session captured" : "session captured without confirmation",
        evidence: []
      });
      this.eventBus?.emit("browser.login", { profile: profile.id, url, cookies: saved.cookies });
      return { profile: profile.id, url, signedIn, cookies: saved.cookies, hosts: saved.hosts, keepOpen: true, port: launched.port };
    } finally {
      client.close();
    }
  }

  planPath(missionId) {
    return join(this.directory, "runs", missionId + ".json");
  }

  savePlanState(missionId, state) {
    mkdirSync(join(this.directory, "runs"), { recursive: true });
    writeFileSync(this.planPath(missionId), JSON.stringify(state, null, 2) + "\n", "utf8");
    return this.planPath(missionId);
  }

  readPlanState(missionId) {
    const path = this.planPath(missionId);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  }

  /**
   * Describe what a flow would do without touching the network.
   */
  plan({ profile = "default", url = null, steps = [], evidence = null } = {}) {
    const planned = steps.map((step, index) => ({
      order: index + 1,
      action: step.action,
      target: step.selector ?? step.url ?? step.value ?? null,
      authority: stepAuthority(step),
      commits: COMMIT_STEPS.includes(step.action)
    }));
    const highest = planned.reduce((level, step) => (step.authority > level ? step.authority : level), "L0");
    return {
      profile,
      url,
      steps: planned,
      evidenceBundle: evidence,
      maxAuthority: highest,
      requiresApproval: planned.some((step) => step.commits),
      externalEffects: planned.filter((step) => step.authority >= "L3").map((step) => step.action + " " + (step.target ?? ""))
    };
  }

  /**
   * Execute a browser flow. Read steps run freely, write steps run under the
   * configured authority level, and a commit step stops the run and returns a
   * resumable approval checkpoint instead of clicking the button.
   */
  async run({
    profile = "default",
    url = null,
    steps = [],
    capture = [],
    evidence = null,
    headless = true,
    timeoutMs = 60000,
    mission = null,
    approvalGranted = false,
    dryRun = false,
    startAt = 0
  } = {}) {
    const plan = this.plan({ profile, url, steps, evidence });
    if (dryRun) {
      return { ok: true, dryRun: true, summary: "dry run: " + plan.steps.length + " steps planned", plan, artifacts: [], metrics: {} };
    }
    if (!this.available()) {
      return { ok: false, summary: this.status().note, plan, artifacts: [], metrics: {} };
    }
    if (url) {
      const verdict = this.policy?.allowHost(url) ?? { allowed: true };
      if (!verdict.allowed) {
        return { ok: false, summary: "blocked by automation policy: " + verdict.reason, plan, artifacts: [], metrics: {} };
      }
    }
    const profileRecord = this.sessions.exists(profile) ? this.sessions.get(profile) : this.sessions.create({ id: profile });
    const bundle = evidence ?? profileRecord.id;
    const started = Date.now();
    const artifacts = [];
    const results = [];
    const extractions = [];
    let launched = null;
    let client = null;
    try {
      launched = await launchBrowser({ userDataDir: profileRecord.userDataDir, headless, url: url ?? "about:blank" });
      const attached = await attachToPage(launched.port, { timeoutMs: 30000 });
      client = attached.client;
      await client.send("Page.enable");
      await client.send("Runtime.enable");
      await client.send("Network.enable");
      if (url) {
        await this.navigate(client, url, timeoutMs);
      }
      for (let index = startAt; index < steps.length; index += 1) {
        const step = steps[index];
        const authority = stepAuthority(step);
        if (COMMIT_STEPS.includes(step.action) && !approvalGranted) {
          const checkpoint = {
            mission,
            profile: profileRecord.id,
            url: await this.currentUrl(client),
            pendingStep: { ...step, order: index + 1, authority },
            remainingSteps: steps.slice(index),
            completedSteps: results,
            createdAt: this.now()
          };
          if (mission) {
            this.savePlanState(mission, checkpoint);
          }
          const snapshot = await this.captureScreenshot(client, bundle, { note: "state before " + step.action, mission });
          if (snapshot) {
            artifacts.push(snapshot.file);
          }
          this.eventBus?.emit("browser.approval.required", { mission, action: step.action, url: checkpoint.url });
          return {
            ok: false,
            pending: checkpoint,
            requiresApproval: true,
            summary: "stopped before " + step.action + " and is waiting for owner approval",
            plan,
            steps: results,
            artifacts,
            extractions,
            metrics: { durationMs: Date.now() - started, stepsDone: results.length }
          };
        }
        const outcome = await this.executeStep(client, step, { bundle, timeoutMs, mission });
        results.push({ order: index + 1, action: step.action, authority, ok: outcome.ok, detail: outcome.detail });
        if (outcome.artifact) {
          artifacts.push(outcome.artifact);
        }
        if (outcome.extraction) {
          extractions.push(outcome.extraction);
        }
        if (!outcome.ok && step.required !== false) {
          return {
            ok: false,
            summary: "step " + (index + 1) + " (" + step.action + ") failed: " + outcome.detail,
            plan,
            steps: results,
            artifacts,
            extractions,
            metrics: { durationMs: Date.now() - started, stepsDone: results.length }
          };
        }
      }
      for (const kind of capture) {
        if (kind === "screenshot") {
          const shot = await this.captureScreenshot(client, bundle, { note: "final state", mission });
          if (shot) {
            artifacts.push(shot.file);
          }
        }
        if (kind === "pdf") {
          const pdf = await this.capturePdf(client, bundle, { mission });
          if (pdf) {
            artifacts.push(pdf.file);
          }
        }
        if (kind === "cookies") {
          const cookies = (await client.send("Network.getAllCookies")).cookies ?? [];
          this.sessions.saveSession(profileRecord.id, cookies);
        }
      }
      this.sessions.touch(profileRecord.id);
      this.audit?.record({
        actor: "browser-operator",
        tool: "browser",
        action: "flow",
        target: url ?? profileRecord.id,
        riskLevel: plan.maxAuthority,
        approval: approvalGranted ? "granted" : "not-required",
        result: "completed " + results.length + " steps",
        mission,
        evidence: artifacts
      });
      return {
        ok: true,
        summary: "completed " + results.length + " steps on " + (url ?? profileRecord.id),
        plan,
        steps: results,
        artifacts,
        extractions,
        metrics: { durationMs: Date.now() - started, stepsDone: results.length }
      };
    } catch (error) {
      return {
        ok: false,
        summary: "browser run failed: " + error.message,
        plan,
        steps: results,
        artifacts,
        extractions,
        metrics: { durationMs: Date.now() - started, stepsDone: results.length }
      };
    } finally {
      if (client) {
        client.close();
      }
      if (launched?.child && !launched.child.killed) {
        launched.child.kill();
      }
    }
  }

  /**
   * Resume a flow that stopped at an approval checkpoint.
   */
  async resume(missionId, { approve = true, headless = true } = {}) {
    const checkpoint = this.readPlanState(missionId);
    if (!checkpoint) {
      throw new Error("No pending browser checkpoint for mission: " + missionId);
    }
    if (!approve) {
      this.savePlanState(missionId, { ...checkpoint, rejectedAt: this.now() });
      return { ok: false, summary: "owner rejected the pending action", checkpoint };
    }
    return this.run({
      profile: checkpoint.profile,
      url: checkpoint.url,
      steps: checkpoint.remainingSteps,
      headless,
      mission: missionId,
      approvalGranted: true
    });
  }

  async navigate(client, url, timeoutMs) {
    const load = client.once("Page.loadEventFired", { timeoutMs }).catch(() => null);
    await client.send("Page.navigate", { url });
    await Promise.race([load, new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 15000)))]);
    return true;
  }

  async currentUrl(client) {
    try {
      return await client.evaluate("location.href");
    } catch {
      return null;
    }
  }

  async waitForSelector(client, selector, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await client.evaluate("!!document.querySelector(" + cssArgument(selector) + ")");
      if (found) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  async executeStep(client, step, { bundle, timeoutMs, mission }) {
    const wait = step.timeoutMs ?? Math.min(timeoutMs, 20000);
    try {
      switch (step.action) {
        case "goto": {
          await this.navigate(client, step.url, wait);
          return { ok: true, detail: step.url };
        }
        case "wait": {
          await new Promise((resolve) => setTimeout(resolve, Math.min(Number(step.ms ?? 1000), 30000)));
          return { ok: true, detail: (step.ms ?? 1000) + "ms" };
        }
        case "waitFor": {
          const found = await this.waitForSelector(client, step.selector, wait);
          return { ok: found, detail: found ? "found " + step.selector : "selector not found: " + step.selector };
        }
        case "fill":
        case "type": {
          const found = await this.waitForSelector(client, step.selector, wait);
          if (!found) {
            return { ok: false, detail: "selector not found: " + step.selector };
          }
          const script =
            "(() => { const el = document.querySelector(" + cssArgument(step.selector) + ");" +
            " if (!el) return false;" +
            " const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');" +
            " if (setter && setter.set) { setter.set.call(el, " + JSON.stringify(String(step.value ?? "")) + "); }" +
            " else { el.value = " + JSON.stringify(String(step.value ?? "")) + "; }" +
            " el.dispatchEvent(new Event('input', { bubbles: true }));" +
            " el.dispatchEvent(new Event('change', { bubbles: true }));" +
            " return true; })()";
          const done = await client.evaluate(script);
          return { ok: Boolean(done), detail: step.selector };
        }
        case "select": {
          const script =
            "(() => { const el = document.querySelector(" + cssArgument(step.selector) + ");" +
            " if (!el) return false; el.value = " + JSON.stringify(String(step.value ?? "")) + ";" +
            " el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()";
          const done = await client.evaluate(script);
          return { ok: Boolean(done), detail: step.selector + " = " + step.value };
        }
        case "check": {
          const script =
            "(() => { const el = document.querySelector(" + cssArgument(step.selector) + ");" +
            " if (!el) return false; el.checked = " + (step.value === false ? "false" : "true") + ";" +
            " el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()";
          const done = await client.evaluate(script);
          return { ok: Boolean(done), detail: step.selector };
        }
        case "click":
        case "submit":
        case "confirm":
        case "pay":
        case "approve":
        case "delete": {
          const found = await this.waitForSelector(client, step.selector, wait);
          if (!found) {
            return { ok: false, detail: "selector not found: " + step.selector };
          }
          const script =
            "(() => { const el = document.querySelector(" + cssArgument(step.selector) + ");" +
            " if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()";
          const done = await client.evaluate(script);
          if (step.waitAfterMs !== 0) {
            await new Promise((resolve) => setTimeout(resolve, Number(step.waitAfterMs ?? 1200)));
          }
          return { ok: Boolean(done), detail: step.selector };
        }
        case "press": {
          for (const type of ["rawKeyDown", "char", "keyUp"]) {
            await client.send("Input.dispatchKeyEvent", {
              type,
              key: step.key ?? "Enter",
              text: step.key === "Enter" || !step.key ? "\r" : step.key,
              windowsVirtualKeyCode: step.key === "Tab" ? 9 : 13
            });
          }
          return { ok: true, detail: step.key ?? "Enter" };
        }
        case "scroll": {
          await client.evaluate("window.scrollBy(0, " + Number(step.pixels ?? 800) + ")");
          return { ok: true, detail: String(step.pixels ?? 800) };
        }
        case "extract": {
          const script =
            "(() => { const nodes = Array.from(document.querySelectorAll(" + cssArgument(step.selector ?? "body") + "));" +
            " return nodes.slice(0, " + Number(step.limit ?? 20) + ").map((node) => (node.innerText || node.textContent || '').trim()).filter(Boolean); })()";
          const values = (await client.evaluate(script)) ?? [];
          const joined = values.join("\n").slice(0, 6000);
          const sanitized = sanitizeUntrusted(joined);
          const extraction = {
            name: step.name ?? step.selector ?? "extract",
            untrusted: true,
            source: await this.currentUrl(client),
            values,
            text: sanitized.text,
            injectionSuspected: sanitized.injectionSuspected
          };
          if (sanitized.injectionSuspected) {
            this.eventBus?.emit("browser.injection.detected", { source: extraction.source, flags: sanitized.flags });
          }
          return { ok: values.length > 0, detail: values.length + " nodes", extraction };
        }
        case "assert": {
          if (step.selector) {
            const found = await this.waitForSelector(client, step.selector, wait);
            return { ok: found, detail: (found ? "present: " : "missing: ") + step.selector };
          }
          if (step.textContains) {
            const body = (await client.evaluate("document.body ? document.body.innerText : ''")) ?? "";
            const present = body.includes(String(step.textContains));
            return { ok: present, detail: (present ? "text found: " : "text missing: ") + step.textContains };
          }
          return { ok: false, detail: "assert needs selector or textContains" };
        }
        case "screenshot": {
          const shot = await this.captureScreenshot(client, bundle, { note: step.note ?? null, mission });
          return { ok: Boolean(shot), detail: shot?.file ?? "capture failed", artifact: shot?.file ?? null };
        }
        case "pdf": {
          const pdf = await this.capturePdf(client, bundle, { mission });
          return { ok: Boolean(pdf), detail: pdf?.file ?? "capture failed", artifact: pdf?.file ?? null };
        }
        case "cookies": {
          const cookies = (await client.send("Network.getAllCookies")).cookies ?? [];
          const saved = this.sessions.saveSession(step.profile ?? bundle, cookies);
          return { ok: true, detail: saved.cookies + " cookies stored" };
        }
        default:
          return { ok: false, detail: "unknown browser step: " + step.action };
      }
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  }

  async captureScreenshot(client, bundle, { note = null, mission = null } = {}) {
    try {
      const result = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const url = await this.currentUrl(client);
      return this.evidence.capture(bundle, {
        kind: "screenshot",
        data: result.data,
        extension: "png",
        url,
        note,
        mission,
        actor: "browser-operator"
      });
    } catch {
      return null;
    }
  }

  async capturePdf(client, bundle, { mission = null } = {}) {
    try {
      const result = await client.send("Page.printToPDF", { printBackground: true });
      const url = await this.currentUrl(client);
      return this.evidence.capture(bundle, {
        kind: "page",
        data: result.data,
        extension: "pdf",
        url,
        mission,
        actor: "browser-operator"
      });
    } catch {
      return null;
    }
  }
}

export { EvidenceLedger, SessionStore };
