import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useFocus, useInput, useStdin } from "ink";
import { useTheme } from "../theme.js";
import { getHorizontalArrowDirection, type HorizontalArrowDirection } from "../input/rawArrowKeys.js";
import { CODEXA_NPM_PACKAGE, formatVersionLabel } from "../../core/version/updateCheck.js";
import {
  formatPermissionGuidance,
  getUpdateCommand,
  isPermissionError,
  runUpdateCommand,
  type GlobalPackageManager,
} from "../../core/version/packageManager.js";
import type { CommandResult, CommandStreamHandlers } from "../../core/process/CommandRunner.js";

type Phase = "menu" | "running" | "done" | "error";

export type RunUpdateFn = (
  pm: GlobalPackageManager,
  handlers?: CommandStreamHandlers,
) => { result: Promise<CommandResult>; cancel: () => void };

const MENU_ITEMS = [
  { label: "Update now" },
  { label: "Later" },
] as const;

type HorizontalDirection = HorizontalArrowDirection;

export { getHorizontalArrowDirection };

interface UpdatePromptPanelProps {
  focusId: string;
  currentVersion: string;
  latestVersion: string;
  packageManager: GlobalPackageManager;
  /** Test seam — defaults to the real cross-platform runner. */
  runUpdate?: RunUpdateFn;
  onSkip: () => void;
  onRestart: () => void;
}

export function UpdatePromptPanel({
  focusId,
  currentVersion,
  latestVersion,
  packageManager,
  runUpdate,
  onSkip,
  onRestart,
}: UpdatePromptPanelProps) {
  const theme = useTheme();
  const { stdin } = useStdin();
  const { isFocused } = useFocus({ id: focusId, autoFocus: true });

  const [phase, setPhase] = useState<Phase>("menu");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const runStartedRef = useRef(false);
  const rawArrowRef = useRef<HorizontalDirection | null>(null);

  useEffect(() => {
    const handleRawInput = (chunk: Buffer | string) => {
      rawArrowRef.current = getHorizontalArrowDirection(
        typeof chunk === "string" ? chunk : chunk.toString(),
      );
    };
    stdin.on("data", handleRawInput);
    return () => {
      stdin.off("data", handleRawInput);
    };
  }, [stdin]);

  useInput((input, key) => {
    if (key.escape) {
      onSkip();
      return;
    }
    if (phase === "menu") {
      const rawArrow = rawArrowRef.current;
      rawArrowRef.current = null;
      if (key.leftArrow || rawArrow === "left" || input === "h") {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.rightArrow || rawArrow === "right" || input === "l") {
        setSelectedIndex((i) => Math.min(MENU_ITEMS.length - 1, i + 1));
        return;
      }
      if (key.return) {
        if (selectedIndex === 0) {
          setPhase("running");
        } else {
          onSkip();
        }
        return;
      }
    } else if (phase === "done") {
      if (key.return) {
        onRestart();
      }
    } else if (phase === "error") {
      if (key.return) {
        onSkip();
      }
    }
  }, { isActive: isFocused });

  useEffect(() => {
    if (phase !== "running") return;
    if (runStartedRef.current) return;
    runStartedRef.current = true;

    const appendLines = (text: string) => {
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length > 0) {
        setOutputLines((prev) => [...prev, ...lines]);
      }
    };

    const runner = runUpdate ?? runUpdateCommand;
    const { result, cancel } = runner(packageManager, {
      onStdout: appendLines,
      onStderr: appendLines,
    });

    let disposed = false;
    void result.then((res) => {
      if (disposed) return;
      if (res.status === "completed" && res.exitCode === 0) {
        setPhase("done");
        return;
      }
      if (isPermissionError(res)) {
        setErrorMessage(formatPermissionGuidance(packageManager));
      } else {
        setErrorMessage(res.userMessage);
      }
      setPhase("error");
    });

    return () => {
      disposed = true;
      cancel();
    };
  }, [phase, packageManager, runUpdate]);

  const footerText = phase === "menu"
    ? "←/→ to choose · Enter to confirm · Esc to close"
    : phase === "done"
      ? "Enter to restart · Esc to stay in Codexa"
    : "Esc to close";

  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <Box
        borderStyle="round"
        borderColor={theme.border}
        paddingX={2}
        paddingY={1}
        width="100%"
        flexDirection="column"
      >
        <Box>
          <Text color={theme.accent} bold>{`Update available: Codexa ${latestVersion}`}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text}>{`Current version: ${currentVersion}`}</Text>
        </Box>
        <Box>
          <Text color={theme.textMuted}>{`Package: ${CODEXA_NPM_PACKAGE}`}</Text>
        </Box>
        <Box>
          <Text color={theme.textMuted}>{`Run: ${getUpdateCommand(packageManager).displayCommand}`}</Text>
        </Box>
      </Box>

      <Box
        borderStyle="round"
        borderColor={phase === "menu" ? theme.borderFocused : theme.border}
        paddingX={2}
        paddingY={1}
        marginTop={1}
        width="100%"
        flexDirection="column"
      >
        {phase === "menu" && (
          <>
            <Box>
              {MENU_ITEMS.map((item, index) => (
                <Text
                  key={item.label}
                  color={index === selectedIndex ? theme.text : theme.textMuted}
                  bold={index === selectedIndex}
                >
                  {`${index === selectedIndex ? "❯ " : "  "}[ ${item.label} ]${index === 0 ? "  " : ""}`}
                </Text>
              ))}
            </Box>
          </>
        )}

        {phase === "running" && (
          <>
            <Text color={theme.text}>{`Installing Codexa ${latestVersion}...`}</Text>
            {outputLines.map((line, i) => (
              <Text key={i} color={theme.textMuted}>{line}</Text>
            ))}
          </>
        )}

        {phase === "done" && (
          <>
            <Text color={theme.success}>{`Codexa ${formatVersionLabel(latestVersion)} installed successfully.`}</Text>
            <Text color={theme.textMuted}>{"Restart Codexa to use the new version."}</Text>
            <Box marginTop={1}>
              <Text color={theme.text} bold>{"❯ [ Restart now ]"}</Text>
            </Box>
          </>
        )}

        {phase === "error" && (
          <>
            <Text color={theme.error}>{"Update failed."}</Text>
            {errorMessage != null && <Text color={theme.textMuted}>{errorMessage}</Text>}
            {outputLines.slice(-5).map((line, i) => (
              <Text key={i} color={theme.textDim}>{line}</Text>
            ))}
          </>
        )}

        <Box marginTop={1}>
          <Text color={theme.textDim}>{footerText}</Text>
        </Box>
      </Box>
    </Box>
  );
}
