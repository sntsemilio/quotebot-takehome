// The web app: the product page and its static files, chat with the conversation model, live quote events over SSE,
// the quote view built from the record, "Mis cotizaciones" read from disk, and evidence files (limited to runs/).
// Built by createApp() with its dependencies so tests can run it without a browser, a model or the network.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Orchestrator } from "../orchestrator/types.js";
import type { Priority } from "../orchestrator/view.js";
import { collectEvents, type Conversation } from "../conversation/session.js";
import type { RunEvent } from "../record/events.js";
import { readEvents } from "../record/store.js";
import { getConversation, listConversations, quotedLabel, quoteStartedAt, viewOfRecord } from "../history/history.js";
import { resolveMessage } from "../memory/context.js";
import type { MemoryStore } from "../memory/memories.js";

export interface AppDeps {
  orchestrator: Orchestrator;
  replay: boolean; // replay mode: the page shows a discreet notice
  newConversation: () => Conversation;
  historyDir: string; // where conversation and quote records are written (runs/app)
  runsRoot: string; // evidence files are served from here only
  publicDir: string;
  now?: () => Date;
  // The memories (context plugin). Absent: no /api/memorias and every # reaches the model as typed.
  memory?: MemoryStore;
}

// Static files of the page: a whitelist, nothing else under public/ is served.
const PUBLIC_FILES: Record<string, { file: string; type: string }> = {
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};

const RUNS_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".zip": "application/zip",
};

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit = 20_000): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("body too large");
  }
  return body;
}

// SSE payload: drop the heavy fields (full evidence text, full page views); the record keeps them.
function slim(e: RunEvent): unknown {
  if (e.type === "evidence.captured") {
    const { text: _t, ...rest } = e;
    return rest;
  }
  if (e.type === "step.executed") return { ...e, result: e.result.slice(0, 200) };
  if (e.type === "model.response") return { ...e, text: e.text.slice(0, 200) };
  return e;
}

