// Orchestrator: implements the contract in ./types.ts.
// Validates the request, skips carriers whose needs are missing, runs the rest in parallel (one browser
// context each, inside runCarrier), enforces a global cost/time cap per quote through an AbortSignal,
// records total.computed for identical parcels, and records run.finished when every carrier has closed.
// Replay mode (REPLAY_RUN=<jsonl>): re-emits a recorded run into a NEW record with its original timing,
// without opening a browser or calling a model.
// Safe by default: live mode (real browsers against carrier sites, real model calls) must be asked for
// explicitly with mode: "live". createOrchestrator() with no configuration refuses to run live.
import path from "node:path";
import { validateRequest, type QuoteRequest } from "../domain/request.js";
import { computeTotal } from "../domain/money.js";
import { carriers as registry } from "../carriers/index.js";
import { missingNeeds, type CarrierPlugin } from "../carriers/types.js";
import { RunStore, readEvents } from "../record/store.js";
import { fold, type RunState } from "../record/state.js";
import type { EventType, RunEvent } from "../record/events.js";
import type { Orchestrator, StartQuoteOptions } from "./types.js";

export type RunCarrierFn = (opts: {
  plugin: CarrierPlugin;
  request: QuoteRequest;
  store: RunStore;
  runDir: string;
  maxUsd: number;
  signal?: AbortSignal;
}) => Promise<void>;

export interface OrchestratorConfig {
  // "live" = real carrier runs; must be explicit. "replay" requires replayFile. Omitted: replay if replayFile
  // is set, otherwise the orchestrator refuses to start quotes (unless runCarrier is injected, as in tests).
  mode?: "live" | "replay";
  runsRoot?: string; // default "runs"
  maxUsd?: number; // global cost cap per quote (all carriers together)
  maxSeconds?: number; // global time cap per quote
  carrierMaxUsd?: number; // per-carrier cost cap passed to runCarrier
  replayFile?: string; // replay mode when set
  replaySpeed?: number; // 1 = original timing; >1 faster (tests)
  carriers?: Record<string, CarrierPlugin>; // default: the registry
  runCarrier?: RunCarrierFn; // injectable for tests; default: agent/carrierAgent.runCarrier (lazy import)
}

interface ActiveRun {
  store: RunStore;
  done: Promise<RunState>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Typed append for events copied from another record (replay) whose type is only known at runtime.
function appendRaw(store: RunStore, type: EventType, data: unknown): number {
  return (store.append as (t: EventType, d: unknown) => number)(type, data);
}

// The app's entry points (server, measure-after) state the mode through the environment: REPLAY_RUN set =
// replay, otherwise live.
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  return {
    mode: env.REPLAY_RUN ? "replay" : "live",
    maxUsd: Number(env.QUOTE_MAX_USD ?? 3),
    maxSeconds: Number(env.QUOTE_MAX_SECONDS ?? 300),
    carrierMaxUsd: Number(env.CARRIER_MAX_USD ?? 1),
    replayFile: env.REPLAY_RUN || undefined,
    replaySpeed: Number(env.REPLAY_SPEED ?? 1),
  };
}

export class LiveModeRefused extends Error {}

// Throws (before any record, browser or model call) unless the requested mode is consistent and explicit.
function checkMode(config: OrchestratorConfig): void {
  if (config.mode === "replay" && !config.replayFile) throw new LiveModeRefused("replay mode needs replayFile");
  if (config.replayFile) {
    if (config.mode === "live") throw new LiveModeRefused("conflicting configuration: mode is live but replayFile is set");
    return;
  }
  if (config.runCarrier) return; // injected carrier runner (tests): no real browser
  if (config.mode !== "live") {
    throw new LiveModeRefused(
      'refusing to run live: pass { mode: "live" } explicitly (or configFromEnv()), or set replayFile for replay',
    );
  }
  // Catches the mistake of setting REPLAY_RUN but building the orchestrator without reading it.
  if (process.env.REPLAY_RUN) throw new LiveModeRefused("refusing to run live: REPLAY_RUN is set in the environment but this orchestrator was configured as live");
}

