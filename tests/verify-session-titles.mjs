import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionTitles, titleTokens, claudeSlug, projectHasPromptHook, projectTitleConfig, remoteLocalId } from "../interop-engine/session-titles.mjs";
import { InteropEngine } from "../interop-engine/interop-engine.mjs";
import { mcpTools } from "../interop-engine/mcp-server.mjs";
import { runSessionCommand } from "../cli/session-cli.mjs";

// ------------------------------------------------------------- sandbox
const sandboxes = [];
function sandbox(prefix) {
  const directory = mkdtempSync(join(tmpdir(), "astack-titles-" + prefix + "-"));
  sandboxes.push(directory);
  return directory;
}
process.on("exit", () => {
  for (const directory of sandboxes) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const home = sandbox("home");
const projects = join(home, ".claude", "projects");
const projectRoot = "C:\\Projects\\lawyer";
const slug = claudeSlug(projectRoot);
let now = new Date("2026-10-17T08:00:00Z");
const clock = () => now;

function line(record) {
  return JSON.stringify(record) + "\n";
}
function user(text, at = "2026-10-01T10:00:00.000Z") {
  return line({ type: "user", message: { role: "user", content: text }, timestamp: at });
}
function answer(text) {
  return line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, timestamp: "2026-10-01T10:01:00.000Z" });
}
function session(id, records, { folder = slug } = {}) {
  const path = join(projects, folder, id + ".jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.join(""));
  const old = new Date("2026-10-01T10:05:00Z");
  utimesSync(path, old, old);
  return path;
}

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const C = "cccccccc-3333-4333-8333-333333333333";
const D = "dddddddd-4444-4444-8444-444444444444";
const fileA = session(A, [
  user("<system-reminder>ignore me</system-reminder>پرونده بخیته رو چک کن ببین تنفیذ شده؟"),
  answer("بررسی کردم."),
  user("<task-notification><task-id>x</task-id></task-notification>"),
  line({ type: "ai-title", aiTitle: "Bakhiteh case check", sessionId: A }),
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "tool output" }] } }),
  line({ bridgeSessionId: "cse_01AAAAAAAAAAAAAAAAAAAAAA", type: "system" }),
  answer("پرونده 1317/2018 بخیته در مرحلهٔ اجراست.")
]);
const fileB = session(B, [user("قرارداد جلیلی"), line({ type: "custom-title", customTitle: "جلیلی · دست مالک", sessionId: B })]);
const fileC = session(C, [user("یه سوال کوتاه")]);
session(D, [user("سرور رو چک کن")], { folder: "C--Projects-sysadmin" });

const titles = new SessionTitles({ home, projectRoot, clock, cli: "/core/bin/astack.mjs", fetchImpl: async () => ({ status: 500 }) });

// ------------------------------------------------------------- settings
{
  const settings = SessionTitles.settings({ first_after_turns: "x", recheck_turns: "40, 12", max_length: 500, enabled: "false", sync_remote: false });
  assert.equal(settings.first_after_turns, 3, "a bad number falls back to the default");
  assert.deepEqual(settings.recheck_turns, [12, 40], "re-check turns are numbers, sorted");
  assert.equal(settings.max_length, 120, "max_length is capped");
  assert.equal(settings.enabled, false);
  assert.equal(settings.sync_remote, false);
}

// ------------------------------------------------------------- reading
{
  const list = titles.sessions();
  assert.deepEqual(list.map((entry) => entry.id).sort(), [A, B, C], "only the current project by default");
  assert.equal(titles.sessions({ all: true }).length, 4);
  const a = list.find((entry) => entry.id === A);
  assert.equal(a.source, "ai");
  assert.equal(a.title, "Bakhiteh case check");
  assert.equal(a.turns, 1, "tool results, notifications and system blocks are not owner prompts");
  assert.equal(a.prompts[0], "پرونده بخیته رو چک کن ببین تنفیذ شده؟");
  assert.equal(list.find((entry) => entry.id === B).source, "owner", "a custom title AStack did not write is the owner's");
  assert.equal(list.find((entry) => entry.id === C).source, "none");
  assert.deepEqual(titles.sessions({ weak: true }).map((entry) => entry.id).sort(), [A, C]);
  const digest = titles.digest({ weak: true }).find((entry) => entry.id === A);
  assert.match(digest.outcome, /1317\/2018/);
  assert.equal(digest.first, "پرونده بخیته رو چک کن ببین تنفیذ شده؟");
  assert.throws(() => titles.resolve("--all"), /Invalid session id/);
  assert.throws(() => titles.resolve("eeeeeeee"), /not found/);
}

