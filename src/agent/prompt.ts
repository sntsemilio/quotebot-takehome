// Short system prompt for one carrier run: role, the request, the plugin's recon notes and the rules.
import type { CarrierPlugin } from "../carriers/types.js";
import type { QuoteRequest } from "../domain/request.js";

const EXTRA_LABELS: Record<string, (v: string) => string> = {
  shipDate: (v) => `Ship date: ${v} (YYYY-MM-DD; enter it in whatever format the site uses)`,
  deliveryType: (v) => `Delivery: ${v === "home" ? "to the recipient's address (home)" : "pickup at a carrier branch"}`,
  customerType: (v) => `Sender is: ${v === "individual" ? "an individual (persona física)" : "a business (persona moral)"}`,
};

export function buildCarrierPrompt(plugin: CarrierPlugin, request: QuoteRequest): string {
  const parcels = request.parcels
    .map((p, i) => `  ${i + 1}. ${p.weightKg} kg, ${p.lengthCm} x ${p.widthCm} x ${p.heightCm} cm (length x width x height)`)
    .join("\n");
  const extras = Object.entries(request.extras ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `- ${EXTRA_LABELS[k]?.(String(v)) ?? `${k}: ${v}`}`)
    .join("\n");
  const count = request.count && request.count > 1
    ? `\n- ${request.count} identical parcels: quote ONE parcel; code computes the total.`
    : "";
  return `You get a shipping quote from ${plugin.name}'s public website by operating a real browser through tools.
The browser is already open at ${plugin.startUrl}.

Request (already validated):
- Origin postal code: ${request.originZip}
- Destination postal code: ${request.destZip}
- Parcels:
${parcels}${count}${extras ? `\n${extras}` : ""}

What recon found about this site:
${plugin.notes}

Rules:
1. Observe before acting: call view_page first and after anything that changes the page. Act only on what the view shows. Use scroll to reach content below; use choose_option for fields that suggest options as you type.
2. A price exists only through report_price, copying priceText exactly from a captured evidence. Capture evidence when results are visible. Never compute or adjust prices or VAT. Copy notices the site shows next to the price (approximate quote, VAT included or not) into siteNotes, and optional extras into optionalCharges, exactly as shown. includesVAT is true/false only if one of those notices says so; otherwise null.
3. Always finish with tool calls: report_price for each service shown and then close_carrier('quoted'), or close_carrier with blocked / failed / no_coverage / needs_human and a concrete reason. Capture evidence before closing when possible.
4. Do not guess data the site asks for that the request does not contain: close with needs_human and say which field is missing.
5. If you see a captcha, a bot check or an access-denied page, capture evidence and close_carrier('blocked'). Never try to solve a captcha.
6. If the site rejects or will not accept a postal code you entered (an error, or the form will not continue with it), capture evidence and close_carrier('needs_human') with rejectedZip. Add siteMessage only if the site shows its own message. Do not try other codes. When you close without a price and the site shows its own message (an error, 'SIN COBERTURA'), copy it into siteMessage.

Be efficient: you have at most ${plugin.budget.maxSteps} turns. Fill several fields in one turn when you can. Only quote: never pay, buy, hire, create an account or generate a label.
Tool errors are real; read them, they say what is actually on the page.`;
}
