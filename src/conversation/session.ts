// One conversation with the small model (claude-haiku-5-5). It collects data and starts quotes through
// request_quote; when a quote finishes it writes a short note from a digest WITHOUT amounts. The prices the
// user sees are painted by code from the record, so the model cannot misquote a number.
import Anthropic from "@anthropic-ai/sdk";
import { carriers as registry } from "../carriers/index.js";
import type { CarrierPlugin } from "../carriers/types.js";
import { todayInBusinessTz } from "../domain/dates.js";
import { PRICES } from "../domain/pricing.js";
import { MONEY } from "../domain/money.js";
import type { Orchestrator } from "../orchestrator/types.js";
import type { RunEvent, Usage } from "../record/events.js";
import { RunStore } from "../record/store.js";
import { buildQuoteView, rejectionSentence, unconfirmedZipSentence, zipQuestion, type CarrierView, type QuoteView } from "../orchestrator/view.js";
import { buildConversationPrompt, RESULT_NOTE_PROMPT } from "./prompt.js";
import { prepareQuote, requestQuoteTool, startedMessage, type FollowUpContext, type QuoteDefaults } from "./requestQuote.js";
import { memoryLine, type ResolvedMessage } from "../memory/context.js";

export const CONVERSATION_MODEL = process.env.CONVERSATION_MODEL ?? "claude-haiku-5-5";
const MAX_TURNS_PER_MESSAGE = 4;
// The result note's call. Haiku 5.5 thinks by default (adaptive thinking, effort "medium") and thinking
// counts against max_tokens, so the old 300-token cap cut notes. Per the Haiku 5.5 migration guide, effort is the
// control (at "low" it barely thinks on simple tasks); thinking is left unset rather than disabled.
const NOTE_MAX_TOKENS = 1024;
const NOTE_EFFORT = "low" as const;

// "model": the model's note (plus guards). "fallback": code note because the model's note was empty, had money or
// the call failed. "fallback:<stop_reason>": the model's response did not end normally (e.g. cut by max_tokens).
export type NoteSource = "model" | "fallback" | `fallback:${string}`;

export interface ConversationUsage {
  calls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  models: string[];
}

export interface TurnLog {
  role: "user" | "assistant" | "tool";
  text: string;
}

// MONEY (an amount in a text) lives in domain/money.ts, so the view can use it too. A note with one is
// replaced; a chat sentence with one is removed; a site note with one never reaches the note's digest.
export { MONEY };

// The text shown when every sentence of a reply had an amount.
export const AMOUNTS_REMOVED = "Los precios aparecen en la tabla de la cotización, copiados de la página de cada paquetería.";

// Removes every sentence with an amount from a chat reply (prices only come from the verified table). Sentences end
// at . ! ? or …, and a Spanish question starting with ¿ is its own sentence, so "Te sale en $350, ¿me das las medidas?"
// keeps the question. Lines are kept; a line left empty by the removal is dropped.
export function redactAmounts(text: string): { text: string; removed: number } {
  let removed = 0;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) { lines.push(line); continue; }
    const kept = line.split(/(?<=[.!?…])\s+|\s+(?=¿)/).filter((s) => {
      if (!MONEY.test(s)) return true;
      removed++;
      return false;
    });
    if (kept.length) lines.push(kept.join(" "));
  }
  const out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: out || (removed ? AMOUNTS_REMOVED : ""), removed };
}

let sharedClient: Anthropic | null = null;
function defaultClient(): Anthropic {
  return (sharedClient ??= new Anthropic());
}

export function costOf(model: string, u: Usage): number {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  if (!key) return 0;
  const p = PRICES[key];
  return ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output +
    (u.cache_creation_input_tokens ?? 0) * p.cacheWrite + (u.cache_read_input_tokens ?? 0) * p.cacheRead) / 1_000_000;
}

// Collects every recorded event of a finished run through the orchestrator contract.
export function collectEvents(orchestrator: Orchestrator, runId: string): RunEvent[] {
  const events: RunEvent[] = [];
  const off = orchestrator.subscribe(runId, (e) => events.push(e));
  off();
  return events;
}

