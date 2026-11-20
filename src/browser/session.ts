// One fresh BrowserContext per carrier run (isolation: no cookies/state leak between carriers, fixes F17),
// with Playwright tracing on and a domain guard on main-frame navigations.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export function hostAllowed(url: string, allowedDomains: string[]): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol === "about:" || u.protocol === "data:" || u.protocol === "blob:") return true;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

export interface Session {
  page: Page;
  context: BrowserContext;
  // HTTP status of the last main-frame document response (e.g. 403/429 from a bot wall), if any.
  mainStatus(): { status: number; url: string } | undefined;
  close(): Promise<void>;
}

export async function openSession(opts: {
  allowedDomains: string[];
  traceFile: string;
  onBlocked: (url: string) => void;
}): Promise<Session> {
  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "es-MX", viewport: { width: 1366, height: 900 } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();

  // Guard applies ONLY to main-frame navigations. Subresources (scripts, CDNs) and iframes pass through.
  await page.route("**/*", (route, request) => {
    let isMainNav = false;
    try {
      isMainNav = request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch {
      // Service-worker requests have no frame; they are not main-frame navigations.
    }
    if (isMainNav && !hostAllowed(request.url(), opts.allowedDomains)) {
      opts.onBlocked(request.url());
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });

  let lastMain: { status: number; url: string } | undefined;
  page.on("response", (res) => {
    try {
      const req = res.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) lastMain = { status: res.status(), url: res.url() };
    } catch {
      // Responses without a frame (service workers) are not main documents.
    }
  });

  let closed = false;
  return {
    page,
    context,
    mainStatus: () => lastMain,
    async close() {
      if (closed) return;
      closed = true;
      fs.mkdirSync(path.dirname(opts.traceFile), { recursive: true });
      await context.tracing.stop({ path: opts.traceFile }).catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
