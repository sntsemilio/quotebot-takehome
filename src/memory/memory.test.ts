// "Memorias", a context plugin with its own record, resolved in code before the model reads a message.
// Fake model, fake orchestrator, a temp folder for the records. No browser, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { MemoryStore, SEEDS, slugify, validateMemory } from "./memories.js";
import { memoryLine, resolveMessage } from "./context.js";
import { Conversation } from "../conversation/session.js";
import { prepareQuote } from "../conversation/requestQuote.js";
import { carriers as registry } from "../carriers/index.js";
import type { Orchestrator } from "../orchestrator/types.js";
import type { QuoteRequest } from "../domain/request.js";
import type { RunEvent } from "../record/events.js";
import { createApp } from "../web/app.js";

const NOW = new Date("2026-11-19T16:00:00Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qb-mem-"));
const read = (f: string): RunEvent[] => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// A store as Mariana would fill it in the UI. Example values for the tests only: the code never seeds them.
function filled(dir = tmp()): MemoryStore {
  const m = new MemoryStore(path.join(dir, "memory.jsonl"));
  assert.ok(m.save({ previousSlug: "tienda-nopal", kind: "tienda", name: "Tienda Nopal", zip: "64000", customerType: "business" }).ok);
  assert.ok(m.save({ previousSlug: "caja-mediana", kind: "caja", name: "Caja mediana", lengthCm: 40, widthCm: 30, heightCm: 25 }).ok);
  assert.ok(m.save({ kind: "destino", name: "Mérida", zip: "97000" }).ok);
  return m;
}

