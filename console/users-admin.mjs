import { join } from "node:path";
import { AUTH_MODES, setConsoleAuth } from "./config-edit.mjs";
import { ROLES, STRONG_PASSWORD_LENGTH, normalizeUsername, passwordProblem } from "./users.mjs";

/**
 * /api/users*: who may sign in to Aramis, and the first administrator.
 *
 * Everything here is local only: the internet listener refuses it (403), so
 * users and passwords are never created or changed from outside this machine.
 * A password is sent once, over loopback, and is never logged, audited or
 * returned. Every write is audited without any secret.
 */
export class UsersError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const REASONS = {
  short: "the password needs at least " + STRONG_PASSWORD_LENGTH + " characters",
  long: "the password is too long",
  username: "the password must not be the username",
  digits: "the password must not be only digits",
  repeated: "the password must not be one repeated character",
  common: "this password is too common",
  mismatch: "the two passwords differ"
};

export class UsersAdmin {
  constructor(server) {
    this.server = server;
    // Creating users is one at a time: two requests must not both become "the first administrator".
    this.creating = Promise.resolve();
  }

  get users() {
    return this.server.users;
  }

  audit(action, target, result) {
    this.server.runtime.audit?.record({ actor: "owner@console", action, target, riskLevel: "L2", result });
  }

  /** The signed-in actor: a user session has a role, a token or ticket session is the machine owner. */
  actor(session) {
    if (session?.user) {
      const role = this.users.roleOf(session.user);
      return { username: session.user, role, admin: role === "admin" };
    }
    return { username: null, role: "admin", admin: true };
  }

  localOnly(listener) {
    if (listener.kind === "remote") {
      throw new UsersError(403, "console users are not managed over the internet listener");
    }
  }

  requireAdmin(session) {
    if (!this.actor(session).admin) {
      throw new UsersError(403, "only an administrator manages console users");
    }
  }

  checkPasswordChoice(password, username, confirm) {
    if (typeof password !== "string") {
      throw new UsersError(400, REASONS.short, { reason: "short" });
    }
    if (confirm !== undefined && confirm !== null && confirm !== password) {
      throw new UsersError(400, REASONS.mismatch, { reason: "mismatch" });
    }
    const problem = passwordProblem(password, username);
    if (problem) {
      throw new UsersError(400, REASONS[problem], { reason: problem });
    }
  }

  view(session, listener) {
    const actor = this.actor(session);
    const list = this.users.list();
    const mode = this.server.authMode();
    return {
      // A user without the admin role sees only themselves.
      users: list.filter((user) => actor.admin || user.username === actor.username).map((user) => ({
        username: user.username,
        role: user.role,
        totp: user.totp,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        current: user.username === actor.username
      })),
      me: { username: actor.username, role: actor.role, admin: actor.admin, method: session?.method ?? "token" },
      setup: { needed: list.length === 0, canCreate: list.length === 0 && !actor.username },
      authMode: mode,
      authModeSetting: this.server.authModeSetting ?? null,
      canRequirePassword: actor.admin && list.some((user) => user.role === "admin") && mode !== "password",
      minPassword: STRONG_PASSWORD_LENGTH,
      roles: ROLES,
      local: listener.kind !== "remote"
    };
  }

  async route(method, id, body, session, listener, address) {
    this.localOnly(listener);
    if (method === "GET") {
      return id ? undefined : this.view(session, listener);
    }
    if (method !== "POST") {
      return undefined;
    }
    switch (id) {
      case undefined:
      case "":
      case "create":
        return this.serialized(() => this.create(body, session));
      case "password":
        return this.changePassword(body, session, address);
      case "totp":
        return this.totp(body, session, address);
      case "remove":
        return this.remove(body, session);
      case "role":
        return this.role(body, session);
      case "auth-mode":
        return this.authMode(body, session);
      default:
        return undefined;
    }
  }

  serialized(task) {
    const run = this.creating.then(task, task);
    this.creating = run.catch(() => {});
    return run;
  }

  async create(body, session) {
    this.requireAdmin(session);
    const name = normalizeUsername(body.username);
    if (!name) {
      throw new UsersError(400, "a username is 2-32 characters: a-z, 0-9, dot, dash or underscore, starting with a letter or digit", { reason: "username-format" });
    }
    const first = this.users.count() === 0;
    if (first && session?.user) {
      throw new UsersError(403, "the first administrator is created from a token session on this computer");
    }
    if (this.users.get(name)) {
      throw new UsersError(409, "this username is already taken", { reason: "exists" });
    }
    this.checkPasswordChoice(body.password, name, body.confirm);
    const role = first ? "admin" : body.role === undefined ? "user" : body.role;
    if (!ROLES.includes(role)) {
      throw new UsersError(400, "a role is admin or user", { reason: "role" });
    }
    await this.users.set(name, body.password, { role });
    this.audit("console-user-created", name, "role " + role + (first ? ", first administrator" : "") + ", created in the console");
    return { username: name, role, created: true, firstAdmin: first, authMode: this.server.authMode() };
  }

