// End to end: runCarrier against a local HTTP server that behaves like a bot wall. Code must close the
// carrier as `blocked` with evidence and a trace BEFORE any model call (the API key is a dummy; a model call
// would fail and close as `failed` instead). The tests of the ready wait, the turns-left notices and the caps with prices inject a
// scripted fake model instead. Needs Chromium (Docker image):
//   ANTHROPIC_API_KEY=dummy npx tsx --test src/agent/carrierAgent.local.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { RunStore } from "../record/store.js";
import { fold } from "../record/state.js";
import type { CarrierPlugin } from "../carriers/types.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { RunEvent } from "../record/events.js";

process.env.ANTHROPIC_API_KEY ??= "dummy";
const { runCarrier, TURNS_LEFT_NOTICE, NUDGE } = await import("./carrierAgent.js");

let server: http.Server;
let base = "";
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/forbidden") return res.writeHead(403, { "content-type": "text/html; charset=utf-8" }).end("<h1>Forbidden</h1>");
    if (req.url === "/wall") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h1>Access Denied</h1><p>You don't have permission to access this server. Reference #18.5f</p>");
    if (req.url === "/reset") return req.socket.destroy(); // like an anti-bot connection reset
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><body>${body}</body>`);
    // Pages: the form text appears 2 s after load; it never appears; a plain page; a page with a price.
    if (req.url === "/slow") return html("<p>Cargando</p><script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p>Listo</p>'), 2000)</script>");
    if (req.url === "/never") return html("<p>Cargando</p>");
    if (req.url === "/plain") return html("<h1>Hola</h1>");
    if (req.url === "/price") return html("<h1>Tarifas</h1><p>Terrestre $123.45</p>");
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function runAgainst(p: string) {
  const plugin: CarrierPlugin = { id: "wall", name: "Wall", startUrl: `${base}${p}`, allowedDomains: ["127.0.0.1"], notes: "", budget: { maxSteps: 3, maxSeconds: 30 } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-a4-"));
  const store = new RunStore(dir, "r");
  const request = { originZip: "64000", destZip: "22000", parcels: [{ weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10 }] };
  await runCarrier({ plugin, request, store, runDir: path.join(dir, "r"), maxUsd: 1 });
  const events = store.events();
  return { events, state: fold(events).carriers.wall, dir };
}

for (const [p, re] of [["/forbidden", /403/], ["/wall", /Access Denied/i], ["/reset", /ERR_EMPTY_RESPONSE|ERR_CONNECTION/]] as const) {
  test(`${p} closes as blocked by code, with evidence and trace, and no model call`, async () => {
    const { events, state, dir } = await runAgainst(p);
    assert.equal(state.status, "blocked", JSON.stringify(state));
    assert.equal(state.closedBy, "code");
    assert.match(state.reason ?? "", re);
    assert.equal(events.filter((e) => e.type === "model.response").length, 0, "no model turn spent");
    if (p !== "/reset") {
      // An error page with no content may not yield a screenshot; the wall pages must.
      assert.ok(state.evidenceId, "closing evidence");
      const ev = events.find((e) => e.type === "evidence.captured");
      assert.ok(ev && ev.type === "evidence.captured" && (ev.images ?? []).length > 0 && fs.existsSync(ev.images![0].file));
    }
    assert.ok(fs.existsSync(path.join(dir, "r", "wall.trace.zip")), "trace saved");
  });
}

// ---- fake model (no API) against local pages ----

type Turn = Anthropic.ContentBlock[] | (() => Anthropic.ContentBlock[]);
// Scripted model: one entry per turn. Keeps a deep copy of every request (the agent mutates its message list).
function fakeModel(script: Turn[]) {
  const requests: { messages: Anthropic.MessageParam[] }[] = [];
  const client = {
    messages: {
      create: async (req: { messages: Anthropic.MessageParam[] }) => {
        requests.push(JSON.parse(JSON.stringify(req)));
        const next = script.shift();
        if (!next) throw new Error("no more scripted turns");
        const content = typeof next === "function" ? next() : next;
        const stop_reason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
        return { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}
let n = 0;
const use = (name: string, input: Record<string, unknown> = {}) => [{ type: "tool_use", id: `tu${++n}`, name, input }] as Anthropic.ContentBlock[];
const say = (text: string) => [{ type: "text", text, citations: null }] as Anthropic.ContentBlock[];
const PRICE = { service: "Terrestre", priceText: "$123.45", amount: 123.45, currency: "MXN", includesVAT: null, deliveryDays: null, evidenceId: "ev1" };

async function runFake(p: string, script: Turn[], extra: Partial<CarrierPlugin> = {}, signal?: AbortSignal) {
  const plugin: CarrierPlugin = { id: "site", name: "Site", startUrl: `${base}${p}`, allowedDomains: ["127.0.0.1"], notes: "", budget: { maxSteps: 4, maxSeconds: 60 }, ...extra };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-s4-"));
  const store = new RunStore(dir, "r");
  const request = { originZip: "64000", destZip: "22000", parcels: [{ weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10 }] };
  const { client, requests } = fakeModel(script);
  await runCarrier({ plugin, request, store, runDir: path.join(dir, "r"), maxUsd: 1, client, signal });
  const events = store.events();
  return { events, state: fold(events).carriers.site, requests };
}
const of = <T extends RunEvent["type"]>(events: RunEvent[], type: T) => events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
// Text blocks of the last message of a request (the tool results message, plus any notice).
const lastTexts = (req: { messages: Anthropic.MessageParam[] }) => {
  const c = req.messages[req.messages.length - 1].content;
  return Array.isArray(c) ? c.flatMap((b) => (b.type === "text" ? [b.text] : [])) : [c];
};

test("the harness waits for readyText before the model's first turn, without spending a turn", async () => {
  const { events, state } = await runFake("/slow", [use("close_carrier", { status: "failed", reason: "test" })], { readyText: "Listo", readyTimeoutMs: 10_000 });
  const ready = of(events, "step.executed").find((e) => e.tool === "wait_ready");
  assert.ok(ready, "wait_ready recorded");
  assert.equal(ready.step, 0);
  const secs = Number(ready.result.match(/visible after ([\d.]+) s/)?.[1]);
  assert.ok(secs >= 1, `waited ${secs} s for a text shown 2 s after load`);
  const firstModel = of(events, "model.response")[0];
  assert.ok(ready.seq < firstModel.seq, "the wait ends before the first model call");
  assert.equal(state.steps, 1, "the wait cost no model turn");
});

test("if readyText never appears, it is recorded as a failure the model did not see, and the model starts anyway", async () => {
  const { events, state } = await runFake("/never", [use("close_carrier", { status: "failed", reason: "test" })], { readyText: "Listo", readyTimeoutMs: 1500 });
  const failed = of(events, "step.failed").find((e) => e.tool === "wait_ready");
  assert.ok(failed, "wait_ready failure recorded");
  assert.equal(failed.shownToModel, false);
  assert.equal(failed.step, 0);
  assert.match(failed.error, /'Listo' not visible after 1\.\d s; the model starts anyway/);
  assert.equal(of(events, "model.response").length, 1);
  assert.equal(state.status, "failed");
  assert.equal(state.closedBy, "model");
});

test("notices at 2 turns and 1 turn left, in the results message and as carrier.notice; no prices -> budget_exhausted", async () => {
  const { events, state, requests } = await runFake("/plain", [use("view_page"), use("view_page"), use("view_page"), use("view_page")]);
  assert.deepEqual(of(events, "carrier.notice").map((e) => [e.step, e.text]), [[2, TURNS_LEFT_NOTICE[2]], [3, TURNS_LEFT_NOTICE[1]]]);
  assert.deepEqual(lastTexts(requests[1]), [], "no notice with 3 turns left");
  assert.deepEqual(lastTexts(requests[2]), [TURNS_LEFT_NOTICE[2]]);
  assert.deepEqual(lastTexts(requests[3]), [TURNS_LEFT_NOTICE[1]]);
  assert.equal(state.status, "budget_exhausted");
  assert.equal(state.reason, "step cap reached (4 model turns)");
});

test("the existing nudge is recorded as carrier.notice", async () => {
  const { events, state, requests } = await runFake("/plain", [say("Listo."), say("Ya.")], { budget: { maxSteps: 10, maxSeconds: 60 } });
  assert.deepEqual(of(events, "carrier.notice").map((e) => [e.step, e.text]), [[1, NUDGE]]);
  assert.deepEqual(lastTexts(requests[1]), [NUDGE]);
  assert.equal(state.status, "failed");
});

test("the step cap with 1 verified price closes as quoted, naming the cap", async () => {
  const { state } = await runFake("/price", [use("capture_evidence", { reason: "rates" }), use("report_price", PRICE), use("view_page")], { budget: { maxSteps: 3, maxSeconds: 60 } });
  assert.equal(state.prices.length, 1);
  assert.equal(state.status, "quoted");
  assert.equal(state.closedBy, "code");
  assert.equal(state.reason, "step cap reached (3 model turns) after 1 verified price(s); the site may list more services");
});

test("the global cap after a verified price also closes as quoted", async () => {
  const ac = new AbortController();
  const { state } = await runFake("/price", [
    use("capture_evidence", { reason: "rates" }),
    () => {
      ac.abort(new Error("quote cost cap reached ($5.000 > $4)"));
      return use("report_price", PRICE);
    },
  ], {}, ac.signal);
  assert.equal(state.prices.length, 1);
  assert.equal(state.status, "quoted");
  assert.equal(state.reason, "global cap: quote cost cap reached ($5.000 > $4) after 1 verified price(s); the site may list more services");
});
