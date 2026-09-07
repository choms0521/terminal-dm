import os from "node:os";
import path from "node:path";

export interface AppPaths {
  dataDir: string;
  browserProfileDir: string;
  settingsFile: string;
}

export function getAppPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const defaultDataDir = path.join(os.homedir(), ".terminal-dm");
  const configuredDataDir = env.TERMINAL_DM_DATA;
  const dataDir = configuredDataDir
    ? path.resolve(configuredDataDir)
    : defaultDataDir;

  return {
    dataDir,
    browserProfileDir: path.join(dataDir, "browser", "instagram"),
    settingsFile: path.join(dataDir, "settings.json"),
  };
}
