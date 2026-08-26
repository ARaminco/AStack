import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../lib/text.mjs";

/**
 * Tamper evident evidence ledger.
 *
 * Every captured screenshot, PDF, download or extraction is hashed and chained
 * to the previous entry, so a bundle of browser evidence can be shown to a
 * counterparty, a court or an auditor with a verifiable order and integrity.
 */
export class EvidenceLedger {
  constructor(root, { clock } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "evidence");
    this.clock = clock ?? (() => new Date());
  }

  now() {
    return this.clock().toISOString();
  }

  bundleDirectory(bundle) {
    return join(this.directory, slugify(bundle, { fallback: "general" }));
  }

  ledgerPath(bundle) {
    return join(this.bundleDirectory(bundle), "ledger.jsonl");
  }

  entries(bundle) {
    const path = this.ledgerPath(bundle);
    if (!existsSync(path)) {
      return [];
    }
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  lastHash(bundle) {
    const entries = this.entries(bundle);
    return entries.length ? entries[entries.length - 1].chain : "genesis";
  }

  /**
   * Store one artifact and append its chained ledger entry.
   */
  capture(bundle, { kind, data, encoding = "base64", extension = "bin", url = null, title = null, note = null, mission = null, actor = null }) {
    const directory = this.bundleDirectory(bundle);
    mkdirSync(directory, { recursive: true });
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), encoding === "base64" ? "base64" : "utf8");
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const stamp = this.now().replace(/[:.]/g, "-");
    const fileName = kind + "-" + stamp + "-" + sha256.slice(0, 8) + "." + extension;
    writeFileSync(join(directory, fileName), buffer);
    const previous = this.lastHash(bundle);
    const entry = {
      id: "EV-" + sha256.slice(0, 10),
      at: this.now(),
      bundle,
      kind,
      file: [".astack", "evidence", slugify(bundle, { fallback: "general" }), fileName].join("/"),
      bytes: buffer.length,
      sha256,
      url,
      title,
      note,
      mission,
      actor,
      previous,
      chain: createHash("sha256").update(previous + sha256 + this.now()).digest("hex")
    };
    appendFileSync(this.ledgerPath(bundle), JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  /**
   * Recompute the chain and the file hashes to prove nothing was altered.
   */
  verify(bundle) {
    const entries = this.entries(bundle);
    const problems = [];
    let previous = "genesis";
    for (const entry of entries) {
      const absolute = join(this.root, entry.file);
      if (!existsSync(absolute)) {
        problems.push({ id: entry.id, problem: "file missing", file: entry.file });
      } else {
        const actual = createHash("sha256").update(readFileSync(absolute)).digest("hex");
        if (actual !== entry.sha256) {
          problems.push({ id: entry.id, problem: "content hash mismatch", file: entry.file });
        }
      }
      if (entry.previous !== previous) {
        problems.push({ id: entry.id, problem: "chain break" });
      }
      previous = entry.chain;
    }
    return { bundle, entries: entries.length, intact: problems.length === 0, problems };
  }

  bundles() {
    if (!existsSync(this.directory)) {
      return [];
    }
    return readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const entries = this.entries(entry.name);
        return {
          bundle: entry.name,
          entries: entries.length,
          lastAt: entries.length ? entries[entries.length - 1].at : null
        };
      });
  }
}