// ------------------------------------------------------------- writing
{
  const before = statSync(fileA).mtimeMs;
  const result = titles.setTitle("aaaaaaaa", "بخیته · اجرایی 1317/2018 · پیگیری تنفیذ", { runtime: "claude-code" });
  assert.equal(result.status, "renamed");
  assert.equal(statSync(fileA).mtimeMs, before, "renaming keeps the transcript's dates");
  const last = readFileSync(fileA, "utf8").trim().split("\n").at(-1);
  assert.deepEqual(JSON.parse(last), { type: "custom-title", sessionId: A, customTitle: "بخیته · اجرایی 1317/2018 · پیگیری تنفیذ" });
  assert.equal(titles.sessions().find((entry) => entry.id === A).source, "astack");
  assert.equal(titles.setTitle(A, "بخیته · اجرایی 1317/2018 · پیگیری تنفیذ").status, "unchanged");

  assert.equal(titles.setTitle(B, "جلیلی · توافق‌نامه").status, "kept-owner", "the owner's title is never replaced without force");
  assert.equal(titles.setTitle(B, "جلیلی · توافق‌نامه", { dryRun: true, force: true }).status, "would-rename");
  assert.throws(() => titles.setTitle(C, "x".repeat(61)), /at most 60/);
  assert.throws(() => titles.setTitle(C, "ab"), /at least 3/);
  assert.throws(() => titles.setTitle(C, "line\nbreak here"), /one line/);
  assert.throws(() => titles.setTitle(C, "token=sk-abcdef123456 test"), /password, token/);

  const batch = titles.apply([{ id: "cccccccc", title: "سوال کوتاه · وکیل" }, { id: B, title: "نه" }, { id: "zz", title: "x y z" }]);
  assert.equal(batch.results[0].status, "renamed");
  assert.equal(batch.results[1].status, "error", "a short title is refused per entry");
  assert.equal(batch.results[2].status, "error");
  assert.ok(batch.batch);
  const undone = titles.undo({ batch: batch.batch });
  assert.equal(undone.results[0].status, "skipped", "an untitled session has no earlier title to restore");
  const undoA = titles.undo({ session: "aaaaaaaa" });
  assert.equal(undoA.results[0].status, "restored");
  assert.equal(titles.sessions().find((entry) => entry.id === A).title, "Bakhiteh case check");
  titles.setTitle(A, "بخیته · اجرایی 1317/2018 · پیگیری تنفیذ");
}

// ------------------------------------------------------------- finding
{
  assert.deepEqual(titleTokens("پرونده ۱۳۱۷ بخيته را"), ["پرونده", "1317", "بخیته"], "Persian digits and Arabic letters are normalised, stopwords dropped");
  const hits = titles.find("وضعیت پرونده بخیته");
  assert.equal(hits[0].id, A);
  assert.ok(hits[0].subjectHit, "the client or case name is the subject of the title");
  assert.deepEqual(titles.find("کلمه بی‌ربط"), []);
  assert.equal(titles.find("سرور").length, 0, "other projects are not searched by default");
  assert.equal(titles.find("سرور", { all: true }).length, 0, "an untitled chat matches only through its title");
}

