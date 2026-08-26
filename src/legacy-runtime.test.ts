import assert from "node:assert/strict";
import test from "node:test";
import { buildLegacyCaptainCleanupScript } from "./legacy-runtime.js";

test("scopes legacy cleanup to the exact Fleet CLI and captain bridge command", () => {
  const script = buildLegacyCaptainCleanupScript("C:\\Fleet With Spaces\\dist\\cli.js", 123);
  assert.match(script, /ProcessId -ne 123/);
  assert.match(script, /captain-bridge/);
  assert.match(script, /IndexOf\(\$cli/);
  assert.doesNotMatch(script, /worker-bridge|codex\.cmd|taskkill/);
  const encoded = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
  assert.equal(Buffer.from(encoded!, "base64").toString("utf8"), "C:\\Fleet With Spaces\\dist\\cli.js");
});
