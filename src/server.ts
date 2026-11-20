// Web server entry point. The app itself is src/web/app.ts.
// usage: npm run dev  ->  http://localhost:3000   (REPLAY_RUN=<jsonl> replays a recorded quote: no browser, no carrier sites)
import path from "node:path";
import { configFromEnv, createOrchestrator } from "./orchestrator/index.js";
import { Conversation } from "./conversation/session.js";
import { createApp } from "./web/app.js";
import { MemoryStore } from "./memory/memories.js";

const PORT = Number(process.env.PORT ?? 3000);
const RUNS_ROOT = "runs";
// The orchestrator writes quotes to runs/<label>/ with label "app"; conversations go to the same folder.
const HISTORY_DIR = path.join(RUNS_ROOT, "app");
const orchestrator = createOrchestrator({ ...configFromEnv(), runsRoot: RUNS_ROOT });
// "Memorias", recorded next to the conversations (runs/app/memory.jsonl). Only the app loads them; the
// measurement harness (measure-after) does not, so the measured runs stay valid.
const memory = new MemoryStore(path.join(HISTORY_DIR, "memory.jsonl"));

const server = createApp({
  orchestrator,
  memory,
  replay: orchestrator.isReplay,
  newConversation: () => new Conversation(orchestrator, { recordDir: HISTORY_DIR }),
  historyDir: HISTORY_DIR,
  runsRoot: RUNS_ROOT,
  publicDir: "public",
});

server.listen(PORT, () =>
  console.log(`Tienda Nopal, envíos: http://localhost:${PORT}${orchestrator.isReplay ? `  [REPLAY ${process.env.REPLAY_RUN}]` : ""}`),
);
