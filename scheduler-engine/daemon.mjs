import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseInterval } from "./cron.mjs";

/**
 * A dependency free supervisor loop.
 *
 * `astack schedule watch` keeps this process alive and ticks the scheduler on
 * a fixed cadence. It writes a pid file so a second watcher refuses to start,
 * and it shuts down cleanly on SIGINT/SIGTERM so a half finished job is never
 * left marked as running.
 */
export class SchedulerDaemon {
  constructor(scheduler, { interval = "60s", root = null, log = console.log } = {}) {
    this.scheduler = scheduler;
    this.intervalMs = parseInterval(interval);
    this.root = root ?? scheduler.root;
    this.log = log;
    this.pidPath = join(this.root, ".astack", "scheduler", "daemon.json");
    this.stopping = false;
    this.timer = null;
  }

  readPid() {
    if (!existsSync(this.pidPath)) {
      return null;
    }
    try {
      return JSON.parse(readFileSync(this.pidPath, "utf8"));
    } catch {
      return null;
    }
  }

  alive(pid) {
    if (!pid) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  writePid() {
    mkdirSync(join(this.root, ".astack", "scheduler"), { recursive: true });
    writeFileSync(
      this.pidPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), intervalMs: this.intervalMs }, null, 2) + "\n",
      "utf8"
    );
  }

  clearPid() {
    rmSync(this.pidPath, { force: true });
  }

  async start({ once = false } = {}) {
    const existing = this.readPid();
    if (existing && this.alive(existing.pid) && existing.pid !== process.pid) {
      throw new Error("A scheduler daemon is already running with pid " + existing.pid + ". Stop it first: astack schedule stop");
    }
    this.writePid();
    const shutdown = () => {
      this.stopping = true;
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.clearPid();
      this.log("scheduler daemon stopped");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    this.log("scheduler daemon started (pid " + process.pid + ", every " + Math.round(this.intervalMs / 1000) + "s)");
    do {
      const results = await this.scheduler.tick();
      for (const result of results) {
        this.log("[" + new Date().toISOString() + "] " + result.id + " " + result.status + " — " + result.summary);
      }
      if (once || this.stopping) {
        break;
      }
      await this.sleep(this.intervalMs);
    } while (!this.stopping);
    this.clearPid();
    return true;
  }

  sleep(milliseconds) {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, milliseconds);
      if (typeof this.timer.unref === "function") {
        this.timer.unref();
      }
    });
  }

  stop() {
    const existing = this.readPid();
    if (!existing) {
      return { stopped: false, reason: "no daemon is registered" };
    }
    if (!this.alive(existing.pid)) {
      this.clearPid();
      return { stopped: true, reason: "stale pid file removed", pid: existing.pid };
    }
    try {
      process.kill(existing.pid, "SIGTERM");
      return { stopped: true, pid: existing.pid };
    } catch (error) {
      return { stopped: false, reason: error.message, pid: existing.pid };
    }
  }

  status() {
    const existing = this.readPid();
    return {
      running: Boolean(existing && this.alive(existing.pid)),
      pid: existing?.pid ?? null,
      startedAt: existing?.startedAt ?? null,
      intervalMs: existing?.intervalMs ?? this.intervalMs
    };
  }
}
