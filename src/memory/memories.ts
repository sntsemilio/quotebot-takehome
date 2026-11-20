// "Memorias", the first context plugin. Named data Mariana saves, edits and deletes: her store (origin postal
// code and whether she ships as an individual or a business), her boxes (dimensions, optional typical weight) and her
// usual destinations (postal code). Validated in code. Recorded like everything else: append-only memory.set and
// memory.deleted events in runs/app/memory.jsonl, folded to the current state.
// Delivery type and ship date are never saved: they change with every shipment.
// The initial slots (#tienda-nopal and three boxes) exist from the start WITHOUT values: nothing is ever invented.
import fs from "node:fs";
import path from "node:path";
import type { RunEvent } from "../record/events.js";
import type { ContextItem, ContextPlugin, Resolution } from "./context.js";
import { num } from "../domain/shipment.js";

export type MemoryKind = "tienda" | "caja" | "destino";
export const MEMORY_KINDS: readonly MemoryKind[] = ["tienda", "caja", "destino"];
export const KIND_LABEL: Record<MemoryKind, string> = { tienda: "Tienda", caja: "Caja", destino: "Destino" };

export interface Memory {
  slug: string;
  kind: MemoryKind;
  name: string;
  zip?: string; // tienda, destino
  customerType?: "individual" | "business"; // tienda
  lengthCm?: number; // caja
  widthCm?: number;
  heightCm?: number;
  weightKg?: number; // caja, optional
}

// The four slots Mariana starts with: her store and the three boxes she uses most. Names only.
export const SEEDS: readonly Memory[] = [
  { slug: "tienda-nopal", kind: "tienda", name: "Tienda Nopal" },
  { slug: "caja-chica", kind: "caja", name: "Caja chica" },
  { slug: "caja-mediana", kind: "caja", name: "Caja mediana" },
  { slug: "caja-grande", kind: "caja", name: "Caja grande" },
];

