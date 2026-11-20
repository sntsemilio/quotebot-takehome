// Runs one carrier: opens an isolated browser session, loops model <-> tools with hard caps in code,
// and writes everything to the record. It returns nothing: the result is read from the record.
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { CarrierPlugin } from "../carriers/types.js";
import type { QuoteRequest } from "../domain/request.js";
import type { RunStore } from "../record/store.js";
import type { CloseStatus, Usage } from "../record/events.js";
import { PRICES } from "../domain/pricing.js";
import type { Page } from "playwright";
import { openSession } from "../browser/session.js";
import { compactView, relevantFrames } from "../browser/snapshot.js";
import { readScroll, scrollSignature } from "../browser/scroll.js";
import { blockFromNavError, blockFromStatus, blockFromText, DOWNLOAD_REASON } from "../browser/blocking.js";
import { buildCarrierPrompt } from "./prompt.js";
import { captureEvidence } from "./evidence.js";
import { describeError, executeTool, frameShowingText, toolDefs, ToolError, type ToolContext } from "./tools.js";
import { afterPricesReason, capReason } from "./caps.js";

const MODEL = "claude-opus-5-5";
// Created on first use, so importing this module needs no API key (tests inject a fake client).
let defaultClient: Anthropic | null = null;

// What the harness knows and the model does not. Added to the results message of the turn that
// leaves 2 or 1 turns, and recorded as carrier.notice.
export const TURNS_LEFT_NOTICE: Record<number, string> = {
  2: "2 turns left. If a captured evidence shows prices, call report_price for each and close_carrier('quoted') now, all in one turn. Otherwise close_carrier with the most accurate status and reason.",
  1: "Last turn: report what the evidence shows and close now.",
};
export const NUDGE = "You must finish with report_price or close_carrier. Do it now.";

export function costOf(model: string, u: Usage): number {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  if (!key) return 0;
  const p = PRICES[key];
  return ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output +
    (u.cache_creation_input_tokens ?? 0) * p.cacheWrite + (u.cache_read_input_tokens ?? 0) * p.cacheRead) / 1_000_000;
}

// Tools exempt from loop detection: they observe, record, scroll or end. Re-viewing, scrolling or capturing
// several times is not "being stuck"; the step cap still bounds them.
const NO_LOOP_CHECK = new Set(["view_page", "report_price", "close_carrier", "capture_evidence", "scroll"]);

// Buttons that reject optional cookies (names vary by consent tool). Only tried when the page mentions cookies.
const DEFAULT_COOKIE_REJECT = "^\\s*(rechazar|reject|decline|denegar|solo (las )?(cookies )?(necesarias|esenciales)|only (necessary|essential)|permitir solo|usar solo)";

async function dismissCookies(page: Page, plugin: CarrierPlugin, store: RunStore): Promise<void> {
  const frames = relevantFrames(page, plugin.allowedDomains);
  const mentions = await Promise.all(frames.map((f) => f.getByText(/cookie/i).first().isVisible().catch(() => false)));
  if (!mentions.some(Boolean)) return;
  const role = plugin.cookieReject?.role ?? "button";
  const name = new RegExp(plugin.cookieReject?.name ?? DEFAULT_COOKIE_REJECT, "i");
  for (const f of frames) {
    const btn = f.getByRole(role, { name }).first();
    if (await btn.isVisible().catch(() => false)) {
      const label = ((await btn.innerText().catch(() => "")) || "").trim();
      const ok = await btn.click({ timeout: 3000 }).then(() => true, () => false);
      const base = { carrierId: plugin.id, step: 0, tool: "dismiss_cookies", args: { role, name: name.source } };
      if (ok) store.append("step.executed", { ...base, result: `clicked "${label}" to reject optional cookies` });
      else store.append("step.failed", { ...base, error: `could not click "${label}"`, shownToModel: false });
      return;
    }
  }
  store.append("step.executed", { carrierId: plugin.id, step: 0, tool: "dismiss_cookies", args: { role, name: name.source }, result: "cookie text visible but no reject button found; left as is" });
}

