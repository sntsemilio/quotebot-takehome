// The web app over HTTP: the product at "/", no start page, "Mis cotizaciones" read from disk, a closed
// conversation is read-only, and no path leaves runs/. Fake orchestrator and fake model: no browser, no network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./app.js";
import { Conversation } from "../conversation/session.js";
import type { Orchestrator } from "../orchestrator/types.js";
import { NOTE7, historyDir } from "../history/fixture.js";

const orchestrator: Orchestrator = {
  async startQuote() { throw new Error("no quotes in this test"); },
  subscribe() { throw new Error("unknown run"); },
  async finished() { throw new Error("unknown run"); },
};
// The model answers one question and never quotes.
const client = {
  messages: {
    create: async () => ({
      model: "claude-haiku-5-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "text", text: "Para cotizar necesito el peso y las medidas.", citations: null }],
    }),
  },
} as unknown as Anthropic;

let server: http.Server;
let base = "";
let dir = "";
before(async () => {
  dir = historyDir();
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-pub-"));
  fs.writeFileSync(path.join(publicDir, "index.html"), '<!doctype html><html lang="es"><body>Tienda Nopal</body></html>');
  fs.writeFileSync(path.join(publicDir, "app.css"), "body{}");
  fs.writeFileSync(path.join(publicDir, "app.js"), "void 0;");
  fs.writeFileSync(path.join(publicDir, "secret.txt"), "not served");
  server = createApp({
    orchestrator, replay: true, historyDir: dir, runsRoot: dir, publicDir,
    newConversation: () => new Conversation(orchestrator, { client, recordDir: dir }),
    now: () => new Date("2026-11-19T16:00:00Z"),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const get = (p: string) => fetch(base + p);

test("'/' always opens the product (with the replay flag); the start page and the setup endpoint are gone", async () => {
  const home = await get("/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<html lang="es" data-replay="1">/);
  assert.equal((await get("/app.css")).headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal((await get("/app.js")).status, 200);
  for (const p of ["/start", "/api/setup", "/secret.txt", "/start.html"]) assert.equal((await get(p)).status, 404, p);
});

test("GET /api/conversations lists the records on disk; GET /api/conversations/:id gives turns, views and notes", async () => {
  const list = await (await get("/api/conversations")).json();
  assert.deepEqual(list.conversations.map((c: { id: string; live: boolean }) => [c.id, c.live]), [
    ["conversation-c7", false], ["conversation-c9", false], ["conversation-ask", false],
  ]);
  const d = await (await get("/api/conversations/conversation-c7")).json();
  assert.equal(d.live, false);
  const quote = d.items.find((i: { kind: string }) => i.kind === "quote");
  assert.equal(quote.note, NOTE7);
  assert.equal(quote.quotedLabel, "Cotizado el 18 nov a las 22:21");
  assert.equal(quote.view.ranked[0].price.priceText, "$488.80");
  for (const p of ["/api/conversations/conversation-nope", "/api/conversations/..%2F..%2Fpackage", "/api/conversations/%E0%A4%A"]) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test("a new chat returns its id and shows as live in the list; a conversation not open in this process is read-only", async () => {
  const post = (body: unknown) => fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const r = await post({ message: "Quiero mandar algo a Mérida" });
  assert.equal(r.status, 200);
  const { conversationId, answer } = await r.json();
  assert.match(conversationId, /^conversation-/);
  assert.equal(answer, "Para cotizar necesito el peso y las medidas.");
  const list = await (await get("/api/conversations")).json();
  assert.deepEqual(list.conversations.find((c: { id: string }) => c.id === conversationId), {
    ...list.conversations.find((c: { id: string }) => c.id === conversationId), live: true, title: "Quiero mandar algo a Mérida", line: "Sin cotización",
  });
  assert.equal((await post({ conversationId, message: "son 2 kg" })).status, 200, "an open conversation continues");
  const closed = await post({ conversationId: "conversation-c7", message: "otra vez" });
  assert.equal(closed.status, 409);
  assert.match((await closed.json()).answer, /Cotizar de nuevo/);
  assert.equal((await post({ message: "" })).status, 400);
});

test("/runs/ never leaves the runs folder", async () => {
  fs.writeFileSync(path.join(dir, "ev.png"), "png");
  assert.equal((await get("/runs/ev.png")).status, 200);
  for (const p of ["/runs/..%2Fpackage.json", "/runs/%2E%2E/%2E%2E/package.json", "/runs/conversation-c7.txt", "/runs/..%5C..%5Cpackage.json"]) {
    assert.equal((await get(p)).status, 404, p);
  }
});
