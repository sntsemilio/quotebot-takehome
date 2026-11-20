// Reasons written when code closes a carrier because a cap was reached. Single source: the carrier agent writes
// them and the view classifies them (capKind) to tell the user which limit stopped the carrier.
export const capReason = {
  steps: (maxSteps: number) => `step cap reached (${maxSteps} model turns)`,
  time: (maxSeconds: number) => `time cap reached (${maxSeconds}s)`,
  cost: (spent: number, maxUsd: number) => `cost cap reached ($${spent.toFixed(3)} > $${maxUsd})`,
  // The orchestrator's cap for the whole quote; its message says whether it was cost or time.
  global: (message: string) => `global cap: ${message}`,
  stuck: "stuck: repeated the same action on the same page 3 times",
};

// Written by the orchestrator (quote cost/time cap) and the harness (harness time cap): matched by their text.
const GLOBAL_COST = /^global cap: .*\bcost cap\b/;
const HARNESS_TIME = /^harness time cap\b/;

export type CapKind = "steps" | "time" | "cost" | "stuck";

// Which limit a code close reason names, or null if it is not a cap. A reason converted to `quoted` after
// verified prices ("<reason> after N verified price(s)...") keeps its prefix, so it still classifies.
export function capKind(reason: string | undefined): CapKind | null {
  const r = reason ?? "";
  if (r.startsWith("step cap reached")) return "steps";
  if (r.startsWith("time cap reached") || HARNESS_TIME.test(r)) return "time";
  if (r.startsWith("cost cap reached") || GLOBAL_COST.test(r)) return "cost";
  if (r.startsWith("global cap:")) return "time";
  if (r.startsWith("stuck:")) return "stuck";
  return null;
}

// When code closes a carrier that already has verified prices, it is `quoted`; the reason says why it stopped.
export function afterPricesReason(reason: string, verifiedPrices: number): string {
  return `${reason} after ${verifiedPrices} verified price(s); the site may list more services`;
}
