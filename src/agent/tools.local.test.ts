// Local browser tests for the carrier tools (evidence, scrolling, verified prices, autocompletes) against copies served from a fake domain.
// No network: every request to *.shop.test is answered by page routes. Needs Chromium (run in the Docker image):
//   npx tsx --test src/agent/tools.local.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { executeTool, vatPolarity, type ToolContext } from "./tools.js";
import { RunStore } from "../record/store.js";
import type { CarrierPlugin } from "../carriers/types.js";

const plugin: CarrierPlugin = { id: "t", name: "Test", startUrl: "https://www.shop.test/", allowedDomains: ["shop.test"], notes: "", budget: { maxSteps: 1, maxSeconds: 1 } };

let browser: Browser;
before(async () => (browser = await chromium.launch()));
after(async () => browser.close());

async function open(pages: Record<string, string>): Promise<{ page: Page; ctx: ToolContext; store: RunStore }> {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.route("**/*", (route) => {
    const body = pages[route.request().url()];
    return body ? route.fulfill({ contentType: "text/html; charset=utf-8", body }) : route.fulfill({ status: 404, body: "" });
  });
  const page = await context.newPage();
  await page.goto("https://www.shop.test/");
  await page.waitForLoadState("load");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-a-"));
  const store = new RunStore(dir, "r");
  const ctx: ToolContext = { page, plugin, store, evidenceDir: path.join(dir, "evidence"), evidence: new Map(), verifiedPrices: 0 };
  return { page, ctx, store };
}
const run = (ctx: ToolContext, name: string, args: unknown) => executeTool(ctx, name, args);
const fails = async (ctx: ToolContext, name: string, args: unknown, re: RegExp) => {
  await assert.rejects(() => executeTool(ctx, name, args), (e: Error) => (assert.match(e.message, re), true));
};

// A long results page (prices far below the fold) with a quote iframe that scrolls internally.
const RESULTS = `<!doctype html><body style="margin:0;font:16px sans-serif">
<h1>Resultados</h1><div style="height:1500px">Cotización Aproximada</div>
<p>Día Siguiente <b>$1,234.50</b></p><div style="height:900px"></div>
<p>Terrestre <span>$</span><span>450.00</span></p><p>Los precios incluyen I.V.A.</p><p>Manejo Especial $348.00</p>
<iframe src="https://form.shop.test/" style="width:600px;height:300px;border:0"></iframe>
<div style="height:400px"></div></body>`;
// The iframe (300px tall) scrolls internally; its price sits at y≈450, i.e. below the iframe's own viewport but
// within the main viewport when the iframe is near the top: the regression seen on Estafeta.
const IFRAME = `<!doctype html><body style="margin:0"><div style="height:450px">arriba</div><p>Seguro opcional $99.00</p><div style="height:600px"></div></body>`;