// ------------------------------------------------------------- watching
{
  const N = "ffffffff-5555-4555-8555-555555555555";
  const fileN = session(N, [user("پرونده بخیته را دوباره بررسی کن")]);
  const hook = (prompt) => titles.promptHook({ session_id: N, transcript_path: fileN, prompt });
  const first = hook("پرونده بخیته را دوباره بررسی کن");
  assert.match(first, /Earlier chats in this project/);
  assert.match(first, /بخیته · اجرایی 1317\/2018/);
  assert.doesNotMatch(first, /Session title due/, "no title is asked on the first prompt");
  assert.equal(hook("ادامه"), null);
  const due = hook("ادامه بده");
  assert.match(due, /Session title due/);
  assert.match(due, /session=ffffffff-5555/);
  assert.match(due, /\/core\/bin\/astack\.mjs" session title --session=ffffffff-5555-4555-8555-555555555555 --/);
  assert.match(due, /Legal work: the party or case label first/);
  assert.equal(hook("4"), null, "a nudge is not repeated at once");
  assert.equal(hook("5"), null);
  assert.match(hook("6"), /Session title due/, "repeated after retry_after_turns");
  hook("7"); hook("8");
  assert.match(hook("9"), /Session title due/);
  for (let turn = 10; turn < 20; turn += 1) {
    assert.equal(hook(String(turn)), null, "at most max_nudges reminders per step");
  }

  const M = "abcdefab-6666-4666-8666-666666666666";
  const fileM = session(M, [user("سلام")]);
  const hookM = (prompt) => titles.promptHook({ session_id: M, transcript_path: fileM, prompt });
  hookM("سلام"); hookM("دو");
  assert.match(hookM("سه"), /Session title due/);
  titles.setTitle(M, "مرکز · آزمون نام‌گذاری");
  for (let turn = 4; turn < 12; turn += 1) {
    assert.equal(hookM(String(turn)), null, "quiet after the title is set");
  }
  assert.match(hookM("12"), /Session title check/, "re-checked at the configured turn");

  const O = "abcdefab-7777-4777-8777-777777777777";
  const fileO = session(O, [user("سلام"), line({ type: "custom-title", customTitle: "عنوان مالک", sessionId: O })]);
  for (let turn = 1; turn < 15; turn += 1) {
    assert.equal(titles.promptHook({ session_id: O, transcript_path: fileO, prompt: "x" + turn }), null, "the owner's title is never questioned");
  }
  assert.equal(titles.promptHook({ session_id: "--bad", transcript_path: fileO }), null);
  assert.equal(titles.promptHook({ session_id: O, transcript_path: join(home, "missing.jsonl") }), null);

  const off = new SessionTitles({ home, projectRoot, clock, config: { enabled: false } });
  assert.equal(off.promptHook({ session_id: N, transcript_path: fileN, prompt: "x" }), null);

  // time-based first title
  const T = "abcdefab-8888-4888-8888-888888888888";
  const fileT = session(T, [user("کار طولانی")]);
  titles.promptHook({ session_id: T, transcript_path: fileT, prompt: "کار طولانی" });
  now = new Date(now.getTime() + 20 * 60000);
  assert.match(titles.promptHook({ session_id: T, transcript_path: fileT, prompt: "ادامه" }), /Session title due/, "due after first_after_minutes");
}

// ------------------------------------------------------------- remote copies
{
  const calls = [];
  // PUTs are recorded; the session list (GET) is empty here.
  const fakeFetch = async (url, options) => {
    if (options.method === "GET") {
      return { status: 200, json: async () => ({ data: [], next_cursor: null }) };
    }
    calls.push({ url, options });
    return { status: 200 };
  };
  const credentials = join(home, ".claude", ".credentials.json");
  const remote = new SessionTitles({ home, projectRoot, clock, fetchImpl: fakeFetch, apiBase: "https://api.test" });
  let result = await remote.pushRemote(fileA, "عنوان");
  assert.equal(result.pushed, 0);
  assert.match(result.reason, /no Claude Code sign-in/);
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "tok-123", expiresAt: now.getTime() - 1000 } }));
  result = await remote.pushRemote(fileA, "عنوان");
  assert.match(result.reason, /expired/);
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "tok-123", expiresAt: now.getTime() + 3600000 } }));
  result = await remote.pushRemote(fileA, "عنوان");
  assert.equal(result.pushed, 1);
  assert.equal(calls[0].url, "https://api.test/v1/code/sessions/cse_01AAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(calls[0].options.headers.Authorization, "Bearer tok-123");
  assert.deepEqual(JSON.parse(calls[0].options.body), { title: "عنوان" });
  assert.equal((await remote.pushRemote(fileC, "x y z")).reason, "local only");
  const noSync = new SessionTitles({ home, projectRoot, clock, fetchImpl: fakeFetch, config: { sync_remote: false } });
  assert.equal((await noSync.pushRemote(fileA, "عنوان")).pushed, 0);

  calls.length = 0;
  const totals = await remote.syncRemote();
  assert.equal(totals.pushed, 1, "sync pushes the latest AStack title of chats with a Remote Control copy");
  assert.equal(JSON.parse(calls[0].options.body).title, "بخیته · اجرایی 1317/2018 · پیگیری تنفیذ");
  appendFileSync(fileA, line({ type: "custom-title", customTitle: "عنوان تازهٔ مالک", sessionId: A }));
  calls.length = 0;
  await remote.syncRemote();
  assert.equal(calls.length, 0, "a title the owner changed since is not overwritten on the phone");
}