// Digest for the result note: statuses, ranking order, notices and zip resolution. No amounts on purpose.
export function resultDigest(view: QuoteView): string {
  const pref = view.request?.preference;
  const lines: string[] = [];
  // Without a preference in the request nobody chose: the note must not say the user did.
  lines.push(pref
    ? `Priority chosen by the user: ${pref.priority}${pref.deadline ? `, deadline ${pref.deadline}` : ""}`
    : "Order: by price, the app's default. The user did not choose a priority: never say they chose one.");
  lines.push("Carriers:");
  for (const c of view.carriers) {
    // Carriers waiting for data are not in the digest at all (the chat already asked for it, rule 8): what
    // the model does not receive it cannot misreport (e.g. "not available in the app").
    if (isSkipped(c)) continue;
    // The message without the plugin's caveat; code adds the caveat once, verbatim (else the note says it twice).
    lines.push(`- ${c.name}: ${c.status}. ${withoutCaveat(c)}`);
    // Why a launched carrier gave no price, in the agent's (or code's) own words, so the note can explain
    // it. Marked as such: it is never the site's message.
    if (c.status !== "quoted" && c.detail) lines.push(`  agent's account (not the site's words): "${c.detail}"`);
  }
  lines.push("Options in ranking order (prices are in the app's table):");
  if (!view.ranked.length) lines.push("- none");
  for (const r of view.ranked) {
    const name = view.carriers.find((c) => c.carrierId === r.carrierId)?.name ?? r.carrierId;
    const delivery = deliveryText(r.delivery, name);
    const deadline = r.meetsDeadline === null ? "" : r.meetsDeadline ? ", meets the deadline" : ", does NOT meet the deadline";
    // A site note with an amount (a breakdown line, "Tarifa base $397.78") never reaches the note's model.
    const wordsOnly = r.price.siteNotes.filter((n) => !MONEY.test(n));
    const notes = wordsOnly.length ? `, site notes: ${wordsOnly.map((n) => `"${n}"`).join(" ")}` : "";
    const vat = r.price.vatBreakdown ? ", VAT included per the site's breakdown" : "";
    lines.push(`${r.rank}. ${name} – ${r.price.service}: ${delivery}${deadline}${vat}${notes}`);
  }
  for (const z of view.zips) {
    for (const r of z.rejectedBy) {
      const name = nameOf(view, r.carrierId);
      if (r.siteMessage) {
        lines.push(`Postal code ${z.zip} (${z.role}) was REJECTED by ${name}: "${r.siteMessage}". Ask the user to confirm it.`);
      } else if (z.seen.length) {
        // The site never said it; another site recognized the code in this quote: it is the form, not the code.
        const by = z.seen.map((x) => `${nameOf(view, x.carrierId)} ("${x.text}")`).join("; ");
        lines.push(`${name}'s form did not continue with postal code ${z.zip} (${z.role}) and its page showed no error. ${by} recognized it in this quote: it looks like ${name}'s form, not the code. Do NOT ask the user to confirm it; suggest quoting on ${name}'s site.`);
      } else {
        lines.push(`${name}'s form did not continue with postal code ${z.zip} (${z.role}) and its page showed no error: it may be the code or the form. Ask the user to confirm it and, if it is correct, to quote on ${name}'s site.`);
      }
    }
    if (z.rejectedBy.length) continue;
    if (z.seen.length) lines.push(`Postal code ${z.zip} (${z.role}) as shown by the sites: ${z.seen.map((s) => `"${s.text}"`).join("; ")}`);
    // Only meaningful when some site quoted without repeating the code; with no prices there is nothing to warn about.
    else if (view.ranked.length) lines.push(`Postal code ${z.zip} (${z.role}) was NOT confirmed by any site's page.`);
  }
  return lines.join("\n");
}

// Says where the delivery time came from: a date the site gave, the site's day count, or the service's name.
// The carrier's published terms are said as such, never as "per the site" of this quote.
function deliveryText(d: QuoteView["ranked"][number]["delivery"], carrierName: string): string {
  if (!d) return "delivery time not stated by the site";
  if (d.arrivalDate) return `arrives ${d.arrivalDate} per the site`;
  if (d.source === "carrier_terms" && d.businessDays) {
    const { min, max } = d.businessDays;
    const days = min === max ? (max === 1 ? "next business day" : `${max} business days`) : `${min}-${max} business days`;
    const brand = carrierName.replace(/\s+México$/, "");
    return `${days}${d.byTime ? ` before ${d.byTime}` : ""} per ${brand}'s published service terms`;
  }
  const days = d.minDays === d.maxDays ? `${d.maxDays}` : `${d.minDays}-${d.maxDays}`;
  return `delivery ${days} day(s) ${d.source === "service_name" ? "by the service name" : "per the site"}`;
}

