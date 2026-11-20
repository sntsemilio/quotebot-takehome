// Honest tools: every tool returns what really happened. Failures are thrown as ToolError and reach
// the model with is_error: true and a useful message (what was searched, what is actually there).
import type Anthropic from "@anthropic-ai/sdk";
import type { Frame, Locator, Page } from "playwright";
import type { CarrierPlugin } from "../carriers/types.js";
import type { CloseStatus, OptionalChargeVerified } from "../record/events.js";
import type { RunStore } from "../record/store.js";
import { compactView, relevantFrames } from "../browser/snapshot.js";
import { readScroll, scrollFrameTo, scrollSignature } from "../browser/scroll.js";
import { amountsMatch, looksLikePrice, normalizeText, parseAmount, textContainsToken } from "../domain/money.js";
import { deliveryInEvidence } from "../domain/delivery.js";
import { captureEvidence, locateInImages, type StoredEvidence } from "./evidence.js";

export class ToolError extends Error {}

// Playwright errors put the useful reason in the call log, not the first line ("Timeout 5000ms exceeded").
// Keep the first line plus the last call-log line that explains WHY (overlay, disabled, hidden, detached...).
const WHY = /intercepts pointer events|not enabled|disabled|not visible|not stable|detached|outside of the viewport|not editable|did not match any elements|resolved to \d+ elements/i;
export function describeError(e: unknown): string {
  const lines = String(e instanceof Error ? e.message : e).split("\n").map((l) => l.trim()).filter(Boolean);
  const why = [...lines].reverse().find((l) => WHY.test(l));
  return why && why !== lines[0] ? `${lines[0]} (${why.replace(/^-\s*/, "").slice(0, 200)})` : (lines[0] ?? "unknown error");
}

// The frame where `text` is visible (same check for wait_for and the harness's initial wait), or null.
export async function frameShowingText(frames: Frame[], text: string): Promise<Frame | null> {
  for (const f of frames) if (await f.getByText(text).first().isVisible().catch(() => false)) return f;
  return null;
}

// What intercepted a click, from Playwright's call log: "<span class="fxg-mouse">Cuenta</span> from <header>…</header>
// subtree intercepts pointer events" -> "<span class="fxg-mouse">Cuenta</span> from <header>…</header> subtree".
export function interceptorOf(e: unknown): string | null {
  const line = String(e instanceof Error ? e.message : e).split("\n").map((l) => l.trim()).reverse().find((l) => /intercepts pointer events/i.test(l));
  return line ? line.replace(/^-\s*/, "").replace(/\s*intercepts pointer events.*$/i, "").slice(0, 160) : null;
}

export interface ToolContext {
  page: Page;
  plugin: CarrierPlugin;
  store: RunStore;
  evidenceDir: string;
  evidence: Map<string, StoredEvidence>; // full visible text (verification source) + per-image text, per evidence id
  verifiedPrices: number;
  closed?: { status: CloseStatus; reason: string };
}

// What a site note says about VAT: true (included), false (not included), null (mentions VAT, unclear),
// undefined (not about VAT). Only verified notes are classified.
export function vatPolarity(note: string): boolean | null | undefined {
  const n = stripAccents(note).toLowerCase();
  if (!/\b(i\.?\s?v\.?\s?a\.?|iva|vat|impuestos?|tax(es)?)\b/.test(n)) return undefined;
  if (/(no\s+incluy|no\s+incluid|sin\s+(i\.?\s?v|iva|impuesto)|mas\s+(i\.?\s?v|iva)|\+\s*(i\.?\s?v|iva)|antes\s+de\s+(i\.?\s?v|iva|impuesto)|exclu|excl\.|not\s+includ|before\s+tax|plus\s+(vat|tax))/.test(n)) return false;
  if (/(incluy|incluid|con\s+(i\.?\s?v|iva)|includ|incl\.?\b)/.test(n)) return true;
  return null;
}

export interface ToolOutcome {
  content: string;
  isView?: boolean; // result is a page view (eligible for elision when superseded)
  viewHash?: string;
}

