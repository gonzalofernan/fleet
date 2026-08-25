import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ensureSettings, initializeLoopDirectory, initializeProjectDirectory, settingsForWorkspace } from "./settings.js";

test("initializes a settings file and separated workspace directories", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-settings-"));
  const settingsPath = join(home, "config", "settings.json");
  const settings = ensureSettings(settingsPath);

  assert.equal(existsSync(settingsPath), true);
  for (const directory of [settings.projectsDirectory, settings.loopsDirectory, settings.worktreesDirectory, settings.archiveDirectory]) {
    assert.equal(existsSync(directory), true);
  }
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), settings);
});

test("creates explicit project and loop metadata layouts", () => {
  const workspace = mkdtempSync(join(tmpdir(), "fleet-layout-"));
  const settings = settingsForWorkspace(workspace);
  const projectPath = initializeProjectDirectory(settings, "Billing API");
  const loopPath = initializeLoopDirectory(settings, "Daily review");

  assert.equal(existsSync(join(projectPath, "PROJECT.md")), true);
  assert.equal(existsSync(join(loopPath, "LOOP.md")), true);
  assert.equal(existsSync(join(loopPath, "runs")), true);
});
