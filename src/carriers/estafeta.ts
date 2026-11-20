import type { CarrierPlugin } from "./types.js";

// Recon of 2026-11-16 plus step-1 runs. Decision: start at the public page (not the iframe URL) so the run
// reflects what a person sees; the tools search inside iframes, so the embedded form is reachable.
export const estafeta: CarrierPlugin = {
  id: "estafeta",
  name: "Estafeta",
  startUrl: "https://www.estafeta.com/cotizar-envio",
  manualUrl: "https://www.estafeta.com/cotizar-envio",
  allowedDomains: ["estafeta.com", "cotizadorsitecorecms.azurewebsites.net"],
  notes: [
    "The quote form lives inside an iframe served from cotizadorsitecorecms.azurewebsites.net; the tools reach into iframes.",
    "It asks for origin postal code and destination postal code, and a shipment type: envelope (sobre) or package (paquete).",
    "The form's labels are plain text next to unlabeled inputs; the radios have no names and are identified by the text after them.",
    "After choosing package, fields for weight (kg) and height, length and width (cm) appear.",
    "The submit button is labeled 'Enviar'. No visible captcha at recon time.",
    "Results list several services (e.g. next day, ground), each with its own price; report each one.",
    "Results may carry notices such as 'Cotización Aproximada' or a VAT statement, and optional extras such as 'Manejo Especial' with their own amount: report them as siteNotes / optionalCharges.",
  ].join("\n"),
  budget: { maxSteps: 15, maxSeconds: 150 },
  // Estafeta's quote table shows only each service's name. Its national services table publishes the terms
  // (estafeta.com/nacional). "Dia Sig." delivers 9:00 to 18:00: a window, not a guaranteed time.
  serviceTerms: [
    { service: "12:30", minBusinessDays: 1, maxBusinessDays: 1, guaranteedBy: "12:30", label: "Día hábil siguiente, antes de las 12:30", sourceUrl: "https://www.estafeta.com/nacional" },
    { service: "Dia Sig.", minBusinessDays: 1, maxBusinessDays: 1, label: "Día hábil siguiente", sourceUrl: "https://www.estafeta.com/nacional" },
    { service: "2 Dias", minBusinessDays: 2, maxBusinessDays: 2, label: "Segundo día hábil", sourceUrl: "https://www.estafeta.com/nacional" },
    { service: "Terrestre", minBusinessDays: 3, maxBusinessDays: 5, label: "De 3 a 5 días hábiles", sourceUrl: "https://www.estafeta.com/nacional" },
  ],
};