test("one capture call scrolls every frame, records ONE event with all images, and locates each price's image", async () => {
  const { page, ctx, store } = await open({ "https://www.shop.test/": RESULTS, "https://form.shop.test/": IFRAME });
  await page.evaluate(() => window.scrollTo(0, 300));
  const out = await run(ctx, "capture_evidence", { reason: "results" });
  const evs = store.events().filter((e) => e.type === "evidence.captured");
  assert.equal(evs.length, 1, "exactly one evidence event per call");
  const images = evs[0].type === "evidence.captured" ? evs[0].images ?? [] : [];
  const main = images.filter((i) => i.frame === "main");
  const inner = images.filter((i) => i.frame !== "main");
  assert.ok(main.length >= 3 && main.length <= 8, `main shots: ${main.length}`);
  assert.ok(inner.length >= 2, `iframe shots: ${inner.length}`);
  for (const i of images) assert.ok(fs.existsSync(i.file), `missing ${i.file}`);
  assert.equal(await page.evaluate(() => window.scrollY), 300, "scroll position restored");
  assert.match(out.content, /evidenceId: ev1/);

  // Price far down the page: the image it is assigned to must have been taken at a scroll that shows it.
  await run(ctx, "report_price", { service: "Día Siguiente", priceText: "$1,234.50", amount: 1234.5, currency: "MXN", includesVAT: null, deliveryDays: null, evidenceId: "ev1" });
  // Price split across two spans ("$" + "450.00") is still located.
  await run(ctx, "report_price", { service: "Terrestre", priceText: "$450.00", amount: 450, currency: "MXN", includesVAT: null, deliveryDays: null, evidenceId: "ev1" });
  // Price only inside the iframe's own scroll area.
  await run(ctx, "report_price", { service: "Seguro", priceText: "$99.00", amount: 99, currency: "MXN", includesVAT: null, deliveryDays: null, evidenceId: "ev1" });
  const verified = store.events().filter((e) => e.type === "price.verified");
  const idx = verified.map((e) => (e.type === "price.verified" ? e.imageIndex : undefined));
  assert.ok(idx.every((i) => i !== undefined), `all located: ${idx}`);
  const yOf = async (sel: string) => page.evaluate((s) => document.querySelector(s)!.getBoundingClientRect().top + window.scrollY, sel);
  const priceY = await yOf("b");
  const img0 = images[idx[0]!];
  assert.equal(img0.frame, "main");
  assert.ok(priceY >= img0.scrollY && priceY < img0.scrollY + 900, `price at y=${priceY} not in image scrolled to ${img0.scrollY}`);
  assert.notEqual(images[idx[2]!].frame, "main", "iframe-only price is located in an iframe image");
  await page.context().close();
});

test("site notes and optional charges are verified; includesVAT needs a verified VAT note that agrees", async () => {
  const { ctx, store } = await open({ "https://www.shop.test/": RESULTS, "https://form.shop.test/": IFRAME });
  await run(ctx, "capture_evidence", { reason: "results" });
  const base = { service: "Día Siguiente", priceText: "$1,234.50", amount: 1234.5, currency: "MXN", deliveryDays: null, evidenceId: "ev1" };
  await fails(ctx, "report_price", { ...base, includesVAT: true }, /nothing backs it: no site note says VAT is included and there is no vatBreakdown/);
  await fails(ctx, "report_price", { ...base, includesVAT: false, siteNotes: ["Los precios incluyen I.V.A."] }, /says the opposite/);
  await fails(ctx, "report_price", { ...base, includesVAT: null, siteNotes: ["Precio garantizado"] }, /does not appear in evidence/);
  await fails(ctx, "report_price", { ...base, includesVAT: null, optionalCharges: [{ name: "Manejo Especial", amountText: "$349.00" }] }, /does not appear as a price/);
  await run(ctx, "report_price", {
    ...base, includesVAT: true, siteNotes: ["Cotización Aproximada", "Los precios incluyen I.V.A."],
    optionalCharges: [{ name: "Manejo Especial", amountText: "$348.00" }],
  });
  const v = store.events().find((e) => e.type === "price.verified");
  assert.ok(v && v.type === "price.verified");
  assert.equal(v.includesVAT, true);
  assert.deepEqual(v.siteNotes, ["Cotización Aproximada", "Los precios incluyen I.V.A."]);
  assert.deepEqual(v.optionalCharges, [{ name: "Manejo Especial", amountText: "$348.00", amount: 348 }]);
  assert.equal(store.events().filter((e) => e.type === "price.rejected").length, 4);
  await ctx.page.context().close();
});

// FedEx's guest results as seen by hand on 2026-11-19: each rate has a
// "Ver detalles adicionales sobre los precios, <price>" button; the details are not an accordion and stay open together.
const BREAKDOWN = (id: string, base: string, vat: string, fuel: string, total: string) => `
<div class="rate"><p>FedEx Nacional ${id}</p><p>${total} MXN</p>
<button aria-expanded="false" aria-label="Ver detalles adicionales sobre los precios, ${total}" onclick="this.nextElementSibling.hidden=false;this.setAttribute('aria-expanded','true')">Detalles</button>
<div hidden><p>Tarifa base</p><p>${base}</p><p>IVA</p><p>${vat}</p><p>RECARGO POR COMBUSTIBLE</p><p>${fuel}</p><p>Total estimado</p><p>${total}</p></div></div>`;
const FEDEX_RATES = `<!doctype html><body><h1>Enviar como invitado</h1><p>Los montos se muestran en MXN</p>
${BREAKDOWN("Económico", "$397.78", "$73.19", "$59.67", "$530.64")}
${BREAKDOWN("Día Siguiente", "$458.88", "$84.45", "$68.83", "$612.16")}
<p>Precios sujetos a IVA</p></body>`;