export function createOrchestrator(config: OrchestratorConfig = {}): Orchestrator & { isReplay: boolean } {
  const runsRoot = config.runsRoot ?? "runs";
  const plugins = config.carriers ?? registry;
  const runs = new Map<string, ActiveRun>();

  async function getRunCarrier(): Promise<RunCarrierFn> {
    if (config.runCarrier) return config.runCarrier;
    // Lazy: the carrier agent loads the browser and the API client; tests and replay never need them.
    const mod = await import("../agent/carrierAgent.js");
    return mod.runCarrier;
  }

  // Records total.computed immediately after each price.verified when the request has identical parcels.
  // The nested append lands on disk right after the price (seq N+1); subscribe() delivers in seq order,
  // so every subscriber sees the price before its total.
  function watchTotals(store: RunStore) {
    let count = 1;
    return store.subscribe((e) => {
      if (e.type === "request.validated") count = e.request.count ?? 1;
      if (e.type === "price.verified" && count > 1) {
        const { total, formula } = computeTotal(e.amount, count, e.currency);
        store.append("total.computed", {
          carrierId: e.carrierId, service: e.service, count, unitAmount: e.amount, total, currency: e.currency, formula, evidenceId: e.evidenceId,
          priceSeq: e.seq,
        });
      }
    });
  }

  async function runLive(store: RunStore, runId: string, input: unknown, carrierIds: string[]): Promise<"completed" | "cap_cost" | "cap_time" | "error"> {
    const v = validateRequest(input);
    const unknown = carrierIds.filter((id) => !plugins[id]);
    if (!v.ok || unknown.length) {
      const errors = [...(v.ok ? [] : v.errors), ...unknown.map((id) => `unknown carrier '${id}' (known: ${Object.keys(plugins).join(", ")})`)];
      store.append("request.invalid", { errors });
      return "error";
    }
    store.append("request.validated", { request: v.request });

    const controller = new AbortController();
    let capStatus: "cap_cost" | "cap_time" | null = null;
    let spent = 0;
    const maxUsd = config.maxUsd ?? Infinity;
    const offCost = store.subscribe((e) => {
      if (e.type !== "model.response") return;
      spent += e.costUsd;
      if (spent > maxUsd && !capStatus) {
        capStatus = "cap_cost";
        controller.abort(new Error(`quote cost cap reached ($${spent.toFixed(3)} > $${maxUsd})`));
      }
    });
    const maxSeconds = config.maxSeconds ?? Infinity;
    const timer = Number.isFinite(maxSeconds)
      ? setTimeout(() => {
          if (!capStatus) capStatus = "cap_time";
          controller.abort(new Error(`quote time cap reached (${maxSeconds}s)`));
        }, maxSeconds * 1000)
      : undefined;

    const runCarrier = await getRunCarrier();
    const runDir = path.join(store.dir, runId);
    await Promise.all(
      carrierIds.map(async (id) => {
        const plugin = plugins[id];
        const missing = missingNeeds(plugin, v.request);
        if (missing.length) {
          store.append("carrier.skipped", { carrierId: id, missing });
          return;
        }
        try {
          await runCarrier({ plugin, request: v.request, store, runDir, maxUsd: config.carrierMaxUsd ?? 1, signal: controller.signal });
        } catch (e) {
          // runCarrier should always close; this is the safety net so the quote can still finish.
          const closed = store.events().some((x) => x.type === "carrier.closed" && x.carrierId === id);
          if (!closed) store.append("carrier.closed", { carrierId: id, status: "failed", reason: `carrier run crashed: ${String(e).split("\n")[0]}`, closedBy: "code" });
        }
      }),
    );
    clearTimeout(timer);
    offCost();
    return capStatus ?? "completed";
  }

  // If the user's request is valid it replaces the recorded one (so count, preference and extras can be
  // exercised in dev); the carrier events are the recorded ones either way. Totals are recomputed live.
  async function runReplay(store: RunStore, source: RunEvent[], userRequest: QuoteRequest | null): Promise<"completed"> {
    const speed = config.replaySpeed && config.replaySpeed > 0 ? config.replaySpeed : 1;
    let prev = source.find((e) => e.type === "run.started")?.ms ?? 0;
    if (userRequest) store.append("request.validated", { request: userRequest });
    for (const e of source) {
      if (e.type === "run.started" || e.type === "run.finished" || e.type === "total.computed") continue; // ours, not the source's
      if (userRequest && (e.type === "request.validated" || e.type === "request.invalid")) continue;
      const wait = (e.ms - prev) / speed;
      prev = e.ms;
      if (wait > 0) await sleep(wait);
      const { seq: _s, t: _t, ms: _m, type, ...data } = e;
      appendRaw(store, type, data);
    }
    return "completed";
  }

  return {
    isReplay: Boolean(config.replayFile),

    async startQuote(request: unknown, carrierIds: string[], opts: StartQuoteOptions = {}): Promise<string> {
      checkMode(config);
      const label = opts.label ?? "app";
      const replaySource = config.replayFile ? readEvents(config.replayFile) : null;
      const ids = replaySource
        ? fold(replaySource).carrierIds
        : carrierIds.length ? [...new Set(carrierIds)] : Object.keys(plugins);
      const runId = `${replaySource ? "replay" : "quote"}-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
      const store = new RunStore(path.join(runsRoot, label), runId);
      store.append("run.started", { runId, label, carrierIds: ids, ...(config.replayFile ? { replayOf: config.replayFile } : {}) });
      const offTotals = watchTotals(store);

      const done = (async () => {
        let status: "completed" | "cap_cost" | "cap_time" | "error";
        let error: string | undefined;
        try {
          if (replaySource) {
            const v = validateRequest(request);
            status = await runReplay(store, replaySource, v.ok ? v.request : null);
          } else {
            status = await runLive(store, runId, request, ids);
          }
          if (status === "error") error = "invalid request";
        } catch (e) {
          status = "error";
          error = String(e);
        }
        offTotals();
        store.append("run.finished", { status, ...(error ? { error } : {}) });
        return fold(store.events());
      })();
      runs.set(runId, { store, done });
      return runId;
    },

    subscribe(runId: string, onEvent: (event: RunEvent) => void): () => void {
      const run = runs.get(runId);
      if (!run) throw new Error(`unknown run '${runId}'`);
      // Delivers strictly in seq order, without duplicates: what is on disk first, then live events.
      // Live events can arrive out of order when a listener appends from inside a notification
      // (total.computed), so they are held until the previous seq has been delivered.
      let lastSeq = 0;
      const pending = new Map<number, RunEvent>();
      const flush = () => {
        while (pending.has(lastSeq + 1)) {
          const e = pending.get(lastSeq + 1)!;
          pending.delete(lastSeq + 1);
          lastSeq = e.seq;
          onEvent(e);
        }
      };
      const off = run.store.subscribe((e) => {
        if (e.seq <= lastSeq) return;
        pending.set(e.seq, e);
        flush();
      });
      for (const e of run.store.events()) {
        if (e.seq <= lastSeq) continue;
        pending.delete(e.seq);
        lastSeq = e.seq;
        onEvent(e);
      }
      flush();
      return off;
    },

    finished(runId: string): Promise<RunState> {
      const run = runs.get(runId);
      if (!run) return Promise.reject(new Error(`unknown run '${runId}'`));
      return run.done;
    },
  };
}
