// Pure tests for bot-wall detection. Run: npx tsx --test src/browser/blocking.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockFromNavError, blockFromStatus, blockFromText } from "./blocking.js";

test("anti-bot network resets are blocks; timeouts and DNS errors are not", () => {
  assert.match(blockFromNavError("page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://www.dhl.com/") ?? "", /ERR_HTTP2_PROTOCOL_ERROR/);
  assert.ok(blockFromNavError("page.goto: net::ERR_CONNECTION_RESET"));
  assert.equal(blockFromNavError("page.goto: Timeout 30000ms exceeded."), null);
  assert.equal(blockFromNavError("page.goto: net::ERR_NAME_NOT_RESOLVED"), null);
});

test("403 and 429 main documents are blocks; 200 and 404 are not", () => {
  assert.ok(blockFromStatus({ status: 403, url: "u" }));
  assert.ok(blockFromStatus({ status: 429, url: "u" }));
  assert.equal(blockFromStatus({ status: 200, url: "u" }), null);
  assert.equal(blockFromStatus({ status: 404, url: "u" }), null);
  assert.equal(blockFromStatus(undefined), null);
});

test("wall texts are detected", () => {
  assert.ok(blockFromText("Access Denied\nYou don't have permission to access this server. Reference #18.abc"));
  assert.ok(blockFromText("Por favor verifica que eres humano"));
  assert.ok(blockFromText("Pardon Our Interruption... "));
  assert.ok(blockFromText("Please complete the captcha to continue")); // short page with a captcha
});

test("a normal long form page that merely uses reCAPTCHA is not a wall", () => {
  const form = "Cotiza tu envío. Código postal de origen. Código postal de destino. Peso. ".repeat(20);
  assert.equal(blockFromText(`${form}\nThis site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.`), null);
  assert.equal(blockFromText(`${form}\nCompleta el captcha si aparece.`), null); // long page: bare "captcha" does not count
});
