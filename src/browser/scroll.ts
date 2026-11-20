// Scroll position of the main frame and each relevant iframe: read for the view header and the loop-detection
// fingerprint (scrolling is progress, not "no progress"), and changed by the scroll tool.
import type { Frame, Page } from "playwright";

export interface FrameScroll {
  frame: Frame;
  label: string; // "main" or the iframe URL
  y: number;
  max: number; // scrollable range (scrollHeight - viewport height); 0 = not scrollable
  viewportHeight: number;
}

export function frameLabel(page: Page, f: Frame): string {
  return f === page.mainFrame() ? "main" : f.url();
}

export async function readScroll(page: Page, frames: Frame[]): Promise<FrameScroll[]> {
  const out: FrameScroll[] = [];
  for (const f of frames) {
    const s = await f
      .evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        return { y: Math.round(el.scrollTop), max: Math.max(0, Math.round(el.scrollHeight - window.innerHeight)), vh: window.innerHeight };
      })
      .catch(() => null);
    if (s) out.push({ frame: f, label: frameLabel(page, f), y: s.y, max: s.max, viewportHeight: s.vh });
  }
  return out;
}

// Compact text such as "main 900/2400; https://x/iframe 0/0". Part of the page fingerprint.
export function scrollSignature(states: FrameScroll[]): string {
  return states.map((s) => `${s.label} ${s.y}/${s.max}`).join("; ");
}

export async function scrollFrameTo(f: Frame, y: number): Promise<number> {
  return f
    .evaluate((top) => {
      const el = document.scrollingElement ?? document.documentElement;
      el.scrollTo({ top, behavior: "instant" as ScrollBehavior });
      return Math.round(el.scrollTop);
    }, y)
    .catch(() => 0);
}
