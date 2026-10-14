import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryEngine } from "../memory-engine/memory-engine.mjs";
import { SkillCatalog } from "../learning-engine/skill-catalog.mjs";
import { SearchEngine } from "../search-engine/search-engine.mjs";
import { foldCharacters, ftsQuery, normalizeForSearch, queryTerms, searchTokens, zwnjAliases } from "../search-engine/normalize.mjs";
import { isSecretFile, redact } from "../search-engine/redact.mjs";
import { cosine, reciprocalRankFusion } from "../search-engine/embeddings.mjs";
import { sqliteAvailable } from "../search-engine/store.mjs";
import { cleanUserText, parseClaudeSession, parseCodexSession } from "../search-engine/sources/sessions.mjs";
import { createService, parseInterval } from "../search-engine/service.mjs";
import { appendSessionMatches } from "../search-engine/hooks.mjs";

const repoRoot = process.cwd();
const sandboxes = [];
function sandbox(prefix) {
  const path = mkdtempSync(join(tmpdir(), "astack-search-" + prefix + "-"));
  sandboxes.push(path);
  return path;
}
process.on("exit", () => {
  for (const path of sandboxes) {
    rmSync(path, { recursive: true, force: true });
  }
});
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
};

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 10, 9, 0, tick++));
const ZWNJ = "\u200c";

// A fake embedder: concept dimensions, so "automobile" and "car" are close
// while sharing no word. Same interface as OllamaEmbedder.
const CONCEPTS = [
  ["car", "automobile", "vehicle", "خودرو", "ماشین"],
  ["court", "lawsuit", "دادگاه", "دعوا"],
  ["invoice", "payment", "فاکتور", "پرداخت"],
  ["deploy", "release", "server"]
];
function fakeEmbedder({ ok = true } = {}) {
  let calls = 0;
  return {
    model: "fake-embed",
    get calls() {
      return calls;
    },
    async available() {
      return ok ? { ok: true, reason: null } : { ok: false, reason: "fake model offline" };
    },
    async embed(texts) {
      calls += texts.length;
      return texts.map((text) => {
        const tokens = searchTokens(text);
        const vector = new Float32Array(CONCEPTS.length + 1);
        CONCEPTS.forEach((words, index) => {
          vector[index] = tokens.filter((token) => words.includes(token)).length;
        });
        vector[CONCEPTS.length] = 0.05;
        return vector;
      });
    }
  };
}

// ---------------------------------------------------------------- 1. Persian normalization
{
  assert.equal(foldCharacters("علي"), foldCharacters("علی"), "Arabic Yeh folds to Persian Yeh");
  assert.equal(foldCharacters("كتاب"), foldCharacters("کتاب"), "Arabic Kaf folds to Keheh");
  assert.equal(foldCharacters("مصطفى"), foldCharacters("مصطفی"), "Alef Maksura folds to Persian Yeh");
  assert.equal(foldCharacters("۱۴۰۳/۰۷/۲۲"), "1403/07/22", "Persian digits fold to ASCII");
  assert.equal(foldCharacters("١٤٠٣"), "1403", "Arabic-Indic digits fold to ASCII");
  assert.equal(foldCharacters("م\u064fح\u064eم\u064e\u0651د"), "محمد", "harakat are removed");
  assert.equal(foldCharacters("کـــتاب"), "کتاب", "tatweel is removed");
  assert.equal(foldCharacters("ﻻ"), "لا", "presentation forms fold through NFKC");
  assert.equal(foldCharacters("Upgrade"), "upgrade", "Latin is lower-cased");
  assert.deepEqual(searchTokens("پرونده" + ZWNJ + "ها"), ["پرونده", "ها"], "ZWNJ is a word break");
  assert.equal(zwnjAliases("می" + ZWNJ + "خواهم"), "میخواهم", "ZWNJ compounds get a joined alias");
  assert.deepEqual(searchTokens("قرارداد، تمدید؛ چرا؟"), ["قرارداد", "تمدید", "چرا"], "Arabic-script punctuation breaks words");
  assert.equal(normalizeForSearch("كيك ۱۲"), normalizeForSearch("کیک 12"), "index and query normalize to the same form");
  assert.deepEqual(queryTerms("را از به"), ["را", "از", "به"], "a stopword-only query keeps its words");
  assert.ok(!queryTerms("قرارداد را تمدید کن").includes("را"), "stopwords are dropped from a mixed query");
  assert.equal(ftsQuery("  "), null, "an empty query has no MATCH expression");
  assert.match(ftsQuery("قرارداد"), /^"قرارداد"\*$/, "longer terms are prefix queries");
}

