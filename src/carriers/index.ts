import type { CarrierPlugin } from "./types.js";
import { estafeta } from "./estafeta.js";
import { fedex } from "./fedex.js";
import { redpack } from "./redpack.js";
import { dhl } from "./dhl.js";
import { ups } from "./ups.js";

// Registry of carriers by id. A new plugin appears in the product just by being listed here.
export const carriers: Record<string, CarrierPlugin> = Object.fromEntries(
  [estafeta, fedex, redpack, dhl, ups].map((p) => [p.id, p]),
);

export function getCarrier(id: string): CarrierPlugin | undefined {
  return carriers[id];
}
