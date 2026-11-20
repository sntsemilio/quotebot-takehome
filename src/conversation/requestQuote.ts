// The request_quote tool of the conversation model, and its code-side handling.
// The model passes what the user said, in the user's units; code converts units (domain/units.ts),
// validates (domain/request.ts) and checks carrier needs. Errors go back to the model verbatim.
// Carriers whose needs are missing do NOT block the quote: it starts right away with the others, and those
// are recorded as carrier.skipped ("necesita dato"); the model asks for the data in the same reply, and the
// answer launches a new quote for those carriers only.
import type Anthropic from "@anthropic-ai/sdk";
import { validateRequest, type ExtraKey, type QuoteRequest } from "../domain/request.js";
import { toParcel, type LengthUnit, type WeightUnit } from "../domain/units.js";
import { missingNeeds, type CarrierPlugin } from "../carriers/types.js";
import { EXTRA_LABELS } from "../orchestrator/view.js";

export function requestQuoteTool(plugins: Record<string, CarrierPlugin>): Anthropic.Tool {
  return {
    name: "request_quote",
    description:
      "Starts a real quote on the carriers' websites. Call it only when you have origin and destination 5-digit postal codes, weight and the three dimensions. " +
      "Pass numbers in the units the user used; code converts lb/in. Code validates and returns clear errors.",
    input_schema: {
      type: "object",
      properties: {
        originZip: { type: "string", description: "5-digit Mexican postal code, exactly as the user gave it" },
        destZip: { type: "string", description: "5-digit Mexican postal code, exactly as the user gave it" },
        parcel: {
          type: "object",
          description: "One parcel as the user described it",
          properties: {
            weight: { type: "number" },
            weightUnit: { type: "string", enum: ["kg", "lb"] },
            length: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
            lengthUnit: { type: "string", enum: ["cm", "in"] },
          },
          required: ["weight", "weightUnit", "length", "width", "height", "lengthUnit"],
        },
        count: { type: "integer", description: "Number of identical parcels (default 1)" },
        carriers: {
          type: "array",
          items: { type: "string", enum: Object.keys(plugins) },
          description: "Only if the user named carriers, or to quote only the carriers that were waiting for data; omit for all",
        },
        extras: {
          type: "object",
          properties: {
            shipDate: { type: "string", description: "YYYY-MM-DD" },
            deliveryType: { type: "string", enum: ["home", "branch"] },
            customerType: { type: "string", enum: ["individual", "business"] },
          },
        },
        preference: {
          type: "object",
          properties: {
            priority: { type: "string", enum: ["cheapest", "fastest", "by_date"] },
            deadline: { type: "string", description: "YYYY-MM-DD, required for by_date" },
          },
          required: ["priority"],
        },
      },
      required: ["originZip", "destZip", "parcel"],
    },
  };
}

// A carrier that will not be launched in this quote because the request lacks data its site requires.
export interface WaitingCarrier {
  carrierId: string;
  name: string;
  needs: { field: ExtraKey; label: string; why: string }[];
}

export type PreparedQuote =
  // carrierIds: every carrier of the quote (the orchestrator records carrier.skipped for the waiting ones).
  | { ok: true; request: QuoteRequest; carrierIds: string[]; launched: string[]; waiting: WaitingCarrier[] }
  | { ok: false; kind: "invalid" | "missing_needs"; message: string };

// The previous quote of this conversation and the carriers that were left waiting for data.
export interface FollowUpContext {
  request: QuoteRequest;
  waiting: string[];
}

function sameShipment(a: QuoteRequest, b: QuoteRequest): boolean {
  return a.originZip === b.originZip && a.destZip === b.destZip && (a.count ?? 1) === (b.count ?? 1) &&
    JSON.stringify(a.parcels) === JSON.stringify(b.parcels);
}

interface RawInput {
  originZip?: unknown;
  destZip?: unknown;
  parcel?: { weight?: number; weightUnit?: WeightUnit; length?: number; width?: number; height?: number; lengthUnit?: LengthUnit };
  count?: unknown;
  carriers?: unknown;
  extras?: unknown;
  preference?: unknown;
}

const isUnit = <T extends string>(v: unknown, opts: T[]): v is T => typeof v === "string" && (opts as string[]).includes(v);

// Without defaults the input is returned as is (the same object): nothing changes for a message without memories.
function withDefaults(input: RawInput, d: QuoteDefaults | undefined): RawInput {
  if (!d) return input;
  const extras = (typeof input.extras === "object" && input.extras !== null ? input.extras : undefined) as Record<string, unknown> | undefined;
  const out: RawInput = { ...input };
  if (d.customerType && extras?.customerType === undefined && (input.extras === undefined || extras)) out.extras = { ...(extras ?? {}), customerType: d.customerType };
  if (d.priority && input.preference === undefined) out.preference = { priority: d.priority };
  return out;
}