// Waits for the plugin's readyText before the model's first turn, without spending turns. Bounded by
// readyTimeoutMs, the carrier's remaining time and the global abort. Records the outcome and never closes the carrier.
async function waitReady(page: Page, plugin: CarrierPlugin, store: RunStore, remainingMs: number, signal?: AbortSignal): Promise<void> {
  const text = plugin.readyText;
  if (!text) return;
  const timeoutMs = Math.max(0, Math.min(plugin.readyTimeoutMs ?? 60_000, remainingMs));
  const args = { text, timeoutMs };
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
  for (;;) {
    const f = await frameShowingText(relevantFrames(page, plugin.allowedDomains), text);
    if (f) {
      store.append("step.executed", { carrierId: plugin.id, step: 0, tool: "wait_ready", args, result: `'${text}' visible after ${secs()} s` });
      return;
    }
    if (signal?.aborted || Date.now() - t0 >= timeoutMs) break;
    await page.waitForTimeout(Math.min(500, Math.max(0, timeoutMs - (Date.now() - t0))));
  }
  store.append("step.failed", {
    carrierId: plugin.id, step: 0, tool: "wait_ready", args, shownToModel: false,
    error: `'${text}' not visible after ${secs()} s${signal?.aborted ? " (aborted by the global cap)" : ""}; the model starts anyway`,
  });
}

