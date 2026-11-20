// A carrier is described by data, not code: where to start, which domains are allowed,
// what the recon found (as prose for the model, never selectors) and its budget.
import type { ExtraKey, QuoteRequest } from "../domain/request.js";
import type { CloseStatus } from "../record/events.js";

// Request data the site requires beyond origin/destination/parcels, with the reason the site uses it
// (the conversation shows `why` when it asks the user).
export interface CarrierNeed {
  field: ExtraKey;
  why: string;
}

export interface CarrierPlugin {
  id: string;
  name: string;
  startUrl: string;
  // The public page where a person quotes by hand, linked when we could not quote this carrier. The agent
  // never uses it. Default: startUrl.
  manualUrl?: string;
  // Hostnames (and their subdomains) the main frame may navigate to. Also used to pick which iframes to show.
  allowedDomains: string[];
  // Descriptive recon notes for the model: what the site asks for, units, quirks. NOT selectors.
  // They may name fields as the site names them (the name/id the tools' errors already list, e.g. form-field-4):
  // still data, not code. The tools find them with their usual strategies, and if the site changes, the error
  // lists the new names.
  notes: string;
  budget: { maxSteps: number; maxSeconds: number };
  // Optional cookie banner button to dismiss before the agent starts (accessible name, case-insensitive regex source).
  cookieReject?: { role: "button" | "link"; name: string };
  // If any of these is missing from request.extras, the carrier is not launched (carrier.skipped).
  needs?: CarrierNeed[];
  // Timeout for opening startUrl. Default: a third of maxSeconds, between 30 and 60 s.
  navTimeoutMs?: number;
  // Text that shows the form is ready. After opening the page and the cookie banner, the harness waits for it
  // (same check as wait_for) before the model's first turn, without spending turns. Counts against maxSeconds.
  readyText?: string;
  readyTimeoutMs?: number; // default 60 s

  // Known doubts about a closing status on this site, shown to the user (UI and result note) next to the
  // status. Plain Spanish for Mariana. `whenReason`: only if the record's close reason contains this text.
  caveats?: CarrierCaveat[];
  // Published delivery terms per service, for sites whose quote does not say when it arrives.
  serviceTerms?: ServiceTerm[];
}

// A delivery term the carrier publishes for one of its services (not a date of any quote). Used only when
// the quote itself gave no delivery, and only for a service whose name matches exactly (after normalizing spaces,
// accents and case): nothing is guessed.
export interface ServiceTerm {
  service: string; // the service's name exactly as the quote form shows it
  minBusinessDays: number;
  maxBusinessDays: number;
  guaranteedBy?: string; // "HH:MM": a guaranteed time, not a delivery window
  label: string; // Spanish, for the UI: "Día hábil siguiente, antes de las 12:30"
  sourceUrl: string; // the carrier's page that publishes it
}

export interface CarrierCaveat {
  status: CloseStatus;
  whenReason?: string;
  text: string;
}

// The caveat that applies to a carrier's final status and reason, if any.
export function caveatFor(plugin: CarrierPlugin | undefined, status: string, reason: string | undefined): string | undefined {
  return plugin?.caveats?.find((c) => c.status === status && (!c.whenReason || (reason ?? "").includes(c.whenReason)))?.text;
}

// The needs of `plugin` that `request` does not provide. Empty array = the carrier can be launched.
export function missingNeeds(plugin: CarrierPlugin, request: QuoteRequest): CarrierNeed[] {
  return (plugin.needs ?? []).filter((n) => request.extras?.[n.field] === undefined);
}
