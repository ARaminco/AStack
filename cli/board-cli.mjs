import { parseArgs } from "../delivery-engine/cli.mjs";

const out = (line) => console.log(line);

function cardLine(card) {
  const who = card.assignee ? card.assignee.kind + ":" + card.assignee.id : "-";
  const extra = [
    card.dependsOn?.length ? "after " + card.dependsOn.join(",") : null,
    card.reviewOf ? "reviews " + card.reviewOf : null,
    card.reviewer ? "reviewer " + card.reviewer : null,
    card.blockedReason ? "blocked: " + card.blockedReason : null,
    card.failedReason && card.status !== "done" ? "reason: " + card.failedReason.slice(0, 80) : null,
    card.notBefore && card.status === "todo" ? "retry after " + card.notBefore : null
  ].filter(Boolean);
  return "- " + card.id + " | " + card.status + " | " + who + " | attempts " + card.attempts.length + " | " + card.objective.slice(0, 70) + (extra.length ? " | " + extra.join(" | ") : "");
}

/**
 * astack board create|list|show|add|run|steer|retry|cancel
 */
export async function runBoardCommand({ runtime, i18n, tokens }) {
  const t = i18n.t.bind(i18n);
  const [action = "list", ...rest] = tokens;
  const { positionals, flags } = parseArgs(rest);
  const board = runtime.board;

  if (action === "create") {
    const created = board.create({
      name: positionals.join(" "),
      description: flags.describe ? String(flags.describe) : "",
      maxParallel: flags.maxParallel ?? null,
      maxRetries: flags.maxRetries ?? null,
      ceiling: flags.ceiling ? String(flags.ceiling) : null
    });
    out(t("cli.board.created", { id: created.id }));
    return;
  }
  if (action === "list") {
    const boards = board.list();
    out(t("cli.board.listTitle", { count: boards.length }));
    for (const entry of boards) {
      const summary = board.summary(entry);
      out("- " + summary.id + " | " + summary.status + " | " + summary.cards + " cards | " +
        Object.entries(summary.counts).filter(([, count]) => count).map(([status, count]) => status + " " + count).join(", "));
    }
    if (!runtime.runner) {
      out(t("cli.board.noRunner"));
    }
    return;
  }
  if (action === "show") {
    const shown = board.show(positionals[0]);
    if (shown.kind === "board") {
      const summary = board.summary(shown.board);
      out(t("cli.board.showTitle", { id: summary.id, name: shown.board.name, cards: summary.cards }));
      for (const card of shown.board.cards) {
        out(cardLine(card));
      }
      return;
    }
    out(JSON.stringify(shown.card, null, 2));
    return;
  }
  if (action === "add") {
    const [boardId, ...objective] = positionals;
    const added = board.add(boardId, {
      objective: objective.join(" "),
      assignee: flags.assignee ? String(flags.assignee) : null,
      dependsOn: flags.depends ? String(flags.depends).split(",").map((entry) => entry.trim()) : [],
      review: Boolean(flags.review),
      reviewer: flags.reviewer ? String(flags.reviewer) : null,
      maxRetries: flags.maxRetries ?? null,
      project: flags.project ? String(flags.project) : null,
      workItem: flags.item ? String(flags.item) : null,
      mission: flags.mission ? String(flags.mission) : null
    });
    out(t("cli.board.added", { id: added.card.id, board: boardId }));
    if (added.reviewer) {
      out(t("cli.board.reviewerAdded", { id: added.reviewer.id }));
    }
    return;
  }
  if (action === "run") {
    if (!runtime.runner) {
      out(t("cli.board.noRunner"));
    }
    const targets = positionals.length ? positionals : board.list().filter((entry) => entry.status === "active").map((entry) => entry.id);
    for (const id of targets) {
      const result = await board.run(id, { once: Boolean(flags.once) });
      if (result.skipped) {
        out(t("cli.board.locked", { id }));
        continue;
      }
      out(t("cli.board.ran", { id, started: result.started.length }));
      for (const card of board.load(id).cards) {
        out(cardLine(card));
      }
    }
    return;
  }
  if (action === "steer") {
    const [cardId, ...note] = positionals;
    board.steer(cardId, note.join(" "));
    out(t("cli.board.steered", { id: cardId }));
    return;
  }
  if (action === "retry") {
    board.retry(positionals[0]);
    out(t("cli.board.retried", { id: positionals[0] }));
    return;
  }
  if (action === "cancel") {
    const result = board.cancel(positionals[0], { reason: flags.reason ? String(flags.reason) : "cancelled by owner" });
    out(t("cli.board.cancelled", { kind: result.kind, id: result.id }));
    return;
  }
  throw new Error(t("cli.board.unknownAction", { action }));
}
