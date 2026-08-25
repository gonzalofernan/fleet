import assert from "node:assert/strict";
import test from "node:test";
import { recommendModel, renderModelComparison } from "./models.js";

test("routes roles to a model recommendation", () => {
  assert.equal(recommendModel("captain"), "gpt-5.6-luna");
  assert.equal(recommendModel("implementer"), "gpt-5.6-terra");
  assert.equal(recommendModel("architect"), "gpt-5.6-sol");
});

test("renders the model cost comparison", () => {
  const comparison = renderModelComparison();
  assert.match(comparison, /GPT-5\.6 Luna/);
  assert.match(comparison, /\$0\.20 \/ \$1\.20/);
});
