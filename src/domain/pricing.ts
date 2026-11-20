// Model prices used to compute the cost of each model call (recorded in model.response and conversation.turn).
// USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-16).
// cacheWrite = 5-minute cache writes. Haiku 5.5 uses its prices for prompts up to 100k tokens.
export const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};
