import type { CarrierPlugin } from "./types.js";

// From the README and the recon of the site.
// Heavy, slow page: larger budget.
export const fedex: CarrierPlugin = {
  id: "fedex",
  name: "FedEx México",
  startUrl: "https://www.fedex.com/es-mx/online/rating.html",
  manualUrl: "https://www.fedex.com/es-mx/online/rating.html",
  allowedDomains: ["fedex.com"],
  // Agreed text, from recorded runs of this site. The postal code line also covers a form that will not continue.
  notes: [
    "The page is slow. The harness waits until 'Desde' is visible before your first turn; if your first view still shows unnamed textboxes, call wait_for('Desde', 20) once.",
    "Origin and destination are Google address autocompletes. Their field names are fromGoogleAddress (origin) and toGoogleAddress (destination); the visible label 'Desde' matches two elements, so pass those names as the field.",
    "Use choose_option with text '<postal code> <city>' and option '<postal code>'. Suggestions look like 'Centro, 64000 Monterrey, N.L., México' or '22000 Tijuana, B.C., México'; some are businesses with an address. If several contain the postal code, the error lists them and the list stays open: in your next turn call click with role 'option' and the exact text of the first suggestion that is an area or a city (not a business) with that postal code and 'México'.",
    "After both addresses are set, the package fields appear: 'Peso del paquete*' (kg) and the fields named form-field-4, form-field-5 and form-field-6 for length, width and height (cm). Fill the four in one turn, then click the button 'Mostrar tarifas'.",
    // The guest breakdown, seen by hand on 2026-11-19: its 'Total estimado' is the row price.
    "Rates take about 10 s: wait_for 'MXN'. The results have two tabs, 'Enviar con una cuenta' (shown first) and 'Enviar como invitado'. The account tab shows each price struck through next to a lower price that needs a FedEx account: never report that lower price. Click the tab 'Enviar como invitado'.",
    "Each rate has a button named 'Ver detalles adicionales sobre los precios, <price>'. Click all of them in one turn (they stay open together), then capture_evidence. Each one shows the site's breakdown: 'Tarifa base', 'IVA', 'RECARGO POR COMBUSTIBLE' and 'Total estimado', each with its amount.",
    "Each service shows 'LLEGA EL <date>', 'ENTREGADO POR <time>' and its name (e.g. 'FedEx Nacional Económico'). Put the arrival date and time as shown in deliveryDays. Report every service and close_carrier('quoted') in the same turn.",
    "For each service, report includesVAT true with vatBreakdown { vatLine: 'IVA <amount>', totalLine: 'Total estimado <amount>' } copied from that service's breakdown, and put the four breakdown lines ('Tarifa base <amount>', 'IVA <amount>', 'RECARGO POR COMBUSTIBLE <amount>', 'Total estimado <amount>') in siteNotes, plus 'Los montos se muestran en MXN' and the notice that rates may differ from the actual charges. If a rate has no breakdown, report it with includesVAT null.",
    "If the site cannot find a postal code, or the form will not continue with it, capture evidence and close as needs_human with rejectedZip; add siteMessage only if the site shows a message.",
    "Never sign in or create an account; quote as a guest.",
  ].join("\n"),
  budget: { maxSteps: 20, maxSeconds: 180 },
  navTimeoutMs: 60_000, // heavy page: the start page did not load in 30 s on 2026-11-18
  // "Desde" appeared ~80 s after start in case 7 and between 72 and 99 s in case 9; the wait starts at ~39 s.
  readyText: "Desde",
  readyTimeoutMs: 75_000,
};
