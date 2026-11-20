// Append-only JSONL store: runs/<label>/<runId>.jsonl. Writes are synchronous so nothing is lost if the process dies.
// Listeners (orchestrator.subscribe, SSE) are notified in-process AFTER each line is on disk; the file stays the
// source of truth, so a listener that joins late reads events() first and then subscribes.
import fs from "node:fs";
import path from "node:path";
import type { EventPayloads, EventType, RunEvent } from "./events.js";

export type EventListener = (event: RunEvent) => void;

export class RunStore {
  readonly file: string;
  private seq = 0;
  private readonly startedAt = Date.now();
  private readonly listeners = new Set<EventListener>();

  constructor(readonly dir: string, readonly runId: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${runId}.jsonl`);
  }

  // Appends one event and returns its sequence number (used to point at it, e.g. "see event N").
  append<K extends EventType>(type: K, data: EventPayloads[K]): number {
    const seq = ++this.seq;
    const event = { seq, t: new Date().toISOString(), ms: Date.now() - this.startedAt, type, ...data } as RunEvent;
    fs.appendFileSync(this.file, JSON.stringify(event) + "\n");
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A failing listener (e.g. a closed SSE socket) must never break recording.
      }
    }
    return seq;
  }

  // Returns an unsubscribe function.
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  events(): RunEvent[] {
    return readEvents(this.file);
  }
}

export function readEvents(file: string): RunEvent[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunEvent);
}