// "Caja Mediana" -> "caja-mediana", "Mérida centro" -> "merida-centro".
export function slugify(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function isEmpty(m: Memory): boolean {
  return m.kind === "caja" ? !(m.lengthCm && m.widthCm && m.heightCm) : !m.zip;
}

const PERSON = { individual: "persona física", business: "persona moral" } as const;
const dims = (m: Memory) => `${num(m.lengthCm!)} × ${num(m.widthCm!)} × ${num(m.heightCm!)} cm`;

// The value as shown in the UI and named in the reply: "CP 64000, persona moral", "40 × 30 × 25 cm, peso típico 3 kg".
export function valueOf(m: Memory): string | undefined {
  if (isEmpty(m)) return undefined;
  if (m.kind === "caja") return `${dims(m)}${m.weightKg ? `, peso típico ${num(m.weightKg)} kg` : ""}`;
  if (m.kind === "tienda") return `CP ${m.zip}${m.customerType ? `, ${PERSON[m.customerType]}` : ""}`;
  return `CP ${m.zip}`;
}

const MISSING = { caja: "medidas", tienda: "CP", destino: "CP" } as const;
export function shortOf(m: Memory): string {
  return valueOf(m) ?? `Sin ${MISSING[m.kind]}`;
}

// What #slug becomes for the model. Explicit, with the token kept so the model can name it.
export function resolveMemory(m: Memory): Resolution {
  const token = m.slug;
  if (isEmpty(m)) {
    const what = m.kind === "caja" ? "its dimensions" : m.kind === "tienda" ? "the origin postal code" : "the destination postal code";
    return {
      token,
      text: `#${token} [a saved ${m.kind === "caja" ? "box" : m.kind === "tienda" ? "store" : "destination"} with no values yet: ask the user for ${what}; never guess]`,
      notice: m.kind === "caja" ? `Tu #${token} todavía no tiene medidas guardadas.` : `Tu #${token} todavía no tiene CP guardado.`,
    };
  }
  const value = valueOf(m)!;
  // A typical weight is only a fallback: the weight the user writes in the message wins.
  if (m.kind === "caja") {
    const typical = m.weightKg ? `; typical weight ${num(m.weightKg)} kg, use it only if the user gave no weight` : "";
    return { token, value, text: `caja de ${dims(m)} (#${token}${typical})` };
  }
  if (m.kind === "destino") return { token, value, text: `destino CP ${m.zip} (#${token})` };
  return { token, value, text: `origen CP ${m.zip} (#${token})`, ...(m.customerType ? { extras: { customerType: m.customerType } } : {}) };
}

export function foldMemories(events: RunEvent[]): Memory[] {
  const map = new Map<string, Memory>(SEEDS.map((m) => [m.slug, { ...m }]));
  for (const e of events) {
    if (e.type === "memory.set") map.set(e.memory.slug, e.memory);
    else if (e.type === "memory.deleted") map.delete(e.slug);
  }
  return [...map.values()];
}

export interface FieldError { field: string; message: string }
export type MemoryValidation = { ok: true; memory: Memory } | { ok: false; errors: FieldError[] };

// A number from JSON or a form ("12,5" too). Empty means not given.
function numberOf(v: unknown): number | undefined | null {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim().replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Validates a memory as sent by the UI. `others`: the slugs already taken by other memories.
export function validateMemory(input: unknown, others: string[]): MemoryValidation {
  const r = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const errors: FieldError[] = [];
  const kind = r.kind as MemoryKind;
  if (!MEMORY_KINDS.includes(kind)) errors.push({ field: "kind", message: "Elige si es una tienda, una caja o un destino." });
  const name = typeof r.name === "string" ? r.name.trim().replace(/\s+/g, " ") : "";
  const slug = slugify(name);
  if (!name) errors.push({ field: "name", message: "Escribe un nombre." });
  else if (name.length > 40) errors.push({ field: "name", message: "El nombre puede tener hasta 40 caracteres." });
  else if (!/^[a-z]/.test(slug)) errors.push({ field: "name", message: "El nombre debe empezar con una letra." });
  else if (others.includes(slug)) errors.push({ field: "name", message: `Ya tienes una memoria llamada #${slug}.` });
  const memory: Memory = { slug, kind, name };
  if (kind === "tienda" || kind === "destino") {
    const zip = typeof r.zip === "number" ? String(r.zip).padStart(5, "0") : typeof r.zip === "string" ? r.zip.trim() : "";
    if (!/^\d{5}$/.test(zip)) errors.push({ field: "zip", message: "El CP debe tener 5 dígitos." });
    memory.zip = zip;
  }
  if (kind === "tienda" && r.customerType !== undefined && r.customerType !== null && r.customerType !== "") {
    if (r.customerType !== "individual" && r.customerType !== "business") errors.push({ field: "customerType", message: "Elige persona física o moral." });
    else memory.customerType = r.customerType;
  }
  if (kind === "caja") {
    const LABEL = { lengthCm: "largo", widthCm: "ancho", heightCm: "alto" } as const;
    for (const k of ["lengthCm", "widthCm", "heightCm"] as const) {
      const n = numberOf(r[k]);
      if (n === undefined) errors.push({ field: k, message: `Escribe el ${LABEL[k]} en cm.` });
      else if (n === null || n <= 0 || n > 300) errors.push({ field: k, message: `El ${LABEL[k]} debe ser un número mayor que 0 y de hasta 300 cm.` });
      else memory[k] = n;
    }
    const w = numberOf(r.weightKg);
    if (w === null || (w !== undefined && (w <= 0 || w > 100))) errors.push({ field: "weightKg", message: "El peso debe ser un número mayor que 0 y de hasta 100 kg, o quedar vacío." });
    else if (w !== undefined) memory.weightKg = w;
  }
  return errors.length ? { ok: false, errors } : { ok: true, memory };
}

function itemOf(m: Memory): ContextItem {
  return { token: m.slug, name: m.name, kind: m.kind, kindLabel: KIND_LABEL[m.kind], short: shortOf(m), empty: isEmpty(m) };
}

// The memories plugin over its own append-only record.
export class MemoryStore implements ContextPlugin {
  readonly id = "memorias";
  constructor(readonly file: string) {}

  private events(): RunEvent[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as RunEvent);
  }

  private append(e: { type: "memory.set"; memory: Memory } | { type: "memory.deleted"; slug: string }) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const seq = this.events().length + 1;
    fs.appendFileSync(this.file, JSON.stringify({ seq, t: new Date().toISOString(), ms: 0, ...e }) + "\n");
  }

  all(): Memory[] {
    return foldMemories(this.events());
  }

  get(slug: string): Memory | undefined {
    return this.all().find((m) => m.slug === slug);
  }

  list(): ContextItem[] {
    return this.all().map(itemOf);
  }

  // For the memories' own UI: each item with its saved values, to edit them.
  listWithValues(): (ContextItem & { values: Omit<Memory, "slug" | "kind" | "name"> })[] {
    return this.all().map((m) => {
      const { slug: _s, kind: _k, name: _n, ...values } = m;
      return { ...itemOf(m), values };
    });
  }

  // Creates or edits. `previousSlug` names the memory being edited (its name, and so its slug, may change).
  save(input: unknown): MemoryValidation {
    const previous = typeof (input as { previousSlug?: unknown })?.previousSlug === "string" ? (input as { previousSlug: string }).previousSlug : undefined;
    const others = this.all().map((m) => m.slug).filter((s) => s !== previous);
    const v = validateMemory(input, others);
    if (!v.ok) return v;
    if (previous && previous !== v.memory.slug && this.get(previous)) this.append({ type: "memory.deleted", slug: previous });
    this.append({ type: "memory.set", memory: v.memory });
    return v;
  }

  remove(slug: string): boolean {
    if (!this.get(slug)) return false;
    this.append({ type: "memory.deleted", slug });
    return true;
  }

  resolve(token: string): Resolution | undefined {
    const m = this.get(token);
    return m ? resolveMemory(m) : undefined;
  }
}