// ------------------------------------------------------------- CLI
{
  const output = [];
  const original = console.log;
  console.log = (text) => output.push(String(text));
  try {
    await runSessionCommand({ runtime: { sessionTitles: titles }, i18n: { t: (key, values) => key + (values ? " " + JSON.stringify(values) : "") }, tokens: ["title", "--session=cccccccc", "--", "--all", "is", "a", "title"] });
  } finally {
    console.log = original;
  }
  assert.match(output[0], /cli\.session\.renamed/);
  assert.equal(titles.sessions().find((entry) => entry.id === C).title, "--all is a title", "free text after -- stays text");
  await assert.rejects(() => runSessionCommand({ runtime: { sessionTitles: titles }, i18n: { t: (key) => key }, tokens: ["title", "--", "x y z"] }), /cli\.session\.titleUsage/);
  await assert.rejects(() => runSessionCommand({ runtime: { sessionTitles: titles }, i18n: { t: (key) => key }, tokens: ["nope"] }), /cli\.session\.unknownAction/);
}

// ------------------------------------------------------------- MCP
{
  const set = mcpTools.find((tool) => tool.name === "astack_session_title");
  const find = mcpTools.find((tool) => tool.name === "astack_session_find");
  assert.equal(set.validate({ session: "aaaaaaaa", title: "بخیته · پیگیری" }), null);
  assert.match(set.validate({ session: "--force", title: "x y z" }), /Invalid session/);
  assert.match(set.validate({ session: "aaaaaaaa", title: "a\nb c" }), /one line/);
  assert.deepEqual(set.args({ session: "aaaaaaaa", title: "--force" }, "codex"), ["session", "title", "--session=aaaaaaaa", "--runtime=codex", "--", "--force"]);
  assert.match(find.validate({ query: "" }), /query/);
  assert.deepEqual(find.args({ query: "--all", all: true }), ["session", "find", "--all", "--", "--all"]);
}

// ------------------------------------------------------------- wiring
{
  const workspace = sandbox("workspace");
  const interop = new InteropEngine(workspace, { home: sandbox("interop-home"), env: {} });
  const settings = interop.plannedClaudeSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node .claude/hooks/owner.mjs" }] }] } });
  assert.equal(settings.hooks.UserPromptSubmit.length, 2, "the owner's prompt hook is kept beside AStack's");
  assert.match(settings.hooks.UserPromptSubmit[1].hooks[0].command, /interop hook prompt --runtime claude-code/);
  const again = interop.plannedClaudeSettings(settings);
  assert.equal(again.hooks.UserPromptSubmit.length, 2, "never duplicated");
  interop.sessionTitles = new SessionTitles({ home, projectRoot, config: { enabled: false } });
  const disabled = interop.plannedClaudeSettings(again);
  assert.equal(disabled.hooks.UserPromptSubmit.length, 1, "disabling removes only AStack's prompt hook");
  assert.equal(interop.promptSubmit({ payload: {} }), null);
  interop.sessionTitles = titles;
  const N = "ffffffff-5555-4555-8555-555555555555";
  const output = interop.promptSubmit({ payload: { session_id: A, transcript_path: fileA, prompt: "x" } });
  assert.ok(output === null || output.hookSpecificOutput.hookEventName === "UserPromptSubmit");
  assert.ok(N);
}