test("vatBreakdown copied from the site backs includesVAT true; wrong total, missing line or a line without VAT are rejected", async () => {
  const { ctx, store } = await open({ "https://www.shop.test/": FEDEX_RATES });
  // Both details open together (not an accordion), then one capture.
  await run(ctx, "click", { role: "button", name: "Ver detalles adicionales sobre los precios, $530.64" });
  await run(ctx, "click", { role: "button", name: "Ver detalles adicionales sobre los precios, $612.16" });
  await run(ctx, "capture_evidence", { reason: "guest rates with breakdowns" });
  const base = { service: "FedEx Nacional Económico", priceText: "$530.64", amount: 530.64, currency: "MXN", deliveryDays: null, evidenceId: "ev1", includesVAT: true };
  const lines = ["Tarifa base $397.78", "IVA $73.19", "RECARGO POR COMBUSTIBLE $59.67", "Total estimado $530.64"];

  await fails(ctx, "report_price", { ...base, vatBreakdown: { vatLine: "IVA $73.19", totalLine: "Total estimado $612.16" } }, /totalLine 'Total estimado \$612\.16' \(read as 612\.16\) is not this price \(530\.64\)/);
  await fails(ctx, "report_price", { ...base, vatBreakdown: { vatLine: "IVA $73.20", totalLine: "Total estimado $530.64" } }, /vatBreakdown line 'IVA \$73\.20' does not appear in evidence ev1/);
  await fails(ctx, "report_price", { ...base, vatBreakdown: { vatLine: "Tarifa base $397.78", totalLine: "Total estimado $530.64" } }, /vatLine 'Tarifa base \$397\.78' must be the breakdown's VAT line/);
  await fails(ctx, "report_price", { ...base, vatBreakdown: { vatLine: "IVA", totalLine: "Total estimado $530.64" } }, /must be the breakdown's VAT line with its amount/);
  assert.equal(store.events().filter((e) => e.type === "price.verified").length, 0);

  await run(ctx, "report_price", { ...base, siteNotes: [...lines, "Los montos se muestran en MXN"], vatBreakdown: { vatLine: "IVA $73.19", totalLine: "Total estimado $530.64" } });
  const v = store.events().find((e) => e.type === "price.verified");
  assert.ok(v && v.type === "price.verified");
  assert.equal(v.includesVAT, true);
  assert.deepEqual(v.vatBreakdown, { vatLine: "IVA $73.19", totalLine: "Total estimado $530.64" });
  assert.deepEqual(v.siteNotes, [...lines, "Los montos se muestran en MXN"]);
  // Without a breakdown the same rate stays null.
  await run(ctx, "report_price", { ...base, service: "FedEx Nacional Día Siguiente", priceText: "$612.16", amount: 612.16, includesVAT: null });
  const v2 = store.events().filter((e) => e.type === "price.verified")[1];
  assert.ok(v2 && v2.type === "price.verified" && v2.includesVAT === null && v2.vatBreakdown === undefined);
  await ctx.page.context().close();
});

test("a note that only mentions VAT (polarity null) no longer backs includesVAT true or false", async () => {
  const { ctx, store } = await open({ "https://www.shop.test/": FEDEX_RATES });
  await run(ctx, "capture_evidence", { reason: "rates" });
  const base = { service: "FedEx Nacional Económico", priceText: "$530.64", amount: 530.64, currency: "MXN", deliveryDays: null, evidenceId: "ev1", siteNotes: ["Precios sujetos a IVA"] };
  assert.equal(vatPolarity("Precios sujetos a IVA"), null);
  await fails(ctx, "report_price", { ...base, includesVAT: true }, /nothing backs it: no site note says VAT is included .*a note that only mentions VAT is not enough/);
  await fails(ctx, "report_price", { ...base, includesVAT: false }, /nothing backs it: no site note says VAT is not included \(a note that only mentions VAT is not enough\)/);
  await run(ctx, "report_price", { ...base, includesVAT: null });
  assert.equal(store.events().filter((e) => e.type === "price.verified").length, 1);
  await ctx.page.context().close();
});

// FedEx shows each delivery piece on its own line; Estafeta shows no delivery at all.
const DELIVERY = `<!doctype html><body><p>LLEGA EL</p><p>vie, nov 20</p><p>ENTREGADO POR</p><p>10:30</p>
<p>FedEx Nacional 10:30 a.m.</p><p>$530.64</p><p>Dia Sig.</p><p>1 paquete</p><p>$2,243.28</p></body>`;

test("report_price keeps deliveryDays only if its dates, times and words are on the page; else the price stands without it", async () => {
  const { ctx, store } = await open({ "https://www.shop.test/": DELIVERY });
  await run(ctx, "capture_evidence", { reason: "rates" });
  const fedex = { service: "FedEx Nacional 10:30 a.m.", priceText: "$530.64", amount: 530.64, currency: "MXN", includesVAT: null, evidenceId: "ev1" };
  const ok = await run(ctx, "report_price", { ...fedex, deliveryDays: "LLEGA EL vie, nov 20, ENTREGADO POR 10:30" });
  assert.doesNotMatch(ok.content, /dropped/);
  // A number derived from the service's name ("1" for "Dia Sig.") is on the page by chance ("1 paquete"): dropped.
  const r = await run(ctx, "report_price", { service: "Dia Sig.", priceText: "$2,243.28", amount: 2243.28, currency: "MXN", includesVAT: null, evidenceId: "ev1", deliveryDays: "1" });
  assert.match(r.content, /deliveryDays '1' was dropped: its dates, times or words are not in evidence ev1 \(a bare number or a dash never counts\)/);
  const [a, b] = store.events().filter((e) => e.type === "price.verified");
  assert.ok(a.type === "price.verified" && b.type === "price.verified");
  assert.deepEqual([a.deliveryDays, a.deliveryDaysDropped], ["LLEGA EL vie, nov 20, ENTREGADO POR 10:30", undefined]);
  assert.deepEqual([b.deliveryDays, b.deliveryDaysDropped], [null, "1"]);
  // A date that is not on the page is dropped too.
  await run(ctx, "report_price", { ...fedex, deliveryDays: "LLEGA EL sáb, nov 21" });
  const c = store.events().filter((e) => e.type === "price.verified")[2];
  assert.ok(c.type === "price.verified" && c.deliveryDays === null && c.deliveryDaysDropped === "LLEGA EL sáb, nov 21");
  await ctx.page.context().close();
});

test("vatPolarity reads what the site says", () => {
  assert.equal(vatPolarity("Los precios incluyen I.V.A."), true);
  assert.equal(vatPolarity("Precios con IVA"), true);
  assert.equal(vatPolarity("Precios más IVA"), false);
  assert.equal(vatPolarity("No incluye impuestos"), false);
  assert.equal(vatPolarity("Prices exclude VAT"), false);
  assert.equal(vatPolarity("Cotización Aproximada"), undefined);
  assert.equal(vatPolarity("IVA"), null);
});

test("scroll by direction and to a text, reporting real positions; nothing moved is said", async () => {
  const { page, ctx } = await open({ "https://www.shop.test/": RESULTS, "https://form.shop.test/": IFRAME });
  const down = await run(ctx, "scroll", { direction: "down" });
  assert.match(down.content, /main 7\d\d\//);
  const to = await run(ctx, "scroll", { toText: "Manejo Especial" });
  assert.ok((await page.evaluate(() => window.scrollY)) > 1500, to.content);
  await run(ctx, "scroll", { direction: "top" });
  const again = await run(ctx, "scroll", { direction: "top" });
  assert.match(again.content, /^Nothing moved/);
  const view = await run(ctx, "view_page", {});
  assert.match(view.content, /Scroll: main 0\//);
  await fails(ctx, "scroll", {}, /needs either direction/);
  await page.context().close();
});

// Autocomplete widget: plain <li> suggestions appear while typing (like many "CP o colonia" fields),
// and a second widget with ARIA options; plus a <select>.
const AUTOCOMPLETE = `<!doctype html><body>
<nav><ul><li>Inicio</li><li>Rastreo</li><li>64000 promociones</li></ul></nav>
<label for="from">Desde</label><input id="from" autocomplete="off"><ul id="sug"></ul>
<label for="to">Para</label><input id="to" role="combobox"><div id="lb" role="listbox"></div>
<label for="c">País</label><select id="c"><option>Selecciona</option><option>México</option><option>Estados Unidos</option></select>
<script>
const places = ["64000 Monterrey, Nuevo León", "64010 Monterrey, Nuevo León", "22000 Tijuana, Baja California"];
from.addEventListener("input", () => { sug.innerHTML = places.filter(p => p.startsWith(from.value)).map(p => "<li onclick=\\"from.value=this.textContent;sug.innerHTML=''\\">" + p + "</li>").join(""); });
to.addEventListener("input", () => { setTimeout(() => { lb.innerHTML = places.filter(p => p.includes(to.value)).map(p => "<div role=option onclick=\\"to.value=this.textContent;lb.innerHTML=''\\">" + p + "</div>").join(""); }, 400); });
</script></body>`;

test("choose_option types, waits for suggestions and picks the single match; ambiguity is reported", async () => {
  const { ctx } = await open({ "https://www.shop.test/": AUTOCOMPLETE });
  // "640" matches two suggestions (and a pre-existing nav item that must be ignored).
  await fails(ctx, "choose_option", { field: "Desde", text: "640" }, /2 suggestions match '640'.*64000 Monterrey.*64010 Monterrey/);
  const a = await run(ctx, "choose_option", { field: "Desde", text: "64000" });
  assert.match(a.content, /Field now shows: "64000 Monterrey, Nuevo León"/);
  const b = await run(ctx, "choose_option", { field: "Para", text: "22000", option: "tijuana" }); // accent/case-insensitive pick
  assert.match(b.content, /Field now shows: "22000 Tijuana, Baja California"/);
  await fails(ctx, "choose_option", { field: "Para", text: "99999" }, /no suggestion list appeared/);
  const c = await run(ctx, "choose_option", { field: "País", text: "mexico" });
  assert.match(c.content, /Selected 'México'/);
  await ctx.page.context().close();
});

// Regressions from the first real FedEx/Redpack runs: styled radios whose <label> covers the input,
// suggestion lists that re-render while results arrive (div items), and suggestions that do not match.
const STYLED = `<!doctype html><body>
<div style="position:relative"><input type="radio" id="pq" name="tipo" value="p" style="position:absolute;left:0;top:0;width:20px;height:20px;margin:0">
<label for="pq" style="position:relative;z-index:1;display:inline-block;padding:4px 40px;background:#fff">Paquete</label></div>
<button id="b" style="position:relative">Continuar</button><div style="position:absolute;left:0;top:0;width:100vw;height:100vh;z-index:5"></div>
<label for="city">Ciudad</label><input id="city" autocomplete="off"><div class="autocomplete-list" id="al"></div>
<label for="desde">Desde</label><input id="desde" autocomplete="off"><ul id="s2"></ul>
<script>
const opts = ["Centro, 64000 Monterrey, N.L., México", "Obispado, 64060 Monterrey, N.L., México"];
city.addEventListener("input", () => { const v = city.value; [0, 250, 500].forEach(ms => setTimeout(() => {
  al.innerHTML = opts.filter(o => o.includes(v)).map(o => "<div onclick=\\"city.value=this.textContent;al.innerHTML=''\\">" + o + "</div>").join(""); }, ms)); });
desde.addEventListener("input", () => { s2.innerHTML = "<li>Pau, Francia</li><li>Selangor, Malasia</li>"; });
</script></body>`;

test("click on a styled radio whose label intercepts the click: clicks the label, reports it, ends checked", async () => {
  const { page, ctx } = await open({ "https://www.shop.test/": STYLED });
  await page.evaluate(() => document.querySelector("div[style*='z-index:5']")!.remove()); // overlay only for the button test
  const r = await run(ctx, "click", { role: "radio", name: "Paquete" });
  assert.match(r.content, /via its <label> \(direct click failed: .*intercepts pointer events/);
  assert.match(r.content, /Now checked: true/);
  await ctx.page.context().close();
});

test("a button covered by an overlay fails with the reason, and is never force-clicked", async () => {
  const { page, ctx } = await open({ "https://www.shop.test/": STYLED });
  await fails(ctx, "click", { role: "button", name: "Continuar" }, /Click on button 'Continuar' failed: .*intercepts pointer events/);
  assert.equal(await page.evaluate(() => document.activeElement?.id ?? ""), "");
  await ctx.page.context().close();
});

test("choose_option waits for a re-rendering div list and clicks the suggestion by text", async () => {
  const { page, ctx } = await open({ "https://www.shop.test/": STYLED });
  await page.evaluate(() => document.querySelector("div[style*='z-index:5']")!.remove());
  const r = await run(ctx, "choose_option", { field: "Ciudad", text: "64000" });
  assert.match(r.content, /Field now shows: "Centro, 64000 Monterrey, N.L., México"/);
  await fails(ctx, "choose_option", { field: "Desde", text: "64000", option: "Monterrey" }, /No suggestion contains 'Monterrey'\. Suggestions shown: "Pau, Francia", "Selangor, Malasia"/);
  await ctx.page.context().close();
});

// FedEx's fixed header (<span class="fxg-mouse">Cuenta</span>) intercepts the click on the address field when the
// page is scrolled. Same shape locally: a fixed header, an autocomplete below it.
const SUGGEST_SCRIPT = `<script>
const places = ["64000 Monterrey, Nuevo León", "64010 Monterrey, Nuevo León"];
from.addEventListener("input", () => { sug.innerHTML = places.filter(p => p.startsWith(from.value)).map(p => "<li onclick=\\"from.value=this.textContent;sug.innerHTML=''\\">" + p + "</li>").join(""); });
</script>`;
const HEADER = `<header style="position:fixed;top:0;left:0;right:0;height:120px;background:#333;color:#fff;z-index:10"><span class="fxg-mouse" style="display:block;height:100%">Cuenta</span></header>`;
// The field sits below the header in the document; the page is scrolled so the header covers it.
const HEADER_AFTER_SCROLL = `<!doctype html><body style="margin:0;font:16px sans-serif">${HEADER}
<div style="height:400px"></div><label for="from">Desde</label><input id="from" autocomplete="off"><ul id="sug"></ul>
<div style="height:2000px"></div>${SUGGEST_SCRIPT}</body>`;
// The field is at the very top of the document: no scroll can take it out from under the header.
const HEADER_ALWAYS = `<!doctype html><body style="margin:0;font:16px sans-serif">${HEADER}
<div style="position:absolute;top:20px;left:20px;z-index:1"><label for="from">Desde</label><input id="from" autocomplete="off"></div>
<ul id="sug" style="margin-top:200px"></ul><div style="height:2000px"></div>${SUGGEST_SCRIPT}</body>`;

test("choose_option picks the suggestion when a fixed header covers the field after scrolling", async () => {
  const { page, ctx } = await open({ "https://www.shop.test/": HEADER_AFTER_SCROLL });
  await page.evaluate(() => window.scrollTo(0, 330)); // the field is now at y≈70, under the 120px header
  const r = await run(ctx, "choose_option", { field: "Desde", text: "64000" });
  assert.match(r.content, /Field now shows: "64000 Monterrey, Nuevo León"/);
  await ctx.page.context().close();
});

test("a header that always covers the field: focuses it directly, says what intercepted, picks the suggestion", async () => {
  const { ctx } = await open({ "https://www.shop.test/": HEADER_ALWAYS });
  const r = await run(ctx, "choose_option", { field: "Desde", text: "64000" });
  assert.match(r.content, /focused directly: <span class="fxg-mouse">Cuenta<\/span>.* intercepted the click/);
  assert.match(r.content, /Field now shows: "64000 Monterrey, Nuevo León"/);
  await ctx.page.context().close();
});

// FedEx's message for an unknown postal code (case 9).
const ZIP_ERROR = `<!doctype html><body><h1>Calcular tarifas</h1>
<p>Error: No podemos encontrar este código postal. Revisa si es correcto e inténtalo de nuevo.</p></body>`;
const SITE_MSG = "Error: No podemos encontrar este código postal. Revisa si es correcto e inténtalo de nuevo.";

test("close_carrier verifies siteMessage against the evidence and rejectedZip against the status", async () => {
  const { ctx, store } = await open({ "https://www.shop.test/": ZIP_ERROR });
  await run(ctx, "capture_evidence", { reason: "zip error" });
  const base = { status: "needs_human", reason: "origin postal code not found", evidenceId: "ev1" };
  await fails(ctx, "close_carrier", { ...base, siteMessage: "El código postal no existe." }, /does not appear in evidence ev1/);
  await fails(ctx, "close_carrier", { status: "needs_human", reason: "r", siteMessage: SITE_MSG }, /siteMessage needs evidenceId/);
  await fails(ctx, "close_carrier", { ...base, siteMessage: "x".repeat(201) }, /201 characters; the limit is 200/);
  await fails(ctx, "close_carrier", { ...base, status: "no_coverage", siteMessage: SITE_MSG, rejectedZip: "origin" }, /rejectedZip goes only with status 'needs_human' \(got 'no_coverage'\)/);
  await fails(ctx, "close_carrier", { status: "needs_human", reason: "r", rejectedZip: "origin" }, /rejectedZip needs evidenceId/);
  await fails(ctx, "close_carrier", { ...base, siteMessage: SITE_MSG, rejectedZip: "sender" }, /Invalid rejectedZip 'sender'/);
  assert.equal(store.events().filter((e) => e.type === "carrier.closed").length, 0, "nothing closed by a rejected call");
  await run(ctx, "close_carrier", { ...base, siteMessage: SITE_MSG, rejectedZip: "origin" });
  const closed = store.events().find((e) => e.type === "carrier.closed");
  assert.ok(closed && closed.type === "carrier.closed");
  assert.equal(closed.siteMessage, SITE_MSG);
  assert.equal(closed.rejectedZip, "origin");
  assert.equal(closed.closedBy, "model");
  await ctx.page.context().close();
});

// FedEx with an unknown postal code may show no error: the form just keeps CONTINUAR disabled (case 9).
const ZIP_NOT_TAKEN = `<!doctype html><body><h1>Calcular tarifas</h1>
<label>Código postal de origen <input value="99999"></label><button disabled>CONTINUAR</button></body>`;

test("rejectedZip without siteMessage is accepted with evidenceId and rejected without it", async () => {
  const { ctx, store } = await open({ "https://www.shop.test/": ZIP_NOT_TAKEN });
  await run(ctx, "capture_evidence", { reason: "origin postal code not taken" });
  await fails(ctx, "close_carrier", { status: "needs_human", reason: "CONTINUAR stayed disabled", rejectedZip: "origin" }, /rejectedZip needs evidenceId/);
  assert.equal(store.events().filter((e) => e.type === "carrier.closed").length, 0);
  await run(ctx, "close_carrier", { status: "needs_human", reason: "CONTINUAR stayed disabled", rejectedZip: "origin", evidenceId: "ev1" });
  const closed = store.events().find((e) => e.type === "carrier.closed");
  assert.ok(closed && closed.type === "carrier.closed");
  assert.equal(closed.rejectedZip, "origin");
  assert.equal(closed.siteMessage, undefined);
  assert.equal(closed.evidenceId, "ev1");
  await ctx.page.context().close();
});
