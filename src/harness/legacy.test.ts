// The contractor's agent (it told the model to estimate prices, solve captchas and allowed booking) is
// gone from the code and from package.json. The "before" is reproduced from the git tag before-baseline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const GONE = ["src/agent.ts", "src/prompt.ts", "src/tools.ts", "src/cli.ts", "src/run-case.ts", "src/harness/measure.ts", "src/harness/recorder.ts"];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? sources(p) : p.endsWith(".ts") && !p.endsWith("legacy.test.ts") ? [p] : [];
  });
}

test("the legacy agent files and its npm scripts are gone, and nothing refers to them", () => {
  for (const f of GONE) assert.equal(fs.existsSync(f), false, `${f} still exists`);
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts.chat, undefined);
  assert.equal(pkg.scripts.case, undefined);
  assert.equal(pkg.scripts.score, "tsx src/harness/scorecard.ts");
  for (const f of sources("src")) {
    const text = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(text, /\brunTurn\b|src\/prompt\.ts|harness\/recorder|run-case|src\/cli\.ts|npm run (chat|case)\b/, f);
  }
  assert.match(fs.readFileSync("src/harness/measure-after.ts", "utf8").split("\n").slice(0, 5).join("\n"), /before-baseline/);
});
