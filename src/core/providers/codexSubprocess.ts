import { spawn } from "child_process";
import { formatCodexLaunchError, spawnCodexProcess } from "../executables/codexExecutable.js";
import { prepareCodexExecLaunch } from "../codex/codexLaunch.js";
import * as perf from "../perf/profiler.js";
import { buildCodexPrompt } from "../codex/codexPrompt.js";
import { createTerminalTitleSequenceStripper } from "../terminal/terminalTitle.js";
import { createCodexJsonStreamParser } from "./codexJsonStream.js";
import {
  createCodexTranscriptStreamParser,
  createStdoutSanitizer,
  isStderrNoise,
  sanitizeCodexTranscript,
  stripAnsi,
  stripNonPrintableControls,
} from "./codexTranscript.js";
import type { BackendProvider } from "./types.js";
import { formatConversationHistory } from "../../session/conversation.js";

// Detects CLI error messages that indicate --experimental-json is not supported.
// When this fires the provider retries in legacy transcript mode.
function looksLikeUnsupportedStructuredOutput(raw: string): boolean {
  return /experimental-json|unknown option|unrecognized option|unexpected argument|unexpected option/i.test(raw);
}

function isProcessTerminationNoise(line: string): boolean {
  return /^SUCCESS: The process with PID \d+ .* has been terminated\.$/.test(line.trim());
}