// ------------------------------------------------------------- review findings (3.6.0)
{
  const reviewHome = sandbox("review-home");
  const reviewProjects = join(reviewHome, ".claude", "projects", slug);
  mkdirSync(reviewProjects, { recursive: true });
  const make = (id, records) => {
    const path = join(reviewProjects, id + ".jsonl");
    writeFileSync(path, records.join(""));
    return path;
  };
  const engine = new SessionTitles({ home: reviewHome, projectRoot, clock });
  const P = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const Q = "11111112-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const fileP = make(P, [user("مالیات"), line({ type: "ai-title", aiTitle: "auto t", sessionId: P })]);
  make(Q, [user("دیگری"), line({ type: "ai-title", aiTitle: "auto q", sessionId: Q })]);

  // 1. undo never overwrites a title the owner set after AStack's
  engine.setTitle(P, "مالیات · اظهارنامه اول");
  appendFileSync(fileP, line({ type: "custom-title", customTitle: "OWNER HAND TITLE", sessionId: P }));
  const undone = engine.undo({ session: P });
  assert.equal(undone.results[0].status, "skipped");
  assert.match(undone.results[0].reason, /renamed since/);
  assert.equal(engine.sessions().find((entry) => entry.id === P).title, "OWNER HAND TITLE");

  // 2. force + undo gives the owner's title back as the owner's
  engine.setTitle(P, "مالیات · با اجازه مالک", { force: true });
  engine.undo({ session: P });
  const restored = engine.sessions().find((entry) => entry.id === P);
  assert.equal(restored.title, "OWNER HAND TITLE");
  assert.equal(restored.source, "owner", "a restored owner title is the owner's again");
  assert.equal(engine.setTitle(P, "مالیات · دوباره").status, "kept-owner");

  // 3. undo and sync take only a full, unique session reference
  assert.throws(() => engine.undo({ session: "1" }), /Invalid session id/);
  assert.throws(() => engine.undo({ session: "1111111" }), /Invalid session id/);
  assert.throws(() => engine.undo({ session: "1111111-" }), /ambiguous|not found/);
  await assert.rejects(() => engine.syncRemote({ session: "1" }), /Invalid session id/);

  // 4. one reminder per re-check point, none in between, "still fits" counts as an answer
  const R = "22222222-cccc-4ccc-8ccc-cccccccccccc";
  const fileR = make(R, [user("پروژه بلند"), line({ type: "ai-title", aiTitle: "auto r", sessionId: R })]);
  const reminders = [];
  for (let turn = 1; turn <= 45; turn += 1) {
    if (turn === 4) {
      engine.setTitle(R, "پروژه بلند · طراحی");
    }
    const context = engine.promptHook({ session_id: R, transcript_path: fileR, prompt: "p" + turn });
    if (context && /Session title (due|check)/.test(context)) {
      reminders.push(turn);
    }
  }
  assert.deepEqual(reminders, [3, 12, 40], "first at 3, then one check at 12 and one at 40, ignored checks are not repeated");
  const S = "33333333-dddd-4ddd-8ddd-dddddddddddd";
  const fileS = make(S, [user("کوتاه"), line({ type: "ai-title", aiTitle: "auto s", sessionId: S })]);
  for (let turn = 1; turn <= 3; turn += 1) {
    engine.promptHook({ session_id: S, transcript_path: fileS, prompt: "p" });
  }
  engine.setTitle(S, "کوتاه · آزمون");
  for (let turn = 4; turn <= 11; turn += 1) {
    engine.promptHook({ session_id: S, transcript_path: fileS, prompt: "p" });
  }
  assert.match(engine.promptHook({ session_id: S, transcript_path: fileS, prompt: "p" }), /Session title check/);
  assert.equal(engine.setTitle(S, "کوتاه · آزمون").status, "unchanged");
  assert.equal(engine.readState(S).namedTurn, 12, "confirming the same title resets the reminders");

  // 5. Claude Code re-appending an older AStack title keeps it AStack's
  engine.setTitle(S, "کوتاه · آزمون دوم");
  appendFileSync(fileS, line({ type: "custom-title", customTitle: "کوتاه · آزمون", sessionId: S }));
  assert.equal(engine.sessions().find((entry) => entry.id === S).source, "astack");

  // owner title: the hook stays quiet, and looks again only after a while
  const O2 = "44444444-eeee-4eee-8eee-eeeeeeeeeeee";
  const fileO2 = make(O2, [user("مالک"), line({ type: "custom-title", customTitle: "مالک · دستی", sessionId: O2 })]);
  for (let turn = 1; turn <= 5; turn += 1) {
    assert.equal(engine.promptHook({ session_id: O2, transcript_path: fileO2, prompt: "p" }), null);
  }
  assert.equal(engine.readState(O2).ownerSeenTurn, 3);

  // 6. a torn last line never swallows the title
  const U = "55555555-ffff-4fff-8fff-ffffffffffff";
  const fileU = make(U, [user("نیمه"), "{\"type\":\"assistant\",\"message\":{\"con"]);
  engine.setTitle(U, "نیمه · خط ناتمام");
  const lines = readFileSync(fileU, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(JSON.parse(lines.at(-1)).customTitle, "نیمه · خط ناتمام");
  assert.equal(engine.sessions().find((entry) => entry.id === U).title, "نیمه · خط ناتمام");

  // 7. the token goes only to the API base given in code
  assert.equal(new SessionTitles({ home: reviewHome }).apiBase, "https://api.anthropic.com");
}

// ------------------------------------------------------------- user-level hook
{
  const userHome = sandbox("user-home");
  const settingsPath = join(userHome, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  const original = { theme: "dark", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node owner.mjs" }] }], Stop: [{ hooks: [{ type: "command", command: "node stop.mjs" }] }] } };
  writeFileSync(settingsPath, JSON.stringify(original));
  const fakeCore = join(userHome, ".astack", "core", "bin");
  mkdirSync(fakeCore, { recursive: true });
  const missingHook = new SessionTitles({ home: userHome, projectRoot, clock, cli: join(fakeCore, "astack.mjs") });
  assert.throws(() => missingHook.installUserHook(), /has no bin\/astack-title-hook\.mjs/, "never wire a hook file the core does not have");
  writeFileSync(join(fakeCore, "astack-title-hook.mjs"), "// hook");
  const user = new SessionTitles({ home: userHome, projectRoot, clock, cli: join(fakeCore, "astack.mjs") });
  assert.equal(user.userHookStatus().installed, false);
  const installed = user.installUserHook();
  assert.ok(installed.changed && installed.backup, "a backup is written before the first change");
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(after.theme, "dark", "other settings are kept");
  assert.equal(after.hooks.Stop.length, 2, "the owner's stop hook stays beside AStack's");
  assert.equal(after.hooks.Stop[0].hooks[0].command, "node stop.mjs");
  assert.match(after.hooks.Stop[1].hooks[0].command, /astack-title-hook\.mjs" interop hook stop --runtime claude-code --scope=user$/);
  assert.equal(after.hooks.UserPromptSubmit.length, 2, "the owner's prompt hook stays beside AStack's");
  assert.equal(after.hooks.UserPromptSubmit[1].hooks[0].command, "node \"" + join(fakeCore, "astack-title-hook.mjs").split("\\").join("/") + "\" interop hook prompt --runtime claude-code --scope=user");
  assert.equal(user.installUserHook().changed, false, "installing twice changes nothing");
  assert.equal(user.userHookStatus().installed, true);
  user.installUserHook({ remove: true });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).hooks.UserPromptSubmit, original.hooks.UserPromptSubmit, "remove takes only AStack's entry");
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).hooks.Stop, original.hooks.Stop, "remove takes only AStack's stop entry");
  writeFileSync(settingsPath, "{ broken");
  assert.throws(() => user.installUserHook(), /not valid JSON/);

  const withHook = sandbox("project-with-hook");
  mkdirSync(join(withHook, ".claude"), { recursive: true });
  writeFileSync(join(withHook, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: "node \"$CLAUDE_PROJECT_DIR/bin/astack.mjs\" interop hook prompt --runtime claude-code" }] }] } }));
  const withoutHook = sandbox("project-without-hook");
  assert.equal(projectHasPromptHook(withHook), true);
  assert.equal(projectHasPromptHook(withoutHook), false);
  assert.equal(projectHasPromptHook(null), false);

  // a project's own opt-out and hint, read by the user-level hook
  const optedOut = sandbox("project-opted-out");
  writeFileSync(join(optedOut, "astack.config.yaml"), "session_titles:\n  enabled: false\n");
  assert.equal(projectTitleConfig(optedOut).enabled, false);
  const embedded = sandbox("project-embedded");
  mkdirSync(join(embedded, "astack"), { recursive: true });
  writeFileSync(join(embedded, "astack", "astack.config.yaml"), "session_titles:\n  hint: \"client · case · task\"\n");
  assert.equal(projectTitleConfig(embedded).hint, "client · case · task", "an embedded core's settings are found in astack/");
  assert.equal(projectTitleConfig(withoutHook), null);
}

