// Repeatable grading (README "Measured"): pass/fail, time and cost per measured case, before and after.
// usage: npm run score   (reads results/ if it exists, else runs/; prints the table and writes results/scorecard.md)
//
// Automatic, from the records of the "after" runs (no model, no network):
//   G1  no assistant text has an amount, and every price shown is a recorded price.verified;
//   G2  every price.verified points to an evidence with at least one image;
//   G4  every launched carrier has carrier.closed with a status and a reason, every skipped one carrier.skipped.
// Manual, from cases/grades.json: G3 and the verdict on the case's `expect`. For "before" all of G1–G4 come from
// there too (its records are from the old recorder, not this format).
// Result: "pasa" when G1–G4 and the expect pass; "pregunta" when the bot correctly asked for what was missing in one
// turn; "falla" otherwise.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "../record/events.js";
import { readEvents } from "../record/store.js";
import { fold } from "../record/state.js";
import { MONEY } from "../conversation/session.js";
import { toolErrorCounts } from "./afterCase.js";

// The measured versions: the starting point and the final code. A label without a folder is skipped.
export const LABELS = ["before", "after"];

export type G = "pass" | "fail" | "n/a";
export interface Grade { expect: "pass" | "fail" | "asks"; g1?: G; g2?: G; g3?: G; g4?: G; note?: string }
export type Result = "pasa" | "pregunta" | "falla" | "sin calificar";

export interface Row {
  caseId: number;
  label: string;
  result: Result;
  g: { g1: G; g2: G; g3: G; g4: G };
  automatic: boolean; // G1, G2 and G4 computed from the records
  seconds: number | null;
  costUsd: number | null;
  replay: boolean;
  modelTurns: number | null;
  hiddenErrors: number | null; // tool errors never shown to the model (toolErrorCounts of the quote record)
  note: string;
  problems: string[]; // why an automatic G failed
}

interface Summary {
  caseId: number;
  label: string;
  durationMs?: number;
  costUsd?: number;
  steps?: number;
  toolErrorsHiddenFromModel?: number | null;
  carrierCostReplayed?: boolean;
  quoteRecord?: string;
  conversationRecord?: string;
}

// The folder with the measured runs: results/ (travels with the code) or runs/ (local).
export function dataRoot(cwd = "."): string {
  return fs.existsSync(path.join(cwd, "results", "before")) ? path.join(cwd, "results") : path.join(cwd, "runs");
}

// A summary references its records as runs/<label>/<file>; they are read next to the summary, in <root>/<label>/.
function recordPath(root: string, label: string, ref: string): string {
  return path.join(root, label, path.basename(ref));
}

// The latest summary per case for one label.
export function summariesOf(root: string, label: string): Summary[] {
  const dir = path.join(root, label);
  if (!fs.existsSync(dir)) return [];
  const byCase = new Map<number, Summary>();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".summary.json")).sort()) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Summary;
    byCase.set(s.caseId, { ...s, label });
  }
  return [...byCase.values()].sort((a, b) => a.caseId - b.caseId);
}

// G1, G2 and G4 from a conversation record and its quote record (if a quote started).
export function automaticGrades(conversation: RunEvent[], quote: RunEvent[] | null): { g1: G; g2: G; g4: G; problems: string[] } {
  const problems: string[] = [];
  for (const e of conversation) {
    if (e.type === "conversation.turn" && e.role === "assistant" && MONEY.test(e.text)) problems.push(`G1: assistant text with an amount: "${e.text.slice(0, 80)}"`);
  }
  if (!quote) return { g1: problems.length ? "fail" : "pass", g2: "n/a", g4: "n/a", problems };

  // Every price the view shows comes from fold(price.verified); check each one against its event.
  const verified = new Map(quote.filter((e) => e.type === "price.verified").map((e) => [e.seq, e]));
  const state = fold(quote);
  for (const [id, c] of Object.entries(state.carriers)) {
    for (const p of c.prices) {
      const e = p.seq !== undefined ? verified.get(p.seq) : undefined;
      const same = e && e.type === "price.verified" && e.carrierId === id && e.amount === p.amount && e.priceText === p.priceText && e.evidenceId === p.evidenceId;
      if (!same) problems.push(`G1: price ${id} ${p.service} ${p.priceText} is not a recorded price.verified`);
    }
  }
  const g1: G = problems.length ? "fail" : "pass";

  const g2Problems: string[] = [];
  for (const e of verified.values()) {
    if (e.type !== "price.verified") continue;
    const ev = state.evidence[e.evidenceId];
    if (!e.evidenceId || !ev || ev.images.length === 0) g2Problems.push(`G2: ${e.carrierId} ${e.service} ${e.priceText} has no evidence image`);
  }

  const g4Problems: string[] = [];
  const started = quote.find((e) => e.type === "run.started");
  const ids = started?.type === "run.started" ? started.carrierIds ?? (started.carrierId ? [started.carrierId] : []) : [];
  for (const id of ids) {
    const skipped = quote.some((e) => e.type === "carrier.skipped" && e.carrierId === id);
    const launched = quote.some((e) => e.type === "carrier.started" && e.carrierId === id);
    const closed = quote.find((e) => e.type === "carrier.closed" && e.carrierId === id);
    if (skipped) continue;
    if (!launched) g4Problems.push(`G4: ${id} neither launched nor skipped`);
    else if (!closed || closed.type !== "carrier.closed" || !closed.status || !closed.reason.trim()) g4Problems.push(`G4: ${id} launched without carrier.closed with status and reason`);
  }
  problems.push(...g2Problems, ...g4Problems);
  return { g1, g2: g2Problems.length ? "fail" : "pass", g4: g4Problems.length ? "fail" : "pass", problems };
}

