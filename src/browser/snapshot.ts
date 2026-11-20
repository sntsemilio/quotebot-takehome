// Compact view of the page for the model: URL, title and the accessibility tree (ariaSnapshot)
// of the main frame and each allowed iframe. Never raw HTML. Capped, with an explicit truncation notice.
import crypto from "node:crypto";
import type { Frame, Page } from "playwright";
import { hostAllowed } from "./session.js";
import { readScroll, scrollSignature } from "./scroll.js";

export interface CompactView {
  text: string;
  hash: string;
}

const DEFAULT_MAX_CHARS = 14_000; // ~4-5k tokens

function frameLabel(page: Page, f: Frame): string {
  return f === page.mainFrame() ? "main frame" : `iframe ${f.url()}`;
}

// Frames the model may see/act on: the main frame plus iframes on allowed domains (skips ads/analytics frames).
export function relevantFrames(page: Page, allowedDomains: string[]): Frame[] {
  return page.frames().filter((f) => f === page.mainFrame() || (f.url() !== "about:blank" && hostAllowed(f.url(), allowedDomains)));
}

export async function compactView(page: Page, allowedDomains: string[], maxChars = DEFAULT_MAX_CHARS): Promise<CompactView> {
  const frames = relevantFrames(page, allowedDomains);
  const omitted = page.frames().length - frames.length;

  const parts: { label: string; body: string }[] = [];
  for (const f of frames) {
    let body: string;
    try {
      body = (await f.locator("body").ariaSnapshot({ timeout: 3000 })).trim();
    } catch (e) {
      body = `(accessibility tree unavailable: ${String(e).split("\n")[0]})`;
    }
    if (body) parts.push({ label: frameLabel(page, f), body });
  }

  // Fair share of the budget per frame; short frames give their leftover to long ones.
  const order = [...parts.keys()].sort((a, b) => parts[a].body.length - parts[b].body.length);
  let remaining = maxChars;
  const shown: string[] = new Array(parts.length);
  order.forEach((idx, i) => {
    const share = Math.floor(remaining / (order.length - i));
    const body = parts[idx].body;
    if (body.length <= share) {
      shown[idx] = body;
      remaining -= body.length;
    } else {
      shown[idx] = `${body.slice(0, share)}\n[truncated: showing ${share} of ${body.length} chars of this frame]`;
      remaining -= share;
    }
  });

  let title = "";
  try {
    title = await page.title();
  } catch {}
  // Scroll positions (y/max px): the accessibility tree does not change on scroll, so this tells the model where it is.
  const scroll = scrollSignature(await readScroll(page, frames));
  const header = `URL: ${page.url()}\nTitle: ${title}\nScroll: ${scroll}` + (omitted ? `\n(${omitted} iframe(s) from other domains omitted)` : "");
  const text = [header, ...parts.map((p, i) => `--- ${p.label} ---\n${shown[i]}`)].join("\n\n");
  return { text, hash: crypto.createHash("sha1").update(text).digest("hex").slice(0, 12) };
}
