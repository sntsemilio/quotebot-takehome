// Runs one carrier against one structured request and prints the result READ FROM THE RECORD.
// usage: npx tsx src/harness/quote.ts <carrierId> <requestFile> [label]
// caps (env, same as measure-after.ts): CASE_MAX_USD (default 3), CASE_MAX_MINUTES (default 10).
import fs from "node:fs";
import path from "node:path";
import { getCarrier } from "../carriers/index.js";
import { missingNeeds } from "../carriers/types.js";
import { validateRequest } from "../domain/request.js";
import { nextBusinessDayInBusinessTz } from "../domain/dates.js";
import { RunStore } from "../record/store.js";
import { fold } from "../record/state.js";
import { runCarrier } from "../agent/carrierAgent.js";

const [carrierId, requestFile, label = "after"] = process.argv.slice(2);
if (!carrierId || !requestFile) {
  console.error("usage: npx tsx src/harness/quote.ts <carrierId> <requestFile> [label]");
  process.exit(1);
}
const plugin = getCarrier(carrierId);
if (!plugin) {
  console.error(`unknown carrier '${carrierId}'`);
  process.exit(1);
}

const maxUsd = Number(process.env.CASE_MAX_USD ?? 3);
const maxMinutes = Number(process.env.CASE_MAX_MINUTES ?? 10);
const runId = `${carrierId}-${path.basename(requestFile, ".json")}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const dir = `runs/${label}`;
const store = new RunStore(dir, runId);
store.append("run.started", { runId, label, carrierIds: [carrierId], requestFile });

function finish(status: "completed" | "cap_cost" | "cap_time" | "error", error?: string): never {
  store.append("run.finished", { status, ...(error ? { error } : {}) });
  const state = fold(store.events());
  const c = state.carriers[carrierId];
  const totalIn = c ? c.inputTokens + c.cacheWriteTokens + c.cacheReadTokens : 0;
  const summary = {
    runId, label, carrierId, requestFile, request: state.request, requestErrors: state.requestErrors,
    run: state.finished,
    result: c && {
      status: c.status, reason: c.reason, closedBy: c.closedBy, closingEvidence: c.evidenceId,
      prices: c.prices,
      rejectedPrices: c.rejectedPrices,
      steps: c.steps, toolCalls: c.toolCalls, failedToolCalls: c.failedToolCalls, blockedNavigations: c.blockedNavigations,
      tokens: {
        input: c.inputTokens, output: c.outputTokens, cacheWrite: c.cacheWriteTokens, cacheRead: c.cacheReadTokens,
        cacheReadPct: totalIn ? Number(((100 * c.cacheReadTokens) / totalIn).toFixed(1)) : 0,
        maxInputPerStep: c.maxInputPerStep,
      },
      costUsd: Number(c.costUsd.toFixed(4)),
      seconds: c.closedMs !== undefined ? Number(((c.closedMs - c.startedMs) / 1000).toFixed(1)) : null,
    },
    record: store.file.replace(/\\/g, "/"),
    trace: `${dir}/${runId}/${carrierId}.trace.zip`,
  };
  fs.writeFileSync(path.join(dir, `${runId}.summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

// Request files may use "$NEXT_BUSINESS_DAY" for dates, resolved now (Monterrey), so they never go stale.
const raw = fs.readFileSync(requestFile, "utf8").replaceAll('"$NEXT_BUSINESS_DAY"', JSON.stringify(nextBusinessDayInBusinessTz()));
const v = validateRequest(JSON.parse(raw));
if (!v.ok) {
  store.append("request.invalid", { errors: v.errors });
  finish("error", `invalid request: ${v.errors.join("; ")}`); // no browser is opened
}
store.append("request.validated", { request: v.request });

// A carrier whose needs are not in the request is not launched (same rule as the orchestrator).
const missing = missingNeeds(plugin, v.request);
if (missing.length) {
  store.append("carrier.skipped", { carrierId, missing });
  finish("completed");
}

const timer = setTimeout(() => {
  store.append("carrier.closed", { carrierId, status: "budget_exhausted", reason: `harness time cap (${maxMinutes} min)`, closedBy: "code" });
  finish("cap_time", `stopped after ${maxMinutes} min`);
}, maxMinutes * 60_000);

try {
  await runCarrier({ plugin, request: v.request, store, runDir: path.join(dir, runId), maxUsd });
  clearTimeout(timer);
  const c = fold(store.events()).carriers[carrierId];
  finish(c?.reason?.startsWith("cost cap") ? "cap_cost" : "completed");
} catch (e) {
  clearTimeout(timer);
  finish("error", String(e));
}
