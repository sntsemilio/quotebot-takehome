// "After" measurement: sends one case message from cases/cases.json to the new conversation, waits for the
// quote it starts (if any) and writes a summary in the same format as the "before" measurement (plus quote details).
// The "before" (the contractor's agent, no longer in the code) is reproduced from the git tag before-baseline.
// usage: npx tsx src/harness/measure-after.ts <caseId> [label] [--reply "<text>"]
// --reply: if the first message did not start a quote (the bot asked something), send <text> as a second turn
// in the same conversation. The summary records the number of turns and each turn's text either way.
// caps (env, same as the before measurement): CASE_MAX_USD (default 3, whole case), CASE_MAX_MINUTES (default 10).
// REPLAY_RUN=<jsonl> replays a recorded quote instead of visiting the sites (no browser, no Opus).
import fs from "node:fs";
import path from "node:path";
import { configFromEnv, createOrchestrator } from "../orchestrator/index.js";
import { Conversation } from "../conversation/session.js";
import { fold } from "../record/state.js";
import { readEvents } from "../record/store.js";
import type { QuoteView } from "../orchestrator/view.js";
import { carrierSummaries, parseAfterArgs, runAfterCase, toolErrorCounts, type CaseTurn } from "./afterCase.js";

const parsed = parseAfterArgs(process.argv.slice(2));
if ("error" in parsed) {
  console.error(parsed.error);
  process.exit(1);
}
const { caseId: id, label, reply } = parsed;
const turns: CaseTurn[] = [];
const cases = JSON.parse(fs.readFileSync("cases/cases.json", "utf8"));
const c = cases.find((x: { id: number }) => x.id === id);
if (!c) {
  console.error(`no case ${id}`);
  process.exit(1);
}

const maxUsd = Number(process.env.CASE_MAX_USD ?? 3);
const maxMinutes = Number(process.env.CASE_MAX_MINUTES ?? 10);
const runId = `case${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const dir = `runs/${label}`;
fs.mkdirSync(dir, { recursive: true });
const startedAt = Date.now();

const orchestrator = createOrchestrator({ ...configFromEnv(), maxUsd, maxSeconds: maxMinutes * 60 });
const conversation = new Conversation(orchestrator, { label });

// Plain-text rendering of the code-painted table, so the summary's answer is comparable with the "before".
function renderTable(view: QuoteView): string {
  if (!view.ranked.length) return "(no verified prices)";
  const names = Object.fromEntries(view.carriers.map((x) => [x.carrierId, x.name]));
  return view.ranked
    .map((r) => {
      const p = r.price;
      const vat = p.includesVAT === true ? "includes VAT per site" : p.includesVAT === false ? "excludes VAT per site" : "VAT not stated by site";
      const total = p.total ? `; total ${p.total.formula}` : "";
      return `${r.rank}. ${names[r.carrierId] ?? r.carrierId} – ${p.service}: ${p.priceText} ${p.currency} (${vat}${p.siteNotes.length ? `; ${p.siteNotes.join("; ")}` : ""}${total}) [evidence ${p.image ?? p.evidenceId}]`;
    })
    .join("\n");
}

function finish(status: "completed" | "cap_cost" | "cap_time" | "error", answer: string | null, extra: Record<string, unknown> = {}, error?: string): never {
  const quoteRunId = conversation.lastRunId;
  const quoteFile = quoteRunId ? path.join(dir, `${quoteRunId}.jsonl`) : null;
  const events = quoteFile && fs.existsSync(quoteFile) ? readEvents(quoteFile) : null;
  const state = events ? fold(events) : null;
  const toolErrors = events ? toolErrorCounts(events) : { hidden: 0, shown: 0 };
  const carriers = state ? Object.values(state.carriers) : [];
  const u = conversation.usage;
  const sum = (f: (x: (typeof carriers)[number]) => number) => carriers.reduce((a, x) => a + f(x), 0);
  // In replay the carrier model.response events are copies of a recorded run: their cost was not spent now.
  const carrierCost = sum((x) => x.costUsd);
  const costUsd = u.costUsd + (orchestrator.isReplay ? 0 : carrierCost);
  const models = [...u.models];
  if (state && sum((x) => x.steps) > 0) models.push(orchestrator.isReplay ? "claude-opus-5-5 (carrier agents, replayed)" : "claude-opus-5-5 (carrier agents)");
  const summary = {
    runId, label, caseId: id, message: c.message, expect: c.expect, status, answer, error,
    turnCount: turns.length,
    turns,
    reply: reply ?? null, // the fixed second-turn text given with --reply (sent only if the bot asked)
    // Same totals keys as the before measurement (conversation + carrier agents together).
    steps: u.calls + sum((x) => x.steps),
    toolCalls: u.toolCalls + sum((x) => x.toolCalls),
    // From the record (step.failed.shownToModel); null for records from before step 4, which do not say.
    toolErrorsHiddenFromModel: toolErrors.hidden,
    toolErrorsShownToModel: toolErrors.shown,
    inputTokens: u.inputTokens + sum((x) => x.inputTokens),
    outputTokens: u.outputTokens + sum((x) => x.outputTokens),
    cacheWriteTokens: u.cacheWriteTokens + sum((x) => x.cacheWriteTokens),
    cacheReadTokens: u.cacheReadTokens + sum((x) => x.cacheReadTokens),
    costUsd: Number(costUsd.toFixed(4)),
    models,
    unpricedModels: [] as string[],
    durationMs: Date.now() - startedAt,
    // After-only details.
    replay: orchestrator.isReplay ? process.env.REPLAY_RUN : undefined,
    conversationCostUsd: Number(u.costUsd.toFixed(4)),
    carrierCostUsd: Number(carrierCost.toFixed(4)), // recorded cost of the original run when replaying
    carrierCostReplayed: orchestrator.isReplay,
    quoteRunId,
    quoteRecord: quoteFile?.replace(/\\/g, "/"),
    quoteStatus: state?.finished?.status,
    carriers: state ? carrierSummaries(state) : [],
    conversationRecord: conversation.recordFile,
    transcript: conversation.log,
    ...extra,
  };
  fs.writeFileSync(`${dir}/${runId}.summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const timer = setTimeout(() => finish("cap_time", null, {}, `stopped after ${maxMinutes} min`), maxMinutes * 60_000);

try {
  const r = await runAfterCase(conversation, c.message, { reply, turns });
  if (!r.runId) {
    clearTimeout(timer);
    finish("completed", r.lastText, { quoteStarted: false, replySent: r.replySent });
  }
  const { view, note, noteSource } = await conversation.describeResult(r.runId!);
  clearTimeout(timer);
  const answer = `${r.lastText}\n\n${note}\n\n${renderTable(view)}`;
  finish(view.runStatus === "cap_cost" ? "cap_cost" : view.runStatus === "cap_time" ? "cap_time" : "completed", answer, { quoteStarted: true, replySent: r.replySent, note, noteSource });
} catch (e) {
  clearTimeout(timer);
  finish("error", null, {}, String(e));
}