// "Quote only" guard: never click anything that hires, pays or generates a shipping label.
const FORBIDDEN_CLICK = /\b(pagar|pago|comprar|compra|contratar|reservar|generar gu[ií]a|gu[ií]a prepagada|checkout|pay|buy|purchase|book)\b/i;
function stripAccents(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function isForbidden(name: string) {
  return FORBIDDEN_CLICK.test(name) || FORBIDDEN_CLICK.test(stripAccents(name));
}

const CLICK_ROLES = ["button", "link", "radio", "checkbox", "tab", "option", "menuitem", "combobox"] as const;
type ClickRole = (typeof CLICK_ROLES)[number];

export const toolDefs: Anthropic.Tool[] = [
  {
    name: "view_page",
    description: "Returns a compact view of the current page: URL, title and accessibility tree of the main frame and its iframes. Call it before acting and after actions that change the page.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "fill_field",
    description: "Fills a form field located by its visible label, placeholder or accessible name (searches inside iframes). For <select> fields, value is the option label. Returns what the field shows after filling.",
    input_schema: {
      type: "object",
      properties: { label: { type: "string" }, value: { type: "string" } },
      required: ["label", "value"],
    },
  },
  {
    name: "click",
    description: "Clicks an element by ARIA role and accessible name (searches inside iframes). For radio/checkbox, name may also be the text shown right after the control, its id, or name=value (as listed in field errors). Reports whether a radio/checkbox ended up checked. Refuses anything that pays, buys, hires or generates a label.",
    input_schema: {
      type: "object",
      properties: { role: { type: "string", enum: [...CLICK_ROLES] }, name: { type: "string" } },
      required: ["role", "name"],
    },
  },
  {
    name: "wait_for",
    description: "Waits until the given text is visible in any frame, up to maxSeconds (max 20). Fails honestly if it never appears.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, maxSeconds: { type: "number" } },
      required: ["text"],
    },
  },
  {
    name: "scroll",
    description: "Scrolls the page. Either direction (down/up by most of a screen, or top/bottom of every scrollable frame) or toText (brings the first visible element with that text into view, inside iframes too). Returns the scroll positions after.",
    input_schema: {
      type: "object",
      properties: { direction: { type: "string", enum: ["down", "up", "top", "bottom"] }, toText: { type: "string" } },
    },
  },
  {
    name: "choose_option",
    description: "For autocomplete fields: types `text` into the field (located like fill_field) and clicks the suggestion that contains `option` (default: text). For <select> fields, selects the option whose label contains it. If several suggestions match, returns them so you can call again with a more specific option.",
    input_schema: {
      type: "object",
      properties: { field: { type: "string" }, text: { type: "string" }, option: { type: "string" } },
      required: ["field", "text"],
    },
  },
  {
    name: "capture_evidence",
    description: "Captures evidence of the current page in one call: scrolls every frame and screenshots all of it, and stores the full visible text in the run record. Returns an evidenceId and an excerpt that always includes every line that looks like a price.",
    input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
  },
  {
    name: "report_price",
    description:
      "Reports one service price. priceText must be copied exactly as it appears in the evidence; code verifies it against the stored evidence text and that it matches amount. " +
      "siteNotes: notices the site shows about this price, copied verbatim (e.g. 'Cotización Aproximada', 'Los precios incluyen I.V.A.'). " +
      "optionalCharges: extra charges the site lists as optional, with their amount text exactly as shown. Every note and charge is verified against the evidence too. " +
      "includesVAT: true/false ONLY if one of your siteNotes says so (included or not included), or true when vatBreakdown copies the site's own price breakdown: vatLine is its VAT line with the amount (e.g. 'IVA $73.19') and totalLine its total line, whose amount must be this price (e.g. 'Total estimado $530.64'). Otherwise null. Never compute VAT.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string" },
        priceText: { type: "string" },
        amount: { type: "number" },
        currency: { type: "string" },
        includesVAT: { type: ["boolean", "null"] },
        deliveryDays: {
          type: ["string", "null"],
          // Verified against the evidence like priceText (its dates, times and words).
          description: "Copy the delivery as the page shows it, in the form 'LLEGA EL <date>, ENTREGADO POR <time>' when the page gives a date and a time; null if the page shows no delivery time; never derive it from the service's name.",
        },
        evidenceId: { type: "string" },
        siteNotes: { type: "array", items: { type: "string" } },
        optionalCharges: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, amountText: { type: "string" } }, required: ["name", "amountText"] },
        },
        vatBreakdown: {
          type: "object",
          properties: { vatLine: { type: "string" }, totalLine: { type: "string" } },
          required: ["vatLine", "totalLine"],
        },
      },
      required: ["service", "priceText", "amount", "currency", "includesVAT", "deliveryDays", "evidenceId"],
    },
  },
  {
    name: "close_carrier",
    description:
      "Ends work on this carrier honestly when no price can be obtained: blocked (captcha/bot wall/access denied: never try to solve a captcha), failed (site error), no_coverage (site says it does not serve the route), needs_human (site needs data the request does not have — say which — or rejected a postal code). Use status 'quoted' only after at least one verified report_price. " +
      "siteMessage: the site's own message (an error, 'SIN COBERTURA'), copied exactly from the evidence given in evidenceId, at most 200 characters; code verifies it. " +
      "rejectedZip: 'origin' or 'destination' when the site rejected or would not accept that postal code (an error, or the form will not continue with it); only with status needs_human and evidenceId. Add siteMessage only if the site shows its own message.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["quoted", "blocked", "failed", "no_coverage", "needs_human"] },
        reason: { type: "string" },
        evidenceId: { type: "string" },
        siteMessage: { type: "string" },
        rejectedZip: { type: "string", enum: ["origin", "destination"] },
      },
      required: ["status", "reason"],
    },
  },
];

// ---------- locating ----------

async function visibleIn(loc: Locator): Promise<Locator[]> {
  const out: Locator[] = [];
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    const l = loc.nth(i);
    if (await l.isVisible().catch(() => false)) out.push(l);
  }
  return out;
}

interface Strategy {
  name: string;
  make: (f: Frame) => Locator;
}
interface Located {
  match?: Locator;
  via?: string;
  tried: { name: string; count: number }[];
}

