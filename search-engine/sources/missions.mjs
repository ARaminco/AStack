import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../redact.mjs";
import { fingerprintOf, sha } from "./util.mjs";

/**
 * Durable missions: title, goal, step titles, report summary and findings.
 * One unit per mission file.
 */
export const id = "missions";
// Bump when parsing changes: every unit of this source is then re-read.
export const version = 1;

export function units({ workspaceRoot }) {
  const directory = join(workspaceRoot, ".astack", "missions");
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const path = join(directory, name);
      return {
        key: name.replace(/\.json$/, ""),
        fingerprint: fingerprintOf(path),
        read: () => {
          let mission;
          try {
            mission = JSON.parse(readFileSync(path, "utf8"));
          } catch {
            return { hash: "unreadable", docs: [] };
          }
          const findings = (mission.findings ?? []).map((finding) => (typeof finding === "string" ? finding : finding?.text ?? finding?.title ?? JSON.stringify(finding)));
          const text = [
            mission.goal && mission.goal !== mission.title ? "Goal: " + mission.goal : "",
            mission.report?.summary ? "Report: " + mission.report.summary : "",
            findings.length ? "Findings:\n- " + findings.join("\n- ") : "",
            (mission.steps ?? []).length ? "Steps:\n- " + mission.steps.map((step) => step.title + " [" + step.state + "]").join("\n- ") : ""
          ]
            .filter(Boolean)
            .join("\n\n");
          const doc = {
            id: "missions:" + mission.id,
            kind: mission.state ?? null,
            title: redact(mission.title ?? mission.id),
            path: ".astack/missions/" + name,
            date: mission.report?.at ?? mission.updatedAt ?? mission.createdAt ?? null,
            text: redact(text),
            meta: { mission: mission.id, state: mission.state ?? null, domain: mission.domain ?? null, project: mission.project ?? null }
          };
          return { hash: sha(JSON.stringify(doc)), docs: [doc] };
        }
      };
    });
}
