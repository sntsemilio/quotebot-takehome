// Structured quote request and its validation. Validation happens in code, before any browser opens.
// Error messages are meant to be returned as-is to the conversation model (request_quote tool).
import { isIsoDate, isPastDate, todayInBusinessTz } from "./dates.js";

export interface Parcel {
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

// Data some carriers ask for that a basic request does not carry. Asked by the conversation, never defaulted.
export interface Extras {
  shipDate?: string; // YYYY-MM-DD, today or later (Monterrey time)
  deliveryType?: "home" | "branch";
  customerType?: "individual" | "business";
}
export type ExtraKey = keyof Extras;
export const EXTRA_KEYS: readonly ExtraKey[] = ["shipDate", "deliveryType", "customerType"];

export interface Preference {
  priority: "cheapest" | "fastest" | "by_date";
  deadline?: string; // YYYY-MM-DD; required when priority is "by_date"
}

export interface QuoteRequest {
  originZip: string;
  destZip: string;
  parcels: Parcel[];
  count?: number; // identical parcels
  extras?: Extras;
  preference?: Preference;
}

export type Validation = { ok: true; request: QuoteRequest } | { ok: false; errors: string[] };

const ZIP = /^\d{5}$/;
const DELIVERY_TYPES = ["home", "branch"] as const;
const CUSTOMER_TYPES = ["individual", "business"] as const;
const PRIORITIES = ["cheapest", "fastest", "by_date"] as const;

function positive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function oneOf<T extends string>(v: unknown, options: readonly T[]): v is T {
  return typeof v === "string" && (options as readonly string[]).includes(v);
}

// `now` is injectable so "not in the past" can be tested at any hour.
export function validateRequest(input: unknown, opts: { now?: Date } = {}): Validation {
  const now = opts.now ?? new Date();
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ["request must be an object"] };
  const r = input;

  const originZip = typeof r.originZip === "number" ? String(r.originZip).padStart(5, "0") : r.originZip;
  const destZip = typeof r.destZip === "number" ? String(r.destZip).padStart(5, "0") : r.destZip;
  if (typeof originZip !== "string" || !ZIP.test(originZip)) errors.push("originZip must be a 5-digit postal code");
  if (typeof destZip !== "string" || !ZIP.test(destZip)) errors.push("destZip must be a 5-digit postal code");

  const parcels: Parcel[] = [];
  if (!Array.isArray(r.parcels) || r.parcels.length === 0) {
    errors.push("parcels must be a non-empty array");
  } else {
    r.parcels.forEach((p, i) => {
      const q = isObject(p) ? p : {};
      for (const k of ["weightKg", "lengthCm", "widthCm", "heightCm"] as const) {
        if (!positive(q[k])) errors.push(`parcels[${i}].${k} must be a number > 0`);
      }
      parcels.push({
        weightKg: q.weightKg as number,
        lengthCm: q.lengthCm as number,
        widthCm: q.widthCm as number,
        heightCm: q.heightCm as number,
      });
    });
  }

  if (r.count !== undefined && !(Number.isInteger(r.count) && (r.count as number) > 0)) {
    errors.push("count, if given, must be a positive integer");
  }

  const today = todayInBusinessTz(now);
  const checkDate = (field: string, v: unknown) => {
    if (!isIsoDate(v)) errors.push(`${field} must be a real date as YYYY-MM-DD`);
    else if (isPastDate(v, now)) errors.push(`${field} ${v} is in the past (today in Monterrey is ${today})`);
  };

  let extras: Extras | undefined;
  if (r.extras !== undefined) {
    if (!isObject(r.extras)) {
      errors.push("extras, if given, must be an object");
    } else {
      extras = {};
      for (const k of Object.keys(r.extras)) {
        if (!(EXTRA_KEYS as readonly string[]).includes(k)) errors.push(`extras.${k} is not a known field (known: ${EXTRA_KEYS.join(", ")})`);
      }
      const e = r.extras;
      if (e.shipDate !== undefined) {
        checkDate("extras.shipDate", e.shipDate);
        extras.shipDate = e.shipDate as string;
      }
      if (e.deliveryType !== undefined) {
        if (!oneOf(e.deliveryType, DELIVERY_TYPES)) errors.push(`extras.deliveryType must be one of: ${DELIVERY_TYPES.join(", ")}`);
        else extras.deliveryType = e.deliveryType;
      }
      if (e.customerType !== undefined) {
        if (!oneOf(e.customerType, CUSTOMER_TYPES)) errors.push(`extras.customerType must be one of: ${CUSTOMER_TYPES.join(", ")}`);
        else extras.customerType = e.customerType;
      }
    }
  }

  let preference: Preference | undefined;
  if (r.preference !== undefined) {
    if (!isObject(r.preference)) {
      errors.push("preference, if given, must be an object");
    } else {
      const p = r.preference;
      if (!oneOf(p.priority, PRIORITIES)) errors.push(`preference.priority must be one of: ${PRIORITIES.join(", ")}`);
      if (p.deadline !== undefined) checkDate("preference.deadline", p.deadline);
      else if (p.priority === "by_date") errors.push("preference.deadline is required when priority is by_date");
      preference = { priority: p.priority as Preference["priority"], ...(p.deadline !== undefined ? { deadline: p.deadline as string } : {}) };
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    request: {
      originZip: originZip as string,
      destZip: destZip as string,
      parcels,
      ...(r.count !== undefined ? { count: r.count as number } : {}),
      ...(extras && Object.keys(extras).length ? { extras } : {}),
      ...(preference ? { preference } : {}),
    },
  };
}
