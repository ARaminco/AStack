import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLocalization } from "../localization-engine/service.mjs";
import { redactSecrets, sanitizeExternalContent } from "../lib/text.mjs";
import { newApprovalCode, parseDecision } from "./approval-replies.mjs";
import { channelTypes } from "./channels/index.mjs";
import { runCommand } from "./commands.mjs";
import { formatForChat, maskId, splitMessage } from "./format.mjs";
import { acquireLock, GatewayState, readJson, writeJsonAtomic } from "./state.mjs";
import { VoiceTranscriber } from "./voice.mjs";

export const GATEWAY_DEFAULTS = {
  enabled: false,
  language: "fa",
  poll_interval_s: 5,
  long_poll_s: 25,
  max_inbound_age_s: 600,
  rate_limit_per_minute: 20,
  send_spacing_ms: 800,
  send_level: "L2",
  ack: true,
  announce_window_h: 24,
  announce_per_tick: 5,
  single_pending_without_code: true,
  owners: {},
  groups: {},
  channels: {},
  listener: { host: "127.0.0.1", port: 8788 },
  voice: {}
};

const CHANNEL_DEFAULTS = {
  "whatsapp-wapi": { token: "credential://wapi/channel" },
  telegram: { token: "credential://telegram/bot", api_base: "https://api.telegram.org" },
  "whatsapp-cloud": {
    access_token: "credential://whatsapp-cloud/access-token",
    app_secret: "credential://whatsapp-cloud/app-secret",
    verify_token: "credential://whatsapp-cloud/verify-token",
    api_version: "v21.0",
    graph_base: "https://graph.facebook.com"
  },
  "whatsapp-bridge": { port: 8790 },
  cli: {}
};

const SEEN_LIMIT = 2000;
const PROMPT_LIMIT = 300;

/**
 * The owner's pocket gateway.
 *
 * Commands arrive from the owner's phone over WhatsApp or Telegram, become
 * objectives for the runner (or a plan-only brief when no runner is
 * installed), and the result goes back to the same chat. Approvals that the
 * runner, a mission or anything else requests are sent to every owner account
 * with a short code, and the owner answers «بفرست» / «نه».
 *
 * Security model:
 * - Only accounts listed under `gateway.owners.<channel>` (or added with
 *   `astack gateway owner add`) are heard; everyone else is ignored and
 *   audited. Groups are heard only when listed under `gateway.groups`, and even
 *   then only owners inside them.
 * - Everything sent goes to an allowlisted owner account or group, passes the
 *   automation policy ("notify") and the authority engine, is rate limited and
 *   audited.
 * - Inbound text is data: it is sanitized, may become an objective, and is
 *   never interpreted as an instruction to the gateway itself beyond the
 *   fixed command set and the approval words.
 * - An approval goes through `runtime.approvals` with actor `owner@<channel>`
 *   and produces the normal receipt; one decision, one action.
 */
export class GatewayEngine {
  constructor(root, {
    clock,
    eventBus = null,
    configuration = null,
    approvals = null,
    audit = null,
    authority = null,
    automationPolicy = null,
    secrets = null,
    chief = null,
    missions = null,
    config = null,
    i18n = null,
    channels = {},
    voice = null,
    log = () => {}
  } = {}) {
    this.root = root;
    this.directory = join(root, ".astack", "gateway");
    this.clock = clock ?? (() => new Date());
    this.eventBus = eventBus;
    this.configuration = configuration;
    this.approvals = approvals;
    this.audit = audit;
    this.authority = authority;
    this.automationPolicy = automationPolicy;
    this.secrets = secrets;
    this.chief = chief;
    this.missions = missions;
    this.configOverride = config;
    this.i18nOverride = i18n;
    this.channelOverrides = channels;
    this.voiceOverride = voice;
    this.log = log;
    this.instances = new Map();
    this.state = new GatewayState(this.directory);
    this.runtime = null;
    this.live = false;
    this.subscribed = false;
    this.sendQueue = Promise.resolve();
  }

  now() {
    return this.clock();
  }

  /**
   * Attach the full runtime so the gateway can reach `runtime.runner` (P1),
   * the scheduler and signals for /status. Safe to call more than once.
   */
  bind(runtime) {
    this.runtime = runtime ?? null;
    return this;
  }

  settings() {
    const raw = this.configOverride ?? this.configuration?.section("gateway", {}) ?? {};
    return {
      ...GATEWAY_DEFAULTS,
      ...raw,
      listener: { ...GATEWAY_DEFAULTS.listener, ...(raw.listener ?? {}) },
      voice: { ...(raw.voice ?? {}) },
      owners: raw.owners ?? {},
      groups: raw.groups ?? {},
      channels: raw.channels ?? {}
    };
  }

