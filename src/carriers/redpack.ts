import type { CarrierPlugin } from "./types.js";

// From the README and the recon of the site.
export const redpack: CarrierPlugin = {
  id: "redpack",
  name: "Redpack",
  startUrl: "https://www.redpack.com.mx/es/cotizador/",
  manualUrl: "https://www.redpack.com.mx/es/cotizador/",
  allowedDomains: ["redpack.com.mx"],
  notes: [
    "The site has bot protection: if a check or captcha appears, close as blocked.",
    "Origin and destination fields accept 'CP o colonia'. Try choose_option with the postal code; in run 1 no suggestion list was detected, in that case fill the postal code with fill_field and check what the field shows.",
    "Both postal code fields share the same placeholder; if a label is ambiguous, use the field's name shown in the error.",
    "The radios (package type, delivery type, person type) are custom-styled; the click tool handles that. Check the 'Now checked' result.",
    "It asks for the delivery type (to the address / 'a domicilio', or pickup at a branch / 'ocurre') and whether the sender is an individual (persona física) or a business (persona moral): use the request's values.",
    "Results may list several services with prices; report each one.",
  ].join("\n"),
  budget: { maxSteps: 15, maxSeconds: 150 },
  needs: [
    { field: "deliveryType", why: "Redpack quotes differently for delivery to the address or pickup at a branch" },
    { field: "customerType", why: "Redpack asks whether the sender is an individual or a business" },
  ],
  // Run 2 (2026-11-18): the form was filled correctly and the site answered "SIN COBERTURA", but it never offered
  // to pick a colonia for the postal codes, so the answer may depend on that.
  caveats: [
    {
      status: "no_coverage",
      text: "Ojo: no pudimos elegir la colonia en el formulario de Redpack, así que esta respuesta puede no ser definitiva. Te sugerimos confirmarlo en su sitio.",
    },
  ],
};
