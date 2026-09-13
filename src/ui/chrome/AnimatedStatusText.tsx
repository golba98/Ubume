import React, { useEffect, useState } from "react";
import { Text } from "ink";
import * as renderDebug from "../../core/perf/renderDebug.js";
import { useTheme } from "../theme.js";
import { sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";
import { BUSY_STATUS_FRAME_MS, BUSY_STATUS_FRAMES, getBusyStatusFrame } from "./busyStatusAnimation.js";

interface AnimatedStatusTextProps {
  baseText: string;
  isActive: boolean;
  isError?: boolean;
  animationFrame?: string;
}

function useLocalBusyStatusFrame(isActive: boolean, label: string): string {
  const [frameIndex, setFrameIndex] = useState(0);
  const staticStatus = process.env.UBUME_DEBUG_STATIC_STATUS === "1";

  useEffect(() => {
    if (!isActive || staticStatus) {
      setFrameIndex(0);
      return;
    }

    setFrameIndex(0);
    const timer = setInterval(() => {
      setFrameIndex((current) => {
        const next = current + 1;
        renderDebug.traceStatusTick({ owner: "Status", label, frameIndex: next });
        return next;
      });
    }, BUSY_STATUS_FRAME_MS);
    timer.unref?.();

    return () => {
      clearInterval(timer);
    };
  }, [isActive, label, staticStatus]);

  if (isActive && staticStatus) {
    return BUSY_STATUS_FRAMES[BUSY_STATUS_FRAMES.length - 1]!;
  }
  return getBusyStatusFrame(frameIndex);
}

export function AnimatedStatusText({ baseText, isActive, isError = false, animationFrame }: AnimatedStatusTextProps) {
  const localFrame = useLocalBusyStatusFrame(isActive, baseText);
  renderDebug.useRenderDebug("Status", {
    baseText,
    isActive,
    isError,
    animationFrame: animationFrame ?? localFrame,
  });
  renderDebug.useLifecycleDebug("Status", {
    baseText,
    isActive,
    isError,
  });

  const theme = useTheme();
  const renderedText = sanitizeTerminalOutput(baseText);
  const suffix = isActive ? animationFrame ?? localFrame : "";

  return (
    <Text color={isError ? theme.error : theme.info} wrap="truncate">
      {renderedText}{suffix}
    </Text>
  );
}
