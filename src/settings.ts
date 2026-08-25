import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface FleetSettings {
  version: 1;
  workspaceRoot: string;
  projectsDirectory: string;
  loopsDirectory: string;
  worktreesDirectory: string;
  archiveDirectory: string;
  defaultModel: string;
  terminalBackend: "windows-terminal";
  maxConcurrentAgents: number;
}

export function defaultSettingsPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "Fleet", "settings.json");
}

export function defaultSettings(): FleetSettings {
  const workspaceRoot = join(homedir(), "Fleet");
  return settingsForWorkspace(workspaceRoot);
}

export function settingsForWorkspace(workspaceRoot: string): FleetSettings {
  const root = resolve(workspaceRoot);
  return {
    version: 1,
    workspaceRoot: root,
    projectsDirectory: join(root, "projects"),
    loopsDirectory: join(root, "loops"),
    worktreesDirectory: join(root, "worktrees"),
    archiveDirectory: join(root, "archive"),
    defaultModel: "gpt-5.6-luna",
    terminalBackend: "windows-terminal",
    maxConcurrentAgents: 6,
  };
}

export function ensureSettings(path = defaultSettingsPath()): FleetSettings {
  const settings = existsSync(path)
    ? readSettings(path)
    : writeSettings(path, defaultSettings());
  ensureWorkspaceDirectories(settings);
  return settings;
}

export function readSettings(path = defaultSettingsPath()): FleetSettings {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FleetSettings>;
  if (parsed.version !== 1 || !parsed.workspaceRoot || !parsed.projectsDirectory || !parsed.loopsDirectory || !parsed.worktreesDirectory || !parsed.archiveDirectory) {
    throw new Error(`Invalid Fleet settings: ${path}`);
  }
  return {
    ...defaultSettings(),
    ...parsed,
    version: 1,
    terminalBackend: "windows-terminal",
  } as FleetSettings;
}

export function writeSettings(path: string, settings: FleetSettings): FleetSettings {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
  return settings;
}

export function ensureWorkspaceDirectories(settings: FleetSettings): void {
  for (const directory of [settings.workspaceRoot, settings.projectsDirectory, settings.loopsDirectory, settings.worktreesDirectory, settings.archiveDirectory]) {
    mkdirSync(directory, { recursive: true });
  }
}

export function managedProjectPath(settings: FleetSettings, name: string): string {
  return join(settings.projectsDirectory, slug(name));
}

export function managedLoopPath(settings: FleetSettings, title: string): string {
  return join(settings.loopsDirectory, slug(title));
}

export function initializeProjectDirectory(settings: FleetSettings, name: string): string {
  const directory = managedProjectPath(settings, name);
  mkdirSync(directory, { recursive: true });
  const metadata = join(directory, "PROJECT.md");
  if (!existsSync(metadata)) writeFileSync(metadata, `# ${name}\n\nFleet project metadata.\n`, "utf8");
  return directory;
}

export function initializeLoopDirectory(settings: FleetSettings, title: string): string {
  const directory = managedLoopPath(settings, title);
  mkdirSync(join(directory, "runs"), { recursive: true });
  const metadata = join(directory, "LOOP.md");
  if (!existsSync(metadata)) writeFileSync(metadata, `# ${title}\n\nFleet recurring loop metadata.\n`, "utf8");
  return directory;
}

function slug(value: string): string {
  const result = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!result) throw new Error("A managed resource needs a non-empty name");
  return result;
}