function fakeModel(responses: Partial<Anthropic.Message>[]) {
  const calls: { messages: Anthropic.MessageParam[] }[] = [];
  const client = {
    messages: {
      create: async (req: { messages: Anthropic.MessageParam[] }) => {
        calls.push(JSON.parse(JSON.stringify(req)));
        const r = responses.shift();
        if (!r) throw new Error("no scripted response");
        return { model: "claude-haiku-5-5", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", ...r };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}
const tool = (input: unknown, id = "t1") => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "request_quote", input }] as Anthropic.ContentBlock[] }) as Partial<Anthropic.Message>;
const say = (text: string) => ({ content: [{ type: "text", text, citations: null }] as Anthropic.ContentBlock[] }) as Partial<Anthropic.Message>;
function fakeOrchestrator() {
  const started: { request: QuoteRequest; carrierIds: string[] }[] = [];
  const orch = {
    async startQuote(request: QuoteRequest, carrierIds: string[]) { started.push({ request, carrierIds }); return `q${started.length}`; },
    subscribe() { return () => {}; },
    async finished() { throw new Error("unused"); },
  } as unknown as Orchestrator;
  return { orch, started };
}
const lastUserText = (c: { messages: Anthropic.MessageParam[] }) => {
  const u = [...c.messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
  return u?.content as string;
};

test("the initial slots exist with names only; validation in code with clear Spanish errors; every change is an event", () => {
  const dir = tmp();
  const m = new MemoryStore(path.join(dir, "memory.jsonl"));
  assert.deepEqual(m.list().map((i) => [i.token, i.kindLabel, i.short, i.empty]), [
    ["tienda-nopal", "Tienda", "Sin CP", true], ["caja-chica", "Caja", "Sin medidas", true],
    ["caja-mediana", "Caja", "Sin medidas", true], ["caja-grande", "Caja", "Sin medidas", true],
  ]);
  assert.ok(SEEDS.every((s) => Object.keys(s).sort().join() === "kind,name,slug"), "no seed carries a value");
  assert.equal(fs.existsSync(m.file), false, "reading never writes");

  const bad = m.save({ previousSlug: "tienda-nopal", kind: "tienda", name: "Tienda Nopal", zip: "6400", customerType: "alguien" });
  assert.ok(!bad.ok);
  assert.deepEqual(bad.errors, [{ field: "zip", message: "El CP debe tener 5 dígitos." }, { field: "customerType", message: "Elige persona física o moral." }]);
  const box = validateMemory({ kind: "caja", name: "Caja chica", lengthCm: "", widthCm: "0", heightCm: "abc", weightKg: "-1" }, []);
  assert.ok(!box.ok);
  assert.deepEqual(box.errors.map((e) => e.message), [
    "Escribe el largo en cm.", "El ancho debe ser un número mayor que 0 y de hasta 300 cm.", "El alto debe ser un número mayor que 0 y de hasta 300 cm.",
    "El peso debe ser un número mayor que 0 y de hasta 100 kg, o quedar vacío.",
  ]);
  const dup = m.save({ kind: "caja", name: "Caja Chica" });
  assert.ok(!dup.ok && dup.errors.some((e) => e.message === "Ya tienes una memoria llamada #caja-chica."));
  assert.ok(!validateMemory({ kind: "destino", name: "123", zip: "97000" }, []).ok, "a slug starts with a letter");
  assert.equal(slugify("Mérida Centro"), "merida-centro");
  assert.equal(fs.existsSync(m.file), false, "an invalid save writes nothing");

  // Create, edit (with a comma decimal from the form), rename and delete: append-only events, folded.
  assert.ok(m.save({ previousSlug: "caja-chica", kind: "caja", name: "Caja chica", lengthCm: "20", widthCm: "15,5", heightCm: 10, weightKg: "1" }).ok);
  assert.ok(m.save({ kind: "destino", name: "Mérida", zip: "97000" }).ok);
  assert.ok(m.save({ previousSlug: "merida", kind: "destino", name: "Mérida centro", zip: "97000" }).ok);
  assert.ok(m.remove("caja-grande"));
  assert.equal(m.remove("caja-grande"), false);
  assert.deepEqual(read(m.file).map((e) => [e.type, e.type === "memory.set" ? e.memory.slug : e.type === "memory.deleted" ? e.slug : ""]), [
    ["memory.set", "caja-chica"], ["memory.set", "merida"], ["memory.deleted", "merida"], ["memory.set", "merida-centro"], ["memory.deleted", "caja-grande"],
  ]);
  assert.deepEqual(read(m.file).map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(m.list().map((i) => [i.token, i.short]), [
    ["tienda-nopal", "Sin CP"], ["caja-chica", "20 × 15.5 × 10 cm, peso típico 1 kg"], ["caja-mediana", "Sin medidas"], ["merida-centro", "CP 97000"],
  ]);
});

test("without # nothing is resolved: the five measured messages reach the model exactly as typed", () => {
  const m = filled();
  const cases = JSON.parse(fs.readFileSync("cases/cases.json", "utf8")) as { id: number; message: string }[];
  for (const c of cases.filter((x) => [1, 5, 6, 7, 9].includes(x.id))) assert.equal(resolveMessage(c.message, [m]), null, `case ${c.id}`);
  assert.equal(resolveMessage("caja #2 de 3 kg", [m]), null, "#2 is not a memory");
  assert.equal(memoryLine(null), "");
  // measure-after never loads memories: the measured runs stay valid.
  assert.doesNotMatch(fs.readFileSync("src/harness/measure-after.ts", "utf8"), /memor/i);
});

test("'#caja-mediana 3 kg desde #tienda-nopal a 06600' quotes from 64000 with the box and the store's customerType; Redpack waits only for the delivery type and UPS for the date", async () => {
  const m = filled();
  const text = "#caja-mediana 3 kg desde #tienda-nopal a 06600";
  const context = resolveMessage(text, [m]);
  assert.equal(context?.modelText, "caja de 40 × 30 × 25 cm (#caja-mediana) 3 kg desde origen CP 64000 (#tienda-nopal) a 06600");
  const { client, calls } = fakeModel([
    tool({ originZip: "64000", destZip: "06600", parcel: { weight: 3, weightUnit: "kg", length: 40, width: 30, height: 25, lengthUnit: "cm" } }),
    say("Estoy cotizando con Estafeta, FedEx y DHL. Para Redpack, ¿la entrega es a domicilio o en sucursal? Para UPS, ¿qué día envías?"),
    tool({ originZip: "64000", destZip: "06600", parcel: { weight: 3, weightUnit: "kg", length: 40, width: 30, height: 25, lengthUnit: "cm" }, carriers: ["redpack", "ups"], extras: { deliveryType: "home", shipDate: "2026-11-20" } }, "t2"),
    say("Listo, cotizo Redpack y UPS."),
  ]);
  const { orch, started } = fakeOrchestrator();
  const dir = tmp();
  const conv = new Conversation(orch, { client, now: () => NOW, recordDir: dir });
  const r = await conv.send(text, { context });

  // The model read the explicit values, never the bare tokens.
  assert.equal(lastUserText(calls[0]), context!.modelText);
  // The request: origin from the store, the box, and the store's customerType merged by code.
  assert.equal(started[0].request.originZip, "64000");
  assert.deepEqual(started[0].request.parcels, [{ weightKg: 3, lengthCm: 40, widthCm: 30, heightCm: 25 }]);
  assert.deepEqual(started[0].request.extras, { customerType: "business" });
  // What the model was told to ask: Redpack only the delivery type, UPS only the date; nobody asks física o moral.
  const toolResult = JSON.stringify(calls[1].messages[calls[1].messages.length - 1]);
  assert.match(toolResult, /Redpack \(redpack\) needs: extras\.deliveryType = entrega a domicilio o en sucursal/);
  assert.match(toolResult, /UPS México \(ups\) needs: extras\.shipDate = fecha de envío/);
  assert.doesNotMatch(toolResult, /customerType/);
  // The reply names the memories used and their values, in code, before the model's text.
  assert.equal(r.text.split("\n\n")[0], "Usé #caja-mediana: 40 × 30 × 25 cm; #tienda-nopal: CP 64000, persona moral.");
  assert.match(r.text, /Para Redpack, ¿la entrega es a domicilio o en sucursal\?/);

  // The answer for Redpack and UPS: the store's customerType still applies, the model never had to repeat it.
  await conv.send("A domicilio y lo mando mañana");
  assert.deepEqual(started[1].carrierIds, ["redpack", "ups"]);
  assert.deepEqual(started[1].request.extras, { deliveryType: "home", shipDate: "2026-11-20", customerType: "business" });

  // The record: the user's own text and the values used then. Editing the memory later never changes it.
  const turns = read(conv.recordFile!).filter((e) => e.type === "conversation.turn");
  const user = turns.find((t) => t.type === "conversation.turn" && t.role === "user");
  assert.ok(user && user.type === "conversation.turn");
  assert.equal(user.text, text);
  assert.deepEqual(user.memoriesUsed, [{ slug: "caja-mediana", value: "40 × 30 × 25 cm" }, { slug: "tienda-nopal", value: "CP 64000, persona moral" }]);
  assert.ok(m.save({ previousSlug: "caja-mediana", kind: "caja", name: "Caja mediana", lengthCm: 45, widthCm: 35, heightCm: 25 }).ok);
  assert.deepEqual(read(conv.recordFile!).find((e) => e.type === "conversation.turn" && e.role === "user")!, user);
  assert.equal(resolveMessage("#caja-mediana", [m])?.used[0].value, "45 × 35 × 25 cm", "only new messages use the new value");
  // The second user turn had no # and records no memories.
  const second = turns.filter((t) => t.type === "conversation.turn" && t.role === "user")[1] as { memoriesUsed?: unknown };
  assert.equal(second.memoriesUsed, undefined);
});

test("an empty memory or an unknown #slug is never resolved with a value: the model is told to ask and the reply says why", async () => {
  const m = filled();
  const text = "#caja-chica 2 kg de #tienda-nopal a #xyz";
  const context = resolveMessage(text, [m])!;
  assert.equal(context.modelText,
    "#caja-chica [a saved box with no values yet: ask the user for its dimensions; never guess] 2 kg de origen CP 64000 (#tienda-nopal) a " +
    "#xyz [nothing is saved under this name: ask the user what it means; never guess]");
  assert.deepEqual(context.used, [{ slug: "tienda-nopal", value: "CP 64000, persona moral" }]);
  const { client, calls } = fakeModel([say("¿Cuánto mide tu caja chica (largo, ancho y alto en cm)? ¿Y a qué código postal va?")]);
  const { orch, started } = fakeOrchestrator();
  const r = await new Conversation(orch, { client, now: () => NOW, recordDir: null }).send(text, { context });
  assert.equal(started.length, 0);
  assert.doesNotMatch(lastUserText(calls[0]), /× |\d+ cm/, "no dimensions for the empty box");
  assert.equal(r.text.split("\n\n")[0], "Usé #tienda-nopal: CP 64000, persona moral. Tu #caja-chica todavía no tiene medidas guardadas. No tengo guardado #xyz.");
  assert.match(r.text, /¿Cuánto mide tu caja chica/);
  // An empty store slot: the postal code is asked, never assumed.
  const empty = new MemoryStore(path.join(tmp(), "memory.jsonl"));
  const c2 = resolveMessage("desde #tienda-nopal", [empty])!;
  assert.deepEqual([c2.used, c2.notices, c2.extras], [[], ["Tu #tienda-nopal todavía no tiene CP guardado."], {}]);
  assert.doesNotMatch(c2.modelText, /\d/);
});

test("a box's typical weight is said as such and only fills in: '#caja-mediana 3 kg' with a box that keeps 2 kg quotes 3 kg", async () => {
  const m = filled();
  assert.ok(m.save({ previousSlug: "caja-mediana", kind: "caja", name: "Caja mediana", lengthCm: 40, widthCm: 30, heightCm: 25, weightKg: 2 }).ok);
  assert.equal(m.list().find((i) => i.token === "caja-mediana")?.short, "40 × 30 × 25 cm, peso típico 2 kg");
  const text = "#caja-mediana 3 kg de #tienda-nopal a 06600";
  const context = resolveMessage(text, [m])!;
  assert.equal(context.modelText,
    "caja de 40 × 30 × 25 cm (#caja-mediana; typical weight 2 kg, use it only if the user gave no weight) 3 kg de origen CP 64000 (#tienda-nopal) a 06600");
  const { client, calls } = fakeModel([
    tool({ originZip: "64000", destZip: "06600", parcel: { weight: 3, weightUnit: "kg", length: 40, width: 30, height: 25, lengthUnit: "cm" } }),
    say("Estoy cotizando tu caja de 3 kg."),
  ]);
  const { orch, started } = fakeOrchestrator();
  const r = await new Conversation(orch, { client, now: () => NOW, recordDir: null }).send(text, { context });
  assert.equal(lastUserText(calls[0]), context.modelText);
  assert.equal(started[0].request.parcels[0].weightKg, 3, "the weight she wrote, not the typical one");
  assert.equal(r.text.split("\n\n")[0], "Usé #caja-mediana: 40 × 30 × 25 cm, peso típico 2 kg; #tienda-nopal: CP 64000, persona moral.");
});

test("the priority under the composer is used only when the model set none; by_date is left to the model", () => {
  const input = { originZip: "64000", destZip: "06600", parcel: { weight: 2, weightUnit: "kg", length: 30, width: 20, height: 15, lengthUnit: "cm" } };
  const fast = prepareQuote(input, registry, NOW, undefined, { priority: "fastest" });
  assert.ok(fast.ok && fast.request.preference?.priority === "fastest");
  const own = prepareQuote({ ...input, preference: { priority: "by_date", deadline: "2026-11-20" } }, registry, NOW, undefined, { priority: "fastest" });
  assert.ok(own.ok && own.request.preference?.priority === "by_date", "the model's own priority wins");
  const set = prepareQuote({ ...input, extras: { customerType: "individual" } }, registry, NOW, undefined, { customerType: "business" });
  assert.ok(set.ok && set.request.extras?.customerType === "individual", "what the user said in the message wins over the memory");
  const none = prepareQuote(input, registry, NOW);
  assert.ok(none.ok && none.request.preference === undefined && none.request.extras === undefined);
});

test("/api/memorias lists, validates, saves and deletes; /api/chat resolves # and passes the priority", async () => {
  const dir = tmp();
  const memory = new MemoryStore(path.join(dir, "memory.jsonl"));
  const { client, calls } = fakeModel([
    tool({ originZip: "64000", destZip: "97000", parcel: { weight: 1, weightUnit: "kg", length: 20, width: 15, height: 10, lengthUnit: "cm" } }),
    say("Cotizando."),
  ]);
  const { orch, started } = fakeOrchestrator();
  const publicDir = tmp();
  fs.writeFileSync(path.join(publicDir, "index.html"), '<!doctype html><html lang="es"><body></body></html>');
  const server: http.Server = createApp({
    orchestrator: { ...orch, finished: () => new Promise(() => {}) } as Orchestrator, replay: false, historyDir: dir, runsRoot: dir, publicDir, memory,
    newConversation: () => new Conversation(orch, { client, now: () => NOW, recordDir: dir }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const list = await (await fetch(base + "/api/memorias")).json();
    assert.equal(list.memories.length, 4);
    const bad = await post("/api/memorias", { previousSlug: "tienda-nopal", kind: "tienda", name: "Tienda Nopal", zip: "640" });
    assert.equal(bad.status, 400);
    assert.deepEqual((await bad.json()).errors, [{ field: "zip", message: "El CP debe tener 5 dígitos." }]);
    const ok = await post("/api/memorias", { previousSlug: "tienda-nopal", kind: "tienda", name: "Tienda Nopal", zip: "64000", customerType: "individual" });
    assert.deepEqual((await ok.json()).memory, {
      token: "tienda-nopal", name: "Tienda Nopal", kind: "tienda", kindLabel: "Tienda", short: "CP 64000, persona física", empty: false,
      values: { zip: "64000", customerType: "individual" },
    });
    assert.equal((await post("/api/memorias", { kind: "destino", name: "Mérida", zip: "97000" })).status, 200);
    assert.equal((await post("/api/memorias", { kind: "caja", name: "Caja de prueba", lengthCm: 20, widthCm: 15, heightCm: 10 })).status, 200);
    assert.equal((await fetch(base + "/api/memorias/caja-grande", { method: "DELETE" })).status, 200);
    assert.equal((await fetch(base + "/api/memorias/caja-grande", { method: "DELETE" })).status, 404);

    const chat = await post("/api/chat", { message: "#caja-de-prueba 1 kg de #tienda-nopal a #merida", priority: "fastest" });
    const answer = await chat.json();
    assert.equal(lastUserText(calls[0]), "caja de 20 × 15 × 10 cm (#caja-de-prueba) 1 kg de origen CP 64000 (#tienda-nopal) a destino CP 97000 (#merida)");
    assert.equal(answer.answer.split("\n\n")[0], "Usé #caja-de-prueba: 20 × 15 × 10 cm; #tienda-nopal: CP 64000, persona física; #merida: CP 97000.");
    assert.deepEqual(started[0].request.extras, { customerType: "individual" });
    assert.deepEqual(started[0].request.preference, { priority: "fastest" });
    assert.equal((await post("/api/chat", { message: "hola", priority: "soon" })).status, 400);
  } finally {
    server.close();
  }
});
