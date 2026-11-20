// Contract tests for src/domain (no network, no browser). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRequest } from "./request.js";
import { todayInBusinessTz, isIsoDate } from "./dates.js";
import { toKg, toCm, toParcel } from "./units.js";
import { computeTotal } from "./money.js";
import { missingNeeds, type CarrierPlugin } from "../carriers/types.js";

const base = { originZip: "64000", destZip: "22000", parcels: [{ weightKg: 10, lengthCm: 40, widthCm: 30, heightCm: 30 }] };
// 2026-11-18 03:30 UTC = 2026-11-17 21:30 in Monterrey (UTC-6, no DST since 2022).
const MTY_EVENING = new Date("2026-11-18T03:30:00Z");

test("today is computed in Monterrey, not UTC", () => {
  assert.equal(todayInBusinessTz(MTY_EVENING), "2026-11-17");
  assert.equal(todayInBusinessTz(new Date("2026-11-18T06:00:00Z")), "2026-11-18"); // 00:00 in Monterrey
});

test("shipDate of today in Monterrey is accepted at 21:30 local (UTC already says tomorrow)", () => {
  const v = validateRequest({ ...base, extras: { shipDate: "2026-11-17" } }, { now: MTY_EVENING });
  assert.ok(v.ok, JSON.stringify(v));
});

test("yesterday in Monterrey is rejected as past, with Monterrey's today in the message", () => {
  const v = validateRequest({ ...base, extras: { shipDate: "2026-11-16" } }, { now: MTY_EVENING });
  assert.ok(!v.ok);
  assert.match(v.errors.join(), /in the past \(today in Monterrey is 2026-11-17\)/);
});

test("deadline uses the same rule and is required for by_date", () => {
  assert.ok(validateRequest({ ...base, preference: { priority: "by_date", deadline: "2026-11-17" } }, { now: MTY_EVENING }).ok);
  const missing = validateRequest({ ...base, preference: { priority: "by_date" } }, { now: MTY_EVENING });
  assert.ok(!missing.ok && missing.errors.some((e) => e.includes("deadline is required")));
  assert.ok(validateRequest({ ...base, preference: { priority: "cheapest" } }, { now: MTY_EVENING }).ok);
});

test("invalid dates and enums give clear errors; unknown extras are rejected", () => {
  assert.ok(!isIsoDate("2026-02-30") && !isIsoDate("2026-2-3") && isIsoDate("2028-02-29"));
  const v = validateRequest(
    { ...base, extras: { shipDate: "2026-02-30", deliveryType: "door", customerType: "company", insurance: true }, preference: { priority: "soonest" } },
    { now: MTY_EVENING },
  );
  assert.ok(!v.ok);
  const all = v.errors.join("\n");
  for (const frag of ["extras.shipDate must be a real date", "extras.deliveryType must be one of: home, branch", "extras.customerType must be one of: individual, business", "extras.insurance is not a known field", "preference.priority must be one of"]) {
    assert.ok(all.includes(frag), `missing error: ${frag}\n${all}`);
  }
});

test("valid extras and preference pass through; empty extras are dropped", () => {
  const v = validateRequest({ ...base, count: 3, extras: { deliveryType: "branch", customerType: "individual" }, preference: { priority: "fastest" } }, { now: MTY_EVENING });
  assert.ok(v.ok);
  assert.deepEqual(v.request.extras, { deliveryType: "branch", customerType: "individual" });
  assert.deepEqual(v.request.preference, { priority: "fastest" });
  assert.equal(v.request.count, 3);
  const e = validateRequest({ ...base, extras: {} }, { now: MTY_EVENING });
  assert.ok(e.ok && e.request.extras === undefined);
});

test("units: lb and inches converted in code with exact factors", () => {
  assert.equal(toKg(10, "lb"), 4.54);
  assert.equal(toKg(10, "kg"), 10);
  assert.equal(toCm(12, "in"), 30.48);
  assert.deepEqual(toParcel({ weight: 22, weightUnit: "lb", length: 16, width: 12, height: 12, lengthUnit: "in" }), {
    weightKg: 9.98, lengthCm: 40.64, widthCm: 30.48, heightCm: 30.48,
  });
});

test("computeTotal works in integer cents and shows the formula", () => {
  assert.deepEqual(computeTotal(0.1, 3, "MXN"), { total: 0.3, formula: "3 x 0.10 MXN = 0.30 MXN" }); // 0.1*3 = 0.30000000000000004 in floats
  assert.deepEqual(computeTotal(1234.5, 2, "MXN"), { total: 2469, formula: "2 x 1234.50 MXN = 2469.00 MXN" });
});

test("missingNeeds lists only what the request lacks", () => {
  const redpack = { needs: [{ field: "deliveryType", why: "home or branch delivery" }, { field: "customerType", why: "individual or business" }] } as CarrierPlugin;
  const v = validateRequest({ ...base, extras: { deliveryType: "home" } }, { now: MTY_EVENING });
  assert.ok(v.ok);
  assert.deepEqual(missingNeeds(redpack, v.request).map((n) => n.field), ["customerType"]);
  assert.deepEqual(missingNeeds({} as CarrierPlugin, v.request), []);
});

test("next business day is computed in Monterrey and skips weekends", async () => {
  const { nextBusinessDayInBusinessTz } = await import("./dates.js");
  assert.equal(nextBusinessDayInBusinessTz(MTY_EVENING), "2026-11-18"); // Tue 21:30 MTY (Wed in UTC) -> Wed
  assert.equal(nextBusinessDayInBusinessTz(new Date("2026-11-21T03:00:00Z")), "2026-11-23"); // Fri 21:00 MTY -> Mon
  assert.equal(nextBusinessDayInBusinessTz(new Date("2026-11-21T18:00:00Z")), "2026-11-23"); // Sat -> Mon
});