// Tries strategies from most to least specific over every relevant frame and keeps the FIRST one that yields
// exactly one visible match. Ambiguity (several matches) is only an error if no strategy yields exactly one.
async function locate(frames: Frame[], strategies: Strategy[]): Promise<Located> {
  const tried: Located["tried"] = [];
  for (const s of strategies) {
    const found: Locator[] = [];
    for (const f of frames) found.push(...(await visibleIn(s.make(f)).catch(() => [])));
    tried.push({ name: s.name, count: found.length });
    if (found.length === 1) return { match: found[0], via: s.name, tried };
  }
  return { tried };
}

function describeMiss(what: string, r: Located): string {
  const ambiguous = r.tried.filter((t) => t.count > 1);
  const summary = r.tried.map((t) => `${t.name}=${t.count}`).join(", ");
  return ambiguous.length
    ? `${what} is ambiguous: no strategy found exactly one match (${summary}).`
    : `${what} not found (${summary}).`;
}

// XPath string literal (handles quotes).
function xq(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat('${s.replace(/'/g, `', "'", '`)}')`;
}
function cleanLabel(label: string): string {
  return label.replace(/:/g, "").trim().replace(/\s+/g, " ");
}
// XPath predicate body: "this node's text, ignoring colons and extra spaces, equals label".
function textEq(label: string): string {
  return `normalize-space(translate(., ':', ''))=${xq(cleanLabel(label))}`;
}
// Matches the TEXT NODE equal to `label` (not its container: a container holding several bare text nodes
// would otherwise anchor "following" after the whole container).
function textNodeXPath(label: string): string {
  return `//text()[${textEq(label)}]`;
}
function cssStr(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}
const FIELD_XPATH = "*[self::input[not(@type='hidden') and not(@type='radio') and not(@type='checkbox') and not(@type='submit') and not(@type='button')] or self::select or self::textarea]";

// Many sites (Estafeta included) put a plain text "label" next to an unlabeled input: no getByLabel match.
// These fallbacks locate the first field that follows the visible text, or a field by its name/id attribute.
function nearTextField(f: Frame, label: string): Locator {
  return f.locator(`xpath=${textNodeXPath(label)}/following::${FIELD_XPATH}[1]`);
}
function byNameOrId(f: Frame, label: string): Locator {
  const v = cssStr(label);
  return f.locator(`input[name="${v}"]:not([type=hidden]), input[id="${v}"]:not([type=hidden]), select[name="${v}"], select[id="${v}"], textarea[name="${v}"], textarea[id="${v}"]`);
}

// Strategies for a text-like field, most specific first: exact accessible matches, then partial,
// then attribute, then nearby text.
function fieldStrategies(label: string): Strategy[] {
  const strategies: Strategy[] = [];
  for (const exact of [true, false]) {
    const sfx = exact ? "-exact" : "";
    strategies.push(
      { name: `label${sfx}`, make: (f) => f.getByLabel(label, { exact }) },
      { name: `placeholder${sfx}`, make: (f) => f.getByPlaceholder(label, { exact }) },
      { name: `textbox${sfx}`, make: (f) => f.getByRole("textbox", { name: label, exact }) },
      { name: `spinbutton${sfx}`, make: (f) => f.getByRole("spinbutton", { name: label, exact }) },
      { name: `combobox${sfx}`, make: (f) => f.getByRole("combobox", { name: label, exact }) },
    );
  }
  strategies.push(
    { name: "name-or-id", make: (f) => byNameOrId(f, label) },
    { name: "text-before", make: (f) => nearTextField(f, label) },
  );
  return strategies;
}

// Strategies for a radio/checkbox, most specific first. Its text is the one right AFTER the control
// (or its <label>): immediate next sibling first, then the next text in document order.
function toggleStrategies(type: "radio" | "checkbox", nm: string): Strategy[] {
  const input = `input[type=${type}]`;
  const s: Strategy[] = [{ name: "id", make: (f) => f.locator(`${input}[id="${cssStr(nm)}"]`) }];
  const nv = nm.match(/^([^=]+)=(.*)$/);
  if (nv) s.push({ name: "name=value", make: (f) => f.locator(`${input}[name="${cssStr(nv[1].trim())}"][value="${cssStr(nv[2].trim())}"]`) });
  s.push(
    { name: "role-exact", make: (f) => f.getByRole(type, { name: nm, exact: true }) },
    { name: "label-exact", make: (f) => f.getByLabel(nm, { exact: true }).and(f.locator(input)) },
    { name: "next-sibling-text", make: (f) => f.locator(`xpath=//input[@type='${type}'][following-sibling::node()[normalize-space()][1][${textEq(nm)}]]`) },
    { name: "next-text", make: (f) => f.locator(`xpath=//input[@type='${type}'][following::text()[normalize-space()][1][${textEq(nm)}]]`) },
    { name: "role", make: (f) => f.getByRole(type, { name: nm }) },
    { name: "text", make: (f) => f.getByText(nm, { exact: true }) },
  );
  return s;
}

