import "./legacyEnvBootstrap.js";
import { parseHeadlessExecArgs } from "./headless/execArgs.js";
import {
  createHeadlessExecTiming,
  HEADLESS_EXEC_PARSE_ERROR,
  runHeadlessExec,
} from "./headless/execRunner.js";

export function printExecHelp(): void {
  console.log(`Usage:
  ubume exec "prompt"
  ubume exec --prompt "prompt"
  ubume exec [--profile <name>] [-c key=value] "prompt"
  ubume exec --model gpt-5.4-mini --reasoning medium "Reply with exactly: UBUME_READY"

Options:
      --prompt <text>     Prompt to submit in headless mode.
      --reasoning <effort>
                          Reasoning effort: none, minimal, low, medium, high, xhigh.
      --benchmark-diagnostics
                          Alias for --timing.
      --timing            Print optional ubume exec phase timing to stderr.
      --ubume-prompt-policy <raw|wrapped>
                          Prompt policy for exec mode. Defaults to raw.
      --skip-git-repo-check
                          Forward --skip-git-repo-check to codex exec.
      --profile <name>    Load a Codex profile from config.
  -m, --model <name>      Select the Codex model for this launch.
  -c, --config <key=val>  Override a runtime config value.
  -h, --help              Show this help text and exit.
`);
}

const isMainModule = Boolean((import.meta as ImportMeta & { main?: boolean }).main);

if (isMainModule) {
  const argv = process.argv.slice(2);
  const timing = createHeadlessExecTiming({
    enabled: process.env.UBUME_EXEC_TIMING === "1"
      || argv.includes("--timing")
      || argv.includes("--benchmark-diagnostics"),
    stderr: process.stderr,
    startTimeMs: Number(process.env.UBUME_EXEC_TIMING_EPOCH_MS) || undefined,
  });
  timing.mark("ubume_exec_process_start", { pid: process.pid });

  const parsed = parseHeadlessExecArgs(argv);
  if (!parsed.ok) {
    console.error(`[ubume exec] parse: ${parsed.error}`);
    timing.mark("ubume_exec_process_exit", { exit_code: HEADLESS_EXEC_PARSE_ERROR });
    process.exit(HEADLESS_EXEC_PARSE_ERROR);
  }

  timing.mark("args_parsed", {
    prompt_character_count: parsed.value.prompt.length,
    prompt_policy: parsed.value.promptPolicy,
  });

  if (parsed.value.help) {
    printExecHelp();
    timing.mark("ubume_exec_process_exit", { exit_code: 0 });
    process.exit(0);
  }

  const result = await runHeadlessExec({
    prompt: parsed.value.prompt,
    launchArgs: parsed.value.launchArgs,
    promptPolicy: parsed.value.promptPolicy,
    benchmarkDiagnostics: (parsed.value.timing || process.env.UBUME_EXEC_TIMING === "1") ? timing : undefined,
  });
  timing.mark("ubume_exec_process_exit", { exit_code: result.exitCode });
  process.exit(result.exitCode);
}
