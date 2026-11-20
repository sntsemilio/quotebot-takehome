// Context plugins. Carriers are data plugins; the user's own context is too. A context plugin lists what it
// knows and resolves a #token to explicit text, in code, before the message reaches the conversation model.
// "Memorias" (memories.ts) is the first one; a product catalog could be another.
import type { Extras } from "../domain/request.js";

export interface ContextItem {
  token: string; // "caja-mediana" (written as #caja-mediana)
  name: string; // "Caja mediana"
  kind: string; // "caja"
  kindLabel: string; // "Caja"
  short: string; // "40 × 30 × 25 cm" or "Sin medidas"
  empty: boolean; // saved without its values yet
}

// What one #token means. `text` replaces the token in what the model reads. `value` is what was used (recorded in
// conversation.turn.memoriesUsed and named in the reply); absent when the item has no values yet, and then `notice`
// says so to the user. `extras` are request data the code merges when the model did not set them.
export interface Resolution {
  token: string;
  text: string;
  value?: string;
  notice?: string;
  extras?: Pick<Extras, "customerType">;
}

export interface ContextPlugin {
  id: string;
  list(): ContextItem[];
  resolve(token: string): Resolution | undefined;
}

// A #token: starts with a letter, lowercase letters, digits and inner hyphens. "#2" or "caja#3" are not tokens.
const TOKEN = /(^|[^\p{L}\p{N}_#-])#([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![\p{L}\p{N}_-])/giu;

export interface ResolvedMessage {
  modelText: string; // the message with every #token replaced by its explicit meaning
  used: { slug: string; value: string }[];
  notices: string[]; // "Tu #caja-chica todavía no tiene medidas guardadas." / "No tengo guardado #xyz."
  extras: Pick<Extras, "customerType">;
}

// Resolves every #token of `text` with the first plugin that knows it. A token nobody knows is never guessed: the model
// is told to ask, and the user reads "No tengo guardado #xyz.". Returns null when the text has no token at all, so a
// message without # reaches the model exactly as typed.
export function resolveMessage(text: string, plugins: ContextPlugin[]): ResolvedMessage | null {
  if (!plugins.length || !TOKEN.test(text)) return null;
  TOKEN.lastIndex = 0;
  const used: ResolvedMessage["used"] = [];
  const notices: string[] = [];
  const extras: ResolvedMessage["extras"] = {};
  const seen = new Set<string>();
  const modelText = text.replace(TOKEN, (_m, before: string, raw: string) => {
    const token = raw.toLowerCase();
    const r = plugins.map((p) => p.resolve(token)).find(Boolean);
    if (!seen.has(token)) {
      seen.add(token);
      if (!r) notices.push(`No tengo guardado #${token}.`);
      else {
        if (r.value !== undefined) used.push({ slug: token, value: r.value });
        if (r.notice) notices.push(r.notice);
        Object.assign(extras, r.extras);
      }
    }
    return before + (r ? r.text : `#${token} [nothing is saved under this name: ask the user what it means; never guess]`);
  });
  return { modelText, used, notices, extras };
}

// The code's own line before the model's reply: which memories were used and with which values, and which could not
// be used. Empty when there is nothing to say.
export function memoryLine(r: ResolvedMessage | null): string {
  if (!r) return "";
  const parts: string[] = [];
  if (r.used.length) parts.push(`Usé ${r.used.map((u) => `#${u.slug}: ${u.value}`).join("; ")}.`);
  parts.push(...r.notices);
  return parts.join(" ");
}
