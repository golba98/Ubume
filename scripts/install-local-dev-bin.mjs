#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(currentFile));
const launcherPath = join(repoRoot, "scripts", "run-local-dev.mjs");

// Both shim names launch the same local-repo dev launcher. `cxd` is the short
// alias for `ubume-dev`.
export const SHIM_NAMES = ["ubume-dev", "ubd", "codexa-dev", "cxd"];

export function resolveInstallBinDir(env = process.env) {
  const override = env.UBUME_DEV_BIN_DIR?.trim() || env.CODEXA_DEV_BIN_DIR?.trim();
  if (override) return override;

  try {
    const prefix = execFileSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (prefix) {
      return process.platform === "win32" ? prefix : join(prefix, "bin");
    }
  } catch {
    // Fall back below when npm is not available.
  }

  return join(homedir(), ".local", "bin");
}

export function createUbumeDevShim(options = {}) {
  const binDir = options.binDir ?? resolveInstallBinDir(options.env ?? process.env);
  const quotedLauncher = JSON.stringify(launcherPath);
  const contents = process.platform === "win32"
    ? `@echo off\r\nnode ${quotedLauncher} %*\r\n`
    : `#!/usr/bin/env sh\nexec node ${quotedLauncher} "$@"\n`;

  mkdirSync(binDir, { recursive: true });

  const shimPaths = SHIM_NAMES.map((name) => {
    const shimPath = join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
    writeFileSync(shimPath, contents, "utf8");
    if (process.platform !== "win32") {
      chmodSync(shimPath, 0o755);
    }
    return shimPath;
  });

  // shimPath kept for backward compatibility (the primary ubume-dev shim).
  return { binDir, shimPath: shimPaths[0], shimPaths, launcherPath };
}

export const createCodexaDevShim = createUbumeDevShim;

if (currentFile === process.argv[1]) {
  const result = createUbumeDevShim();
  console.log(`Installed ${SHIM_NAMES.join(", ")} -> ${result.launcherPath}`);
  for (const shimPath of result.shimPaths) {
    console.log(`Shim: ${shimPath}`);
  }
  console.log("The published ubume command was not modified.");
}
