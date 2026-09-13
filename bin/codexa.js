#!/usr/bin/env node

import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

process.stderr.write("The `codexa` command has been renamed to `ubume`.\nPlease use `ubume` instead.\n\n");

const currentFile = fileURLToPath(import.meta.url);
const ubumeScript = join(dirname(currentFile), "ubume.js");

const child = spawn(process.execPath, [ubumeScript, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  console.error(`Failed to launch ubume: ${error.message}`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
