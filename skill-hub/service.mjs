import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillHub, packSettings } from "./skill-hub.mjs";

/**
 * Daemon service for the skill hub (contract: documentation/V3-Plan.md).
 *
 * The only background work is an optional, periodic update check of packs
 * that were imported from a git remote. It compares commits and records the
 * result in `.astack/skill-hub/updates.json`. It never imports, never changes
 * a pack and never runs anything from a pack.
 */
export function createService({ runtime, config = null, log = () => {} } = {}) {
  const settings = packSettings({ ...(runtime?.configuration?.section?.("skills", {})?.packs ?? {}), ...(config ?? {}) });
  const hub = runtime?.skillHub ?? new SkillHub(runtime?.root ?? process.cwd(), {
    workspaceRoot: runtime?.workspaceRoot,
    policy: runtime?.automationPolicy ?? null,
    audit: runtime?.audit ?? null,
    settings
  });
  let timer = null;
  let last = null;
  let running = false;

  const check = () => {
    if (running) {
      return last;
    }
    running = true;
    try {
      last = hub.checkUpdates();
      const available = last.results.filter((entry) => entry.status === "update-available");
      mkdirSync(hub.stateDirectory, { recursive: true });
      writeFileSync(join(hub.stateDirectory, "updates.json"), JSON.stringify(last, null, 2) + "\n", "utf8");
      if (available.length) {
        log("skill-hub: updates available for " + available.map((entry) => entry.pack).join(", ") + " (check only; import manually)");
        runtime?.eventBus?.emit?.("skill-hub.update-available", { packs: available.map((entry) => entry.pack) });
      }
    } catch (error) {
      log("skill-hub: update check failed: " + String(error?.message ?? error));
    } finally {
      running = false;
    }
    return last;
  };

  return {
    name: "skill-hub",
    async start() {
      if (!settings.updateCheck) {
        return;
      }
      const hours = Math.max(1, Number(settings.updateCheckHours) || 24);
      timer = setInterval(check, hours * 3600000);
      timer.unref?.();
      check();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    check,
    status() {
      return {
        enabled: settings.enabled,
        updateCheck: settings.updateCheck,
        intervalHours: settings.updateCheckHours,
        running: Boolean(timer),
        lastCheck: last?.at ?? null,
        updatesAvailable: (last?.results ?? []).filter((entry) => entry.status === "update-available").map((entry) => entry.pack),
        ...hub.status()
      };
    }
  };
}