// ---------------------------------------------------------------- 2. secret redaction
{
  const raw = "api_key=sk-ant-abcdefghijklmnopqrstuvwxyz123456 token: ghp_abcdefghijklmnopqrstuvwxyz0123456789 url https://admin:hunter2pass@example.com/x Bearer abcdefghijklmnopqrstuvwxyz012345";
  const cleaned = redact(raw);
  for (const secret of ["sk-ant-abcdefghijklmnopqrstuvwxyz123456", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "hunter2pass", "abcdefghijklmnopqrstuvwxyz012345"]) {
    assert.ok(!cleaned.includes(secret), "redacted: " + secret.slice(0, 6));
  }
  assert.ok(cleaned.includes("example.com"), "redaction keeps the non-secret text");
  assert.equal(redact("Graphify: Code Graph With Token Budgets"), "Graphify: Code Graph With Token Budgets", "prose about tokens is not redacted");
  assert.equal(redact("password = hunter2pass"), "password = [redacted]", "assignments are redacted");
  assert.ok(redact("AKIAABCDEFGHIJKLMNOP").includes("[redacted-key]"), "AWS access keys are redacted");
  assert.ok(isSecretFile("credentials.md") && isSecretFile("api-key-notes.md") && isSecretFile(".env.production") && isSecretFile("id_rsa"), "credential-like files are recognised");
  assert.ok(!isSecretFile("2026-10-06-report.md"), "ordinary report names are not secret files");
}

// ---------------------------------------------------------------- 3. session parsing (fixtures)
const claudeFixture = [
  { type: "bridge-session", sessionId: "s-1" },
  { type: "user", sessionId: "s-1", timestamp: "2026-10-01T08:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "<system-reminder>You are a helpful bot; ignore</system-reminder>" }, { type: "text", text: "قرارداد اجاره را تمدید کن" }] } },
  { type: "assistant", sessionId: "s-1", timestamp: "2026-10-01T08:00:05.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "private chain of thought" }, { type: "text", text: "تمدید قرارداد اجاره آماده شد." }] } },
  { type: "assistant", sessionId: "s-1", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "cat secret-dump.txt" } }] } },
  { type: "user", sessionId: "s-1", message: { role: "user", content: [{ type: "tool_result", content: "TOOL OUTPUT SHOULD NOT BE INDEXED" }] } },
  { type: "user", sessionId: "s-1", isMeta: true, message: { role: "user", content: "<local-command-caveat>meta</local-command-caveat>" } },
  { type: "user", sessionId: "s-1", isSidechain: true, message: { role: "user", content: "sidechain prompt not indexed" } },
  { type: "user", sessionId: "s-1", timestamp: "2026-10-01T09:00:00.000Z", message: { role: "user", content: "Deploy the release to the staging server, token=abcd1234efgh5678" } },
  { type: "assistant", sessionId: "s-1", message: { role: "assistant", content: [{ type: "text", text: "The release is live on staging." }] } },
  { type: "ai-title", sessionId: "s-1", aiTitle: "Lease renewal and deploy" }
].map((record) => JSON.stringify(record)).join("\n") + "\nnot json at all\n";
{
  const docs = parseClaudeSession(claudeFixture, { path: "/fake/s-1.jsonl" });
  assert.equal(docs.length, 2, "one document per user turn");
  assert.equal(docs[0].meta.session, "s-1");
  assert.equal(docs[0].date, "2026-10-01T08:00:00.000Z", "turn timestamp kept");
  assert.ok(docs[0].title.startsWith("Lease renewal and deploy"), "the session ai-title labels the turn");
  assert.ok(docs[0].text.includes("قرارداد اجاره") && docs[0].text.includes("آماده شد"), "user and assistant text are indexed");
  const all = docs.map((doc) => doc.text).join("\n");
  for (const excluded of ["helpful bot", "private chain", "secret-dump", "TOOL OUTPUT", "sidechain prompt", "meta"]) {
    assert.ok(!all.includes(excluded), "not indexed: " + excluded);
  }
  assert.ok(!all.includes("abcd1234efgh5678"), "token-like values in turns are redacted");
  assert.equal(cleanUserText("<command-name>/clear</command-name>"), "", "slash-command wrappers are not owner text");
  assert.equal(cleanUserText("# Context from my IDE setup:\n\n## Open tabs:\n- a.md: a.md\n\n## My request for Codex:\nFix the guide"), "Fix the guide", "Codex IDE context keeps only the request");

  const codex = [
    { type: "session_meta", timestamp: "2026-10-02T10:00:00.000Z", payload: { id: "codex-1", cwd: "/work/project" } },
    { type: "response_item", timestamp: "2026-10-02T10:00:01.000Z", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "developer instructions" }] } },
    { type: "response_item", timestamp: "2026-10-02T10:00:02.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
    { type: "response_item", timestamp: "2026-10-02T10:00:03.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the invoice export" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Invoice export fixed." }] } }
  ].map((record) => JSON.stringify(record)).join("\n");
  const codexDocs = parseCodexSession(codex, { path: "/fake/rollout.jsonl" });
  assert.equal(codexDocs.length, 1, "Codex: one turn, injected context and developer text skipped");
  assert.equal(codexDocs[0].meta.session, "codex-1");
  assert.ok(codexDocs[0].text.includes("Invoice export fixed."), "Codex assistant text is indexed");
}

