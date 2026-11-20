import type { CarrierPlugin } from "./types.js";

// From the README and the "before" run (ERR_HTTP2_PROTOCOL_ERROR on load); no live recon yet.
export const dhl: CarrierPlugin = {
  id: "dhl",
  name: "DHL México",
  startUrl: "https://www.dhl.com/mx-es/home/envio/cotizacion-envio.html",
  manualUrl: "https://www.dhl.com/mx-es/home/envio/cotizacion-envio.html",
  allowedDomains: ["dhl.com"],
  notes: [
    "Often blocks automated browsers (connection reset or access denied). Code closes those as blocked; if you see a wall code missed, close as blocked.",
    "The quote form may ask for origin and destination country plus postal code or city; the country fields suggest options as you type: use choose_option (Mexico for both).",
    "It may ask whether it is a document or a package and for weight and dimensions.",
    "Results may list several services with prices and delivery dates; report each one.",
  ].join("\n"),
  budget: { maxSteps: 15, maxSeconds: 150 },
};
