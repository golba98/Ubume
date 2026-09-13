#!/usr/bin/env node

/**
 * audit-ubume-capabilities.mjs
 * 
 * Lightweight Ubume capability audit checker.
 * Performs static analysis on source to report feature availability.
 * 
 * Usage: node scripts/audit-ubume-capabilities.mjs
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = import.meta.dirname ?? 
  resolve(new URL(import.meta.url).pathname, "..", "..");

const repoRoot = resolve(__dirname, "..");

const checks = {
  entrypoint() {
    const path = join(repoRoot, "bin", "ubume.js");
    const exists = existsSync(path);
    return {
      pass: exists,
      evidence: exists ? [path] : [],
      reason: exists 
        ? "Entry wrapper spawns Bun runtime to execute app"
        : "Entry wrapper not found"
    };
  },

  cliHelpVersion() {
    const launchArgsPath = join(repoRoot, "src", "config", "launchArgs.ts");
    const launcherPath = join(repoRoot, "bin", "ubume.js");
    if (!existsSync(launchArgsPath) || !existsSync(launcherPath)) {
      return { pass: false, evidence: [], reason: "launch arg parser or launcher not found" };
    }
    
    const launchArgsContent = readFileSync(launchArgsPath, "utf-8");
    const launcherContent = readFileSync(launcherPath, "utf-8");
    const combined = `${launchArgsContent}\n${launcherContent}`;
    const hasHelp = /--help/.test(combined) && /["']-h["']/.test(combined);
    const hasVersion = /--version/.test(combined) && /["']-v["']/.test(combined);
    const exitsBeforeInk = /process\.exit\(0\)/.test(launcherContent) && !/render\(/.test(launcherContent);
    const readsPackageVersion = /package\.json/.test(launcherContent) && /version/.test(launcherContent);
    
    return {
      pass: hasHelp && hasVersion && exitsBeforeInk && readsPackageVersion,
      evidence: [launchArgsPath, launcherPath],
      reason: hasHelp && hasVersion && exitsBeforeInk && readsPackageVersion
        ? "--help/-h and --version/-v exit from launcher before Ink and version reads package.json"
        : `Missing evidence: ${[
          hasHelp ? null : "help flags",
          hasVersion ? null : "version flags",
          exitsBeforeInk ? null : "early exit before Ink",
          readsPackageVersion ? null : "package.json version read",
        ].filter(Boolean).join(", ")}`
    };
  },

  initialPromptArgument() {
    const path = join(repoRoot, "src", "config", "launchArgs.ts");
    const appPath = join(repoRoot, "src", "app.tsx");
    
    if (!existsSync(path) || !existsSync(appPath)) {
      return { pass: false, evidence: [], reason: "Required files not found" };
    }

    const launchContent = readFileSync(path, "utf-8");
    const appContent = readFileSync(appPath, "utf-8");
    
    const hasExtraction = /initialPrompt/.test(launchContent) && /promptArgs/.test(launchContent);
    const hasUsage = /launchArgs\.initialPrompt/.test(appContent)
      && /initialPromptSubmittedRef/.test(appContent)
      && /startPromptRun\(initialPrompt,\s*initialPrompt,/.test(appContent);
    
    return {
      pass: hasExtraction && hasUsage,
      evidence: [path, appPath],
      reason: hasExtraction && hasUsage
        ? "Initial prompt support present"
        : "Passthrough args stored but not used for initial prompt"
    };
  },

  interactiveMode() {
    const indexPath = join(repoRoot, "src", "index.tsx");
    if (!existsSync(indexPath)) {
      return { pass: false, evidence: [], reason: "src/index.tsx not found" };
    }

    const content = readFileSync(indexPath, "utf-8");
    const hasTTY = /isTTY|TTY|isatty/.test(content);
    const hasInk = /render\(|<App/.test(content);
    
    return {
      pass: hasTTY && hasInk,
      evidence: [indexPath],
      reason: hasTTY && hasInk
        ? "Interactive mode with TTY detection and Ink UI present"
        : "TTY or UI setup missing"
    };
  },

  modelPicker() {
    const paths = [
      join(repoRoot, "src", "ui", "panels", "ModelPicker.tsx"),
      join(repoRoot, "src", "config", "settings.ts")
    ];
    
    const exist = paths.filter(p => existsSync(p));
    const hasModels = exist.some(p => 
      /AVAILABLE_MODELS/.test(readFileSync(p, "utf-8"))
    );
    
    return {
      pass: exist.length === 2 && hasModels,
      evidence: exist,
      reason: exist.length === 2 && hasModels
        ? "Model picker UI and model enumeration present"
        : `Missing components: ${exist.length}/2`
    };
  },

  configLoading() {
    const paths = [
      join(repoRoot, "src", "config", "layeredConfig.ts"),
      join(repoRoot, "src", "config", "persistence.ts"),
      join(repoRoot, "src", "config", "runtimeConfig.ts")
    ];
    
    const exist = paths.filter(p => existsSync(p));
    return {
      pass: exist.length === paths.length,
      evidence: exist,
      reason: exist.length === 3
        ? "Layered config resolution, persistence, and runtime config present"
        : `Found ${exist.length}/3 config modules`
    };
  },

  agentsmdSupport() {
    const loaderPath = join(repoRoot, "src", "core", "workspace", "projectInstructions.ts");
    const appPath = join(repoRoot, "src", "app.tsx");
    const promptPath = join(repoRoot, "src", "core", "codex", "codexPrompt.ts");
    const providerPath = join(repoRoot, "src", "core", "providers", "codexSubprocess.ts");
    
    const paths = [loaderPath, appPath, promptPath, providerPath];
    const existing = paths.filter(p => existsSync(p));
    if (existing.length !== paths.length) {
      return {
        pass: false,
        evidence: existing,
        reason: `Found ${existing.length}/4 AGENTS.md support files`
      };
    }
    
    const loaderContent = readFileSync(loaderPath, "utf-8");
    const appContent = readFileSync(appPath, "utf-8");
    const promptContent = readFileSync(promptPath, "utf-8");
    const providerContent = readFileSync(providerPath, "utf-8");
    const discoversAgents = /AGENTS\.md/.test(loaderContent) && /\.codex/.test(loaderContent);
    const appLoadsAgents = /loadProjectInstructions/.test(appContent) && /projectInstructions/.test(appContent);
    const promptInjectsAgents = /Project instructions:/.test(promptContent) && /projectInstructions/.test(promptContent);
    const providerPassesAgents = /projectInstructions/.test(providerContent) && /buildCodexPrompt/.test(providerContent);

    return {
      pass: discoversAgents && appLoadsAgents && promptInjectsAgents && providerPassesAgents,
      evidence: paths,
      reason: discoversAgents && appLoadsAgents && promptInjectsAgents && providerPassesAgents
        ? "AGENTS.md/.codex/AGENTS.md discovery, app loading, and prompt injection present"
        : `Missing evidence: ${[
          discoversAgents ? null : "discovery",
          appLoadsAgents ? null : "app loading",
          promptInjectsAgents ? null : "prompt injection",
          providerPassesAgents ? null : "provider pass-through",
        ].filter(Boolean).join(", ")}`
    };
  },

  commandExecution() {
    const path = join(repoRoot, "src", "core", "process", "CommandRunner.ts");
    if (!existsSync(path)) {
      return { pass: false, evidence: [], reason: "CommandRunner.ts not found" };
    }

    const content = readFileSync(path, "utf-8");
    const hasRun = /runCommand|spawn/.test(content);
    const hasOutput = /stdout|stderr/.test(content);
    
    return {
      pass: hasRun && hasOutput,
      evidence: [path],
      reason: hasRun && hasOutput
        ? "Shell command execution with output capture present"
        : "Command execution incomplete"
    };
  },

  fileEditingLayer() {
    const paths = [
      join(repoRoot, "src", "core", "workspace", "workspaceActivity.ts"),
      join(repoRoot, "src", "core", "workspace", "workspaceGuard.ts")
    ];
    
    const exist = paths.filter(p => existsSync(p));
    const content = exist.map(p => readFileSync(p, "utf-8")).join("");
    const hasTracking = /createWorkspaceActivityTracker|modified|created|deleted/.test(content);
    const hasGuard = /isPathInsideWorkspace|workspaceGuard/.test(content);
    
    return {
      pass: exist.length === 2 && hasTracking && hasGuard,
      evidence: exist,
      reason: hasTracking && hasGuard
        ? "File activity tracking and workspace guard present"
        : exist.length < 2 ? "Activity or guard module missing" : "Tracking/guard logic incomplete"
    };
  },

  diffRenderer() {
    const rendererPath = join(repoRoot, "src", "ui", "render", "diffRenderer.ts");
    const testPath = join(repoRoot, "src", "ui", "render", "diffRenderer.test.ts");
    const markdownPath = join(repoRoot, "src", "ui", "render", "Markdown.tsx");
    const timelinePath = join(repoRoot, "src", "ui", "timeline", "timelineMeasure.ts");
    const paths = [rendererPath, testPath, markdownPath, timelinePath];
    const existing = paths.filter(p => existsSync(p));

    if (existing.length !== paths.length) {
      return {
        pass: false,
        evidence: existing,
        reason: `Found ${existing.length}/4 diff renderer files/integrations`
      };
    }

    const rendererContent = readFileSync(rendererPath, "utf-8");
    const testContent = readFileSync(testPath, "utf-8");
    const markdownContent = readFileSync(markdownPath, "utf-8");
    const timelineContent = readFileSync(timelinePath, "utf-8");
    const exportsUtility = /export\s+function\s+isUnifiedDiff/.test(rendererContent)
      && /export\s+function\s+renderUnifiedDiff/.test(rendererContent)
      && /export\s+function\s+maybeRenderDiff/.test(rendererContent)
      && /DiffRenderLine/.test(rendererContent);
    const detectsUnifiedDiff = /DIFF_GIT_HEADER_PATTERN/.test(rendererContent)
      && /HUNK_HEADER_PATTERN/.test(rendererContent)
      && /OLD_FILE_HEADER_PATTERN/.test(rendererContent)
      && /NEW_FILE_HEADER_PATTERN/.test(rendererContent);
    const hasFocusedTests = /isUnifiedDiff/.test(testContent)
      && /renderUnifiedDiff/.test(testContent)
      && /ANSI|control/i.test(testContent)
      && /normal text|normal prose/i.test(testContent);
    const markdownIntegrated = /diffRenderer/.test(markdownContent) && /maybeRenderDiff/.test(markdownContent);
    const timelineIntegrated = /diffRenderer/.test(timelineContent) && /maybeRenderDiff/.test(timelineContent);
    
    return {
      pass: exportsUtility && detectsUnifiedDiff && hasFocusedTests && markdownIntegrated && timelineIntegrated,
      evidence: paths,
      reason: exportsUtility && detectsUnifiedDiff && hasFocusedTests && markdownIntegrated && timelineIntegrated
        ? "Unified diff renderer utility, tests, and UI integrations present"
        : `Missing evidence: ${[
          exportsUtility ? null : "utility exports",
          detectsUnifiedDiff ? null : "unified diff detection",
          hasFocusedTests ? null : "focused tests",
          markdownIntegrated ? null : "Markdown integration",
          timelineIntegrated ? null : "timeline integration",
        ].filter(Boolean).join(", ")}`
    };
  },

  approvalSandboxLogic() {
    const paths = [
      join(repoRoot, "src", "core", "workspace", "workspaceGuard.ts"),
      join(repoRoot, "src", "config", "runtimeConfig.ts")
    ];
    
    const exist = paths.filter(p => existsSync(p));
    const content = exist.map(p => readFileSync(p, "utf-8")).join("");
    const hasSandbox = /sandbox|approval|permission|writable.*root/.test(content);
    
    return {
      pass: exist.length === 2 && hasSandbox,
      evidence: exist,
      reason: hasSandbox
        ? "Sandbox configuration and approval logic present"
        : "Approval or sandbox logic missing"
    };
  },

  sessionHistoryPersistence() {
    const paths = [
      join(repoRoot, "src", "session", "types.ts"),
      join(repoRoot, "src", "session", "appSession.ts"),
      join(repoRoot, "src", "config", "persistence.ts")
    ];
    
    const exist = paths.filter(p => existsSync(p));
    return {
      pass: exist.length === 3,
      evidence: exist,
      reason: exist.length === 3
        ? "Session event types, state management, and persistence present"
        : `Found ${exist.length}/3 session modules`
    };
  },

  debugLogging() {
    const debugPath = join(repoRoot, "src", "core", "debug", "inputDebug.ts");
    const envPath = join(repoRoot, "bin", "ubume.js");
    
    const debugExists = existsSync(debugPath);
    const envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
    const hasEnvDebug = /UBUME_DEBUG|debug/.test(envContent);
    
    return {
      pass: debugExists || hasEnvDebug,
      evidence: [debugExists ? debugPath : envPath].filter(p => existsSync(p)),
      reason: debugExists && hasEnvDebug
        ? "Debug logging module and environment variable support present"
        : debugExists || hasEnvDebug
        ? "Partial debug support"
        : "Debug logging not found"
    };
  },

  windowsPowerShellHandling() {
    const launcherPath = join(repoRoot, "bin", "ubume.js");
    if (!existsSync(launcherPath)) {
      return { pass: false, evidence: [], reason: "Launcher not found" };
    }

    const content = readFileSync(launcherPath, "utf-8");
    const hasWinDetect = /win32|platform|windows/i.test(content);
    const hasExeResolution = /bun\.exe|bun\.cmd|shell|spawn/.test(content);
    
    return {
      pass: hasWinDetect && hasExeResolution,
      evidence: [launcherPath],
      reason: hasWinDetect && hasExeResolution
        ? "Windows platform detection and executable resolution present"
        : "Windows-specific handling incomplete"
    };
  },

  resizeHandling() {
    const indexPath = join(repoRoot, "src", "index.tsx");
    if (!existsSync(indexPath)) {
      return { pass: false, evidence: [], reason: "src/index.tsx not found" };
    }

    const content = readFileSync(indexPath, "utf-8");
    const hasResize = /resize|onResize|RESIZE/.test(content);
    const hasRepaint = /repaint|recalculate|calculateLayout/.test(content);
    
    return {
      pass: hasResize && hasRepaint,
      evidence: [indexPath],
      reason: hasResize && hasRepaint
        ? "Terminal resize event handling and UI recalculation present"
        : "Resize handling incomplete"
    };
  },

  streamingHandler() {
    const paths = [
      join(repoRoot, "src", "core", "providers", "codexSubprocess.ts"),
      join(repoRoot, "src", "core", "providers", "codexJsonStream.ts"),
      join(repoRoot, "src", "core", "providers", "codexTranscript.ts")
    ];
    
    const exist = paths.filter(p => existsSync(p));
    const content = exist.map(p => readFileSync(p, "utf-8")).join("");
    const hasStreaming = /stream|emit|chunk|line|onLine/.test(content);
    
    return {
      pass: exist.length === paths.length && hasStreaming,
      evidence: exist,
      reason: exist.length === paths.length && hasStreaming
        ? "Streaming response handler present"
        : `Streaming implementation incomplete: found ${exist.length}/${paths.length} modules`
    };
  },

  interruptCancelHandling() {
    const indexPath = join(repoRoot, "src", "index.tsx");
    const appPath = join(repoRoot, "src", "app.tsx");
    
    const paths = [indexPath, appPath].filter(p => existsSync(p));
    const content = paths.map(p => readFileSync(p, "utf-8")).join("");
    const hasSignals = /SIGINT|SIGTERM|signal|cancel/.test(content);
    const hasCancel = /cancel|abort|kill/.test(content);
    
    return {
      pass: hasSignals && hasCancel,
      evidence: paths,
      reason: hasSignals && hasCancel
        ? "Signal handling and cancellation logic present"
        : "Interrupt/cancel handling incomplete"
    };
  }
};

function statusSymbol(pass) {
  return pass ? "✓" : "✗";
}

function statusLabel(pass) {
  return pass ? "PASS" : "MISSING";
}

function formatName(name) {
  return name
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, str => str.toUpperCase());
}

console.log("\n" + "=".repeat(80));
console.log("UBUME CAPABILITY AUDIT REPORT");
console.log("=".repeat(80));
console.log(`Repository: ${repoRoot}\n`);

const results = [];

for (const [name, checkFn] of Object.entries(checks)) {
  const result = checkFn();
  results.push({ name, ...result });
  
  const symbol = statusSymbol(result.pass);
  const status = statusLabel(result.pass);
  const formattedName = formatName(name);
  
  console.log(`${symbol} ${status.padEnd(8)} | ${formattedName}`);
  console.log(`           ${result.reason}`);
  if (result.evidence.length > 0) {
    console.log(`           Evidence: ${result.evidence.map(e => e.replace(repoRoot, ".")).join(", ")}`);
  }
  console.log();
}

const total = results.length;
const passed = results.filter(r => r.pass).length;
const missing = total - passed;
const pctComplete = Math.round((passed / total) * 100);

console.log("=".repeat(80));
console.log("CAPABILITY SUMMARY");
console.log("=".repeat(80));
console.log(`Total checks:        ${total}`);
console.log(`Passed:              ${passed} (${pctComplete}%)`);
console.log(`Missing/Partial:     ${missing} (${100 - pctComplete}%)`);
console.log();

const missingFeatures = results.filter(r => !r.pass).map(r => formatName(r.name));

if (missingFeatures.length > 0) {
  console.log("TOP MISSING FEATURES:");
  missingFeatures.forEach((f, i) => {
    console.log(`  ${i + 1}. ${f}`);
  });
  console.log();
}

console.log("=".repeat(80));
console.log();

process.exit(passed === total ? 0 : 1);
