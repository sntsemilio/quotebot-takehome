import type { CarrierPlugin } from "./types.js";

// The URL https://wwwapps.ups.com/ctc/request?loc=es_MX answers the automated browser with a file download instead
// of a page. Start from the README's public
// page instead and let the agent follow the link to the calculator. The calculator quotes for a specific ship date.
export const ups: CarrierPlugin = {
  id: "ups",
  name: "UPS México",
  startUrl: "https://www.ups.com/mx/es/support/shipping-support/shipping-costs-rates.page",
  manualUrl: "https://www.ups.com/mx/es/support/shipping-support/shipping-costs-rates.page",
  allowedDomains: ["ups.com"],
  notes: [
    "Start page is UPS's shipping costs page: find and follow the link to the time-and-cost calculator ('Calcular tiempo y costo' or similar) on ups.com.",
    "The 'Calculate time and cost' form asks for origin and destination (country, postal code, sometimes city) and a ship date: use the request's ship date.",
    "It asks for package details (weight in kg, dimensions in cm; select metric units if the form offers a unit choice).",
    "It may offer a sign-in; never sign in. Quote as a guest.",
    "Results list several services with prices and delivery dates; report each one.",
  ].join("\n"),
  budget: { maxSteps: 15, maxSeconds: 150 },
  needs: [{ field: "shipDate", why: "UPS quotes prices and delivery times for a specific ship date" }],
  caveats: [
    {
      status: "failed",
      whenReason: "descarga",
      text: "Probable bloqueo: su página responde con una descarga a nuestro navegador automatizado; en un navegador normal sí cargó (verificado el 16 nov). Puedes cotizar directo en el sitio de UPS.",
    },
  ],
};