// Moves the single rolling cache breakpoint to the last block of the last message.
function setRollingCache(messages: Anthropic.MessageParam[]) {
  for (const m of messages) {
    if (Array.isArray(m.content)) for (const b of m.content) delete (b as { cache_control?: unknown }).cache_control;
  }
  const last = messages[messages.length - 1];
  if (Array.isArray(last.content) && last.content.length) {
    (last.content[last.content.length - 1] as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
  }
}

export async function runCarrier(opts: {
  plugin: CarrierPlugin;
  request: QuoteRequest;
  store: RunStore;
  runDir: string; // runs/<label>/<runId>/
  maxUsd: number;
  // Aborted by the orchestrator's global cost/time cap for the whole quote. The carrier then closes as
  // budget_exhausted with the signal's reason; in-flight model calls are cancelled.
  signal?: AbortSignal;
  client?: Anthropic; // tests inject a fake model; default: the real API client
}): Promise<void> {
  const { plugin, request, store, runDir, signal } = opts;
  const client = opts.client ?? (defaultClient ??= new Anthropic());
  const abortReason = () => capReason.global(signal?.reason instanceof Error ? signal.reason.message : String(signal?.reason ?? "aborted"));
  const traceFile = path.join(runDir, `${plugin.id}.trace.zip`).replace(/\\/g, "/");
  store.append("carrier.started", { carrierId: plugin.id, startUrl: plugin.startUrl, budget: plugin.budget, traceFile });

  const startedAt = Date.now();
  let costUsd = 0;
  let closed = false;
  // Every close by code goes through here. a carrier that already has verified prices is `quoted`
  // whatever stopped it (a cap, stuck, the global cap, a model failure, a wall after the prices); the reason
  // names the cause.
  let tc: ToolContext | undefined;
  const closeByCode = (status: CloseStatus, reason: string, evidenceId?: string) => {
    if (closed) return;
    closed = true;
    const n = tc?.verifiedPrices ?? 0;
    if (n > 0 && status !== "quoted") {
      status = "quoted";
      reason = afterPricesReason(reason, n);
    }
    store.append("carrier.closed", { carrierId: plugin.id, status, reason, closedBy: "code", ...(evidenceId ? { evidenceId } : {}) });
  };

  const session = await openSession({
    allowedDomains: plugin.allowedDomains,
    traceFile,
    onBlocked: (url) => store.append("navigation.blocked", { carrierId: plugin.id, url }),
  });
  const ctx: ToolContext = {
    page: session.page, plugin, store, evidenceDir: path.join(runDir, "evidence"), evidence: new Map(), verifiedPrices: 0,
  };
  tc = ctx;
  // Close as blocked by code, backed by evidence, without spending model turns.
  const closeBlocked = async (reason: string) => {
    const ev = await captureEvidence(ctx, `blocked: ${reason}`).catch(() => null);
    closeByCode("blocked", reason, ev?.evidenceId);
  };
  const detectBlock = async (): Promise<string | null> => {
    const byStatus = blockFromStatus(session.mainStatus());
    if (byStatus) return byStatus;
    const texts: string[] = [];
    for (const f of relevantFrames(session.page, plugin.allowedDomains)) texts.push(await f.locator("body").innerText({ timeout: 3000 }).catch(() => ""));
    return blockFromText(texts.join("\n"));
  };

  try {
    try {
      // The plugin may set it (FedEx: heavy page, timed out at 30 s on 2026-11-18). Default: a third of the
      // carrier's time budget, between 30 and 60 s.
      const navTimeout = plugin.navTimeoutMs ?? Math.min(60_000, Math.max(30_000, Math.round((plugin.budget.maxSeconds * 1000) / 3)));
      await session.page.goto(plugin.startUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
      await session.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    } catch (e) {
      const msg = String(e).split("\n")[0];
      store.append("step.failed", { carrierId: plugin.id, step: 0, tool: "goto", args: { url: plugin.startUrl }, error: msg, shownToModel: false });
      const blocked = blockFromNavError(msg);
      if (blocked) return await closeBlocked(blocked);
      // UPS answered both public URLs with a file download to the automated browser (2026-11-18), while a normal
      // browser loads the page: a probable block, but not a proven bot wall, so it stays `failed`.
      // The plugin's caveat (whenReason: DOWNLOAD_REASON) tells the user what is known about it.
      if (/Download is starting/i.test(msg)) {
        closeByCode("failed", DOWNLOAD_REASON);
        return;
      }
      closeByCode("failed", `could not open start page: ${msg}`);
      return;
    }
    const wall = await detectBlock();
    if (wall) return await closeBlocked(wall);
    await dismissCookies(session.page, plugin, store);
    await waitReady(session.page, plugin, store, plugin.budget.maxSeconds * 1000 - (Date.now() - startedAt), signal);
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildCarrierPrompt(plugin, request), cache_control: { type: "ephemeral" } }];
    const tools: Anthropic.Tool[] = toolDefs.map((t, i) => (i === toolDefs.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: [{ type: "text", text: "Start. Call view_page first." }] }];

    let lastView: { block: Anthropic.ToolResultBlockParam; seq: number } | null = null;
    const seen = new Map<string, number>();
    let nudged = false;
    // Appends the turns-left notice (if any) for the turns after `step`, and records it.
    const withNotice = (content: Anthropic.ContentBlockParam[], step: number): Anthropic.ContentBlockParam[] => {
      const text = TURNS_LEFT_NOTICE[plugin.budget.maxSteps - step];
      if (!text) return content;
      store.append("carrier.notice", { carrierId: plugin.id, step, text });
      return [...content, { type: "text", text }];
    };

    for (let step = 1; ; step++) {
      const elapsed = (Date.now() - startedAt) / 1000;
      if (signal?.aborted) return closeByCode("budget_exhausted", abortReason());
      if (step > plugin.budget.maxSteps) return closeByCode("budget_exhausted", capReason.steps(plugin.budget.maxSteps));
      if (elapsed > plugin.budget.maxSeconds) return closeByCode("budget_exhausted", capReason.time(plugin.budget.maxSeconds));
      if (costUsd > opts.maxUsd) return closeByCode("budget_exhausted", capReason.cost(costUsd, opts.maxUsd));

      setRollingCache(messages);
      let response: Anthropic.Message;
      try {
        response = await client.messages.create(
          { model: MODEL, max_tokens: 4000, system, tools, messages },
          {
            signal: AbortSignal.any([
              AbortSignal.timeout(Math.ceil(Math.max(5, plugin.budget.maxSeconds - elapsed) * 1000)),
              ...(signal ? [signal] : []),
            ]),
          },
        );
      } catch (e) {
        store.append("step.failed", { carrierId: plugin.id, step, tool: "model", args: null, error: String(e).split("\n")[0], shownToModel: false });
        if (signal?.aborted) return closeByCode("budget_exhausted", abortReason());
        return closeByCode(elapsed > plugin.budget.maxSeconds - 5 ? "budget_exhausted" : "failed", `model call failed: ${String(e).split("\n")[0]}`);
      }
      const stepCost = costOf(response.model, response.usage as Usage);
      costUsd += stepCost;
      store.append("model.response", {
        carrierId: plugin.id, step, model: response.model, stopReason: response.stop_reason, usage: response.usage as Usage, costUsd: stepCost,
        text: response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n"),
      });
      messages.push({ role: "assistant", content: response.content as Anthropic.ContentBlockParam[] });

      const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) {
        if (ctx.verifiedPrices > 0) return closeByCode("quoted", "model stopped after reporting verified prices");
        if (nudged) return closeByCode("failed", "model stopped without report_price or close_carrier");
        nudged = true;
        store.append("carrier.notice", { carrierId: plugin.id, step, text: NUDGE });
        messages.push({ role: "user", content: withNotice([{ type: "text", text: NUDGE }], step) });
        continue;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      let stuck = false;
      for (const use of uses) {
        // Once closed (by the model in this same turn), remaining calls are not executed.
        if (ctx.closed || stuck) {
          results.push({ type: "tool_result", tool_use_id: use.id, content: "Not executed: carrier already closed.", is_error: true });
          continue;
        }
        let viewHash: string | undefined;
        if (!NO_LOOP_CHECK.has(use.name)) {
          // Page fingerprint = URL + view hash + scroll positions: acting again after scrolling is not "no progress".
          viewHash = (await compactView(session.page, plugin.allowedDomains).catch(() => null))?.hash;
          const scroll = scrollSignature(await readScroll(session.page, relevantFrames(session.page, plugin.allowedDomains)).catch(() => []));
          const key = `${use.name}|${JSON.stringify(use.input)}|${session.page.url()}|${viewHash}|${scroll}`;
          const n = (seen.get(key) ?? 0) + 1;
          seen.set(key, n);
          if (n >= 3) {
            const error = "stuck: same action on the same page a third time";
            store.append("step.failed", { carrierId: plugin.id, step, tool: use.name, args: use.input, error, shownToModel: true });
            results.push({ type: "tool_result", tool_use_id: use.id, content: error, is_error: true });
            stuck = true;
            continue;
          }
          if (n === 2) {
            const error = "No progress: you already did exactly this on this same page and nothing changed. Try something different or close_carrier.";
            store.append("step.failed", { carrierId: plugin.id, step, tool: use.name, args: use.input, error, shownToModel: true });
            results.push({ type: "tool_result", tool_use_id: use.id, content: error, is_error: true });
            continue;
          }
        }
        try {
          const out = await executeTool(ctx, use.name, use.input);
          const seq = store.append("step.executed", { carrierId: plugin.id, step, tool: use.name, args: use.input, result: out.content, viewHash: out.viewHash ?? viewHash });
          const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: use.id, content: out.content };
          if (out.isView) {
            // Elide only the view that just got superseded; older ones are already short, so the cached prefix survives.
            if (lastView) lastView.block.content = `[previous view omitted, see event ${lastView.seq}]`;
            lastView = { block, seq };
          }
          results.push(block);
        } catch (e) {
          const msg = e instanceof ToolError ? e.message : `Tool ${use.name} failed: ${describeError(e)}`;
          store.append("step.failed", { carrierId: plugin.id, step, tool: use.name, args: use.input, error: msg, shownToModel: true });
          results.push({ type: "tool_result", tool_use_id: use.id, content: msg, is_error: true });
        }
      }
      // After a close or a stuck action there is no next turn: no turns-left notice.
      messages.push({ role: "user", content: ctx.closed || stuck ? results : withNotice(results, step) });

      if (ctx.closed) return;
      if (stuck) return closeByCode("budget_exhausted", capReason.stuck);
      // A wall can appear after submitting a form: check before spending another model turn.
      const wallAfter = await detectBlock();
      if (wallAfter) return await closeBlocked(wallAfter);
    }
  } finally {
    if (!closed && !hasClosingEvent(store, plugin.id)) closeByCode("failed", "carrier loop ended without a closing event");
    await session.close();
  }
}

// Safety net: checks the record (not memory) for a closing event of this carrier.
function hasClosingEvent(store: RunStore, carrierId: string): boolean {
  return store.events().some((e) => e.type === "carrier.closed" && e.carrierId === carrierId);
}