// Data the code adds when the model did not set it. customerType comes from a #tienda memory the user called;
// priority from the control under the composer (only cheapest/fastest: by_date needs a deadline the model must set).
export interface QuoteDefaults {
  customerType?: "individual" | "business";
  priority?: "cheapest" | "fastest";
}

// followUp: when the model calls again for the same shipment without naming carriers, the new quote is only
// for the carriers that were waiting for data (no second visit to the sites that already answered).
export function prepareQuote(raw: unknown, plugins: Record<string, CarrierPlugin>, now: Date = new Date(), followUp?: FollowUpContext, defaults?: QuoteDefaults): PreparedQuote {
  const input = withDefaults((raw ?? {}) as RawInput, defaults);
  const p = input.parcel ?? {};
  const unitErrors: string[] = [];
  if (!isUnit(p.weightUnit, ["kg", "lb"])) unitErrors.push("parcel.weightUnit must be kg or lb");
  if (!isUnit(p.lengthUnit, ["cm", "in"])) unitErrors.push("parcel.lengthUnit must be cm or in");
  if (unitErrors.length) return { ok: false, kind: "invalid", message: `Invalid request:\n- ${unitErrors.join("\n- ")}` };

  const parcel = toParcel({
    weight: p.weight as number, weightUnit: p.weightUnit as WeightUnit,
    length: p.length as number, width: p.width as number, height: p.height as number, lengthUnit: p.lengthUnit as LengthUnit,
  });
  const candidate = {
    originZip: input.originZip,
    destZip: input.destZip,
    parcels: [parcel],
    ...(input.count !== undefined && input.count !== 1 ? { count: input.count } : {}),
    ...(input.extras !== undefined ? { extras: input.extras } : {}),
    ...(input.preference !== undefined ? { preference: input.preference } : {}),
  };
  const v = validateRequest(candidate, { now });
  const named = Array.isArray(input.carriers) && input.carriers.length ? [...new Set(input.carriers.map(String))] : null;
  const isFollowUp = !named && v.ok && followUp !== undefined && followUp.waiting.length > 0 && sameShipment(v.request, followUp.request);
  const requested = named ?? (isFollowUp ? followUp!.waiting : Object.keys(plugins));
  const unknown = requested.filter((id) => !plugins[id]);
  const errors = [...(v.ok ? [] : v.errors), ...unknown.map((id) => `unknown carrier '${id}' (available: ${Object.keys(plugins).join(", ")})`)];
  if (!v.ok || errors.length) return { ok: false, kind: "invalid", message: `Invalid request:\n- ${errors.join("\n- ")}` };

  const waiting: WaitingCarrier[] = requested
    .map((id) => ({
      carrierId: id,
      name: plugins[id].name,
      needs: missingNeeds(plugins[id], v.request).map((n) => ({ field: n.field, label: EXTRA_LABELS[n.field], why: n.why })),
    }))
    .filter((w) => w.needs.length > 0);
  const launched = requested.filter((id) => !waiting.some((w) => w.carrierId === id));
  if (!launched.length) {
    // Nothing could be quoted: starting a run where every carrier is skipped would only add noise.
    return {
      ok: false,
      kind: "missing_needs",
      message: `Not started: every requested carrier needs data the user has not given.\n${waitingLines(waiting)}\n` +
        "Ask the user for all of it in ONE message; when they answer, call request_quote again with those extras.",
    };
  }
  return { ok: true, request: v.request, carrierIds: requested, launched, waiting };
}

function waitingLines(waiting: WaitingCarrier[]): string {
  return waiting.map((w) => `- ${w.name} (${w.carrierId}) needs: ${w.needs.map((n) => `extras.${n.field} = ${n.label} (${n.why})`).join("; ")}`).join("\n");
}

// Tool result for a started quote: who is being quoted now and, if any, who waits for which data.
export function startedMessage(runId: string, prepared: Extract<PreparedQuote, { ok: true }>, plugins: Record<string, CarrierPlugin>): string {
  const names = prepared.launched.map((id) => plugins[id]?.name ?? id).join(", ");
  let msg = `Quote started (${runId}) with: ${names}. The app shows live progress and the verified prices. Do not write any price.`;
  if (prepared.waiting.length) {
    msg +=
      `\nNot launched, waiting for data (shown to the user as "necesita dato"):\n${waitingLines(prepared.waiting)}\n` +
      "In this SAME reply, say you are quoting with the others and ask the user for that data in one message, saying which carrier needs what. " +
      `When they answer, call request_quote again for the same shipment with carriers: [${prepared.waiting.map((w) => `"${w.carrierId}"`).join(", ")}] and the extras. ` +
      "If they decline, do nothing more: those carriers stay as needing data.";
  }
  return msg;
}
