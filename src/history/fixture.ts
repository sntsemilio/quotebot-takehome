// Test support for "Mis cotizaciones": a history folder like runs/app, built from the recorded quotes of
// case 7 and case 9 (src/record/fixtures) and synthetic conversation records. Used by history and web tests only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "record", "fixtures");
export const RUN7 = "quote-2026-11-19T04-21-55-802Z-qotf";
export const RUN9 = "quote-2026-11-19T04-33-03-517Z-ntk3";
export const NOTE7 = "La primera opción es FedEx México, FedEx Nacional Económico, con llegada el 27 de noviembre según el sitio.";

type TurnIn = { t: string; role: "user" | "assistant" | "tool"; text: string; runId?: string };
function conversationFile(dir: string, id: string, turns: TurnIn[]) {
  const lines = turns.map((x, i) => JSON.stringify({ seq: i + 1, ms: i, type: "conversation.turn", conversationId: id, ...x }));
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
}

// A history folder like runs/app: three conversations, two quote records.
export function historyDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-hist-"));
  fs.copyFileSync(path.join(fixtures, "case7-qotf.jsonl"), path.join(dir, `${RUN7}.jsonl`));
  fs.copyFileSync(path.join(fixtures, "case9-ntk3.jsonl"), path.join(dir, `${RUN9}.jsonl`));
  conversationFile(dir, "conversation-c7", [
    { t: "2026-11-19T04:21:54.000Z", role: "user", text: "Cuánto me cobran por 4 cajas de 10 kg, 40x30x30, de 64000 a 22000?" },
    { t: "2026-11-19T04:21:55.700Z", role: "tool", text: "request_quote {…} -> Quote started", runId: RUN7 },
    { t: "2026-11-19T04:21:56.000Z", role: "assistant", text: "Estoy cotizando con Estafeta, FedEx y DHL. Los precios aparecerán abajo.", runId: RUN7 },
    { t: "2026-11-19T04:24:20.000Z", role: "assistant", text: `[result note] ${NOTE7}`, runId: RUN7 },
    { t: "2026-11-19T04:25:00.000Z", role: "user", text: "Gracias" },
    { t: "2026-11-19T04:25:02.000Z", role: "assistant", text: "Con gusto." },
  ]);
  conversationFile(dir, "conversation-c9", [
    { t: "2026-11-17T18:00:00.000Z", role: "user", text: "De 99999 a 06000, 1 kg, 30x20x15 cm" },
    { t: "2026-11-17T18:00:01.000Z", role: "tool", text: "request_quote {…}", runId: RUN9 },
    { t: "2026-11-17T18:00:02.000Z", role: "assistant", text: "Estoy cotizando.", runId: RUN9 },
  ]);
  conversationFile(dir, "conversation-ask", [
    { t: "2026-11-01T16:00:00.000Z", role: "user", text: "Hola, ¿cuánto cuesta mandar un regalo a Mérida? Es una caja mediana con una lámpara de barro" },
    { t: "2026-11-01T16:00:02.000Z", role: "assistant", text: "Para cotizar necesito los códigos postales, el peso y las medidas." },
  ]);
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a record");
  return dir;
}
