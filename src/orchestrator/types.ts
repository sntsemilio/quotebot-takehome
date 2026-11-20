// Contract between the conversation/UI (line B) and the carrier runs (line A). Signatures only:
// line B implements them in src/orchestrator/.
//
// Behavior the implementation must honor:
// - startQuote validates the request in code (domain/request.ts). Invalid -> request.invalid, no browser opens.
// - For each carrier: if missingNeeds(plugin, request) is non-empty -> carrier.skipped (terminal, folds to
//   needs_human); otherwise runCarrier() in parallel, one BrowserContext per carrier.
// - Per-carrier caps come from the plugin; a global cost/time cap per quote aborts runCarrier via its signal.
// - total.computed for each verified price when request.count > 1. Ranking by preference uses ONLY
//   verified prices from the folded record.
// - The quote is finished when every carrier has closed or been skipped -> run.finished.
// - Replay mode: with env REPLAY_RUN=<path to a recorded JSONL>, startQuote re-emits that run's events with
//   their original timing, without opening a browser or calling the model.
import type { RunEvent } from "../record/events.js";
import type { RunState } from "../record/state.js";

export interface StartQuoteOptions {
  label?: string; // runs/<label>/ (default "app")
}

export interface Orchestrator {
  // Starts the quote and resolves with its runId as soon as run.started is recorded (does not wait for carriers).
  // `request` is unvalidated input: validation is part of the run and recorded.
  startQuote(request: unknown, carrierIds: string[], opts?: StartQuoteOptions): Promise<string>;
  // Delivers every event of the run in order: the ones already recorded first, then live ones.
  // Returns an unsubscribe function.
  subscribe(runId: string, onEvent: (event: RunEvent) => void): () => void;
  // Resolves with the folded state once run.finished is recorded.
  finished(runId: string): Promise<RunState>;
}