// ------------------------------------------------------------- remaining review findings
{
  const costHome = sandbox("cost-home");
  const costProjects = join(costHome, ".claude", "projects", slug);
  mkdirSync(costProjects, { recursive: true });
  const engine = new SessionTitles({ home: costHome, projectRoot, clock });
  const V = "66666666-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const fileV = join(costProjects, V + ".jsonl");
  writeFileSync(fileV, user("بی‌نام می‌ماند"));
  let reads = 0;
  const original = engine.titleOf.bind(engine);
  engine.titleOf = (...args) => {
    reads += 1;
    return original(...args);
  };
  for (let turn = 1; turn <= 60; turn += 1) {
    engine.promptHook({ session_id: V, transcript_path: fileV, prompt: "p" });
  }
  assert.ok(reads <= 6, "an untitled chat that ignores its reminders is read only at reminder points (" + reads + " reads)");

  // undo of an undo is not a redo
  const W = "77777777-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const fileW = join(costProjects, W + ".jsonl");
  writeFileSync(fileW, user("مالک") + line({ type: "custom-title", customTitle: "عنوان مالک", sessionId: W }));
  engine.setTitle(W, "عنوان اجباری", { force: true });
  engine.undo({ session: W });
  const second = engine.undo({ session: W });
  assert.equal(engine.sessions().find((entry) => entry.id === W).title, "عنوان مالک", "a second undo does not bring the forced title back");
  assert.ok(second.results.every((result) => result.status !== "restored"));
}