  /** Verify the acting user's current password, counting a wrong one against the same lockout as sign-in. */
  async reauthenticate(session, current, address) {
    if (!session?.user) {
      throw new UsersError(403, "this is done by a signed-in user; with the token use: astack console user set <name>");
    }
    const keys = ["ip:" + address, "user:" + session.user];
    const gate = this.server.guard.check(keys);
    if (!gate.allowed) {
      throw new UsersError(429, "too many attempts, try again later");
    }
    const ok = await this.users.checkPassword(session.user, String(current ?? ""));
    if (!ok) {
      this.server.guard.fail(keys);
      this.audit("console-user-reauth-failed", session.user, "wrong current secret");
      throw new UsersError(422, "the current password is wrong", { reason: "current" });
    }
    this.server.guard.succeed(["user:" + session.user]);
    return session.user;
  }

  async changePassword(body, session, address) {
    const name = await this.reauthenticate(session, body.current, address);
    this.checkPasswordChoice(body.password, name, body.confirm);
    if (body.password === body.current) {
      throw new UsersError(400, "choose a different password", { reason: "same" });
    }
    await this.users.set(name, body.password);
    const ended = this.server.auth.keepOnlySession(name, session.key, this.users.credentialVersion(name));
    this.audit("console-user-secret-changed", name, "changed by the user, " + ended + " other session(s) ended");
    return { username: name, changed: true, otherSessionsEnded: ended };
  }

  async totp(body, session, address) {
    const name = await this.reauthenticate(session, body.current, address);
    if (body.action === "enable") {
      const enrolled = this.users.enableTotp(name);
      this.server.auth.keepOnlySession(name, session.key, this.users.credentialVersion(name));
      this.audit("console-user-totp", name, "enabled");
      // The enrolment secret is shown once so an authenticator app can be set up.
      return { username: name, totp: true, secret: enrolled.secret, uri: enrolled.uri };
    }
    if (body.action === "disable") {
      this.users.disableTotp(name);
      this.server.auth.keepOnlySession(name, session.key, this.users.credentialVersion(name));
      this.audit("console-user-totp", name, "disabled");
      return { username: name, totp: false };
    }
    throw new UsersError(400, "action is enable or disable");
  }

  remove(body, session) {
    this.requireAdmin(session);
    const name = normalizeUsername(body.username);
    if (!name || !this.users.get(name)) {
      throw new UsersError(404, "Unknown console user");
    }
    if (this.users.isAdmin(name) && this.users.adminCount() <= 1) {
      throw new UsersError(409, "the last administrator cannot be removed", { reason: "last-admin" });
    }
    this.users.remove(name);
    const ended = this.server.auth.destroyUserSessions(name);
    this.audit("console-user-removed", name, "removed in the console, " + ended + " session(s) ended");
    return { username: name, removed: true, self: name === session?.user };
  }

  role(body, session) {
    this.requireAdmin(session);
    const name = normalizeUsername(body.username);
    if (!name || !this.users.get(name)) {
      throw new UsersError(404, "Unknown console user");
    }
    if (!ROLES.includes(body.role)) {
      throw new UsersError(400, "a role is admin or user", { reason: "role" });
    }
    try {
      this.users.setRole(name, body.role);
    } catch (error) {
      throw new UsersError(409, error.message, { reason: "last-admin" });
    }
    this.audit("console-user-role", name, "role " + body.role);
    return { username: name, role: body.role };
  }

  /**
   * Persist `console.auth`. Turning token sign-in off is refused while there is
   * no administrator who could sign in with a username and password instead.
   */
  authMode(body, session) {
    this.requireAdmin(session);
    const mode = body.mode;
    if (!AUTH_MODES.includes(mode) || mode === "token") {
      throw new UsersError(400, "mode is password or both");
    }
    if (mode === "password" && !this.users.list().some((user) => user.role === "admin")) {
      throw new UsersError(409, "create an administrator first: token sign-in cannot be turned off without one", { reason: "no-admin" });
    }
    const runtime = this.server.runtime;
    const result = setConsoleAuth({
      configPath: runtime.configuration?.path ?? null,
      backupsRoot: runtime.workspaceRoot ? join(runtime.workspaceRoot, ".astack", "backups") : null,
      mode,
      clock: this.server.clock
    });
    this.server.authModeSetting = mode;
    this.audit("console-auth-mode", "console.auth", mode + (result.persisted ? ", saved in astack.config.yaml" : ", this run only (" + result.reason + ")"));
    return { authMode: this.server.authMode(), persisted: result.persisted, line: result.line, reason: result.reason ?? null };
  }
}
