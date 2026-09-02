import React, { memo, useEffect, useMemo, useRef } from "react";
import { Box, Static, Text } from "ink";
import type { RuntimeSummary } from "../../config/runtimeConfig.js";
import type { CodexAuthState } from "../../core/auth/codexAuth.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import type { TimelineEvent, UIState } from "../../session/types.js";
import {
  buildActiveRenderItems,
  buildIntroRenderItem,
  buildStaticRenderItems,
  buildTimelineItems,
  TimelineRowView,
} from "./Timeline.js";
import { buildNativeTranscriptParts, type NativeTranscriptRowItem, type TimelineRow } from "./timelineMeasure.js";
import { LIVE_WINDOW_SAFETY_ROWS, windowLiveRows } from "./liveViewportWindow.js";
import { buildStaticTranscript, createStaticTranscriptCache, type StaticTranscriptCache } from "./staticTranscriptCache.js";
import { getShellHeight, getShellWidth, resolveStartupHeaderMode, type TerminalViewport } from "../layout.js";
import { LOGO_COMPACT, LOGO_COMPACT_MIN_COLS, LOGO_LARGE, LOGO_MEDIUM, selectLogoVariant } from "../render/logoVariants.js";
import { useTheme } from "../theme.js";

export interface TranscriptShellProps {
  layout: TerminalViewport;
  authState: CodexAuthState;
  workspaceLabel: string;
  workspaceRoot?: string | null;
  runtimeSummary?: RuntimeSummary | null;
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  uiState: UIState;
  composer: React.ReactNode;
  composerRows?: number;
  notice?: string | null;
  verboseMode?: boolean;
  clearCount?: number;
  repaintGeneration?: number;
  visible?: boolean;
}

function isTranscriptEvent(event: TimelineEvent): boolean {
  return event.type === "user" || event.type === "assistant" || event.type === "run" || event.type === "shell";
}

export function isHomeScreenState({
  staticEvents,
  activeEvents,
  uiState,
}: {
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  uiState: UIState;
}): boolean {
  return uiState.kind === "IDLE"
    && !staticEvents.some(isTranscriptEvent)
    && !activeEvents.some(isTranscriptEvent);
}

function getLogoVariantName(rows: readonly string[]): "large" | "medium" | "compact" | "wordmark" | "none" {
  if (rows.length === 0) return process.env["CODEXA_NO_ASCII_LOGO"] === "1" ? "none" : "wordmark";
  if (rows === LOGO_LARGE || rows.join("\n") === LOGO_LARGE.join("\n")) return "large";
  if (rows === LOGO_MEDIUM || rows.join("\n") === LOGO_MEDIUM.join("\n")) return "medium";
  if (rows === LOGO_COMPACT || rows.join("\n") === LOGO_COMPACT.join("\n")) return "compact";
  return "wordmark";
}

function getLogoHiddenReason({
  startupHeaderMode,
  logoVariant,
  width,
}: {
  startupHeaderMode: ReturnType<typeof resolveStartupHeaderMode>;
  logoVariant: ReturnType<typeof getLogoVariantName>;
  width: number;
}): string | null {
  if (startupHeaderMode === "tiny") return "terminal-too-small";
  if (process.env["CODEXA_NO_ASCII_LOGO"] === "1") return "CODEXA_NO_ASCII_LOGO";
  if (logoVariant === "wordmark") return `no-ascii-variant-fits-width-${width}`;
  if (logoVariant === "none") return `no-logo-variant-fits-width-${width}`;
  return null;
}

