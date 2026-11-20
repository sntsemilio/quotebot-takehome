// Event types of the run record (expediente). Each event is one JSONL line; past events are never edited.
// Fields marked "legacy" exist only so step-1 records (e.g. the Estafeta run used for replay) still fold.
import type { ExtraKey, QuoteRequest } from "../domain/request.js";
import type { Memory } from "../memory/memories.js";

export type CloseStatus = "quoted" | "blocked" | "failed" | "no_coverage" | "needs_human" | "budget_exhausted";

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

// One screenshot of an evidence capture. A capture may scroll each frame and take several.
export interface EvidenceImage {
  index: number; // position within this capture's images
  file: string; // path under runs/, forward slashes
  frame: string; // "main" or the iframe URL
  scrollY: number; // vertical scroll offset of that frame when taken
  // Visible text inside this image only. Makes the price -> image association auditable from the JSONL:
  // price.verified.imageIndex points to the first image whose text contains the priceText.
  text?: string;
}

// A site notice copied verbatim from the evidence ("Cotización Aproximada", "Los precios incluyen I.V.A.").
export type SiteNote = string;

export interface OptionalChargeReported {
  name: string;
  amountText: string; // exactly as shown, e.g. "$348.00"
}
export interface OptionalChargeVerified extends OptionalChargeReported {
  amount: number; // parsed in code from amountText
}

// The site's own price breakdown backing includesVAT true, e.g. FedEx's
// { vatLine: "IVA $73.19", totalLine: "Total estimado $530.64" }. Both lines are copied from the evidence; code checks
// they appear there, that vatLine is about VAT with an amount > 0, and that totalLine's amount is the reported price.
// Code never computes VAT.
export interface VatBreakdown {
  vatLine: string;
  totalLine: string;
}

export interface EventPayloads {
  "run.started": {
    runId: string;
    label: string;
    carrierIds?: string[];
    carrierId?: string; // legacy (one carrier per run)
    requestFile?: string; // only when the request came from a file (harness)
    replayOf?: string; // replay mode: path of the recorded JSONL being re-emitted (no browser, no carrier model)
  };
  // One turn of the conversation with the user. Written to the conversation's own record
  // (runs/<label>/conversation-<id>.jsonl); runId links the turn that started a quote to that quote's record.
  "conversation.turn": {
    conversationId: string;
    role: "user" | "assistant" | "tool";
    text: string;
    runId?: string;
    model?: string;
    costUsd?: number; // cost of the model call(s) that produced this turn
    // Set on turns produced by model calls since the previous turn; absent on user turns and older records.
    stopReason?: string | null; // stop_reason of the last of those calls ("end_turn", "max_tokens", "tool_use"...)
    outputTokens?: number; // output tokens of those calls, thinking included
    thinkingBlocks?: number; // thinking/redacted_thinking blocks in those responses (Haiku 5.5 thinks by default)
    // The model's reply had sentences with an amount; code removed them before showing it.
    redacted?: boolean;
    redactedSentences?: number;
    // On a user turn, the memories its #slugs resolved to, with the values used then (a later edit of the
    // memory never changes this record).
    memoriesUsed?: { slug: string; value: string }[];
  };
  // The memories' own record (runs/app/memory.jsonl), append-only; memory/memories.ts folds it.
  "memory.set": { memory: Memory };
  "memory.deleted": { slug: string };
  "request.validated": { request: QuoteRequest };
  "request.invalid": { errors: string[] };
  // Not launched because the request lacks data the site requires. Terminal: folds to needs_human.
  "carrier.skipped": { carrierId: string; missing: { field: ExtraKey; why: string }[] };
  "carrier.started": { carrierId: string; startUrl: string; budget: { maxSteps: number; maxSeconds: number }; traceFile: string };
  "model.response": {
    carrierId: string;
    step: number;
    model: string;
    stopReason: string | null;
    usage: Usage;
    costUsd: number;
    text: string;
  };
  "step.executed": { carrierId: string; step: number; tool: string; args: unknown; result: string; viewHash?: string };
  // shownToModel: true when the error went back to the model as an is_error tool result; false for harness
  // failures the model never saw (goto, cookies, wait_ready, the model call itself). Absent in older records.
  "step.failed": { carrierId: string; step: number; tool: string; args: unknown; error: string; shownToModel: boolean };
  // Text the harness added to the model's input on its own (turns-left warning, the nudge to finish).
  "carrier.notice": { carrierId: string; step: number; text: string };
  "navigation.blocked": { carrierId: string; url: string };
  "evidence.captured": {
    carrierId: string;
    evidenceId: string;
    reason: string;
    url: string;
    text: string; // full visible text of all relevant frames: the verification source
    capturedAt: string;
    images?: EvidenceImage[];
    screenshot?: string; // legacy (one full-page screenshot)
  };
  "price.reported": {
    carrierId: string;
    service: string;
    priceText: string;
    amount: number;
    currency: string;
    includesVAT: boolean | null;
    deliveryDays: string | null;
    evidenceId: string;
    siteNotes?: SiteNote[];
    optionalCharges?: OptionalChargeReported[];
    vatBreakdown?: VatBreakdown;
  };
  "price.verified": {
    carrierId: string;
    service: string;
    amount: number;
    currency: string;
    // true/false only when a verified site note says so with the same polarity, or true when a verified
    // vatBreakdown backs it; else null.
    includesVAT: boolean | null;
    deliveryDays: string | null;
    // What the agent reported as delivery when it was not on the page (deliveryDays is then null).
    deliveryDaysDropped?: string;
    priceText: string;
    evidenceId: string;
    siteNotes?: SiteNote[]; // only the verified ones
    optionalCharges?: OptionalChargeVerified[]; // only the verified ones
    vatBreakdown?: VatBreakdown; // only when verified
    imageIndex?: number; // image of the evidence where priceText appears
  };
  "price.rejected": { carrierId: string; service: string; priceText: string; evidenceId: string; reason: string };
  // N identical parcels x one verified price. Amounts in currency units, computed in integer cents.
  "total.computed": {
    carrierId: string;
    service: string;
    count: number;
    unitAmount: number;
    total: number;
    currency: string;
    formula: string; // e.g. "3 x 450.00 MXN = 1350.00 MXN"
    evidenceId: string;
    // Seq of the price.verified this total belongs to (missing in older records). A site can show
    // the same service twice with different dates and prices, so service + evidenceId does not identify a price.
    priceSeq: number;
  };
  "carrier.closed": {
    carrierId: string;
    status: CloseStatus;
    reason: string;
    evidenceId?: string;
    closedBy: "model" | "code";
    // The site's own message, verified in code against evidenceId's text (max 200 chars).
    siteMessage?: string;
    // The site rejected this postal code of the request (invalid, unknown, not found). Only with needs_human + siteMessage.
    rejectedZip?: "origin" | "destination";
  };
  "run.finished": { status: "completed" | "cap_cost" | "cap_time" | "error"; error?: string };
}

export type EventType = keyof EventPayloads;

export type RunEvent = {
  [K in EventType]: { seq: number; t: string; ms: number; type: K } & EventPayloads[K];
}[EventType];
