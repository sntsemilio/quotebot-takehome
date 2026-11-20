// Unit conversion is done in code, never by the model. Exact factors (international pound and inch).

export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;

export type WeightUnit = "kg" | "lb";
export type LengthUnit = "cm" | "in";

// Rounded to 2 decimals: enough for any carrier form and avoids "4.5359237 kg" in the request.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function toKg(value: number, unit: WeightUnit): number {
  return unit === "kg" ? value : round2(value * KG_PER_LB);
}

export function toCm(value: number, unit: LengthUnit): number {
  return unit === "cm" ? value : round2(value * CM_PER_IN);
}

export interface ParcelInput {
  weight: number;
  weightUnit: WeightUnit;
  length: number;
  width: number;
  height: number;
  lengthUnit: LengthUnit;
}

// Converts a parcel as the user said it into the canonical kg/cm parcel of QuoteRequest.
export function toParcel(p: ParcelInput) {
  return {
    weightKg: toKg(p.weight, p.weightUnit),
    lengthCm: toCm(p.length, p.lengthUnit),
    widthCm: toCm(p.width, p.lengthUnit),
    heightCm: toCm(p.height, p.lengthUnit),
  };
}
