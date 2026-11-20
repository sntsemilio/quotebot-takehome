// The shipment's data as plain lines, for the user to paste into a carrier's own quote form when we could
// not quote it. Built in code from the validated request only: no site text, no prices.
import type { Parcel, QuoteRequest } from "./request.js";

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
export const num = (n: number) => n.toLocaleString("es-MX", { maximumFractionDigits: 2 });

// "1 caja de 2 kg, 30 × 20 × 15 cm" / "4 cajas de 10 kg, 40 × 30 × 30 cm".
function boxes(n: number, p: Parcel): string {
  return `${n} ${n === 1 ? "caja" : "cajas"} de ${num(p.weightKg)} kg, ${num(p.lengthCm)} × ${num(p.widthCm)} × ${num(p.heightCm)} cm`;
}

// "2026-11-20" -> "20 nov 2026". A date that does not parse is shown as given.
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

// Origen: CP 64000
// Destino: CP 22000
// Paquetes: 4 cajas de 10 kg, 40 × 30 × 30 cm
// Fecha de envío: 20 nov 2026          (only when the request has a ship date)
// Parcels that differ are listed one after the other, separated by "; ".
export function shipmentText(r: QuoteRequest): string {
  const parcels = r.parcels.length === 1 ? boxes(r.count ?? 1, r.parcels[0]) : r.parcels.map((p) => boxes(1, p)).join("; ");
  const lines = [`Origen: CP ${r.originZip}`, `Destino: CP ${r.destZip}`, `Paquetes: ${parcels}`];
  if (r.extras?.shipDate) lines.push(`Fecha de envío: ${shortDate(r.extras.shipDate)}`);
  return lines.join("\n");
}
