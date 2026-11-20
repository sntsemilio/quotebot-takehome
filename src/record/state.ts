// Folds the event log into the current state. Pure function: the record is the source of truth,
// so a carrier's result is whatever its events say, never the model's prose.
// Also folds step-1 records (legacy run.started.carrierId and evidence.captured.screenshot).
import type { CloseStatus, EvidenceImage, OptionalChargeVerified, RunEvent, VatBreakdown } from "./events.js";
import type { ExtraKey, QuoteRequest } from "../domain/request.js";

export interface VerifiedPrice {
  service: string;
  amount: number;
  currency: string;
  includesVAT: boolean | null;
  deliveryDays: string | null;
  priceText: string;
  evidenceId: string;
  siteNotes: string[];
  optionalCharges: OptionalChargeVerified[];
  vatBreakdown?: VatBreakdown; // the site's breakdown that backs includesVAT true
  // The image where the price appears, or the evidence's only/first image if not located.
  image?: string;
  // Present when count > 1 and a total.computed event exists for this price.
  total?: { count: number; total: number; formula: string };
  seq?: number; // seq of its price.verified event (total.computed points to it)
}

export interface CarrierState {
  status: CloseStatus | "running";
  reason?: string;
  closedBy?: "model" | "code";
  evidenceId?: string;
  siteMessage?: string; // the site's own message given at close, verified against the evidence
  rejectedZip?: "origin" | "destination"; // the request's postal code the site rejected
  skipped?: { missing: { field: ExtraKey; why: string }[] }; // set when never launched (status needs_human)
  prices: VerifiedPrice[];
  rejectedPrices: number;
  steps: number;
  toolCalls: number;
  failedToolCalls: number;
  blockedNavigations: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  maxInputPerStep: number;
  costUsd: number;
  startedMs: number;
  closedMs?: number;
}

export interface RunState {
  runId?: string;
  replayOf?: string;
  carrierIds: string[];
  request?: QuoteRequest;
  requestErrors?: string[];
  carriers: Record<string, CarrierState>;
  evidence: Record<string, { carrierId: string; url: string; images: EvidenceImage[] }>;
  finished?: { status: string; error?: string; ms: number };
}

function emptyCarrier(ms: number): CarrierState {
  return {
    status: "running", prices: [], rejectedPrices: 0, steps: 0, toolCalls: 0, failedToolCalls: 0, blockedNavigations: 0,
    inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, maxInputPerStep: 0, costUsd: 0, startedMs: ms,
  };
}

// Sets a terminal status once; later closing events for the same carrier are ignored (first close wins).
function close(
  x: CarrierState, status: CloseStatus, reason: string, ms: number, closedBy: "model" | "code",
  extra: { evidenceId?: string; siteMessage?: string; rejectedZip?: "origin" | "destination" } = {},
) {
  if (x.status !== "running") return;
  x.status = status;
  x.reason = reason;
  x.closedBy = closedBy;
  x.evidenceId = extra.evidenceId;
  if (extra.siteMessage) x.siteMessage = extra.siteMessage;
  if (extra.rejectedZip) x.rejectedZip = extra.rejectedZip;
  x.closedMs = ms;
}

export function fold(events: RunEvent[]): RunState {
  const s: RunState = { carriers: {}, carrierIds: [], evidence: {} };
  const c = (id: string, ms: number) => (s.carriers[id] ??= emptyCarrier(ms));

  for (const e of events) {
    switch (e.type) {
      case "run.started":
        s.runId = e.runId;
        s.carrierIds = e.carrierIds ?? (e.carrierId ? [e.carrierId] : []);
        if (e.replayOf) s.replayOf = e.replayOf;
        break;
      case "request.validated": s.request = e.request; break;
      case "request.invalid": s.requestErrors = e.errors; break;
      case "carrier.skipped": {
        const x = c(e.carrierId, e.ms);
        x.skipped = { missing: e.missing };
        close(x, "needs_human", `missing: ${e.missing.map((m) => `${m.field} (${m.why})`).join("; ")}`, e.ms, "code");
        break;
      }
      case "carrier.started": c(e.carrierId, e.ms); break;
      case "model.response": {
        const x = c(e.carrierId, e.ms);
        const inTok = (e.usage.input_tokens ?? 0) + (e.usage.cache_creation_input_tokens ?? 0) + (e.usage.cache_read_input_tokens ?? 0);
        x.steps++;
        x.inputTokens += e.usage.input_tokens ?? 0;
        x.outputTokens += e.usage.output_tokens ?? 0;
        x.cacheWriteTokens += e.usage.cache_creation_input_tokens ?? 0;
        x.cacheReadTokens += e.usage.cache_read_input_tokens ?? 0;
        x.maxInputPerStep = Math.max(x.maxInputPerStep, inTok);
        x.costUsd += e.costUsd;
        break;
      }
      case "step.executed": c(e.carrierId, e.ms).toolCalls++; break;
      case "step.failed": { const x = c(e.carrierId, e.ms); x.toolCalls++; x.failedToolCalls++; break; }
      case "carrier.notice": break; // recorded for audit; does not change the state
      case "navigation.blocked": c(e.carrierId, e.ms).blockedNavigations++; break;
      case "evidence.captured": {
        const images: EvidenceImage[] = e.images ?? (e.screenshot ? [{ index: 0, file: e.screenshot, frame: "main", scrollY: 0 }] : []);
        s.evidence[e.evidenceId] = { carrierId: e.carrierId, url: e.url, images };
        break;
      }
      case "price.verified": {
        const imgs = s.evidence[e.evidenceId]?.images ?? [];
        const img = (e.imageIndex !== undefined ? imgs.find((i) => i.index === e.imageIndex) : undefined) ?? imgs[0];
        c(e.carrierId, e.ms).prices.push({
          service: e.service, amount: e.amount, currency: e.currency, includesVAT: e.includesVAT,
          deliveryDays: e.deliveryDays, priceText: e.priceText, evidenceId: e.evidenceId,
          siteNotes: e.siteNotes ?? [], optionalCharges: e.optionalCharges ?? [], image: img?.file, seq: e.seq,
          ...(e.vatBreakdown ? { vatBreakdown: e.vatBreakdown } : {}),
        });
        break;
      }
      case "price.rejected": c(e.carrierId, e.ms).rejectedPrices++; break;
      case "total.computed": {
        // The exact price by priceSeq. Older records have no priceSeq: the first price with the same
        // service, evidence and amount that has no total yet.
        const prices = c(e.carrierId, e.ms).prices;
        const p = e.priceSeq !== undefined
          ? prices.find((q) => q.seq === e.priceSeq)
          : prices.find((q) => q.service === e.service && q.evidenceId === e.evidenceId && q.amount === e.unitAmount && !q.total);
        if (p) p.total = { count: e.count, total: e.total, formula: e.formula };
        break;
      }
      case "carrier.closed":
        close(c(e.carrierId, e.ms), e.status, e.reason, e.ms, e.closedBy, { evidenceId: e.evidenceId, siteMessage: e.siteMessage, rejectedZip: e.rejectedZip });
        break;
      case "run.finished": s.finished = { status: e.status, error: e.error, ms: e.ms }; break;
    }
  }
  return s;
}