async function listFields(frames: Frame[]): Promise<string> {
  const names: string[] = [];
  for (const f of frames) {
    const got = await f
      .locator("input:not([type=hidden]), select, textarea")
      .evaluateAll((els) =>
        els
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => {
            const e = el as HTMLInputElement;
            const attrs = `${e.name ? ` name=${e.name}` : ""}${e.id ? ` id=${e.id}` : ""}`;
            const lbl = e.labels?.[0]?.innerText?.trim();
            if (e.type === "radio" || e.type === "checkbox") {
              let after = lbl || "";
              if (!after) {
                let n = e.nextSibling;
                while (n && !(n.textContent ?? "").trim()) n = n.nextSibling;
                after = (n?.textContent ?? "").trim();
              }
              if (!after) {
                after = document.evaluate("following::text()[normalize-space()][1]", e, null, XPathResult.STRING_TYPE, null).stringValue.trim();
              }
              return `[${e.type}] "${after.replace(/\s+/g, " ").slice(0, 40)}"${attrs} value=${e.value}${e.checked ? " (checked)" : ""}`;
            }
            const near = document
              .evaluate("preceding::text()[normalize-space()][1]", e, null, XPathResult.STRING_TYPE, null)
              .stringValue.trim();
            const shown = lbl || e.getAttribute("aria-label") || e.placeholder || (near ? `text before it: ${near}` : e.type);
            return `"${shown}"${attrs}`;
          }),
      )
      .catch(() => [] as string[]);
    names.push(...got);
  }
  return names.length
    ? `${names.join("; ")}. (Radios/checkboxes can also be clicked by their id or as name=value.)`
    : "(none)";
}

async function listClickables(frames: Frame[]): Promise<string> {
  const names: string[] = [];
  for (const f of frames) {
    const got = await f
      .locator("button, a, [role=button], [role=radio], [role=tab], input[type=radio], input[type=submit], input[type=button], label")
      .evaluateAll((els) =>
        els
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => (el.getAttribute("aria-label") || (el as HTMLElement).innerText || (el as HTMLInputElement).value || "").trim().replace(/\s+/g, " "))
          .filter((t) => t && t.length < 60),
      )
      .catch(() => [] as string[]);
    names.push(...got);
  }
  const uniq = [...new Set(names)].slice(0, 40);
  return uniq.length ? uniq.map((n) => `"${n}"`).join(", ") : "(none)";
}

// ---------- autocomplete suggestions ----------

// Accent- and case-insensitive text for matching suggestions ("Mérida" ~ "merida").
function foldText(s: string): string {
  return normalizeText(stripAccents(s));
}

// Among several matches, prefer an exact one, then those starting with the wanted text.
function narrow(texts: string[], want: string): string[] {
  const uniq = [...new Set(texts)];
  const exact = uniq.filter((t) => foldText(t) === want);
  if (exact.length) return exact;
  const starts = uniq.filter((t) => foldText(t).startsWith(want));
  return starts.length ? starts : uniq;
}

interface Candidate {
  loc: Locator;
  text: string;
  isOption: boolean;
  seenBefore: boolean; // the same DOM node was already visible before typing (e.g. a nav menu item)
}

// Visible suggestion-like elements: ARIA options and menu items, plus list items (many widgets render
// suggestions as plain <li>). To tell suggestions from the page's own lists, `mark` tags every visible
// candidate node before typing (a data attribute, no other change); afterwards, untagged nodes are new.
// Widgets that re-render their list create new nodes, so a list left over from a previous call does not hide them.
// Generic widget patterns only (ARIA, list items, common autocomplete libraries), never site-specific selectors.
const SUGGESTION_SELECTOR = "[role=option], [role=menuitem], li, .pac-item, .dropdown-item, [class*='autocomplete'] > div, [class*='suggest'] > div";
const SEEN_ATTR = "data-qb-seen";
async function suggestionCandidates(frames: Frame[], mark = false): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const f of frames) {
    const loc = f.locator(SUGGESTION_SELECTOR);
    const info = await loc
      .evaluateAll(
        (els, { mark, attr }) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            const st = getComputedStyle(e);
            const visible = r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
            const seenBefore = e.hasAttribute(attr);
            if (mark && visible) e.setAttribute(attr, "1");
            return { text: ((e as HTMLElement).innerText ?? "").trim().replace(/\s+/g, " "), visible, seenBefore, isOption: e.getAttribute("role") === "option" };
          }),
        { mark, attr: SEEN_ATTR },
      )
      .catch(() => [] as { text: string; visible: boolean; seenBefore: boolean; isOption: boolean }[]);
    info.forEach((x, i) => {
      if (x.visible && x.text && x.text.length <= 150) out.push({ loc: loc.nth(i), text: x.text, isOption: x.isOption, seenBefore: x.seenBefore });
    });
  }
  return out;
}

// ---------- execution ----------

