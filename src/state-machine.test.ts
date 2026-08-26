import assert from "node:assert/strict";
import test from "node:test";
import { assertAgentTransition, assertAttemptTransition, assertLoopRunTransition, assertRuntimeTransition, assertTaskTransition } from "./state-machine.js";

test("accepts lifecycle progressions and rejects terminal resurrection", () => {
  assert.doesNotThrow(() => assertAgentTransition("running", "waiting"));
  assert.doesNotThrow(() => assertTaskTransition("running", "review"));
  assert.doesNotThrow(() => assertAttemptTransition("starting", "running"));
  assert.doesNotThrow(() => assertRuntimeTransition("cancelling", "cancelled"));
  assert.doesNotThrow(() => assertLoopRunTransition("queued", "running"));
  assert.throws(() => assertAgentTransition("completed", "running"), /Invalid agent transition/);
  assert.throws(() => assertRuntimeTransition("stopped", "running"), /Invalid runtime transition/);
  assert.throws(() => assertLoopRunTransition("completed", "running"), /Invalid loop run transition/);
});