  t(key, vars = {}) {
    if (!this.i18n) {
      this.i18n = this.i18nOverride ?? createLocalization({ locale: this.settings().language });
    }
    return this.i18n.t("gateway." + key, vars);
  }

  // ------------------------------------------------------------ channels

  channelConfig(id) {
    return { ...(CHANNEL_DEFAULTS[id] ?? {}), ...(this.settings().channels?.[id] ?? {}) };
  }

  /**
   * Channels that are switched on. The loopback channel is only ever active
   * when it was injected (tests) or explicitly enabled.
   */
  enabledChannels() {
    const configured = Object.entries(this.settings().channels ?? {})
      .filter(([, value]) => value && value.enabled === true)
      .map(([id]) => id);
    return [...new Set([...configured, ...Object.keys(this.channelOverrides)])].filter((id) => channelTypes[id] || this.channelOverrides[id]);
  }

  channelContext(id) {
    return {
      now: () => this.now(),
      secret: (reference, purpose) => {
        if (!this.secrets) {
          throw new Error("no secret broker available for " + id);
        }
        return this.secrets.resolve(reference, { requester: "gateway:" + id, purpose });
      },
      assertHost: (url) => {
        const verdict = this.automationPolicy?.allowHost?.(url) ?? { allowed: true };
        if (!verdict.allowed) {
          throw new Error("network policy: " + verdict.reason);
        }
      },
      bridgeDirectory: join(this.directory, "bridge")
    };
  }

  channel(id) {
    if (this.channelOverrides[id]) {
      return this.channelOverrides[id];
    }
    if (!this.instances.has(id)) {
      const Type = channelTypes[id];
      if (!Type) {
        throw new Error("Unknown gateway channel: " + id + ". Use: " + Object.keys(channelTypes).join(", "));
      }
      this.instances.set(id, new Type({ id, config: this.channelConfig(id), context: this.channelContext(id) }));
    }
    return this.instances.get(id);
  }

  // ----------------------------------------------------------- allowlist

  ownersFile() {
    return join(this.directory, "owners.json");
  }

  /**
   * Every account listed for a channel is the owner. Entries come from
   * `gateway.owners.<channel>` and from `.astack/gateway/owners.json`, which
   * keeps phone numbers and ids out of a committed config file.
   */
  owners(channelId) {
    const fromConfig = this.settings().owners?.[channelId] ?? [];
    const fromFile = readJson(this.ownersFile(), {}).owners?.[channelId] ?? [];
    const list = [...(Array.isArray(fromConfig) ? fromConfig : [fromConfig]), ...fromFile].map((entry) => String(entry).trim()).filter(Boolean);
    return [...new Set(list)];
  }

  groups(channelId) {
    const fromConfig = this.settings().groups?.[channelId] ?? [];
    const fromFile = readJson(this.ownersFile(), {}).groups?.[channelId] ?? [];
    return [...new Set([...(Array.isArray(fromConfig) ? fromConfig : [fromConfig]), ...fromFile].map((entry) => String(entry).trim()).filter(Boolean))];
  }

  editOwners(channelId, entry, { remove = false, group = false } = {}) {
    const file = readJson(this.ownersFile(), { owners: {}, groups: {} });
    const bucket = group ? "groups" : "owners";
    file[bucket] = file[bucket] ?? {};
    const current = new Set(file[bucket][channelId] ?? []);
    if (remove) {
      current.delete(String(entry));
    } else {
      current.add(String(entry));
    }
    file[bucket][channelId] = [...current];
    writeJsonAtomic(this.ownersFile(), file);
    return file[bucket][channelId];
  }

  /**
   * The configured owner entry this message's sender matches, or null.
   */
  matchOwner(channelId, candidates) {
    const channel = this.channel(channelId);
    const owners = this.owners(channelId);
    for (const owner of owners) {
      const ownerAliases = channel.aliases(owner);
      for (const candidate of candidates ?? []) {
        for (const alias of channel.aliases(candidate)) {
          if (ownerAliases.has(alias)) {
            return owner;
          }
        }
      }
    }
    return null;
  }

  groupAllowed(channelId, chatId) {
    const channel = this.channel(channelId);
    const wanted = channel.normalizeId(chatId);
    return this.groups(channelId).some((group) => channel.normalizeId(group) === wanted);
  }

  /**
   * Outbound targets are owners and allowlisted groups, nothing else.
   */
  targetAllowed(channelId, target) {
    return Boolean(this.matchOwner(channelId, [target])) || this.groupAllowed(channelId, target);
  }

  // --------------------------------------------------------------- send