export const codexSubprocessProvider: BackendProvider = {
  id: "codex-subprocess",
  label: "Ubume",
  description: "Direct connection to the Codex neural network.",
  authState: "delegated",
  authLabel: "Authenticated via Codex",
  statusMessage: "Authentication is managed via Ubume.",
  supportsModels: () => true,
  run: (prompt, options, handlers) => {
    let done = false;
    let cancelled = false;
    let proc: ReturnType<typeof spawn> | null = null;
    let procExited = false;
    let currentRawOutput = "";
    let finalAnswerObserved = false;

    const finishError = (message: string) => {
      if (done) return;
      done = true;
      handlers.onError(message, currentRawOutput);
    };

    const finishSuccess = (response: string) => {
      if (done) return;
      done = true;
      handlers.onResponse(response);
    };

    const emitFinalAnswerObserved = (response: string) => {
      if (finalAnswerObserved) return;
      finalAnswerObserved = true;
      handlers.onFinalAnswerObserved?.(response);
    };

    const startAttempt = (structuredOutput: boolean, probeCapabilities = false) => {
      if (cancelled || done) return;
      let firstChunkSeen = false;
      let firstStderrSeen = false;
      handlers.benchmarkHooks?.onProviderPrepStart?.();
      void prepareCodexExecLaunch(
        {
          runtime: options.runtime,
          cwd: options.workspaceRoot,
          structuredOutput,
          probeCapabilities,
          imageAttachments: options.imageAttachments,
          codexCommandPath: options.runtime.codexCommandPath,
        },
        import.meta.url,
      )
        .then((launchPlan) => {
          if (cancelled || done) return;
          if (!launchPlan.ok) {
            finishError(launchPlan.error);
            return;
          }
          if (!launchPlan.executable) {
            finishError("Codex launch preparation did not return an executable.");
            return;
          }
          handlers.benchmarkHooks?.onProviderPrepComplete?.();

          let rawStdout = "";
          let rawStderr = "";
          let stdoutLineBuffer = "";
          let mode: "undecided" | "json" | "legacy" = structuredOutput ? "undecided" : "legacy";
          let legacyProgressSequence = 0;

          // Consecutive thinking lines from the transcript parser are coalesced into
          // a single progress update so the UI shows one accumulating block rather
          // than a rapid series of individual entries. The sequence resets whenever
          // an assistant delta or tool activity event breaks the run of thinking lines.
          let activeTranscriptThinkingId: string | null = null;
          let activeTranscriptThinkingText = "";

          const resetTranscriptCoalescing = () => {
            activeTranscriptThinkingId = null;
            activeTranscriptThinkingText = "";
          };

          const emitLegacyProgress = (source: "stdout" | "stderr" | "transcript", text: string) => {
            if (isProcessTerminationNoise(text)) return;
            const displayText = text.length > 80 ? `${text.slice(0, 77)}...` : text;
            handlers.onProgress?.({
              id: `${source}-${++legacyProgressSequence}`,
              source,
              text: displayText,
            });
          };

          const transcriptParser = createCodexTranscriptStreamParser({
            onThinkingLine: (line) => {
              if (activeTranscriptThinkingId === null) {
                activeTranscriptThinkingId = `transcript-thinking-${++legacyProgressSequence}`;
                activeTranscriptThinkingText = line;
              } else {
                activeTranscriptThinkingText = `${activeTranscriptThinkingText}\n${line}`;
              }
              handlers.onProgress?.({
                id: activeTranscriptThinkingId,
                source: "transcript",
                text: activeTranscriptThinkingText,
              });
            },
            onAssistantDelta: (chunk) => {
              resetTranscriptCoalescing();
              handlers.onAssistantDelta?.(chunk);
            },
            onToolActivity: (activity) => {
              resetTranscriptCoalescing();
              handlers.onToolActivity?.(activity);
            },
          });
          const transcriptStdoutSanitizer = createStdoutSanitizer();
          const transcriptStderrSanitizer = createStdoutSanitizer();
          const stdoutTitleStripper = createTerminalTitleSequenceStripper({
            source: "src/core/providers/codexSubprocess.ts:codex.stdout",
            stream: "stdout",
            origin: "codex-cli",
          });
          const stderrTitleStripper = createTerminalTitleSequenceStripper({
            source: "src/core/providers/codexSubprocess.ts:codex.stderr",
            stream: "stderr",
            origin: "codex-cli",
          });
          const jsonParser = createCodexJsonStreamParser({
            onProgress: (update) => handlers.onProgress?.(update),
            onAssistantDelta: (chunk) => handlers.onAssistantDelta?.(chunk),
            onFinalAnswerObserved: emitFinalAnswerObserved,
            onToolActivity: (activity) => handlers.onToolActivity?.(activity),
          });

          const feedTranscript = (text: string, stream: "stdout" | "stderr") => {
            const sanitizer = stream === "stdout" ? transcriptStdoutSanitizer : transcriptStderrSanitizer;
            const clean = sanitizer.process(text);
            if (clean) {
              transcriptParser.feed(clean);
            }
          };

          const switchToTranscriptFallback = () => {
            if (mode === "legacy") return;
            mode = "legacy";
            if (rawStdout) {
              feedTranscript(rawStdout, "stdout");
            }
            if (rawStderr) {
              feedTranscript(rawStderr, "stderr");
            }
            stdoutLineBuffer = "";
          };

          const processStructuredLines = (flush: boolean) => {
            while (true) {
              const newlineIndex = stdoutLineBuffer.indexOf("\n");
              if (newlineIndex === -1) {
                if (!flush) return;
                if (!stdoutLineBuffer) return;
              }

              const line = newlineIndex === -1
                ? stdoutLineBuffer
                : stdoutLineBuffer.slice(0, newlineIndex);
              stdoutLineBuffer = newlineIndex === -1 ? "" : stdoutLineBuffer.slice(newlineIndex + 1);
              const normalizedLine = line.replace(/\r$/, "");
              if (!normalizedLine.trim()) {
                continue;
              }

              const parsed = jsonParser.feedLine(normalizedLine);
              if (!parsed) {
                if (mode === "json") {
                  emitLegacyProgress("stdout", normalizedLine);
                  continue;
                }
                switchToTranscriptFallback();
                return;
              }
              mode = "json";
            }
          };

          const ingestStdoutText = (text: string) => {
            if (!text) return;
            currentRawOutput += text;
            rawStdout += text;

            if (mode === "legacy") {
              feedTranscript(text, "stdout");
              return;
            }

            stdoutLineBuffer += text;
            processStructuredLines(false);
          };

          const ingestStderrText = (text: string) => {
            if (!text) return;
            currentRawOutput += text;
            rawStderr += text;

            if (mode === "legacy") {
              feedTranscript(text, "stderr");
              return;
            }

            const lines = stripNonPrintableControls(stripAnsi(text))
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "\n")
              .split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || isStderrNoise(trimmed) || isProcessTerminationNoise(trimmed)) continue;
              emitLegacyProgress("stderr", trimmed);
            }
          };

          handlers.onProcessLifecycle?.("before-spawn");
          proc = spawnCodexProcess(launchPlan.executable, launchPlan.args, { stdio: ["pipe", "pipe", "pipe"] });
          procExited = false;
          handlers.onProcessLifecycle?.("spawned");
          handlers.benchmarkHooks?.onCodexProcessSpawned?.({
            executable: launchPlan.executable,
            argv: launchPlan.args,
          });
          perf.mark("spawn_done");

          proc.stdout?.on("data", (chunk: Buffer) => {
            if (cancelled || done) return;
            if (!firstChunkSeen) {
              firstChunkSeen = true;
              perf.mark("first_chunk");
              handlers.benchmarkHooks?.onFirstStdout?.();
            }
            perf.mark("last_chunk");
            ingestStdoutText(stdoutTitleStripper.process(chunk));
          });

          proc.stderr?.on("data", (chunk: Buffer) => {
            if (cancelled || done) return;
            if (!firstStderrSeen) {
              firstStderrSeen = true;
              handlers.benchmarkHooks?.onFirstStderr?.();
            }
            ingestStderrText(stderrTitleStripper.process(chunk));
          });

          proc.on("close", (code) => {
            procExited = true;
            handlers.onProcessLifecycle?.("exit");
            if (cancelled || done) return;
            ingestStdoutText(stdoutTitleStripper.flush());
            ingestStderrText(stderrTitleStripper.flush());
            if (!firstChunkSeen) {
              handlers.benchmarkHooks?.onFirstStdout?.(false);
            }
            if (!firstStderrSeen) {
              handlers.benchmarkHooks?.onFirstStderr?.(false);
            }

            if (mode !== "legacy") {
              processStructuredLines(true);
            }

            if (mode === "legacy") {
              const remainingStdout = transcriptStdoutSanitizer.flush();
              if (remainingStdout) transcriptParser.feed(remainingStdout);
              const remainingStderr = transcriptStderrSanitizer.flush();
              if (remainingStderr) transcriptParser.feed(remainingStderr);
              transcriptParser.flush();
            }

            handlers.benchmarkHooks?.onCodexProcessExit?.(code);

            if (
              structuredOutput
              && code !== 0
              && !jsonParser.hasStructuredEvents()
              && looksLikeUnsupportedStructuredOutput(`${rawStdout}\n${rawStderr}`)
            ) {
              currentRawOutput = "";
              startAttempt(false, true);
              return;
            }

            const structuredFailure = jsonParser.getFailureMessage();
            if (structuredFailure) {
              finishError(structuredFailure);
              return;
            }

            if (code === 0) {
              const finalResponse = mode === "json"
                ? jsonParser.getFinalResponse().trim() || sanitizeCodexTranscript(currentRawOutput)
                : sanitizeCodexTranscript(currentRawOutput);
              emitFinalAnswerObserved(finalResponse);
              finishSuccess(finalResponse);
              return;
            }

            finishError(`Process exited with code ${code}`);
          });

          proc.on("error", (err) => {
            handlers.onProcessLifecycle?.("error");
            if (cancelled || done) return;
            const errno = err as NodeJS.ErrnoException;
            finishError(formatCodexLaunchError(errno));
          });

          const promptPolicy = options.promptPolicy ?? "wrapped";
          const history = options.conversationHistory?.length
            ? `Previous conversation:\n${formatConversationHistory(options.conversationHistory)}\n\n`
            : "";
          const baseProviderPrompt = promptPolicy === "raw"
            ? prompt
            : buildCodexPrompt(prompt, options.runtime, undefined, {
                projectInstructions: options.projectInstructions,
              });
          const providerPrompt = history ? `${history}${baseProviderPrompt}` : baseProviderPrompt;
          handlers.benchmarkHooks?.onProviderPromptPrepared?.({
            policy: promptPolicy,
            characterCount: providerPrompt.length,
          });
          proc.stdin?.write(providerPrompt);
          proc.stdin?.end();
        })
        .catch((error) => {
          const errno = error as NodeJS.ErrnoException;
          finishError(formatCodexLaunchError(errno));
        });
    };

    currentRawOutput = "";
    startAttempt(true);

    return () => {
      cancelled = true;
      done = true;
      handlers.benchmarkHooks?.onCleanupStart?.();
      handlers.onProcessLifecycle?.("cleanup");
      if (!proc || procExited || proc.killed) {
        handlers.benchmarkHooks?.onCleanupComplete?.({ skipped: true });
        return;
      }
      proc.kill();
      handlers.benchmarkHooks?.onCleanupComplete?.({ skipped: false });
    };
  },
};