function nameOf(view: QuoteView, carrierId: string): string {
  return view.carriers.find((c) => c.carrierId === carrierId)?.name ?? carrierId;
}
// The carrier's message as the view builds it, minus the caveat the view appends to it.
function withoutCaveat(c: CarrierView): string {
  return c.caveat && c.message.endsWith(` ${c.caveat}`) ? c.message.slice(0, -(c.caveat.length + 1)) : c.message;
}
// Never launched for lack of data (the only carriers whose view lists `missing`).
function isSkipped(c: CarrierView): boolean {
  return Boolean(c.missing);
}
// Carriers the note must account for: no price, launched (skipped ones were already asked for in the chat).
function unpriced(view: QuoteView): CarrierView[] {
  return view.carriers.filter((c) => c.status !== "quoted" && !isSkipped(c));
}
// The rejection sentence of each carrier that rejected `z`, then the question, once per postal code.
// Without the site's words the sentence does not claim a rejection; the question is asked unless another
// site recognized the code in this quote (then it is the form, not the code).
function rejectionParts(view: QuoteView, z: QuoteView["zips"][number]): string[] {
  const seen = z.seen[0];
  const seenBy = seen ? { name: nameOf(view, seen.carrierId), text: seen.text } : undefined;
  const sentences = z.rejectedBy.map((r) => r.siteMessage
    ? rejectionSentence(nameOf(view, r.carrierId), z.role, z.zip, r.siteMessage)
    : unconfirmedZipSentence(nameOf(view, r.carrierId), z.zip, seenBy));
  const ask = z.rejectedBy.some((r) => r.siteMessage) || !seen;
  return ask ? [...sentences, zipQuestion(z.role)] : sentences;
}
// Whether the note names the carrier: first word of its name ("FedEx" for "FedEx México"), whole word, ignoring case and accents.
function names(note: string, carrierName: string): boolean {
  const fold = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const word = fold(carrierName.split(/\s+/)[0]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${word}($|[^\\p{L}\\p{N}])`, "u").test(fold(note));
}

// What the model's note must not leave out. A rejected postal code goes with its sentence and question
// when the note does not mention the code; every launched carrier without a price is named, else its message is added.
export function guardNote(note: string, view: QuoteView): string {
  let out = note;
  const add = (t: string) => (out = `${out} ${t}`.trim());
  for (const z of view.zips) if (z.rejectedBy.length && !out.includes(z.zip)) rejectionParts(view, z).forEach(add);
  // The caveat is not added here: describeResult adds each one once, verbatim.
  for (const c of unpriced(view)) if (!names(out, c.name)) add(withoutCaveat(c));
  return out;
}

// Deterministic note, used when the model's note contains money or the model is unavailable.
// A rejected postal code comes first, with the question; each rejecting carrier is said once. Carriers
// waiting for data are left out (the chat asked already; the table shows them as "Necesita un dato").
export function fallbackNote(view: QuoteView): string {
  const first = view.ranked[0];
  const parts: string[] = [];
  const rejecting = new Set<string>();
  for (const z of view.zips) {
    if (!z.rejectedBy.length) continue;
    parts.push(...rejectionParts(view, z));
    z.rejectedBy.forEach((r) => rejecting.add(r.carrierId));
  }
  if (first) {
    const name = view.carriers.find((c) => c.carrierId === first.carrierId)?.name ?? first.carrierId;
    parts.push(`La primera opción de la tabla es ${name} – ${first.price.service}.`);
  } else {
    parts.push("No conseguimos ningún precio en esta cotización.");
  }
  for (const c of unpriced(view)) if (!rejecting.has(c.carrierId)) parts.push(c.message);
  for (const z of view.zips) {
    if (!z.rejectedBy.length && !z.seen.length && view.ranked.length) parts.push(`Ningún sitio confirmó el código postal ${z.zip}; revísalo.`);
  }
  return parts.join(" ");
}

export class Conversation {
  readonly messages: Anthropic.MessageParam[] = [];
  readonly log: TurnLog[] = [];
  readonly usage: ConversationUsage = { calls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0, models: [] };
  lastRunId?: string;
  // Last started quote and the carriers it left waiting for data (a follow-up quotes only those).
  private lastQuote?: FollowUpContext;
  // The conversation's own record: runs/<label>/<conversationId>.jsonl with one conversation.turn per turn.
  readonly conversationId = `conversation-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
  private readonly recordDir: string | null;
  private store: RunStore | null = null;
  private pendingCost = 0; // model cost since the last recorded turn
  private lastModel?: string;
  // Model calls since the last recorded turn, their output tokens and thinking blocks, last stop reason.
  private pendingCalls = 0;
  private pendingOutputTokens = 0;
  private pendingThinking = 0;
  private lastStopReason: string | null = null;
  private readonly plugins: Record<string, CarrierPlugin>;
  private readonly model: string;
  private readonly client: () => Anthropic;
  private readonly now: () => Date;

  constructor(
    private readonly orchestrator: Orchestrator,
    // recordDir: where the conversation record goes (default runs/<label or "app">); null = do not record (tests).
    opts: { plugins?: Record<string, CarrierPlugin>; client?: Anthropic; model?: string; now?: () => Date; label?: string; recordDir?: string | null } = {},
  ) {
    this.plugins = opts.plugins ?? registry;
    this.model = opts.model ?? CONVERSATION_MODEL;
    this.client = opts.client ? () => opts.client! : defaultClient;
    this.now = opts.now ?? (() => new Date());
    this.label = opts.label;
    this.recordDir = opts.recordDir === undefined ? `runs/${opts.label ?? "app"}` : opts.recordDir;
  }

  // Path of the conversation record, once the first turn was written.
  get recordFile(): string | undefined {
    return this.store?.file.replace(/\\/g, "/");
  }

  // Logs a turn in memory and appends it to the conversation record, with the model cost spent since the last turn.
  private turn(t: TurnLog, runId?: string, extra: { redacted?: boolean; redactedSentences?: number; memoriesUsed?: { slug: string; value: string }[] } = {}) {
    this.log.push(t);
    if (this.recordDir === null) return;
    this.store ??= new RunStore(this.recordDir, this.conversationId);
    const cost = this.pendingCost;
    const calls = this.pendingCalls;
    const model = calls ? { stopReason: this.lastStopReason, outputTokens: this.pendingOutputTokens, thinkingBlocks: this.pendingThinking } : {};
    this.pendingCost = 0;
    this.pendingCalls = 0;
    this.pendingOutputTokens = 0;
    this.pendingThinking = 0;
    this.store.append("conversation.turn", {
      conversationId: this.conversationId, role: t.role, text: t.text,
      ...(runId ? { runId } : {}),
      ...(t.role === "assistant" && this.lastModel ? { model: this.lastModel } : {}),
      ...(cost ? { costUsd: Number(cost.toFixed(6)) } : {}),
      ...model,
      ...extra,
    });
  }
  private readonly label?: string;

  private track(response: Anthropic.Message) {
    const model = response.model;
    const u = response.usage as Usage;
    this.pendingCalls++;
    this.pendingOutputTokens += u.output_tokens ?? 0;
    this.pendingThinking += (response.content ?? []).filter((b) => b.type === "thinking" || b.type === "redacted_thinking").length;
    this.lastStopReason = response.stop_reason ?? null;
    this.usage.calls++;
    this.usage.inputTokens += u.input_tokens ?? 0;
    this.usage.outputTokens += u.output_tokens ?? 0;
    this.usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
    this.usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    const cost = costOf(model, u);
    this.usage.costUsd += cost;
    this.pendingCost += cost;
    this.lastModel = model;
    if (!this.usage.models.includes(model)) this.usage.models.push(model);
  }

  // Data the code adds to request_quote when the model did not set it, for the rest of the conversation:
  // the store's customerType once a #tienda memory was called, and the priority last picked under the composer.
  private readonly defaults: QuoteDefaults = {};
  // The user's message that started each quote; its note answers that message, not a later one.
  private readonly startedBy = new Map<string, string>();

  // Handles one user message. Returns the assistant's text and the runId if a quote was started.
  // `context` is the message with its #memories resolved by the server (memory/context.ts): the model reads
  // the explicit text, the record keeps what the user typed plus the values used, and the reply starts with the code's
  // own line naming them. Without context and priority, the message reaches the model exactly as typed.
  async send(userText: string, opts: { context?: ResolvedMessage | null; priority?: "cheapest" | "fastest" } = {}): Promise<{ text: string; runId?: string }> {
    const ctx = opts.context ?? null;
    if (ctx?.extras.customerType) this.defaults.customerType = ctx.extras.customerType;
    if (opts.priority) this.defaults.priority = opts.priority;
    const lead = memoryLine(ctx);
    const withLead = (text: string) => (lead ? `${lead}\n\n${text}` : text);
    this.messages.push({ role: "user", content: ctx ? ctx.modelText : userText });
    this.turn({ role: "user", text: userText }, undefined, ctx?.used.length ? { memoriesUsed: ctx.used } : {});
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: buildConversationPrompt(this.plugins, todayInBusinessTz(this.now())), cache_control: { type: "ephemeral" } },
    ];
    const tools = [{ ...requestQuoteTool(this.plugins), cache_control: { type: "ephemeral" as const } }];
    let runId: string | undefined;

    for (let turn = 0; turn < MAX_TURNS_PER_MESSAGE; turn++) {
      const response = await this.client().messages.create({ model: this.model, max_tokens: 1024, system, tools, messages: this.messages });
      this.track(response);
      this.messages.push({ role: "assistant", content: response.content as Anthropic.ContentBlockParam[] });
      const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!uses.length) {
        // No amount reaches the chat; the model's sentences with one are removed and the turn says how many.
        const clean = redactAmounts(text);
        const reply = withLead(clean.text);
        this.turn({ role: "assistant", text: reply }, runId, clean.removed ? { redacted: true, redactedSentences: clean.removed } : {});
        return { text: reply, runId };
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        this.usage.toolCalls++;
        let content: string;
        let isError = false;
        if (use.name !== "request_quote") {
          content = `Unknown tool '${use.name}'.`;
          isError = true;
        } else if (runId) {
          content = `A quote was already started in this message (${runId}).`;
          isError = true;
        } else {
          const defaults = this.defaults.customerType || this.defaults.priority ? { ...this.defaults } : undefined;
          const prepared = prepareQuote(use.input, this.plugins, this.now(), this.lastQuote, defaults);
          if (!prepared.ok) {
            content = prepared.message;
            isError = true;
          } else {
            runId = await this.orchestrator.startQuote(prepared.request, prepared.carrierIds, this.label ? { label: this.label } : {});
            this.startedBy.set(runId, userText);
            this.lastRunId = runId;
            this.lastQuote = { request: prepared.request, waiting: prepared.waiting.map((w) => w.carrierId) };
            content = startedMessage(runId, prepared, this.plugins);
          }
        }
        this.turn({ role: "tool", text: `${use.name} ${JSON.stringify(use.input)} -> ${isError ? "ERROR " : ""}${content}` }, runId);
        results.push({ type: "tool_result", tool_use_id: use.id, content, ...(isError ? { is_error: true } : {}) });
      }
      this.messages.push({ role: "user", content: results });
    }
    const text = withLead("No pude completar tu solicitud en este mensaje. ¿Me la repites con origen, destino, peso y medidas?");
    this.turn({ role: "assistant", text }, runId);
    return { text, runId };
  }

  // Waits for the quote, builds the view from the record and writes the note around the code-painted table.
  async describeResult(runId: string): Promise<{ view: QuoteView; note: string; noteSource: NoteSource }> {
    await this.orchestrator.finished(runId);
    const view = buildQuoteView(collectEvents(this.orchestrator, runId), this.now());
    // The message that started this quote, not a later one (a follow-up for other carriers is not this quote's).
    const lastUser = this.startedBy.get(runId) ?? [...this.log].reverse().find((l) => l.role === "user")?.text ?? "";
    let note = "";
    let noteSource: NoteSource = "model";
    try {
      const response = await this.client().messages.create({
        model: this.model,
        max_tokens: NOTE_MAX_TOKENS,
        output_config: { effort: NOTE_EFFORT },
        system: RESULT_NOTE_PROMPT,
        messages: [{ role: "user", content: `User's last message (use its language): ${lastUser}\n\nDigest:\n${resultDigest(view)}` }],
      });
      this.track(response);
      // Only text blocks are the note; thinking blocks (empty by default on Haiku 5.5) are never shown.
      note = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      // A response that did not end normally (cut by max_tokens, refusal...) is never shown, not even in part.
      if (response.stop_reason !== "end_turn") {
        note = "";
        noteSource = `fallback:${response.stop_reason}`;
      }
    } catch {
      note = "";
    }
    if (!note || MONEY.test(note)) {
      note = fallbackNote(view);
      if (noteSource === "model") noteSource = "fallback";
    } else {
      note = guardNote(note, view);
    }
    // Known doubts (plugin caveats, e.g. Redpack's colonia) must reach the user even if the model left them out.
    for (const c of view.carriers) if (c.caveat && !note.includes(c.caveat)) note = `${note} ${c.caveat}`.trim();
    this.turn({ role: "assistant", text: `[result note] ${note}` }, runId);
    // Keep the history coherent for follow-ups: attach the note to the last assistant message.
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "assistant") {
      const blocks = Array.isArray(last.content) ? last.content : [{ type: "text" as const, text: last.content }];
      last.content = [...blocks, { type: "text", text: `[Quote ${runId} finished. Note shown to the user: ${note}]` }];
    }
    return { view, note, noteSource };
  }
}
