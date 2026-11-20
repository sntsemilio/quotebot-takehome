// Core of the "after" measurement, separate from the CLI so it can be tested with a fake model and replay.
// Protocol: one turn with the case message; a second turn with a fixed reply ONLY if the first turn did not
// start a quote (the bot asked something) and a reply was given.
import type { Conversation } from "../conversation/session.js";
import type { RunEvent } from "../record/events.js";
import type { RunState } from "../record/state.js";

export interface CaseTurn {
  user: string;
  assistant: string;
  runId?: string; // set when this turn started a quote
}

export interface AfterCaseResult {
  runId?: string; // the quote started, if any
  lastText: string; // the bot's text in the last turn
  replySent: boolean;
}

// `turns` is filled as the conversation goes, so a caller that stops early (time cap) still has them.
export async function runAfterCase(conversation: Conversation, message: string, opts: { reply?: string; turns: CaseTurn[] }): Promise<AfterCaseResult> {
  const first = await conversation.send(message);
  opts.turns.push({ user: message, assistant: first.text, ...(first.runId ? { runId: first.runId } : {}) });
  if (first.runId || opts.reply === undefined) return { runId: first.runId, lastText: first.text, replySent: false };

  const second = await conversation.send(opts.reply);
  opts.turns.push({ user: opts.reply, assistant: second.text, ...(second.runId ? { runId: second.runId } : {}) });
  return { runId: second.runId, lastText: second.text, replySent: true };
}

// CLI arguments: <caseId> [label] [--reply "<text>"] (the flag may go anywhere).
export function parseAfterArgs(argv: string[]): { caseId: number; label: string; reply?: string } | { error: string } {
  const args = [...argv];
  let reply: string | undefined;
  const i = args.indexOf("--reply");
  if (i >= 0) {
    reply = args[i + 1];
    if (reply === undefined || reply.startsWith("--") || !reply.trim()) return { error: '--reply needs a text, e.g. --reply "La caja mide 30x20x15 cm"' };
    args.splice(i, 2);
  }
  const caseId = Number(args[0]);
  if (!Number.isInteger(caseId)) return { error: 'usage: measure-after.ts <caseId> [label] [--reply "<text>"]' };
  return { caseId, label: args[1] ?? "after", ...(reply !== undefined ? { reply } : {}) };
}

// Tool errors of the model's own calls (step > 0, tool other than "model"), split by whether the
// error went back to the model. A record without shownToModel does not say: both counts are null then.
export function toolErrorCounts(events: RunEvent[]): { hidden: number | null; shown: number | null } {
  const failed = events.filter((e): e is Extract<RunEvent, { type: "step.failed" }> => e.type === "step.failed");
  if (failed.length && !failed.some((e) => "shownToModel" in e)) return { hidden: null, shown: null };
  const tools = failed.filter((e) => e.step > 0 && e.tool !== "model");
  const shown = tools.filter((e) => e.shownToModel === true).length;
  return { hidden: tools.length - shown, shown };
}

// One line per carrier of the summary, with its model turns and seconds from start to close.
export function carrierSummaries(state: RunState) {
  return Object.entries(state.carriers).map(([carrierId, x]) => ({
    carrierId, status: x.status, reason: x.reason, verifiedPrices: x.prices.length, costUsd: Number(x.costUsd.toFixed(4)),
    modelTurns: x.steps,
    seconds: x.closedMs === undefined ? null : Number(((x.closedMs - x.startedMs) / 1000).toFixed(1)),
  }));
}