export async function executeTool(ctx: ToolContext, name: string, rawArgs: unknown): Promise<ToolOutcome> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const { page, plugin } = ctx;
  const frames = () => relevantFrames(page, plugin.allowedDomains);

  switch (name) {
    case "view_page": {
      const v = await compactView(page, plugin.allowedDomains);
      return { content: v.text, isView: true, viewHash: v.hash };
    }

    case "fill_field": {
      const label = String(args.label ?? "");
      const value = String(args.value ?? "");
      if (!label) throw new ToolError("fill_field needs a non-empty label.");
      const fs_ = frames();
      const r = await locate(fs_, fieldStrategies(label));
      if (!r.match) throw new ToolError(`${describeMiss(`Field '${label}'`, r)} Visible fields: ${await listFields(fs_)}`);
      const el = r.match;
      const tag = await el.evaluate((e) => e.tagName.toLowerCase());
      if (tag === "select") {
        await el.selectOption({ label: value }, { timeout: 5000 }).catch(() => el.selectOption(value, { timeout: 5000 }));
      } else {
        await el.fill(value, { timeout: 5000 });
      }
      const shown = await el.inputValue().catch(() => "(unreadable)");
      return { content: `Filled '${label}'. Field now shows: "${shown}"${shown !== value ? " (differs from what was typed — check the view)" : ""}` };
    }

    case "click": {
      const role = String(args.role ?? "") as ClickRole;
      const nm = String(args.name ?? "");
      if (!CLICK_ROLES.includes(role)) throw new ToolError(`Unsupported role '${role}'. Use one of: ${CLICK_ROLES.join(", ")}.`);
      if (isForbidden(nm)) throw new ToolError(`Refused: '${nm}' looks like paying, buying, hiring or generating a label. This agent only quotes.`);
      const fs_ = frames();
      const isToggle = role === "radio" || role === "checkbox";
      const strategies: Strategy[] = isToggle
        ? toggleStrategies(role, nm)
        : [
            { name: "role-exact", make: (f) => f.getByRole(role, { name: nm, exact: true }) },
            { name: "role", make: (f) => f.getByRole(role, { name: nm }) },
          ];
      const r = await locate(fs_, strategies);
      if (!r.match) {
        const visible = isToggle ? `Visible fields: ${await listFields(fs_)}` : `Visible clickable texts: ${await listClickables(fs_)}`;
        throw new ToolError(`${describeMiss(`${role} '${nm}'`, r)} ${visible}`);
      }
      const el = r.match;
      const actual = ((await el.getAttribute("aria-label").catch(() => null)) || (await el.innerText().catch(() => "")) || "").trim();
      if (isForbidden(actual)) throw new ToolError(`Refused: the matched element reads '${actual}', which looks like paying/buying/hiring. This agent only quotes.`);
      let how = "";
      try {
        await el.click({ timeout: 5000 });
      } catch (e) {
        // Custom-styled radios/checkboxes hide the native input under their <label>, which then intercepts the
        // click. A person clicks the label: do the same, once, and report it. Never for buttons/links.
        if (!isToggle || r.via === "text") throw new ToolError(`Click on ${role} '${nm}' failed: ${describeError(e)}`);
        const viaLabel = await el.evaluate((n) => {
          const l = (n as HTMLInputElement).labels?.[0];
          if (!l) return false;
          l.click();
          return true;
        }).catch(() => false);
        if (!viaLabel) throw new ToolError(`Click on ${role} '${nm}' failed and it has no <label> to click instead: ${describeError(e)}`);
        how = ` via its <label> (direct click failed: ${describeError(e)})`;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      const checked = isToggle && r.via !== "text" ? ` Now checked: ${await el.isChecked().catch(() => "unknown")}.` : "";
      return { content: `Clicked ${role} '${nm}' (matched by ${r.via})${how}${actual && actual !== nm ? ` (element text: "${actual.slice(0, 80)}")` : ""}.${checked} URL now: ${page.url()}` };
    }

    case "wait_for": {
      const text = String(args.text ?? "");
      if (!text) throw new ToolError("wait_for needs a non-empty text.");
      const secs = Math.min(Math.max(Number(args.maxSeconds ?? 10) || 10, 1), 20);
      const deadline = Date.now() + secs * 1000;
      while (Date.now() < deadline) {
        const f = await frameShowingText(frames(), text);
        if (f) return { content: `'${text}' is visible (in ${f === page.mainFrame() ? "main frame" : `iframe ${f.url()}`}).` };
        await page.waitForTimeout(500);
      }
      throw new ToolError(`'${text}' did not appear within ${secs}s. Call view_page to see what the page shows instead.`);
    }

    case "scroll": {
      const direction = args.direction == null ? undefined : String(args.direction);
      const toText = args.toText == null ? "" : String(args.toText);
      if (!direction && !toText) throw new ToolError("scroll needs either direction (down/up/top/bottom) or toText.");
      const fs_ = frames();
      const before = scrollSignature(await readScroll(page, fs_));
      if (toText) {
        let found: Locator | undefined;
        for (const f of fs_) {
          const l = f.getByText(toText).first();
          if ((await l.count().catch(() => 0)) > 0) {
            found = l;
            break;
          }
        }
        if (!found) throw new ToolError(`No element with text '${toText}' in the page (main frame or allowed iframes).`);
        await found.scrollIntoViewIfNeeded({ timeout: 5000 });
      } else if (direction === "top" || direction === "bottom") {
        for (const s of await readScroll(page, fs_)) if (s.max > 0) await scrollFrameTo(s.frame, direction === "top" ? 0 : s.max);
      } else if (direction === "down" || direction === "up") {
        const vp = page.viewportSize() ?? { width: 1366, height: 900 };
        // The wheel scrolls whatever is under the pointer (an iframe or the page), like a person would.
        await page.mouse.move(vp.width / 2, vp.height / 2);
        await page.mouse.wheel(0, (direction === "down" ? 1 : -1) * Math.round(vp.height * 0.8));
      } else {
        throw new ToolError(`Unknown direction '${direction}'. Use down, up, top or bottom.`);
      }
      await page.waitForTimeout(250);
      const after = scrollSignature(await readScroll(page, fs_));
      return { content: `${after === before ? "Nothing moved (already there). " : ""}Scroll now: ${after}` };
    }

    case "choose_option": {
      const field = String(args.field ?? "");
      const text = String(args.text ?? "");
      const pick = String(args.option ?? args.text ?? "");
      if (!field || !text) throw new ToolError("choose_option needs field and text.");
      const fs_ = frames();
      const r = await locate(fs_, fieldStrategies(field));
      if (!r.match) throw new ToolError(`${describeMiss(`Field '${field}'`, r)} Visible fields: ${await listFields(fs_)}`);
      const el = r.match;
      const want = foldText(pick);

      if ((await el.evaluate((e) => e.tagName.toLowerCase())) === "select") {
        const labels = await el.evaluate((e) => Array.from((e as HTMLSelectElement).options).map((o) => o.label.trim()));
        const hits = narrow(labels.filter((l) => foldText(l).includes(want)), want);
        if (hits.length !== 1) throw new ToolError(`${hits.length ? `${hits.length} options` : "No option"} of '${field}' match '${pick}'. Options: ${labels.slice(0, 30).map((l) => `"${l}"`).join(", ")}`);
        await el.selectOption({ label: hits[0] }, { timeout: 5000 });
        return { content: `Selected '${hits[0]}' in '${field}'.` };
      }

      // Fixed headers cover fields on scrolled pages (FedEx). Center the field first; if the click is
      // still intercepted, focus it without a click (typing needs focus, not a pointer) and say so.
      await el.evaluate((e) => e.scrollIntoView({ block: "center", inline: "nearest" })).catch(() => {});
      let how = "";
      try {
        await el.click({ timeout: 5000 });
      } catch (e) {
        const by = interceptorOf(e);
        if (!by) throw e;
        await el.focus({ timeout: 5000 }).catch(() => { throw e; });
        how = ` (focused directly: ${by} intercepted the click)`;
      }
      await el.fill("", { timeout: 5000 });
      // Tag what is visible now; items matching the wanted text already (e.g. a nav link) are never picked.
      const preexisting = new Set((await suggestionCandidates(fs_, true)).filter((c) => foldText(c.text).includes(want)).map((c) => c.text));
      await el.pressSequentially(text, { delay: 60, timeout: 10_000 });
      // Suggestions = role=option items, or nodes that appeared after typing. Fallback: same nodes shown/filtered
      // in place (widgets that toggle visibility), minus anything that matched before typing.
      // Remote suggestion lists update several times while results arrive: wait until the matching set is
      // the same on two consecutive polls before choosing.
      const deadline = Date.now() + 8000;
      let fresh: Candidate[] = [];
      let matching: Candidate[] = [];
      let lastKey = "";
      while (Date.now() < deadline) {
        const all = await suggestionCandidates(fs_);
        fresh = all.filter((c) => c.isOption || !c.seenBefore);
        matching = fresh.filter((c) => foldText(c.text).includes(want));
        if (!matching.length) matching = all.filter((c) => !preexisting.has(c.text) && foldText(c.text).includes(want));
        const key = matching.map((c) => c.text).join("|");
        if (matching.length && key === lastKey) break;
        lastKey = key;
        await page.waitForTimeout(350);
      }
      const list = (cs: Candidate[]) => [...new Set(cs.map((c) => c.text))].slice(0, 15).map((t) => `"${t}"`).join(", ");
      if (!matching.length) {
        throw new ToolError(fresh.length
          ? `No suggestion contains '${pick}'. Suggestions shown: ${list(fresh)}. Call again with option set to one of them.`
          : `Typed '${text}' in '${field}' but no suggestion list appeared within 8s. Call view_page to see what the field shows.`);
      }
      const narrowed = narrow(matching.map((c) => c.text), want);
      if (narrowed.length > 1) throw new ToolError(`${narrowed.length} suggestions match '${pick}': ${list(matching.filter((c) => narrowed.includes(c.text)))}. Call again with a more specific option.`);
      // Click by text at click time (not by index): the list may have re-rendered since it was read.
      const chosenText = narrowed[0];
      let clicked = false;
      let lastErr: unknown;
      for (const f of fs_) {
        const target = f.locator(SUGGESTION_SELECTOR).filter({ hasText: chosenText }).filter({ visible: true }).last();
        if ((await target.count().catch(() => 0)) === 0) continue;
        await target.evaluate((e) => e.scrollIntoView({ block: "center", inline: "nearest" })).catch(() => {});
        try {
          await target.click({ timeout: 5000 });
          clicked = true;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!clicked) throw new ToolError(`Suggestion "${chosenText}" was shown but could not be clicked${lastErr ? `: ${describeError(lastErr)}` : " (it disappeared)"}.`);
      await page.waitForTimeout(400);
      const value = await el.inputValue().catch(() => "(unreadable)");
      return { content: `Chose suggestion "${chosenText}" for '${field}'${how}. Field now shows: "${value}"` };
    }

    case "capture_evidence": {
      const reason = String(args.reason ?? "");
      const ev = await captureEvidence(ctx, reason);
      return { content: `evidenceId: ${ev.evidenceId}\n${ev.excerpt}` };
    }

    case "report_price": {
      const service = String(args.service ?? "");
      const priceText = String(args.priceText ?? "");
      const amount = Number(args.amount);
      const currency = String(args.currency ?? "");
      const includesVAT = typeof args.includesVAT === "boolean" ? args.includesVAT : null;
      const deliveryDays = args.deliveryDays == null ? null : String(args.deliveryDays);
      const evidenceId = String(args.evidenceId ?? "");
      const siteNotes = Array.isArray(args.siteNotes) ? args.siteNotes.map(String) : [];
      const optionalCharges = Array.isArray(args.optionalCharges)
        ? args.optionalCharges.map((c) => ({ name: String((c as Record<string, unknown>)?.name ?? ""), amountText: String((c as Record<string, unknown>)?.amountText ?? "") }))
        : [];
      const vb = args.vatBreakdown && typeof args.vatBreakdown === "object" ? (args.vatBreakdown as Record<string, unknown>) : null;
      const vatBreakdown = vb ? { vatLine: String(vb.vatLine ?? ""), totalLine: String(vb.totalLine ?? "") } : undefined;
      ctx.store.append("price.reported", {
        carrierId: plugin.id, service, priceText, amount, currency, includesVAT, deliveryDays, evidenceId,
        ...(siteNotes.length ? { siteNotes } : {}), ...(optionalCharges.length ? { optionalCharges } : {}),
        ...(vatBreakdown ? { vatBreakdown } : {}),
      });

      const reject = (reason: string): never => {
        ctx.store.append("price.rejected", { carrierId: plugin.id, service, priceText, evidenceId, reason });
        throw new ToolError(`Price rejected: ${reason}`);
      };
      const ev = ctx.evidence.get(evidenceId);
      if (!ev) return reject(`unknown evidenceId '${evidenceId}'. Known: ${[...ctx.evidence.keys()].join(", ") || "(none — call capture_evidence first)"}.`);
      if (!looksLikePrice(priceText)) reject(`'${priceText}' does not look like a price (needs a digit plus "$", "MXN" or 2 decimals). Copy the full price exactly as shown, with its symbol.`);
      if (!textContainsToken(ev.text, priceText)) reject(`'${priceText}' does not appear as a whole price in the text of evidence ${evidenceId} (a match glued to other digits does not count). Copy it exactly as the page shows it.`);
      const parsed = parseAmount(priceText);
      if (parsed === null || !Number.isFinite(amount) || !amountsMatch(parsed, amount)) reject(`amount ${amount} does not match '${priceText}' (read as ${parsed}).`);

      // Every note and optional charge is verified against the same evidence text.
      for (const note of siteNotes) {
        if (!/\p{L}/u.test(note) || note.trim().length < 3) reject(`site note '${note}' is not a text notice; copy the notice exactly as shown.`);
        if (!textContainsToken(ev.text, note)) reject(`site note '${note}' does not appear in evidence ${evidenceId}. Copy it exactly or leave it out.`);
      }
      const charges: OptionalChargeVerified[] = [];
      for (const ch of optionalCharges) {
        if (ch.name.trim().length < 3 || !textContainsToken(ev.text, ch.name)) reject(`optional charge name '${ch.name}' does not appear in evidence ${evidenceId}.`);
        if (!looksLikePrice(ch.amountText) || !textContainsToken(ev.text, ch.amountText)) reject(`optional charge amount '${ch.amountText}' for '${ch.name}' does not appear as a price in evidence ${evidenceId}.`);
        const a = parseAmount(ch.amountText);
        if (a === null) reject(`cannot read an amount from '${ch.amountText}'.`);
        charges.push({ name: ch.name, amountText: ch.amountText, amount: a! });
      }
      // A breakdown copied from the site. Verified like the notes; code only checks that its total is this price.
      if (vatBreakdown) {
        const { vatLine, totalLine } = vatBreakdown;
        for (const line of [vatLine, totalLine]) {
          if (!textContainsToken(ev.text, line)) reject(`vatBreakdown line '${line}' does not appear in evidence ${evidenceId}. Copy it exactly as the breakdown shows it (label and amount), or leave vatBreakdown out.`);
        }
        const vatAmount = parseAmount(vatLine);
        if (vatPolarity(vatLine) === undefined || !looksLikePrice(vatLine) || vatAmount === null || !(vatAmount > 0)) reject(`vatBreakdown.vatLine '${vatLine}' must be the breakdown's VAT line with its amount (e.g. 'IVA $73.19').`);
        const totalAmount = parseAmount(totalLine);
        if (!looksLikePrice(totalLine) || totalAmount === null || !amountsMatch(totalAmount, amount)) reject(`vatBreakdown.totalLine '${totalLine}' (read as ${totalAmount}) is not this price (${amount}). Use the breakdown of this service, or leave vatBreakdown out.`);
      }
      // includesVAT may be true/false only when backed: a verified note that says exactly that (a note that only
      // mentions VAT, polarity null, backs nothing), or for true a verified vatBreakdown. No note may say the opposite.
      if (includesVAT !== null) {
        const vatNotes = siteNotes.map((n) => ({ n, p: vatPolarity(n) })).filter((x) => x.p !== undefined);
        const contra = vatNotes.find((x) => typeof x.p === "boolean" && x.p !== includesVAT);
        if (contra) reject(`includesVAT is ${includesVAT} but the site note '${contra.n}' says the opposite.`);
        const backed = vatNotes.some((x) => x.p === includesVAT) || (includesVAT === true && vatBreakdown !== undefined);
        if (!backed) {
          reject(`includesVAT is ${includesVAT} but nothing backs it: no site note says VAT is ${includesVAT ? "included" : "not included"}${includesVAT ? " and there is no vatBreakdown" : ""} (a note that only mentions VAT is not enough). Add the site's exact text, or use includesVAT: null.`);
        }
      }

      // The delivery is kept only if its dates, times and words are on the page; otherwise the price is
      // still verified, without a delivery, and the agent is told why.
      const deliveryOk = deliveryDays === null || deliveryInEvidence(deliveryDays, ev.text);
      const imageIndex = locateInImages(ev, priceText);
      ctx.store.append("price.verified", {
        carrierId: plugin.id, service, amount, currency, includesVAT, deliveryDays: deliveryOk ? deliveryDays : null, priceText, evidenceId,
        ...(deliveryOk ? {} : { deliveryDaysDropped: deliveryDays! }),
        ...(siteNotes.length ? { siteNotes } : {}), ...(charges.length ? { optionalCharges: charges } : {}),
        ...(vatBreakdown ? { vatBreakdown } : {}),
        ...(imageIndex !== undefined ? { imageIndex } : {}),
      });
      ctx.verifiedPrices++;
      const where = imageIndex !== undefined ? `, shown in image ${imageIndex}` : ", not located in a single image";
      const dropped = deliveryOk ? "" : ` deliveryDays '${deliveryDays}' was dropped: its dates, times or words are not in evidence ${evidenceId} (a bare number or a dash never counts). The price stands without a delivery; never derive one from the service's name.`;
      return { content: `Verified: ${service} = ${amount} ${currency} (evidence ${evidenceId}${where}${siteNotes.length ? `, ${siteNotes.length} note(s)` : ""}${charges.length ? `, ${charges.length} optional charge(s)` : ""}).${dropped} Report any other service shown, then close_carrier with status 'quoted'.` };
    }

    case "close_carrier": {
      const status = String(args.status ?? "") as CloseStatus;
      const reason = String(args.reason ?? "");
      const evidenceId = args.evidenceId ? String(args.evidenceId) : undefined;
      if (!["quoted", "blocked", "failed", "no_coverage", "needs_human"].includes(status)) throw new ToolError(`Invalid status '${status}'.`);
      if (status === "quoted" && ctx.verifiedPrices === 0) throw new ToolError("Cannot close as 'quoted' with no verified price. Use report_price first, or close with another status.");
      if (evidenceId && !ctx.evidence.has(evidenceId)) throw new ToolError(`Unknown evidenceId '${evidenceId}'.`);
      // What the site said reaches the user only if it is in the evidence, like siteNotes.
      const siteMessage = args.siteMessage == null || String(args.siteMessage).trim() === "" ? undefined : String(args.siteMessage).trim();
      const rejectedZip = args.rejectedZip == null ? undefined : String(args.rejectedZip);
      if (siteMessage !== undefined) {
        if (siteMessage.length > 200) throw new ToolError(`siteMessage has ${siteMessage.length} characters; the limit is 200. Copy only the site's message.`);
        if (!evidenceId) throw new ToolError("siteMessage needs evidenceId: capture_evidence of the page that shows the message, then close with that evidenceId.");
        if (!textContainsToken(ctx.evidence.get(evidenceId)!.text, siteMessage)) throw new ToolError(`siteMessage '${siteMessage}' does not appear in evidence ${evidenceId}. Copy it exactly as the page shows it.`);
      }
      if (rejectedZip !== undefined) {
        if (rejectedZip !== "origin" && rejectedZip !== "destination") throw new ToolError(`Invalid rejectedZip '${rejectedZip}'. Use 'origin' or 'destination'.`);
        if (status !== "needs_human") throw new ToolError(`rejectedZip goes only with status 'needs_human' (got '${status}').`);
        // A site may just not take the code (no error shown), so siteMessage is optional; the evidence is not.
        if (!evidenceId) throw new ToolError("rejectedZip needs evidenceId: capture_evidence of the page with the postal code not accepted, then close with that evidenceId.");
      }
      ctx.store.append("carrier.closed", {
        carrierId: plugin.id, status, reason, evidenceId, closedBy: "model",
        ...(siteMessage !== undefined ? { siteMessage } : {}), ...(rejectedZip !== undefined ? { rejectedZip } : {}),
      });
      ctx.closed = { status, reason };
      return { content: `Closed ${plugin.name} as ${status}.` };
    }

    default:
      throw new ToolError(`Unknown tool '${name}'.`);
  }
}