// ---------------------------------------------------------------- 4. RRF and cosine
{
  const fused = reciprocalRankFusion([["a", "b", "c"], ["c", "a"]]);
  assert.equal(fused[0].key, "a", "an item ranked high in both lists wins");
  assert.equal(fused.find((entry) => entry.key === "b").ranks[1], undefined, "missing ranks stay empty");
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9 && Math.abs(cosine([1, 0], [0, 1])) < 1e-9, "cosine similarity");
}

// ---------------------------------------------------------------- 5. engine, for each backend
function workspace(label) {
  const root = sandbox(label);
  const home = join(root, "home");
  const memory = new MemoryEngine(root, { clock });
  const skills = new SkillCatalog(repoRoot, { workspaceRoot: root });
  write(join(root, "documentation", "Leases.md"), [
    "# Lease handbook",
    "",
    "## Renewal",
    "",
    "قرارداد اجاره هر سال در تاریخ ۱۴۰۳/۰۷/۰۱ تمدید می" + ZWNJ + "شود. کارفرما مي" + ZWNJ + "خواهد پیش" + ZWNJ + "پرداخت را زودتر بگیرد.",
    "",
    "## Deposits",
    "",
    "The deposit is returned after the final inspection."
  ].join("\n"));
  write(join(root, "documentation", "Deploy.md"), "# Deploy runbook\n\nDeploy deploy deploy: the release pipeline pushes to the server.\n\nSecret note: password=Sup3rS3cretValue!\n");
  write(join(root, "documentation", "credentials.md"), "# Credentials\n\nroot password is hunter2-should-never-be-read\n");
  write(join(root, "memory", "notes.md"), "# Notes\n\nThe court hearing moved to next month.\n");
  // Claude Code transcripts for this workspace, plus one for another project.
  const slug = root.replace(/[^a-zA-Z0-9]/g, "-");
  write(join(home, ".claude", "projects", slug, "s-1.jsonl"), claudeFixture);
  write(join(home, ".claude", "projects", "other-project", "x.jsonl"), claudeFixture.replace(/s-1/g, "x-9").replace("Lease renewal", "Foreign session"));
  write(join(home, ".codex", "sessions", "2026", "10", "02", "rollout-a.jsonl"), [
    { type: "session_meta", payload: { id: "codex-here", cwd: root } },
    { type: "response_item", timestamp: "2026-10-02T10:00:03.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the invoice export" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Invoice export fixed." }] } }
  ].map((record) => JSON.stringify(record)).join("\n"));
  write(join(home, ".codex", "sessions", "2026", "10", "02", "rollout-b.jsonl"), [
    { type: "session_meta", payload: { id: "codex-elsewhere", cwd: join(root, "..", "elsewhere") } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Invoice from another project" }] } }
  ].map((record) => JSON.stringify(record)).join("\n"));
  return { root, home, memory, skills };
}

const backends = sqliteAvailable() ? ["sqlite", "json"] : ["json"];
if (!sqliteAvailable()) {
  console.log("note: node:sqlite unavailable on Node " + process.versions.node + "; testing the JSON fallback only");
}

for (const backend of backends) {
  const label = "[" + backend + "] ";
  const { root, home, memory, skills } = workspace(backend);
  const embedder = fakeEmbedder();
  const engine = new SearchEngine(root, { memory, skills, memoryConfig: { import_paths: ["memory"] }, clock, home, embedder, backend: backend === "json" ? "json" : null });
  assert.equal(engine.backend(), backend, label + "backend selected");
  if (backend === "json") {
    assert.match(engine.fallbackReason(), /json/, label + "the fallback says why");
  } else {
    assert.equal(engine.fallbackReason(), null, label + "no fallback message on sqlite");
  }

  // Before any index: graceful, empty, and the hook stays silent.
  const empty = await engine.query("قرارداد");
  assert.equal(empty.indexed, false, label + "no index yet");
  assert.deepEqual(empty.results, [], label + "no results without an index");
  const silent = [];
  assert.deepEqual(appendSessionMatches({ runtime: { search: engine }, query: "قرارداد", out: (line) => silent.push(line), t: (key) => key }), [], label + "hook is silent without an index");
  assert.equal(silent.length, 0, label + "hook printed nothing");

  // Memory: a fact, its correction, a forgotten record and a secret.
  const original = memory.remember("decision", { title: "Hosting provider is Alpha", body: "We host the API on Alpha cloud." });
  const replaced = memory.facets.supersede(original.id, { title: "Hosting provider is Beta", body: "We moved the API hosting to Beta cloud." });
  const forgotten = memory.remember("semantic", { title: "Hosting rumour", body: "Gamma hosting was discussed once." });
  memory.forget(forgotten.id);
  memory.remember("identity", { title: "Owner prefers Persian replies", body: "پاسخ\u200cها همیشه به فارسی ساده", importance: 0.9 });
  memory.remember("preference", { title: "No tables in WhatsApp output", body: "One item per line.", importance: 0.8 });
  memory.remember("semantic", { title: "Payment gateway key", body: "api_key=sk-live-ABCDEFGHIJKLMNOPQRSTUV123456 for the gateway" });

  const first = await engine.index({});
  assert.ok(first.sources.reports.docs >= 4, label + "reports indexed by section");
  assert.equal(first.sources.memory.docs, 5, label + "memory records indexed (forgotten one excluded)");
  assert.equal(first.sources.sessions.docs, 3, label + "this workspace's Claude turns and matching Codex turn only");
  assert.ok(first.sources.skills.docs > 0, label + "skill catalog indexed");
  assert.equal(first.semantic.used, true, label + "fake embedder used during index");
  assert.ok(first.embedded > 0, label + "vectors stored");

  // Persian variants all find the same report section.
  for (const variant of ["قرارداد اجاره", "قرارداد", "تمديد", "می" + ZWNJ + "خواهد", "میخواهد", "مي" + ZWNJ + "خواهد", "پیشپرداخت", "1403/07/01", "۱۴۰۳"]) {
    const result = await engine.query(variant, { sources: ["reports"], semantic: "off" });
    assert.ok(result.results.some((hit) => hit.title.includes("Renewal")), label + "Persian variant finds the section: " + variant);
  }

  // FTS ranking: the document dense in the term ranks first; scores descend.
  const deploy = await engine.query("deploy", { sources: ["reports"], semantic: "off" });
  assert.equal(deploy.results[0].path, "documentation/Deploy.md", label + "BM25 ranks the deploy runbook first");
  for (let index = 1; index < deploy.results.length; index += 1) {
    assert.ok(deploy.results[index - 1].score >= deploy.results[index].score, label + "scores are sorted");
  }
  assert.ok(deploy.results[0].snippet.length > 0, label + "results carry a snippet");

  // Secrets never reach the index.
  const secretFile = await engine.query("hunter2", { sources: ["reports"], semantic: "off" });
  assert.equal(secretFile.results.length, 0, label + "credential-named files are never indexed");
  const status = engine.status();
  const raw = readFileSync(engine.indexPath()).toString("utf8");
  for (const secret of ["Sup3rS3cretValue", "sk-live-ABCDEFGHIJKLMNOPQRSTUV123456", "hunter2-should-never-be-read", "abcd1234efgh5678"]) {
    assert.ok(!raw.includes(secret), label + "secret absent from the index file: " + secret.slice(0, 8));
  }
  assert.ok(status.exists && status.docs > 0, label + "status reports docs");

  // Superseded memory is excluded by default, visible with history flags.
  const hosting = await engine.query("hosting provider", { sources: ["memory"], semantic: "off" });
  const titles = hosting.results.map((hit) => hit.title);
  assert.ok(titles.includes("Hosting provider is Beta"), label + "the current fact is found");
  assert.ok(!titles.includes("Hosting provider is Alpha"), label + "the superseded fact is excluded by default");
  assert.ok(!titles.includes("Hosting rumour"), label + "a forgotten (retired) record is never indexed");
  const history = await engine.query("hosting provider", { sources: ["memory"], semantic: "off", includeSuperseded: true });
  assert.ok(history.results.some((hit) => hit.title === "Hosting provider is Alpha" && hit.status === "superseded"), label + "--include-superseded shows history");
  const asOf = new Date(new Date(original.at).getTime() + 100).toISOString();
  assert.ok(asOf < replaced.replacement.at, label + "asOf sits between the fact and its correction");
  const then = await engine.query("hosting provider", { sources: ["memory"], semantic: "off", asOf });
  assert.deepEqual(then.results.map((hit) => hit.title), ["Hosting provider is Alpha"], label + "asOf answers what was believed then");

  // A long section split into chunks comes back once.
  write(join(root, "documentation", "Long.md"), "# Long\n\n## Archive policy\n\n" + Array.from({ length: 60 }, (_, index) => "Archive retention line " + index + " keeps the ledger for seven years.").join("\n\n"));
  await engine.index({ sources: ["reports"] });
  const archive = await engine.query("archive retention ledger", { sources: ["reports"], semantic: "off" });
  assert.equal(archive.results.filter((hit) => hit.path === "documentation/Long.md").length, 1, label + "chunks of one section collapse into one result");

  // Sessions: only this workspace.
  const sessions = await engine.query("invoice", { sources: ["sessions"], semantic: "off" });
  assert.equal(sessions.results.length, 1, label + "the other project's Codex session is not indexed");
  assert.equal(sessions.results[0].meta.session, "codex-here");
  const foreign = await engine.query("Foreign session", { sources: ["sessions"], semantic: "off" });
  assert.equal(foreign.results.length, 0, label + "another project's Claude transcripts are not indexed");

  // Hybrid ranking: "automobile" shares no word with the car note; vectors bridge it.
  memory.remember("semantic", { title: "Company car", body: "The car lease ends in spring." });
  await engine.index({ sources: ["memory"] });
  const lexicalOnly = await engine.query("automobile", { sources: ["memory"], semantic: "off" });
  assert.equal(lexicalOnly.results.length, 0, label + "lexical search alone misses the synonym");
  const hybrid = await engine.query("automobile", { sources: ["memory"], semantic: "auto" });
  assert.equal(hybrid.semantic.used, true, label + "auto uses the available embedder");
  assert.equal(hybrid.results[0]?.title, "Company car", label + "the vector layer finds the synonym");
  assert.equal(hybrid.results[0].lexicalRank, null, label + "the hit came from the vector list");
  const both = await engine.query("car lease", { sources: ["memory"], semantic: "on" });
  assert.equal(both.results[0].title, "Company car", label + "a hit in both lists wins the fusion");
  assert.ok(both.results[0].lexicalRank && both.results[0].vectorRank, label + "fused result carries both ranks");
  const offline = new SearchEngine(root, { memory, skills, clock, home, embedder: fakeEmbedder({ ok: false }), backend: backend === "json" ? "json" : null });
  const degraded = await offline.query("car lease", { sources: ["memory"], semantic: "auto" });
  assert.equal(degraded.semantic.used, false, label + "auto degrades to lexical when the model is missing");
  assert.match(degraded.semantic.reason, /offline/, label + "the reason is reported");
  assert.equal(degraded.results[0].title, "Company car", label + "lexical results still come back");

  // Incremental reindex: unchanged → nothing re-read; edit → one unit; delete → removed.
  const before = embedder.calls;
  const second = await engine.index({});
  for (const [id, entry] of Object.entries(second.sources)) {
    assert.equal(entry.indexed, 0, label + "nothing reindexed on an unchanged workspace: " + id);
  }
  assert.equal(embedder.calls, before, label + "no re-embedding on an unchanged workspace");
  const deployPath = join(root, "documentation", "Deploy.md");
  write(deployPath, "# Deploy runbook\n\nRollback procedure: revert the release tag.\n");
  const future = new Date(Date.now() + 5000);
  utimesSync(deployPath, future, future);
  const third = await engine.index({ sources: ["reports"] });
  assert.equal(third.sources.reports.indexed, 1, label + "only the edited file is reindexed");
  assert.equal((await engine.query("rollback", { sources: ["reports"], semantic: "off" })).results[0]?.path, "documentation/Deploy.md", label + "the edit is searchable");
  const touched = join(root, "documentation", "Leases.md");
  const later = new Date(Date.now() + 10000);
  utimesSync(touched, later, later);
  const fourth = await engine.index({ sources: ["reports"] });
  assert.equal(fourth.sources.reports.indexed, 0, label + "a touched but unchanged file is not reindexed (hash check)");
  unlinkSync(deployPath);
  const fifth = await engine.index({ sources: ["reports"] });
  assert.equal(fifth.sources.reports.removed, 1, label + "a deleted file leaves the index");
  assert.equal((await engine.query("rollback", { sources: ["reports"], semantic: "off" })).results.length, 0, label + "deleted content is gone");
  const forced = await engine.index({ sources: ["skills"], force: true });
  assert.equal(forced.sources.skills.indexed, 1, label + "--force rebuilds");

  // Token budget: a tiny budget keeps the first result and reports the rest.
  const budgeted = await engine.query("قرارداد deploy invoice car hosting", { semantic: "off", budget: 10, k: 10 });
  assert.equal(budgeted.results.length, 1, label + "budget limits rendered results");
  assert.ok(budgeted.omitted >= 1, label + "omitted results are counted");

  // Hook output once the index exists.
  const printed = [];
  const hits = appendSessionMatches({ runtime: { search: engine }, query: "قرارداد اجاره", out: (line) => printed.push(line), t: (key, vars) => key + ":" + vars.count });
  assert.equal(hits.length, 1, label + "hook finds the past session");
  assert.equal(printed[0], "cli.search.alsoFound:1", label + "hook prints a heading");
  assert.equal(appendSessionMatches({ runtime: { search: engine }, query: "قرارداد اجاره", out: () => {}, t: (key) => key, flags: { noSessions: true } }).length, 0, label + "--no-sessions disables the hook");

  // Owner profile: deterministic, from memory and sessions.
  const profile = await engine.ownerProfile({ budget: 600 });
  assert.match(profile.text, /Owner prefers Persian replies/, label + "identity memories in the profile");
  assert.match(profile.text, /No tables in WhatsApp output/, label + "preferences in the profile");
  assert.match(profile.text, /Hosting provider is Beta/, label + "current decisions in the profile");
  assert.ok(!profile.text.includes("Hosting provider is Alpha"), label + "superseded decisions stay out of the profile");
  assert.match(profile.text, /Lease renewal and deploy/, label + "recent sessions in the profile");
  assert.ok(profile.tokens <= 650, label + "profile respects its budget");
  const summarised = await engine.ownerProfile({ summarise: true, runner: { execute: async () => ({ status: "completed", summary: "- Prefers Persian." }) }, save: false });
  assert.match(summarised.text, /Prefers Persian/, label + "an optional runner summary is added");
  const noRunner = await engine.ownerProfile({ summarise: true, save: false });
  assert.match(noRunner.summaryError, /runner/, label + "summarise without a runner explains itself");
}

// ---------------------------------------------------------------- 6. daemon service contract
{
  assert.equal(parseInterval("15m"), 900000);
  assert.equal(parseInterval("90s"), 90000);
  assert.equal(parseInterval("1h"), 3600000);
  assert.equal(parseInterval("nonsense", 1234), 1234);
  let runs = 0;
  const runtime = { search: { index: async () => { runs += 1; return { durationMs: 1, embedded: 0, sources: { memory: { indexed: 2 } } }; } } };
  const service = createService({ runtime, config: { reindex_every: "1h", reindex_on_start: false }, log: () => {} });
  assert.equal(service.name, "search");
  await service.start();
  assert.equal(service.status().active, true, "service starts its timer");
  await service.tick();
  assert.equal(runs, 1, "a tick runs an incremental index");
  assert.equal(service.status().lastReport.indexed, 2);
  await service.stop();
  assert.equal(service.status().active, false, "service stops");
  const disabled = createService({ runtime, config: { enabled: false } });
  await disabled.start();
  assert.equal(disabled.status().active, false, "a disabled service does not start");
}

// ---------------------------------------------------------------- 7. runtime wiring (contract)
{
  const { createRuntime } = await import("../runtime/astack-runtime.mjs");
  const runtime = createRuntime();
  assert.equal(typeof runtime.search.query, "function", "runtime.search.query");
  assert.equal(typeof runtime.search.index, "function", "runtime.search.index");
  assert.equal(typeof runtime.search.status, "function", "runtime.search.status");
  const status = runtime.search.status();
  assert.ok(["sqlite", "json"].includes(status.backend), "status names its backend");
  assert.equal(typeof status.exists, "boolean", "status says whether the index exists");
}

console.log("AStack search verification passed (" + backends.join(" + ") + ").");