function TranscriptShellInner({
  layout,
  authState,
  workspaceLabel,
  workspaceRoot = null,
  runtimeSummary = null,
  staticEvents,
  activeEvents,
  uiState,
  composer,
  composerRows,
  notice = null,
  verboseMode = false,
  clearCount = 0,
  visible = true,
}: TranscriptShellProps) {
  const theme = useTheme();
  const startupHeaderMode = useMemo(
    () => resolveStartupHeaderMode({
      cols: layout.cols,
      rows: layout.rows,
      introRows: 8,
      composerRows: composerRows ?? 5,
    }),
    [composerRows, layout.cols, layout.rows],
  );
  const homeScreenActive = visible && isHomeScreenState({ staticEvents, activeEvents, uiState });
  const shellWidth = getShellWidth(layout.cols);
  const introInnerWidth = Math.max(10, shellWidth - 2);
  const selectedLogoRows = startupHeaderMode === "tiny"
    ? []
    : startupHeaderMode === "large"
      ? selectLogoVariant(introInnerWidth)
      : introInnerWidth >= LOGO_COMPACT_MIN_COLS ? LOGO_COMPACT : [];
  const selectedLogoVariant = getLogoVariantName(selectedLogoRows);
  const logoHiddenReason = getLogoHiddenReason({
    startupHeaderMode,
    logoVariant: selectedLogoVariant,
    width: introInnerWidth,
  });
  const startupTraceKeyRef = useRef<string | null>(null);
  // Stable snapshot of the transcript inputs; hold the last visible one while
  // an overlay hides the shell. Identity only changes when the reducer
  // replaces one of these arrays, never on a keystroke or a stream flush.
  const liveTranscript = useMemo(
    () => ({ staticEvents, activeEvents, uiState }),
    [staticEvents, activeEvents, uiState],
  );
  const visibleTranscriptRef = useRef(liveTranscript);
  if (visible) {
    visibleTranscriptRef.current = liveTranscript;
  }
  const renderedTranscript = visibleTranscriptRef.current;
  const renderedStaticEvents = renderedTranscript.staticEvents;
  const renderedActiveEvents = renderedTranscript.activeEvents;
  const renderedUiState = renderedTranscript.uiState;
  const conversationViewportRows = Math.max(
    2,
    getShellHeight(layout.rows) - (composerRows ?? 0) - (notice ? 1 : 0),
  );

  const staticTimelineItems = useMemo(() => buildTimelineItems(renderedStaticEvents), [renderedStaticEvents]);
  const activeTimelineItems = useMemo(() => buildTimelineItems(renderedActiveEvents), [renderedActiveEvents]);
  const staticTurnIds = useMemo(
    () => staticTimelineItems.flatMap((item) => item.type === "turn" ? [item.turnId] : []),
    [staticTimelineItems],
  );
  const activeTurnIds = useMemo(
    () => activeTimelineItems.flatMap((item) => item.type === "turn" ? [item.turnId] : []),
    [activeTimelineItems],
  );
  const allTurnIds = useMemo(() => [...staticTurnIds, ...activeTurnIds], [staticTurnIds, activeTurnIds]);
  const activeTurnId = activeTurnIds[0] ?? null;

  // Static half: intro + finalized turns, built incrementally. The cache ref
  // lives in this keyed instance, so /clear and width repaints (which remount
  // the shell) start from an empty cache.
  const staticCacheRef = useRef<StaticTranscriptCache | null>(null);
  const staticTranscript = useMemo(() => {
    const cache = staticCacheRef.current ?? (staticCacheRef.current = createStaticTranscriptCache());
    return buildStaticTranscript(
      cache,
      [
        buildIntroRenderItem({
          authState,
          workspaceLabel,
          layout,
          providerLabel: runtimeSummary?.providerLabel ?? null,
          startupHeaderMode,
        }),
        ...buildStaticRenderItems(staticTimelineItems, allTurnIds, activeTurnId, null, null),
      ],
      { totalWidth: shellWidth, verboseMode, workspaceRoot },
    );
  }, [activeTurnId, allTurnIds, authState, layout, runtimeSummary?.providerLabel, shellWidth, startupHeaderMode, staticTimelineItems, verboseMode, workspaceLabel, workspaceRoot]);

  // Live half: only the running turn, rebuilt per streaming flush.
  const activeTranscript = useMemo(
    () => buildNativeTranscriptParts(
      buildActiveRenderItems(activeTimelineItems, allTurnIds, renderedUiState),
      {
        totalWidth: shellWidth,
        verboseMode,
        debugLabel: "transcript-shell-native",
        workspaceRoot,
      },
    ),
    [activeTimelineItems, allTurnIds, renderedUiState, shellWidth, verboseMode, workspaceRoot],
  );

  const nativeTranscript = useMemo(() => ({
    staticItems: [...staticTranscript.staticItems, ...activeTranscript.staticItems],
    liveRows: [...staticTranscript.liveRows, ...activeTranscript.liveRows],
  }), [activeTranscript, staticTranscript]);
  const committedRows = useMemo(
    () => nativeTranscript.staticItems.reduce((total, item) => total + item.rows.length, 0),
    [nativeTranscript.staticItems],
  );
  // The whole running turn is measured live (see appendNativeTurnParts), but
  // only its tail is rendered: Ink clears the terminal *and scrollback* on any
  // frame whose live output exceeds the viewport, which yanks a user who
  // scrolled up back to the bottom on every streaming tick. The full turn is
  // committed to <Static> at finalize, so nothing is lost from scrollback.
  const liveWindowRows = Math.max(1, conversationViewportRows - LIVE_WINDOW_SAFETY_ROWS);
  const visibleLiveRows = useMemo(
    () => windowLiveRows(nativeTranscript.liveRows, liveWindowRows),
    [liveWindowRows, nativeTranscript.liveRows],
  );
  const liveRowsHidden = nativeTranscript.liveRows.length - visibleLiveRows.length;
  const spacerRows = Math.max(0, conversationViewportRows - committedRows - visibleLiveRows.length);

  useEffect(() => {
    const nextKey = [
      layout.cols,
      layout.rows,
      layout.mode,
      startupHeaderMode,
      homeScreenActive ? "home" : "transcript",
      staticEvents.length,
      activeEvents.length,
      uiState.kind,
      selectedLogoVariant,
      clearCount,
    ].join("|");
    if (startupTraceKeyRef.current === nextKey) return;
    startupTraceKeyRef.current = nextKey;
    renderDebug.traceEvent("startup", "homeRender", {
      cols: layout.cols,
      rows: layout.rows,
      layoutMode: layout.mode,
      activeRoot: "TranscriptShell",
      messageCount: [...staticEvents, ...activeEvents].filter(isTranscriptEvent).length,
      staticEventsLength: staticEvents.length,
      activeEventsLength: activeEvents.length,
      uiStateKind: uiState.kind,
      selectedLayoutMode: startupHeaderMode,
      selectedLogoVariant,
      logoBranchSelected: selectedLogoVariant !== "none" && selectedLogoVariant !== "wordmark",
      logoHiddenReason,
      composerCount: visible ? 1 : 0,
      footerCount: visible ? 1 : 0,
      homeScreenRendererUsed: homeScreenActive,
      staticItemCount: staticEvents.length,
      liveRowCount: activeEvents.length,
      liveRowsHidden,
      clearCount,
    });
  }, [
    activeEvents,
    clearCount,
    homeScreenActive,
    layout.cols,
    layout.mode,
    layout.rows,
    liveRowsHidden,
    logoHiddenReason,
    selectedLogoVariant,
    startupHeaderMode,
    staticEvents,
    uiState.kind,
    visible,
  ]);

  return (
    <Box flexDirection="column" width="100%" display={visible ? "flex" : "none"}>
      <Static key={`native-static-${clearCount}`} items={nativeTranscript.staticItems}>
        {(item: NativeTranscriptRowItem) => <NativeRowsItem key={item.key} rows={item.rows} />}
      </Static>
      {spacerRows > 0 && <Box height={spacerRows} />}
      <NativeRowsItem rows={visibleLiveRows} />

      {visible && notice && (
        <Box width="100%" paddingX={1}>
          <Text color={theme.success} wrap="truncate">{notice}</Text>
        </Box>
      )}
      {visible && composer}
    </Box>
  );
}

export const TranscriptShell = memo(function TranscriptShell(props: TranscriptShellProps) {
  // repaintGeneration must fold into the outer remount key (not just <Static>'s
  // own key) — Ink only reliably re-flushes already-printed <Static> content on
  // a genuine fresh mount of the whole subtree, confirmed empirically: keying
  // away only the inner <Static> node did not trigger Ink's isStaticDirty/
  // onImmediateRender escape hatch the same way a full remount does.
  return (
    <TranscriptShellInner
      key={`clear-${props.clearCount ?? 0}-repaint-${props.repaintGeneration ?? 0}`}
      {...props}
    />
  );
});

function NativeRowsItem({ rows }: { rows: TimelineRow[] }) {
  return (
    <Box flexDirection="column">
      {rows.map((row) => <TimelineRowView key={row.key} row={row} />)}
    </Box>
  );
}