// ------------------------------------------------------------- 3.7: phone chats and the stop hook
{
  // The exact id Claude Code gives a chat resumed from a Remote Control session.
  assert.equal(remoteLocalId("cse_019xUzSKsss8gAB9C6opvhrk"), "a355971f-7878-5cd4-b3ce-aa38ff5c53bc");

  const phoneHome = sandbox("phone-home");
  const phoneProjects = join(phoneHome, ".claude", "projects", slug);
  mkdirSync(phoneProjects, { recursive: true });
  const remote = "cse_01PHONEPHONEPHONEPHONE01";
  const id = remoteLocalId(remote);
  const fileP = join(phoneProjects, id + ".jsonl");
  writeFileSync(fileP, user("سفارش جدید برای سیروان"));
  writeFileSync(join(phoneHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-9", expiresAt: now.getTime() + 3600000 } }));

  const requests = [];
  let phoneTitle = "auto from phone";
  let listIds = [];
  const fake = async (url, options) => {
    requests.push({ url, method: options.method, body: options.body });
    if (options.method === "PUT") {
      phoneTitle = JSON.parse(options.body).title;
      return { status: 200 };
    }
    if (url.includes("/v1/code/sessions?")) {
      return { status: 200, json: async () => ({ data: listIds.map((value) => ({ id: value })), next_cursor: null }) };
    }
    return { status: 200, json: async () => ({ id: remote, title: phoneTitle }) };
  };
  const engine = new SessionTitles({ home: phoneHome, projectRoot, clock, fetchImpl: fake, apiBase: "https://api.test" });

  // linked through a Remote Control log name …
  assert.deepEqual(engine.remoteIds(fileP), [], "unknown until a log or the session list names it");
  const logs = join(phoneHome, ".astack", "remote-control");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "cohub.pro-" + remote + ".log"), "log");
  engine.remoteMapCache = null;
  assert.deepEqual(engine.remoteIds(fileP), [remote], "a server log name links the phone chat");
  // … or through the account's session list
  rmSync(join(logs, "cohub.pro-" + remote + ".log"));
  engine.remoteMapCache = null;
  listIds = [remote, "cse_01OTHEROTHEROTHEROTHER1"];
  assert.equal((await engine.refreshRemoteList({ maxAgeMs: 0 })).count, 2);
  assert.deepEqual(engine.remoteIds(fileP), [remote], "the session list links the phone chat");
  assert.equal((await engine.refreshRemoteList()).refreshed, false, "the list is cached for a while");

  // stop hook: a reminder that was ignored is enforced once, in the same reply
  const stop = (extra = {}) => engine.stopHook({ session_id: id, transcript_path: fileP, ...extra });
  for (let turn = 1; turn <= 3; turn += 1) {
    engine.promptHook({ session_id: id, transcript_path: fileP, prompt: "p" });
  }
  const enforced = await stop();
  assert.match(enforced.block, /set this chat's title/);
  assert.match(enforced.block, new RegExp("session=" + id));
  assert.equal(await stop({ stop_hook_active: true }), null, "never blocks while continuing for a stop hook");
  assert.equal(await stop(), null, "never twice in one turn");

  // the agent sets the title; the stop hook pushes it to the phone
  requests.length = 0;
  engine.setTitle(id, "سیروان · سفارش فسنجون و بریانی");
  await stop();
  const puts = requests.filter((request) => request.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, "https://api.test/v1/code/sessions/" + remote);
  assert.equal(phoneTitle, "سیروان · سفارش فسنجون و بریانی");
  requests.length = 0;
  await stop();
  assert.equal(requests.filter((request) => request.method === "PUT").length, 0, "no push when nothing changed");

  // the owner renames the chat on the phone: it comes back as the owner's title
  // (the phone is read at most every three replies)
  const advance = (count = 3) => {
    for (let index = 0; index < count; index += 1) {
      engine.promptHook({ session_id: id, transcript_path: fileP, prompt: "p" });
    }
  };
  // invalid or automatic phone titles are never taken
  advance();
  phoneTitle = "x".repeat(300) + "\u0001";
  await stop();
  assert.equal(engine.sessions().find((entry) => entry.id === id).title, "سیروان · سفارش فسنجون و بریانی", "an invalid phone title is refused");
  appendFileSync(fileP, line({ type: "ai-title", aiTitle: "Sirvan order from phone", sessionId: id }));
  engine.setTitle(id, "سیروان · سفارش فسنجون و بریانی"); // still current
  advance();
  phoneTitle = "Sirvan order from phone";
  await stop();
  assert.equal(engine.sessions().find((entry) => entry.id === id).title, "سیروان · سفارش فسنجون و بریانی", "Claude Code's automatic title is not an owner rename");
  advance();
  phoneTitle = "سیروان · نام دستی از موبایل";
  await stop();
  const back = engine.sessions().find((entry) => entry.id === id);
  assert.equal(back.title, "سیروان · نام دستی از موبایل");
  assert.equal(back.source, "owner", "a phone rename is the owner's title here");
  assert.equal(engine.setTitle(id, "سیروان · دوباره").status, "kept-owner");
  // Claude Code then drops it from the transcript: the owner's phone title comes back, never AStack's older one
  writeFileSync(fileP, user("سفارش جدید برای سیروان") + line({ type: "ai-title", aiTitle: "auto", sessionId: id }));
  requests.length = 0;
  advance();
  await stop();
  const healed = engine.sessions().find((entry) => entry.id === id);
  assert.equal(healed.title, "سیروان · نام دستی از موبایل", "self-repair restores the owner's phone rename");
  assert.equal(healed.source, "owner");
  advance();
  await stop();
  assert.equal(requests.filter((request) => request.method === "PUT").length, 0, "an owner title is never pushed over the phone");

  // Claude Code rewrites the transcript without our title: the stop hook puts it back
  const H = "12121212-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const fileH = join(phoneProjects, H + ".jsonl");
  writeFileSync(fileH, user("پرونده"));
  engine.setTitle(H, "بخیته · سرکشی پرتال");
  writeFileSync(fileH, user("پرونده") + line({ type: "ai-title", aiTitle: "auto again", sessionId: H }));
  await engine.stopHook({ session_id: H, transcript_path: fileH });
  assert.equal(engine.sessions().find((entry) => entry.id === H).title, "بخیته · سرکشی پرتال", "a lost AStack title is restored");
  appendFileSync(fileH, line({ type: "custom-title", customTitle: "عنوان مالک", sessionId: H }));
  await engine.stopHook({ session_id: H, transcript_path: fileH });
  assert.equal(engine.sessions().find((entry) => entry.id === H).title, "عنوان مالک", "an owner title is never healed over");

  // a push that reached only some copies is not counted as done
  const twoHome = sandbox("two-copies");
  const twoProjects = join(twoHome, ".claude", "projects", slug);
  mkdirSync(join(twoHome, ".astack", "remote-control"), { recursive: true });
  mkdirSync(twoProjects, { recursive: true });
  writeFileSync(join(twoHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: now.getTime() + 3600000 } }));
  const remoteA = "cse_01AAAAAAAAAAAAAAAAAAAAAAAA";
  const idA = remoteLocalId(remoteA);
  const fileA2 = join(twoProjects, idA + ".jsonl");
  writeFileSync(fileA2, user("دو نسخه") + line({ bridgeSessionId: "cse_01BBBBBBBBBBBBBBBBBBBBBBBB", type: "system" }));
  writeFileSync(join(twoHome, ".astack", "remote-control", "hq-" + remoteA + ".log"), "log");
  const partial = new SessionTitles({ home: twoHome, projectRoot, clock, apiBase: "https://api.test", fetchImpl: async (url, options) => (options.method === "PUT" ? { status: url.includes("AAAA") ? 500 : 200 } : { status: 200, json: async () => ({ data: [] }) }) });
  assert.equal(partial.remoteIds(fileA2).length, 2);
  partial.setTitle(idA, "دو نسخه · آزمون");
  await partial.stopHook({ session_id: idA, transcript_path: fileA2 });
  assert.equal(partial.readState(idA).pushedTitle, null, "not every copy took the title, so it is not marked as pushed");

  // re-checks are never enforced; disabled means silent
  const quiet = new SessionTitles({ home: phoneHome, projectRoot, clock, fetchImpl: fake, config: { enabled: false } });
  assert.equal(await quiet.stopHook({ session_id: id, transcript_path: fileP }), null);

  // project wiring has the stop hook beside an owner stop hook
  const interop = new InteropEngine(sandbox("wiring-37"), { home: sandbox("wiring-37-home"), env: {} });
  const settings = interop.plannedClaudeSettings({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node .claude/hooks/astack-wrapup.mjs" }] }] } });
  assert.equal(settings.hooks.Stop.length, 2);
  assert.match(settings.hooks.Stop[1].hooks[0].command, /astack-title-hook\.mjs" interop hook stop --runtime claude-code$/);
  assert.equal(interop.plannedClaudeSettings(settings).hooks.Stop.length, 2, "never duplicated");
}

console.log("verify-session-titles: ok");
