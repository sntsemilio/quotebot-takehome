// Evidence capture: in ONE call, scrolls every frame with content (the main frame and each allowed iframe
// that scrolls internally) and takes as many viewport screenshots as needed to cover it (cap: 8 per frame).
// Records ONE evidence.captured event with all images. Keeps, in memory, the text visible in each image so
// report_price can say in which image a price appears. Used by the capture_evidence tool and by code
// (e.g. to back a `blocked` close with evidence).
import fs from "node:fs";
import path from "node:path";
import type { Frame, Page } from "playwright";
import type { CarrierPlugin } from "../carriers/types.js";
import type { EvidenceImage } from "../record/events.js";
import type { RunStore } from "../record/store.js";
import { relevantFrames } from "../browser/snapshot.js";
import { readScroll, scrollFrameTo, frameLabel } from "../browser/scroll.js";
import { MONEY_LINE, normalizeText, textContainsToken } from "../domain/money.js";

export const MAX_SHOTS_PER_FRAME = 8;

export interface StoredEvidence {
  text: string; // full visible text of all relevant frames (verification source)
  imageTexts: string[]; // text visible in each image, by image index (locates prices)
}

export interface EvidenceDeps {
  page: Page;
  plugin: CarrierPlugin;
  store: RunStore;
  evidenceDir: string;
  evidence: Map<string, StoredEvidence>;
}

// Text nodes of `frame` whose box intersects [top, bottom) in that frame's viewport coordinates.
async function visibleTextIn(f: Frame, top: number, bottom: number): Promise<string> {
  return f
    .evaluate(
      ({ top, bottom }) => {
        const out: string[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = (n.textContent ?? "").trim();
          const el = n.parentElement;
          if (!t || !el) continue;
          const st = getComputedStyle(el);
          if (st.visibility === "hidden" || st.display === "none") continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          for (const b of Array.from(r.getClientRects())) {
            if (b.width > 0 && b.bottom > top && b.top < bottom) {
              out.push(t);
              break;
            }
          }
        }
        return out.join("\n");
      },
      { top, bottom },
    )
    .catch(() => "");
}

function positions(max: number, step: number): number[] {
  const ys: number[] = [];
  for (let y = 0; ys.length < MAX_SHOTS_PER_FRAME; y += step) {
    ys.push(Math.min(y, max));
    if (y >= max) break;
  }
  return [...new Set(ys)];
}

export async function captureEvidence(d: EvidenceDeps, reason: string): Promise<{ evidenceId: string; text: string; images: EvidenceImage[]; excerpt: string }> {
  const { page, plugin } = d;
  const evidenceId = `ev${d.evidence.size + 1}`;
  fs.mkdirSync(d.evidenceDir, { recursive: true });
  const frames = relevantFrames(page, plugin.allowedDomains);
  const before = await readScroll(page, frames);
  const images: EvidenceImage[] = [];
  const imageTexts: string[] = [];
  const fileFor = (i: number) => path.join(d.evidenceDir, `${plugin.id}-${evidenceId}-${i}.png`).replace(/\\/g, "/");
  const settle = () => page.waitForTimeout(150);

  // 1) Main frame: viewport shots down the page. Each image's text includes iframe content visible in it.
  const main = before.find((s) => s.frame === page.mainFrame());
  const vh = main?.viewportHeight ?? page.viewportSize()?.height ?? 900;
  for (const y of positions(main?.max ?? 0, vh)) {
    const actualY = await scrollFrameTo(page.mainFrame(), y);
    await settle();
    const file = fileFor(images.length);
    await page.screenshot({ path: file, timeout: 10_000 });
    const parts = [await visibleTextIn(page.mainFrame(), 0, vh)];
    for (const f of frames) {
      if (f === page.mainFrame()) continue;
      const box = await (await f.frameElement().catch(() => null))?.boundingBox().catch(() => null);
      if (!box || box.y >= vh || box.y + box.height <= 0) continue;
      // Visible part of the iframe = main viewport ∩ the iframe's own viewport (content below its internal
      // scroll is NOT in this image, even if it would fit in the main viewport).
      const ownHeight = before.find((s) => s.frame === f)?.viewportHeight ?? box.height;
      const top = Math.max(0, -box.y);
      const bottom = Math.min(ownHeight, vh - box.y);
      if (bottom > top) parts.push(await visibleTextIn(f, top, bottom));
    }
    const imageText = parts.filter(Boolean).join("\n");
    images.push({ index: images.length, file, frame: "main", scrollY: actualY, text: imageText });
    imageTexts.push(imageText);
  }

  // 2) Iframes that scroll internally: element shots while scrolling inside them.
  for (const s of before) {
    if (s.frame === page.mainFrame() || s.max <= 0) continue;
    const el = await s.frame.frameElement().catch(() => null);
    if (!el) continue;
    for (const y of positions(s.max, s.viewportHeight)) {
      const actualY = await scrollFrameTo(s.frame, y);
      await settle();
      const file = fileFor(images.length);
      const ok = await el.screenshot({ path: file, timeout: 10_000 }).then(() => true, () => false);
      if (!ok) break;
      const imageText = await visibleTextIn(s.frame, 0, s.viewportHeight);
      images.push({ index: images.length, file, frame: frameLabel(page, s.frame), scrollY: actualY, text: imageText });
      imageTexts.push(imageText);
    }
  }

  // Restore where the agent was.
  for (const s of before) await scrollFrameTo(s.frame, s.y);

  const texts: string[] = [];
  for (const f of frames) {
    const t = await f.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    if (t.trim()) texts.push(t);
  }
  const text = texts.join("\n\n");
  d.evidence.set(evidenceId, { text, imageTexts });
  d.store.append("evidence.captured", { carrierId: plugin.id, evidenceId, reason, url: page.url(), text, capturedAt: new Date().toISOString(), images });

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const moneyLines = lines.filter((l) => MONEY_LINE.test(l));
  const head = text.slice(0, 1200);
  const excerpt =
    `${images.length} image(s) covering ${new Set(images.map((i) => i.frame)).size} frame(s).\n` +
    `${head}${text.length > 1200 ? `\n[... ${text.length - 1200} more chars stored in the record]` : ""}\n\n` +
    `Lines that look like prices (${moneyLines.length}):\n${moneyLines.slice(0, 60).join("\n") || "(none)"}`;
  return { evidenceId, text, images, excerpt };
}

// Index of the first image whose visible text contains `snippet` (also tolerating a price split across nodes,
// e.g. "$" and "1,234.50" in separate spans). undefined if no image shows it.
export function locateInImages(ev: StoredEvidence, snippet: string): number | undefined {
  const squash = (s: string) => normalizeText(s).replace(/\s+/g, "");
  for (let i = 0; i < ev.imageTexts.length; i++) {
    const t = ev.imageTexts[i];
    if (textContainsToken(t, snippet) || textContainsToken(squash(t), squash(snippet))) return i;
  }
  return undefined;
}