export function createApp(deps: AppDeps): http.Server {
  const now = deps.now ?? (() => new Date());
  const runsRoot = path.resolve(deps.runsRoot);
  // Conversations open in this process, keyed by their record id (conversation-…). After a restart they are
  // read-only history.
  const conversations = new Map<string, Conversation>();
  const notes = new Map<string, Promise<{ note: string; noteSource: string }>>();
  // Quotes running in this process: an unfinished record that is not here was interrupted.
  const active = new Set<string>();
  const isRunning = (runId: string) => active.has(runId);
  const priorityOf = (url: URL): Priority | undefined => {
    const p = url.searchParams.get("priority");
    return p === "cheapest" || p === "fastest" || p === "by_date" ? p : undefined;
  };

  // Serves /runs/<path> only if it resolves inside runs/ (no traversal) and has an allowed extension.
  function serveRunsFile(urlPath: string, res: http.ServerResponse) {
    let rel: string;
    try {
      rel = decodeURIComponent(urlPath.slice("/runs/".length));
    } catch {
      return json(res, 400, { error: "bad path" });
    }
    const file = path.resolve(runsRoot, rel);
    const type = RUNS_TYPES[path.extname(file).toLowerCase()];
    if (!file.startsWith(runsRoot + path.sep) || rel.includes("\0") || !type) return json(res, 404, { error: "not found" });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": type, "content-length": st.size, "x-content-type-options": "nosniff" });
      fs.createReadStream(file).pipe(res);
    });
  }

  function startNote(conv: Conversation, runId: string) {
    if (notes.has(runId)) return;
    const p = conv
      .describeResult(runId)
      .then((r) => ({ note: r.note, noteSource: r.noteSource }))
      .catch((e) => ({ note: "", noteSource: `error: ${String(e).split("\n")[0]}` }));
    notes.set(runId, p);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    // The product, always. The replay flag goes in the markup so the page needs no setup call.
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      const html = fs.readFileSync(path.join(deps.publicDir, "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(deps.replay ? html.replace('<html lang="es">', '<html lang="es" data-replay="1">') : html);
      return;
    }
    const asset = req.method === "GET" ? PUBLIC_FILES[p] : undefined;
    if (asset) {
      res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache" });
      res.end(fs.readFileSync(path.join(deps.publicDir, asset.file)));
      return;
    }

    // One chat message. Without conversationId a new conversation starts; its id comes back in the reply.
    if (req.method === "POST" && p === "/api/chat") {
      let conversationId: string | undefined, message: string, priority: unknown;
      try {
        ({ conversationId, message, priority } = JSON.parse(await readBody(req)));
        if ((conversationId !== undefined && typeof conversationId !== "string") || typeof message !== "string" || !message.trim()) throw new Error("bad input");
        if (priority !== undefined && priority !== "cheapest" && priority !== "fastest" && priority !== "by_date") throw new Error("bad priority");
      } catch {
        return json(res, 400, { error: "send {message} or {conversationId, message}, optionally with priority" });
      }
      let conv: Conversation | undefined;
      if (conversationId) {
        conv = conversations.get(conversationId);
        if (!conv) return json(res, 409, { error: "conversation not open", answer: "Esta conversación ya no se puede continuar. Usa «Cotizar de nuevo» para empezar otra con el mismo mensaje." });
      } else {
        conv = deps.newConversation();
        conversations.set(conv.conversationId, conv);
      }
      try {
        // #memories resolved in code before the model reads the message; the priority picked under the
        // composer goes with it (by_date is left to the model: it needs a deadline). Neither: the message as typed.
        const context = deps.memory ? resolveMessage(message, [deps.memory]) : null;
        const next = priority === "cheapest" || priority === "fastest" ? priority : undefined;
        const { text, runId } = context || next ? await conv.send(message, { context, priority: next }) : await conv.send(message);
        if (runId) {
          active.add(runId);
          deps.orchestrator.finished(runId).catch(() => undefined).finally(() => active.delete(runId));
          startNote(conv, runId);
        }
        return json(res, 200, { conversationId: conv.conversationId, answer: text, runId });
      } catch (e) {
        console.log(e);
        return json(res, 200, { conversationId: conv.conversationId, answer: "No pude procesar tu mensaje por un error del servidor. Envíalo de nuevo en un momento.", error: true });
      }
    }

    // "Mis cotizaciones": the list, and one conversation with each quote's view and note. Read from disk.
    if (req.method === "GET" && p === "/api/conversations") {
      const list = listConversations(deps.historyDir, now(), { isRunning }).map((c) => ({ ...c, live: conversations.has(c.id) }));
      return json(res, 200, { conversations: list });
    }
    let m = p.match(/^\/api\/conversations\/([^/]+)$/);
    if (req.method === "GET" && m) {
      let id: string;
      try {
        id = decodeURIComponent(m[1]);
      } catch {
        return json(res, 404, { error: "not found" });
      }
      const detail = getConversation(deps.historyDir, id, now(), { isRunning, priority: priorityOf(url) });
      if (!detail) return json(res, 404, { error: "not found" });
      return json(res, 200, { ...detail, live: conversations.has(id) });
    }

    // Live events of a quote: Server-Sent Events, closes after run.finished.
    m = p.match(/^\/api\/quotes\/([\w.-]+)\/events$/);
    if (req.method === "GET" && m) {
      const runId = m[1];
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      let off: (() => void) | null = null;
      let ended = false;
      const send = (e: RunEvent) => {
        if (ended) return;
        res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(slim(e))}\n\n`);
        if (e.type === "run.finished") {
          ended = true;
          queueMicrotask(() => off?.());
          res.end();
        }
      };
      try {
        off = deps.orchestrator.subscribe(runId, send);
      } catch {
        res.write(`event: error\ndata: ${JSON.stringify({ error: "unknown run" })}\n\n`);
        return res.end();
      }
      if (ended) off();
      req.on("close", () => off?.());
      return;
    }

    // A quote as the user sees it: statuses, ranked verified prices, postal codes, and the note. Quotes of this
    // process come from the orchestrator; past ones from their record in the history folder (so the
    // priority control works on any quote).
    m = p.match(/^\/api\/quotes\/([\w.-]+)$/);
    if (req.method === "GET" && m) {
      const runId = m[1];
      let events: RunEvent[];
      try {
        events = collectEvents(deps.orchestrator, runId);
      } catch {
        const file = path.join(deps.historyDir, `${runId}.jsonl`);
        if (!fs.existsSync(file)) return json(res, 404, { error: "unknown run" });
        events = readEvents(file);
      }
      // Ranked by the server, in the priority the user picked (?priority=cheapest|fastest|by_date).
      const started = quoteStartedAt(events);
      const view = viewOfRecord(runId, events, started, { isRunning, priority: priorityOf(url) });
      const note = view.finished && notes.has(runId) ? await notes.get(runId) : undefined;
      return json(res, 200, { ...view, quotedLabel: started ? quotedLabel(started) : null, note: note?.note, noteSource: note?.noteSource });
    }

    // "Memorias". The list, create or edit (validated in code; errors in Spanish, per field) and delete.
    if (p === "/api/memorias" || p.startsWith("/api/memorias/")) {
      if (!deps.memory) return json(res, 404, { error: "no memories" });
      if (req.method === "GET" && p === "/api/memorias") return json(res, 200, { memories: deps.memory.listWithValues() });
      if (req.method === "POST" && p === "/api/memorias") {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { errors: [{ field: "", message: "No se pudo leer lo que enviaste." }] });
        }
        const saved = deps.memory.save(body);
        if (!saved.ok) return json(res, 400, { errors: saved.errors });
        return json(res, 200, { memory: deps.memory.listWithValues().find((m) => m.token === saved.memory.slug) });
      }
      const d = p.match(/^\/api\/memorias\/([a-z0-9-]+)$/);
      if (req.method === "DELETE" && d) return deps.memory.remove(d[1]) ? json(res, 200, { deleted: d[1] }) : json(res, 404, { error: "not found" });
      return json(res, 404, { error: "not found" });
    }

    if (req.method === "GET" && p.startsWith("/runs/")) return serveRunsFile(p, res);

    res.writeHead(404);
    res.end();
  });
}