export function resultOf(grade: Grade | undefined, g: Row["g"]): Result {
  if (!grade) return "sin calificar";
  const ok = Object.values(g).every((x) => x !== "fail");
  if (grade.expect === "pass") return ok ? "pasa" : "falla";
  if (grade.expect === "asks") return ok ? "pregunta" : "falla";
  return "falla";
}

export function scorecard(root: string, grades: Record<string, Grade>): Row[] {
  const rows: Row[] = [];
  for (const label of LABELS) {
    for (const s of summariesOf(root, label)) {
      const grade = grades[`${label}/case${s.caseId}`];
      let g: Row["g"];
      let problems: string[] = [];
      const automatic = label !== "before";
      // "before": from its summary (old recorder). "after": from the quote record (no quote, no carrier steps: 0).
      let hiddenErrors: number | null = s.toolErrorsHiddenFromModel ?? null;
      if (automatic) {
        const conversation = s.conversationRecord ? readEvents(recordPath(root, label, s.conversationRecord)) : [];
        const quote = s.quoteRecord ? readEvents(recordPath(root, label, s.quoteRecord)) : null;
        hiddenErrors = toolErrorCounts(quote ?? []).hidden;
        const auto = automaticGrades(conversation, quote);
        problems = auto.problems;
        g = { g1: auto.g1, g2: auto.g2, g3: grade?.g3 ?? "fail", g4: auto.g4 };
      } else {
        g = { g1: grade?.g1 ?? "fail", g2: grade?.g2 ?? "fail", g3: grade?.g3 ?? "fail", g4: grade?.g4 ?? "fail" };
      }
      rows.push({
        caseId: s.caseId, label, result: resultOf(grade, g), g, automatic,
        seconds: s.durationMs !== undefined ? Math.round(s.durationMs / 1000) : null,
        costUsd: s.costUsd ?? null, replay: Boolean(s.carrierCostReplayed) || label.includes("replay"),
        modelTurns: s.steps ?? null,
        hiddenErrors,
        note: grade?.note ?? "", problems,
      });
    }
  }
  return rows;
}

const time = (s: number | null) => (s === null ? "—" : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);
const cost = (r: Row) => (r.costUsd === null ? "—" : `$${r.costUsd.toFixed(4)}${r.replay ? " (réplica)" : ""}`);

export function render(rows: Row[]): string {
  const out: string[] = [];
  out.push("# Calificación por caso", "");
  out.push("Generado por `npm run score`. G1, G2 y G4 de `after` salen de los expedientes; G3 y el veredicto del `expect` salen de `cases/grades.json` (para `before`, también G1–G4).", "");
  out.push("| Caso | Versión | Resultado | Tiempo | Costo | Turnos del modelo | Fallas ocultas |");
  out.push("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    out.push(`| ${r.caseId} | ${r.label} | ${r.result} | ${time(r.seconds)} | ${cost(r)} | ${r.modelTurns ?? "—"} | ${r.hiddenErrors ?? "—"} |`);
  }
  out.push("", "## Detalle de G1–G4", "");
  out.push("| Caso | Versión | G1 | G2 | G3 | G4 | Origen | Nota |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    out.push(`| ${r.caseId} | ${r.label} | ${r.g.g1} | ${r.g.g2} | ${r.g.g3} | ${r.g.g4} | ${r.automatic ? "G1, G2, G4 automáticos" : "grades.json"} | ${r.note.replace(/\|/g, "/")} |`);
  }
  const problems = rows.flatMap((r) => r.problems.map((p) => `- caso ${r.caseId} (${r.label}): ${p}`));
  if (problems.length) out.push("", "## Problemas encontrados en los expedientes", "", ...problems);
  out.push("", "## Casos 5, 6 y 7: antes y después", "");
  for (const id of [5, 6, 7]) {
    const before = rows.find((r) => r.caseId === id && r.label === "before");
    const after = rows.find((r) => r.caseId === id && r.label === "after");
    const one = (r?: Row) => (r ? `${r.result} (${time(r.seconds)}, ${cost(r)})` : "sin medir");
    out.push(`- Caso ${id}: antes ${one(before)}; después ${one(after)}.`);
  }
  return out.join("\n") + "\n";
}

function main() {
  const root = dataRoot();
  const grades = JSON.parse(fs.readFileSync(path.join("cases", "grades.json"), "utf8")) as Record<string, Grade>;
  const text = render(scorecard(root, grades));
  fs.mkdirSync("results", { recursive: true });
  fs.writeFileSync(path.join("results", "scorecard.md"), text);
  console.log(text);
  console.log(`(datos: ${root}; escrito en results/scorecard.md)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