  sendPermitted(channelId) {
    const action = this.automationPolicy?.allowAction?.("notify") ?? { allowed: true };
    if (!action.allowed) {
      return { allowed: false, reason: action.reason };
    }
    const decision = this.authority?.evaluate?.({ action: "gateway.send", level: this.settings().send_level, tool: "gateway" });
    if (decision && !decision.allowed) {
      return { allowed: false, reason: decision.reason };
    }
    return { allowed: true };
  }

  rateAllows(state, channelId) {
    const minute = this.now().getTime() - 60000;
    const sends = (state.sends[channelId] ?? []).filter((at) => at > minute);
    state.sends[channelId] = sends;
    return sends.length < Number(this.settings().rate_limit_per_minute);
  }

  /**
   * Format, split, gate, rate limit, send and audit. Returns the ids of the
   * messages that went out (one per part) or { queued: true }.
   */
  async sendTo(channelId, target, text, { quoted = null, files = [], fromOutbox = false, promptFor = null } = {}) {
    const run = this.sendQueue.then(() => this.sendNow(channelId, target, text, { quoted, files, fromOutbox, promptFor }));
    this.sendQueue = run.catch(() => {});
    return run;
  }

  async sendNow(channelId, target, text, { quoted, files, fromOutbox, promptFor }) {
    const channel = this.channel(channelId);
    if (!this.targetAllowed(channelId, target)) {
      this.audit?.record({ actor: "gateway", tool: "gateway", action: "gateway-send-refused", target: channelId + ":" + maskId(target), riskLevel: "L2", result: "target is not an allowlisted owner or group" });
      throw new Error("gateway refuses to send to a target that is not an allowlisted owner or group");
    }
    const permitted = this.sendPermitted(channelId);
    if (!permitted.allowed) {
      this.audit?.record({ actor: "gateway", tool: "gateway", action: "gateway-send-refused", target: channelId + ":" + maskId(target), riskLevel: "L2", result: permitted.reason });
      throw new Error("gateway send not permitted: " + permitted.reason);
    }
    const body = formatForChat(text);
    const parts = splitMessage(body, { maxChars: channel.maxChars ?? 1500, label: (index, total) => this.t("partLabel", { index, total }) });
    const state = this.state.read();
    if (!this.rateAllows(state, channelId)) {
      if (!fromOutbox) {
        // A queued approval prompt keeps its link, so a reply quoting it
        // still finds the request once the outbox delivers it.
        state.outbox.push({ channel: channelId, target, text: body, quoted, files, promptFor, at: this.now().toISOString() });
        state.outbox = state.outbox.slice(-200);
      }
      this.state.write(state);
      return { queued: true, ids: [] };
    }
    this.state.write(state);
    const ids = [];
    const spacing = Number(this.settings().send_spacing_ms);
    for (let index = 0; index < parts.length; index += 1) {
      const sent = await channel.sendText(target, parts[index], { quoted: index === 0 ? quoted : null });
      ids.push(sent?.id ?? null);
      this.recordSend(channelId);
      if (spacing && index < parts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, spacing));
      }
    }
    for (const file of files ?? []) {
      if (!existsSync(file)) {
        throw new Error("file to send does not exist: " + file);
      }
      const sent = await channel.sendFile(target, file, {});
      ids.push(sent?.id ?? null);
      this.recordSend(channelId);
    }
    this.audit?.record({
      actor: "gateway",
      tool: "gateway",
      action: "gateway-sent",
      target: channelId + ":" + maskId(target),
      riskLevel: "L2",
      approval: "policy",
      result: parts.length + " part(s), " + (files?.length ?? 0) + " file(s)",
      metadata: { ids: ids.filter(Boolean).slice(0, 10) }
    });
    return { queued: false, ids };
  }

  recordSend(channelId) {
    this.state.update((state) => {
      state.sends[channelId] = [...(state.sends[channelId] ?? []), this.now().getTime()].slice(-500);
    });
  }

  async flushOutbox() {
    const state = this.state.read();
    if (!state.outbox.length) {
      return 0;
    }
    const pending = state.outbox;
    state.outbox = [];
    this.state.write(state);
    let sent = 0;
    for (const item of pending) {
      try {
        const result = await this.sendTo(item.channel, item.target, item.text, { quoted: item.quoted, files: item.files, fromOutbox: true });
        if (result.queued) {
          this.state.update((current) => {
            current.outbox.push(item);
          });
        } else {
          sent += 1;
          if (item.promptFor) {
            this.linkPromptMessages(item.promptFor, result.ids.filter(Boolean).map((id) => ({ channel: item.channel, target: item.target, id })));
          }
        }
      } catch (error) {
        this.log("[gateway] outbox item dropped: " + error.message);
      }
    }
    return sent;
  }

  /**
   * Primary owner accounts: every listed owner of every enabled channel (or of
   * one channel). Accounts that are aliases of each other are sent once.
   */
  ownerTargets(channelId = null) {
    const targets = [];
    for (const id of channelId ? [channelId] : this.enabledChannels()) {
      const channel = this.channel(id);
      const covered = new Set();
      for (const owner of this.owners(id)) {
        const aliases = [...channel.aliases(owner)];
        if (aliases.some((alias) => covered.has(alias))) {
          continue;
        }
        aliases.forEach((alias) => covered.add(alias));
        targets.push({ channel: id, target: owner });
      }
    }
    return targets;
  }

  /**
   * Public contract: tell the owner something on their phone.
   */
  async notify({ text = "", level = "info", files = [], channel = null, approvalId = null } = {}) {
    if (approvalId) {
      return this.promptApproval(approvalId, { channel, note: text || null });
    }
    const prefix = { success: "✅ ", warn: "⚠️ ", warning: "⚠️ ", error: "❌ " }[level] ?? "";
    const results = [];
    for (const { channel: id, target } of this.ownerTargets(channel)) {
      try {
        const result = await this.sendTo(id, target, prefix + text, { files });
        results.push({ channel: id, target: maskId(target), ok: true, queued: result.queued, ids: result.ids });
      } catch (error) {
        results.push({ channel: id, target: maskId(target), ok: false, error: error.message });
      }
    }
    return { sent: results.filter((entry) => entry.ok).length, results };
  }

  // ----------------------------------------------------------- approvals

  approvalText(approval, code, note = null) {
    const lines = [this.t("approval.title"), this.t("approval.code", { code })];
    lines.push(this.t("approval.action", { action: approval.action }));
    if (approval.summary && approval.summary !== approval.action) {
      lines.push(this.t("approval.summary", { summary: approval.summary }));
    }
    if (approval.target) {
      lines.push(this.t("approval.target", { target: approval.target }));
    }
    const values = Object.entries(approval.parameters ?? {}).filter(([key]) => key !== "mission").slice(0, 12);
    if (values.length) {
      lines.push(this.t("approval.values"));
      for (const [key, value] of values) {
        const shown = typeof value === "object" ? JSON.stringify(value) : String(value);
        lines.push("- " + key + ": " + redactSecrets(shown).slice(0, 160));
      }
    }
    lines.push(this.t("approval.level", { level: approval.level }));
    if (approval.mission) {
      lines.push(this.t("approval.mission", { mission: approval.mission }));
    }
    if (note) {
      lines.push(note);
    }
    lines.push(this.t("approval.howTo", { code }));
    return lines.join("\n");
  }

  linkPromptMessages(approvalId, delivered) {
    this.state.update((state) => {
      const entry = state.prompts.find((item) => item.approvalId === approvalId);
      if (entry) {
        entry.messages = [...(entry.messages ?? []), ...delivered];
        entry.promptedAt = this.now().toISOString();
      }
    });
  }

  ensurePrompt(approvalId, extra = {}) {
    return this.state.update((state) => {
      let prompt = state.prompts.find((entry) => entry.approvalId === approvalId);
      if (!prompt) {
        prompt = {
          approvalId,
          code: newApprovalCode(new Set(state.prompts.map((entry) => entry.code))),
          createdAt: this.now().toISOString(),
          messages: [],
          origin: extra.origin ?? null
        };
        state.prompts.push(prompt);
        state.prompts = state.prompts.slice(-PROMPT_LIMIT);
      }
      return prompt;
    });
  }

  /**
   * Send an approval request to every owner account. Idempotent per approval
   * id: a second trigger (event plus sweep, runner result plus event) does not
   * send it twice.
   */
  async promptApproval(approvalId, { channel = null, note = null, origin = null } = {}) {
    let approval;
    try {
      approval = this.approvals?.get(approvalId);
    } catch {
      return { sent: 0, error: "unknown approval " + approvalId };
    }
    if (!approval || approval.state !== "pending") {
      return { sent: 0, skipped: approval?.state ?? "missing" };
    }
    const existing = this.state.read().prompts.find((entry) => entry.approvalId === approvalId);
    if (existing?.messages?.length || existing?.queued) {
      return { sent: 0, code: existing.code, skipped: "already-prompted" };
    }
    const prompt = this.ensurePrompt(approvalId, { origin });
    const text = this.approvalText(approval, prompt.code, note);
    const delivered = [];
    let queued = 0;
    for (const { channel: id, target } of this.ownerTargets(channel)) {
      try {
        const result = await this.sendTo(id, target, text, { promptFor: approvalId });
        queued += result.queued ? 1 : 0;
        for (const messageId of result.ids.filter(Boolean)) {
          delivered.push({ channel: id, target, id: messageId });
        }
      } catch (error) {
        this.log("[gateway] approval prompt to " + id + " failed: " + error.message);
      }
    }
    this.linkPromptMessages(approvalId, delivered);
    if (queued) {
      this.state.update((state) => {
        const entry = state.prompts.find((item) => item.approvalId === approvalId);
        if (entry) {
          entry.queued = true;
        }
      });
    }
    this.audit?.record({ actor: "gateway", tool: "gateway", action: "gateway-approval-prompted", target: approvalId, riskLevel: approval.level, approval: "pending", result: "code " + prompt.code + " to " + delivered.length + " message(s)", mission: approval.mission });
    return { sent: delivered.length, queued, code: prompt.code };
  }

  /**
   * Pending approvals that no owner has been told about yet — the
   * cross-process path, since an approval requested in another process never
   * reaches this event bus.
   */
  async announcePending() {
    if (!this.approvals) {
      return 0;
    }
    const settings = this.settings();
    const since = this.now().getTime() - Number(settings.announce_window_h) * 3600 * 1000;
    const prompted = new Set(this.state.read().prompts.filter((entry) => entry.messages?.length || entry.queued).map((entry) => entry.approvalId));
    const fresh = this.approvals.pending().filter((approval) => !prompted.has(approval.id) && new Date(approval.createdAt).getTime() >= since);
    let sent = 0;
    for (const approval of fresh.slice(0, Number(settings.announce_per_tick))) {
      const result = await this.promptApproval(approval.id);
      sent += result.sent ? 1 : 0;
    }
    return sent;
  }

  openPrompts() {
    const state = this.state.read();
    return state.prompts.filter((prompt) => {
      try {
        return this.approvals?.get(prompt.approvalId)?.state === "pending";
      } catch {
        return false;
      }
    });
  }

  /**
   * Which approval a reply answers: the quoted prompt, then the code, then
   * the only open prompt. Several open and nothing to tell them apart is
   * ambiguous — never guessed.
   */
  resolvePrompt(channelId, message, code) {
    const prompts = this.state.read().prompts;
    if (message.quotedId) {
      const quoted = prompts.find((prompt) => (prompt.messages ?? []).some((entry) => entry.channel === channelId && String(entry.id) === String(message.quotedId)));
      if (quoted) {
        return { prompt: quoted };
      }
    }
    if (code) {
      const byCode = prompts.find((prompt) => prompt.code === code);
      return byCode ? { prompt: byCode } : { error: "unknown-code" };
    }
    const open = this.openPrompts();
    if (open.length === 1 && this.settings().single_pending_without_code) {
      return { prompt: open[0] };
    }
    if (!open.length) {
      return { error: "none" };
    }
    return { error: "ambiguous", open };
  }

  async handleDecision(channelId, message, reply, parsed, { voice = false } = {}) {
    if (voice && !this.voiceSettings().allow_approvals) {
      await reply(this.t("approval.voiceNotAccepted"));
      return { action: "decision-refused-voice" };
    }
    const resolved = this.resolvePrompt(channelId, message, parsed.code);
    if (resolved.error === "unknown-code") {
      await reply(this.t("approval.unknownCode", { code: parsed.code }));
      return { action: "decision-unknown-code" };
    }
    if (resolved.error === "none") {
      await reply(this.t("approval.none"));
      return { action: "decision-none" };
    }
    if (resolved.error === "ambiguous") {
      const lines = [this.t("approval.ambiguous")];
      for (const prompt of resolved.open) {
        const approval = this.approvals.get(prompt.approvalId);
        lines.push(this.t("approval.ambiguousItem", { code: prompt.code, action: approval.action }));
      }
      await reply(lines.join("\n"));
      return { action: "decision-ambiguous", codes: resolved.open.map((prompt) => prompt.code) };
    }
    const { prompt } = resolved;
    const by = "owner@" + channelId;
    let decided;
    try {
      const current = this.approvals.get(prompt.approvalId);
      if (current.state !== "pending") {
        throw Object.assign(new Error("already " + current.state), { record: current });
      }
      decided = parsed.decision === "approve"
        ? this.approvals.approve(prompt.approvalId, { by, note: "gateway message " + message.id })
        : this.approvals.reject(prompt.approvalId, { by, note: "gateway message " + message.id });
    } catch (error) {
      let record = error.record;
      try {
        record = record ?? this.approvals.get(prompt.approvalId);
      } catch {
        record = null;
      }
      await reply(this.t("approval.alreadyDecided", {
        state: this.t("approval.states." + (record?.state ?? "unknown")),
        by: record?.decidedBy ?? "-",
        at: String(record?.decidedAt ?? record?.updatedAt ?? "-").replace("T", " ").slice(0, 16)
      }));
      return { action: "decision-already-decided", approval: prompt.approvalId, state: record?.state ?? null };
    }
    this.state.update((state) => {
      const entry = state.prompts.find((item) => item.approvalId === prompt.approvalId);
      if (entry) {
        entry.decidedAt = this.now().toISOString();
        entry.decidedBy = by;
      }
    });
    if (parsed.decision !== "approve") {
      await reply(this.t("approval.denied"));
      return { action: "decision-denied", approval: decided.id };
    }
    await reply(this.t("approval.approved", { receipt: decided.receipt?.id ?? "-" }));
    const resumed = await this.resume(decided, channelId);
    if (resumed) {
      await reply(resumed);
    }
    return { action: "decision-approved", approval: decided.id, receipt: decided.receipt?.id ?? null };
  }

  /**
   * Continue whatever was waiting on the approval: the run through the runner
   * when one exists, otherwise the mission through the mission engine.
   */
  async resume(approval, channelId) {
    if (!approval.mission) {
      return this.t("approval.notResumable");
    }
    const runner = this.runtime?.runner ?? null;
    try {
      if (runner?.execute) {
        const result = await runner.execute({ missionId: approval.mission, source: "gateway:" + channelId });
        return this.describeRun(result);
      }
      const missions = this.runtime?.missions ?? this.missions;
      if (missions) {
        missions.resume(approval.mission, { note: "approved from " + channelId });
        const result = await missions.run(approval.mission, { actor: "owner@" + channelId });
        return this.t("approval.resumed", { summary: result.summary });
      }
    } catch (error) {
      return this.t("reply.error", { reason: error.message });
    }
    return this.t("approval.notResumable");
  }

  // ------------------------------------------------------------- inbound

  voiceSettings() {
    return { ...this.settings().voice };
  }

  voice() {
    if (!this.voiceInstance) {
      this.voiceInstance = this.voiceOverride ?? new VoiceTranscriber({ config: this.voiceSettings(), policy: this.automationPolicy });
    }
    return this.voiceInstance;
  }

  markSeen(channelId, messageId) {
    return this.state.update((state) => {
      const seen = state.seen[channelId] ?? [];
      if (seen.includes(messageId)) {
        return false;
      }
      state.seen[channelId] = [...seen, messageId].slice(-SEEN_LIMIT);
      return true;
    });
  }

  auditIgnored(channelId, message, reason) {
    const count = this.state.update((state) => {
      state.ignored[channelId] = (state.ignored[channelId] ?? 0) + 1;
      return state.ignored[channelId];
    });
    this.audit?.record({
      actor: "gateway",
      tool: "gateway",
      action: reason === "stale" ? "gateway-stale" : "gateway-ignored",
      target: channelId + ":" + maskId(message.senderIds?.[0] ?? message.chatId),
      riskLevel: "L1",
      result: reason,
      metadata: { chat: maskId(message.chatId), group: Boolean(message.isGroup), total: count }
    });
  }

  /**
   * One inbound message, start to finish. Dedup is recorded before any work so
   * a crash mid-way can never run the same command twice.
   */
  async handleInbound(channelId, message) {
    if (!message?.id) {
      return { action: "invalid" };
    }
    if (!this.markSeen(channelId, String(message.id))) {
      return { action: "duplicate" };
    }
    if (message.fromMe) {
      return { action: "own-message" };
    }
    const owner = this.matchOwner(channelId, message.senderIds ?? []);
    if (!owner) {
      this.auditIgnored(channelId, message, "not an owner");
      return { action: "ignored", reason: "stranger" };
    }
    if (message.isGroup && !this.groupAllowed(channelId, message.chatId)) {
      this.auditIgnored(channelId, message, "group not allowlisted");
      return { action: "ignored", reason: "group" };
    }
    const age = Math.floor(this.now().getTime() / 1000) - Number(message.timestamp || 0);
    if (message.timestamp && age > Number(this.settings().max_inbound_age_s)) {
      this.auditIgnored(channelId, message, "stale");
      return { action: "ignored", reason: "stale" };
    }
    const target = message.isGroup ? message.chatId : owner;
    const reply = (text, options = {}) => this.sendTo(channelId, target, text, { quoted: message.id, ...options });
    this.audit?.record({ actor: "owner@" + channelId, tool: "gateway", action: "gateway-inbound", target: channelId + ":" + maskId(owner), riskLevel: "L1", result: message.voice ? "voice" : "text", metadata: { id: String(message.id).slice(0, 64) } });

    let text = String(message.text ?? "");
    let fromVoice = false;
    if (message.voice) {
      const transcript = await this.transcribe(channelId, message);
      if (!transcript.ok) {
        await reply(this.t("reply.voiceUnavailable", { reason: transcript.error }));
        return { action: "voice-failed", reason: transcript.error };
      }
      text = transcript.text;
      fromVoice = true;
      await reply(this.t("reply.voiceHeard", { text }));
    }
    if (!text.trim()) {
      await reply(this.t("reply.unsupported"));
      return { action: "unsupported", type: message.unsupported ?? null };
    }

    const decision = parseDecision(text);
    if (decision) {
      return this.handleDecision(channelId, message, reply, decision, { voice: fromVoice });
    }
    if (text.trim().startsWith("/")) {
      return runCommand(this, { channelId, message, text: text.trim(), reply, owner });
    }
    return this.runObjective(channelId, message, text, reply);
  }

  async transcribe(channelId, message) {
    const settings = this.voiceSettings();
    if (settings.enabled === false) {
      return { ok: false, error: this.t("reply.voiceDisabled") };
    }
    let file = null;
    try {
      const media = join(this.directory, "media");
      mkdirSync(media, { recursive: true });
      file = await this.channel(channelId).downloadVoice(message, media);
      const result = await this.voice().transcribe(file.path);
      this.audit?.record({ actor: "gateway", tool: "gateway", action: "gateway-voice", target: channelId, riskLevel: "L1", result: result.ok ? "transcribed on " + result.device : "failed: " + result.error });
      return result.ok ? { ok: true, text: String(result.text ?? "").trim() } : { ok: false, error: result.error };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      if (file?.temporary && file.path && !this.voiceSettings().keep_media) {
        rmSync(file.path, { force: true });
      }
    }
  }

  /**
   * An owner request becomes an objective for the runner. The authority
   * ceiling is the runner's own default — the gateway never raises it.
   */
  async runObjective(channelId, message, text, reply) {
    const sanitized = sanitizeExternalContent(text, { maxLength: 4000 });
    if (sanitized.injectionSuspected) {
      this.audit?.record({ actor: "gateway", tool: "gateway", action: "gateway-quarantined", target: channelId, riskLevel: "L1", result: sanitized.flags.join(", ").slice(0, 200) });
      await reply(this.t("reply.quarantined"));
      return { action: "quarantined" };
    }
    const objective = sanitized.text.trim();
    const runner = this.runtime?.runner ?? null;
    if (runner?.execute) {
      if (this.settings().ack) {
        await reply(this.t("reply.ack"));
      }
      let result;
      try {
        result = await runner.execute({ objective, source: "gateway:" + channelId });
      } catch (error) {
        await reply(this.t("reply.failed", { reason: error.message }));
        return { action: "run-error", error: error.message };
      }
      const prompts = [];
      for (const id of approvalIdsOf(result)) {
        prompts.push(await this.promptApproval(id, { origin: { channel: channelId, run: result?.id ?? null } }));
      }
      await reply(this.describeRun(result));
      return { action: "run", status: result?.status ?? null, run: result?.id ?? null, prompts };
    }
    const chief = this.runtime?.chief ?? this.chief;
    if (!chief) {
      await reply(this.t("reply.noRunner"));
      return { action: "no-runner" };
    }
    const brief = chief.brief(objective, { includeRepoMap: false });
    const lines = [this.t("reply.planOnly"), ...brief.summary.map((line) => "- " + line), this.t("reply.planSteps")];
    for (const step of brief.plan.steps) {
      lines.push("- " + step.title + " (" + (step.authority ?? "L1") + ")");
    }
    await reply(lines.join("\n"));
    return { action: "plan-only", steps: brief.plan.steps.length };
  }

  describeRun(result) {
    const status = result?.status ?? "unknown";
    const summary = String(result?.summary ?? "").trim();
    const output = typeof result?.output === "string" ? result.output.trim() : "";
    if (status === "completed") {
      return [this.t("reply.completed"), summary, output && output !== summary ? output : ""].filter(Boolean).join("\n");
    }
    if (status === "awaiting-approval") {
      return [this.t("reply.waiting"), summary].filter(Boolean).join("\n");
    }
    if (status === "queued") {
      return this.t("reply.queued", { id: result?.id ?? "-" });
    }
    if (status === "refused") {
      // Nothing ran: the runner's own limits said no (budget, concurrency, engine).
      const reason = String(result?.reason ?? "");
      const known = ["daily-budget", "max-concurrent", "engine-unavailable"].includes(reason);
      return this.t("reply.refused", { reason: known ? this.t("reply.refusedReasons." + reason) : reason || summary || "-" });
    }
    if (status === "dry-run") {
      return [this.t("reply.dryRun"), summary].filter(Boolean).join("\n");
    }
    return this.t("reply.failed", { reason: summary || status });
  }

  // ---------------------------------------------------------------- poll

  /**
   * One pass over the enabled channels (or one channel): pull, handle, save
   * the cursor; then the approval sweep and the outbox.
   */
  async pollOnce({ channel = null, timeoutS = 0, signal = null } = {}) {
    const ids = channel ? [channel] : this.enabledChannels();
    const report = [];
    for (const id of ids) {
      const instance = this.channel(id);
      if (instance.mode === "webhook") {
        report.push({ channel: id, mode: "webhook", handled: 0 });
        continue;
      }
      const lock = acquireLock(join(this.directory, "locks", id + ".lock"));
      if (!lock) {
        report.push({ channel: id, skipped: "another poller holds the lock" });
        continue;
      }
      try {
        const cursor = this.state.read().cursors[id] ?? null;
        const { messages, cursor: next } = await instance.poll({ cursor, timeoutS, signal });
        const outcomes = [];
        for (const message of messages) {
          try {
            outcomes.push(await this.handleInbound(id, message));
          } catch (error) {
            this.log("[gateway] " + id + " message failed: " + error.message);
            outcomes.push({ action: "error", error: error.message });
          }
        }
        this.state.update((state) => {
          state.cursors[id] = next ?? cursor;
        });
        report.push({ channel: id, received: messages.length, outcomes });
      } catch (error) {
        report.push({ channel: id, error: error.message });
      } finally {
        lock.release();
      }
    }
    const announced = await this.announcePending().catch(() => 0);
    const flushed = await this.flushOutbox().catch(() => 0);
    return { channels: report, announced, flushed };
  }

  /**
   * Webhook entry point (the gateway listener calls it after verifying the
   * request). Messages are handled in order, in the background.
   */
  ingest(channelId, messages) {
    let chain = Promise.resolve();
    for (const message of messages ?? []) {
      chain = chain.then(() => this.handleInbound(channelId, message)).catch((error) => this.log("[gateway] " + channelId + " webhook message failed: " + error.message));
    }
    return chain;
  }

  // -------------------------------------------------------------- events

  /**
   * Live mode (the daemon service): approvals requested in this process are
   * announced the moment they are created.
   */
  subscribe() {
    if (this.subscribed || !this.eventBus) {
      return;
    }
    this.subscribed = true;
    this.eventBus.on("approval.requested", (event) => {
      if (this.live && event.payload?.id) {
        this.promptApproval(event.payload.id).catch((error) => this.log("[gateway] prompt failed: " + error.message));
      }
    });
    this.eventBus.on("runner.awaiting-approval", (event) => {
      if (!this.live) {
        return;
      }
      for (const id of approvalIdsOf(event.payload)) {
        this.promptApproval(id).catch((error) => this.log("[gateway] prompt failed: " + error.message));
      }
    });
  }

  // -------------------------------------------------------------- status

  status() {
    const settings = this.settings();
    const state = this.state.read();
    const channels = {};
    for (const id of new Set([...Object.keys(channelTypes).filter((key) => key !== "cli"), ...this.enabledChannels()])) {
      let configured = { ok: false, missing: [] };
      try {
        configured = this.channel(id).configured();
      } catch (error) {
        configured = { ok: false, missing: [error.message] };
      }
      channels[id] = {
        enabled: this.enabledChannels().includes(id),
        configured: configured.ok,
        missing: configured.missing,
        owners: this.owners(id).length,
        groups: this.groups(id).length,
        cursor: state.cursors[id] ?? null,
        ignored: state.ignored[id] ?? 0
      };
    }
    return {
      enabled: settings.enabled === true,
      live: this.live,
      language: settings.language,
      runner: Boolean(this.runtime?.runner?.execute),
      channels,
      openApprovals: this.openPrompts().length,
      outbox: state.outbox.length,
      voice: { model: this.voice().config.model, language: this.voice().config.language, device: this.voice().config.device, enabled: this.voiceSettings().enabled !== false }
    };
  }

  describe() {
    const enabled = this.enabledChannels();
    return enabled.length ? enabled.join(", ") : "no channel enabled (astack gateway status)";
  }
}

/**
 * Approval ids from a runner result or a `runner.awaiting-approval` payload,
 * whatever shape it takes: ids, approval records, or a nested run.
 */
export function approvalIdsOf(payload) {
  const ids = new Set();
  const visit = (value) => {
    if (!value) {
      return;
    }
    if (typeof value === "string" && value.startsWith("AP-")) {
      ids.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === "object") {
      if (typeof value.id === "string" && value.id.startsWith("AP-")) {
        ids.add(value.id);
      }
      visit(value.approvals);
      visit(value.approvalIds);
      visit(value.approvalId);
      visit(value.run);
    }
  };
  visit(payload);
  return [...ids];
}
