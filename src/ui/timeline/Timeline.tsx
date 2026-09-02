import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import {
  getRunPlanText,
  type AssistantEvent,
  type ErrorEvent,
  type RunEvent,
  type ShellEvent,
  type SystemEvent,
  type TimelineEvent,
  type UIState,
  type UserPromptEvent,
} from "../../session/types.js";
import { APP_VERSION } from "../../config/settings.js";
import { formatCodexaVersionLabel } from "../../core/version/channel.js";
import type { CodexAuthState } from "../../core/auth/codexAuth.js";
import { getAuthStateLabel } from "../../core/auth/codexAuth.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import { getShellWidth, type Layout, type StartupHeaderMode } from "../layout.js";
import type { TimelineRow, TimelineSnapshot, TimelineTone } from "./timelineMeasure.js";
import { buildStableTimelineSnapshot, buildTimelineSnapshot } from "./timelineMeasure.js";
import { resolveTurnRunPhase, type TurnOpacity, type TurnRunPhase } from "./TurnGroup.js";
import { useTheme } from "../theme.js";

// ─── Types & constants ────────────────────────────────────────────────────────

interface TimelineProps {
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  layout: Layout;
  uiState: UIState;
  viewportRows: number;
  verboseMode?: boolean;
  authState?: CodexAuthState;
  workspaceLabel?: string;
  workspaceRoot?: string | null;
  providerLabel?: string | null;
  startupHeaderMode?: StartupHeaderMode;
  showIntro?: boolean;
  contentSized?: boolean;
}

type StandaloneTimelineEvent = SystemEvent | ErrorEvent | ShellEvent;

interface TurnTimelineItem {
  type: "turn";
  turnId: number;
  turnIndex: number;
  user: UserPromptEvent | null;
  run: RunEvent | null;
  assistant: AssistantEvent | null;
}

interface EventTimelineItem {
  type: "event";
  event: StandaloneTimelineEvent;
}

export type TimelineItem = TurnTimelineItem | EventTimelineItem;

export interface TurnRenderState {
  opacity: TurnOpacity;
  question: string | null;
  runPhase: TurnRunPhase;
}

interface TurnRenderTimelineItem {
  key: string;
  type: "turn";
  padded: boolean;
  item: TurnTimelineItem;
  renderState: TurnRenderState;
}

interface EventRenderTimelineItem {
  key: string;
  type: "event";
  padded: boolean;
  event: StandaloneTimelineEvent;
}

export interface IntroRenderTimelineItem {
  key: string;
  type: "intro";
  padded: boolean;
  intro: {
    version: string;
    layoutMode: Layout["mode"];
    startupHeaderMode?: StartupHeaderMode;
    authLabel: string;
    workspaceLabel: string;
    providerLabel?: string | null;
  };
}

export type RenderTimelineItem = IntroRenderTimelineItem | TurnRenderTimelineItem | EventRenderTimelineItem;

// Re-enter follow-tail mode when the user scrolls within this many rows of the
// tail, preventing a "stuck just above bottom" state after a near-end wheel scroll.
const NEAR_BOTTOM_THRESHOLD = 3;
const STABLE_RENDER_ENABLED = process.env.CODEXA_STABLE_RENDER !== "0";

export interface TimelineViewportState {
  anchorRow: number;
  followTail: boolean;
  unseenItems: number;
  unseenRows: number;
  frozenSnapshot: TimelineSnapshot | null;
}

interface FinalizeContinuityOptions {
  previousTotalRows: number;
  viewportRows: number;
}

// ─── Viewport helpers ────────────────────────────────────────────────────────

function isStandaloneEvent(event: TimelineEvent): event is StandaloneTimelineEvent {
  return event.type === "system" || event.type === "error" || event.type === "shell";
}

function getActiveTurnId(uiState: UIState): number | null {
  return uiState.kind === "THINKING"
    || uiState.kind === "RESPONDING"
    || uiState.kind === "ANSWER_VISIBLE"
    || uiState.kind === "AWAITING_USER_ACTION"
    || uiState.kind === "ERROR"
    ? uiState.turnId
    : null;
}

function isBusyUiState(uiState: UIState): boolean {
  return uiState.kind === "THINKING"
    || uiState.kind === "RESPONDING"
    || uiState.kind === "ANSWER_VISIBLE"
    || uiState.kind === "SHELL_RUNNING";
}

function getRunningTurnIds(events: TimelineEvent[]): number[] {
  return events
    .filter((event): event is RunEvent => event.type === "run" && event.status === "running")
    .map((event) => event.turnId);
}

function getFinalizedTurnIds(events: TimelineEvent[]): number[] {
  return events
    .filter((event): event is RunEvent => event.type === "run" && event.status !== "running")
    .map((event) => event.turnId);
}

function latestFinalizedRunEndsWithPlan(events: TimelineEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "run" || event.status === "running") {
      continue;
    }

    const lastStreamItem = (event.streamItems ?? [])
      .slice()
      .sort((left, right) => left.streamSeq - right.streamSeq)
      .at(-1);
    return lastStreamItem?.kind === "plan"
      && event.plan?.status === "completed"
      && getRunPlanText(event.plan).trim().length > 0;
  }

  return false;
}

function hasFinalizeTransition(params: {
  previousRunningTurnIds: number[];
  nextRunningTurnIds: number[];
  nextFinalizedTurnIds: number[];
  previousBusy: boolean;
  nextBusy: boolean;
}): boolean {
  if (!params.previousBusy || params.nextBusy) return false;
  return params.previousRunningTurnIds.some((turnId) =>
    !params.nextRunningTurnIds.includes(turnId)
    && params.nextFinalizedTurnIds.includes(turnId)
  );
}

function clampAnchorRow(anchorRow: number, totalRows: number): number {
  if (totalRows <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(anchorRow, totalRows - 1));
}

export function isNearBottom(anchorRow: number, totalRows: number): boolean {
  return totalRows <= 0 || anchorRow >= totalRows - 1 - NEAR_BOTTOM_THRESHOLD;
}

function getFirstPageAnchor(totalRows: number, viewportRows: number): number {
  if (totalRows <= 0) {
    return 0;
  }
  return Math.min(totalRows - 1, Math.max(0, viewportRows - 1));
}

// ─── Timeline item builders ───────────────────────────────────────────────────

export function buildTimelineItems(events: TimelineEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const turns = new Map<number, TurnTimelineItem>();
  let nextTurnIndex = 1;

  for (const event of events) {
    if (isStandaloneEvent(event)) {
      items.push({ type: "event", event });
      continue;
    }

    const turnId = event.turnId;
    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        type: "turn",
        turnId,
        turnIndex: nextTurnIndex++,
        user: null,
        run: null,
        assistant: null,
      };
      turns.set(turnId, turn);
      items.push(turn);
    }

    if (event.type === "user") {
      turn.user = event;
    } else if (event.type === "run") {
      turn.run = event;
    } else if (event.type === "assistant") {
      turn.assistant = event;
    }
  }

  return items.filter((item) => item.type === "event" || item.user !== null);
}

export type TurnOpacityResolver = (turnId: number, activeTurnId: number | null) => TurnOpacity;

/**
 * Build a resolver once per render pass so resolving every turn's opacity is
 * O(turns) instead of O(turns²) (two indexOf scans per turn). Semantics match
 * resolveTurnOpacity exactly, including the "absent id → index -1" behaviour.
 */
export function createTurnOpacityResolver(turnIds: number[]): TurnOpacityResolver {
  const indexById = new Map<number, number>();
  turnIds.forEach((id, index) => indexById.set(id, index));
  const lastTurnId = turnIds[turnIds.length - 1];
  return (turnId, activeTurnId) => {
    if (turnIds.length === 0) return "dim";
    if (activeTurnId === null) {
      return turnId === lastTurnId ? "recent" : "dim";
    }
    const activeIndex = indexById.get(activeTurnId) ?? -1;
    const currentIndex = indexById.get(turnId) ?? -1;
    if (currentIndex === activeIndex) return "active";
    if (currentIndex === activeIndex - 1) return "recent";
    return "dim";
  };
}

export function resolveTurnOpacity(turnIds: number[], turnId: number, activeTurnId: number | null): TurnOpacity {
  return createTurnOpacityResolver(turnIds)(turnId, activeTurnId);
}

export function createFollowTailViewport(totalRows: number): TimelineViewportState {
  return {
    anchorRow: Math.max(0, totalRows - 1),
    followTail: true,
    unseenItems: 0,
    unseenRows: 0,
    frozenSnapshot: null,
  };
}

function createAnchoredViewport(snapshot: TimelineSnapshot, anchorRow: number): TimelineViewportState {
  return {
    anchorRow: clampAnchorRow(anchorRow, snapshot.totalRows),
    followTail: false,
    unseenItems: 0,
    unseenRows: 0,
    frozenSnapshot: snapshot,
  };
}

function findFinalResponseStartRow(snapshot: TimelineSnapshot, previousTotalRows: number, viewportRows: number): number | null {
  const searchFloor = Math.max(0, previousTotalRows - Math.max(1, viewportRows));
  const responseIndex = snapshot.rows.findIndex((row, index) =>
    index >= searchFloor && row.key.includes("-codex-response-")
  );
  return responseIndex >= 0 ? responseIndex : null;
}

export function createFinalizeContinuityViewport(
  snapshot: TimelineSnapshot,
  options: FinalizeContinuityOptions,
): TimelineViewportState {
  if (snapshot.totalRows === 0) {
    return createFollowTailViewport(0);
  }

  const responseStartRow = findFinalResponseStartRow(
    snapshot,
    options.previousTotalRows,
    options.viewportRows,
  );
  const answerPreviewRows = Math.min(3, Math.max(1, Math.floor(options.viewportRows / 4)));
  const fallbackAnchor = options.previousTotalRows + answerPreviewRows - 1;
  const anchorRow = responseStartRow === null
    ? fallbackAnchor
    : responseStartRow + answerPreviewRows - 1;

  return createAnchoredViewport(snapshot, Math.min(snapshot.totalRows - 1, Math.max(0, anchorRow)));
}

// ─── Viewport operations ─────────────────────────────────────────────────────

function getFrozenSnapshot(
  viewport: TimelineViewportState,
  liveSnapshot: TimelineSnapshot,
): TimelineSnapshot {
  return viewport.followTail || viewport.frozenSnapshot === null
    ? liveSnapshot
    : viewport.frozenSnapshot;
}

export function syncTimelineViewport(
  viewport: TimelineViewportState,
  liveSnapshot: TimelineSnapshot,
  options: { finalizeContinuity?: FinalizeContinuityOptions } = {},
): TimelineViewportState {
  if (liveSnapshot.totalRows === 0) {
    // Preserve a frozen scroll offset through a transient empty-snapshot moment so
    // the user's reading position is not reset to row 0.  Only reset when the
    // viewport is already in follow-tail mode (there is nothing meaningful to preserve).
    return viewport.followTail ? createFollowTailViewport(0) : viewport;
  }

  if (viewport.followTail) {
    if (options.finalizeContinuity) {
      return createFinalizeContinuityViewport(liveSnapshot, options.finalizeContinuity);
    }

    const nextAnchor = liveSnapshot.totalRows - 1;
    if (
      viewport.anchorRow === nextAnchor
      && viewport.unseenItems === 0
      && viewport.unseenRows === 0
      && viewport.frozenSnapshot === null
    ) {
      return viewport;
    }
    return createFollowTailViewport(liveSnapshot.totalRows);
  }

  const frozenSnapshot = viewport.frozenSnapshot ?? liveSnapshot;
  const anchorRow = clampAnchorRow(viewport.anchorRow, frozenSnapshot.totalRows);
  const unseenItems = Math.max(0, liveSnapshot.itemCount - frozenSnapshot.itemCount);
  const unseenRows = Math.max(0, liveSnapshot.totalRows - frozenSnapshot.totalRows);

  if (
    viewport.anchorRow === anchorRow
    && viewport.unseenItems === unseenItems
    && viewport.unseenRows === unseenRows
    && viewport.frozenSnapshot === frozenSnapshot
  ) {
    return viewport;
  }

  return {
    anchorRow,
    followTail: false,
    unseenItems,
    unseenRows,
    frozenSnapshot,
  };
}

/**
 * Returns the item index and row-within-item for the given absolute anchorRow
 * inside a snapshot.  Used by reflowTimelineViewport to translate a row-based
 * anchor into a layout-independent (item, offset) anchor.
 */
export function findAnchorItem(
  snapshot: TimelineSnapshot,
  anchorRow: number,
): { itemIndex: number; rowWithinItem: number } {
  let rowOffset = 0;
  for (let i = 0; i < snapshot.items.length; i++) {
    const item = snapshot.items[i]!;
    if (rowOffset + item.rowCount > anchorRow) {
      return { itemIndex: i, rowWithinItem: anchorRow - rowOffset };
    }
    rowOffset += item.rowCount;
  }
  // anchorRow is at or beyond the last item – clamp to end
  const lastIdx = Math.max(0, snapshot.items.length - 1);
  const lastItem = snapshot.items[lastIdx];
  return {
    itemIndex: lastIdx,
    rowWithinItem: lastItem ? Math.max(0, lastItem.rowCount - 1) : 0,
  };
}

/**
 * Rebuilds the frozen viewport snapshot after a terminal width change.
 *
 * When the terminal is resized (width changes), all snapshot memos are
 * rebuilt at the new snapshotWidth, so liveSnapshot already contains
 * correctly reflowed rows.  However syncTimelineViewport preserves the
 * old frozenSnapshot (with old-width rows), causing visual corruption.
 *
 * This function replaces the stale frozen snapshot with a new one built
 * from the same items as before (liveSnapshot.items[0..frozenItemCount]),
 * now correctly wrapped at the new width.  The anchorRow is translated
 * from the old layout via an item-level anchor so the user's reading
 * position is preserved across reflow.
 */
export function reflowTimelineViewport(
  viewport: TimelineViewportState,
  liveSnapshot: TimelineSnapshot,
): TimelineViewportState {
  if (liveSnapshot.totalRows === 0) {
    return createFollowTailViewport(0);
  }

  if (viewport.followTail) {
    return createFollowTailViewport(liveSnapshot.totalRows);
  }

  const oldFrozen = viewport.frozenSnapshot ?? liveSnapshot;

  // Translate anchorRow → stable (item, rowWithinItem) anchor
  const clampedAnchor = clampAnchorRow(viewport.anchorRow, oldFrozen.totalRows);
  const { itemIndex: anchorItemIdx, rowWithinItem: anchorRowWithinItem } =
    findAnchorItem(oldFrozen, clampedAnchor);

  // Grab the same items from liveSnapshot (already reflowed at new width)
  const frozenItemCount = oldFrozen.itemCount;
  const newFrozenItems = liveSnapshot.items.slice(0, frozenItemCount);

  if (newFrozenItems.length === 0) {
    return createFollowTailViewport(liveSnapshot.totalRows);
  }

  // Assemble a new frozen snapshot from the reflowed items
  const newFrozenRows = newFrozenItems.flatMap((item) => item.rows);
  const newFrozenSnapshot: TimelineSnapshot = {
    items: newFrozenItems,
    rows: newFrozenRows,
    totalRows: newFrozenRows.length,
    itemCount: frozenItemCount,
  };

  // Reconstruct anchorRow in the new layout
  let newAnchorRow = 0;
  for (let i = 0; i < anchorItemIdx; i++) {
    newAnchorRow += newFrozenItems[i]!.rowCount;
  }
  const targetItem = newFrozenItems[anchorItemIdx];
  if (targetItem) {
    newAnchorRow += Math.min(anchorRowWithinItem, targetItem.rowCount - 1);
  } else {
    // Anchor item is beyond the new frozen range (unseen) – clamp to end
    newAnchorRow = Math.max(0, newFrozenSnapshot.totalRows - 1);
  }
  newAnchorRow = clampAnchorRow(newAnchorRow, newFrozenSnapshot.totalRows);

  const unseenItems = Math.max(0, liveSnapshot.itemCount - frozenItemCount);
  const unseenRows = Math.max(0, liveSnapshot.totalRows - newFrozenSnapshot.totalRows);

  return {
    anchorRow: newAnchorRow,
    followTail: false,
    unseenItems,
    unseenRows,
    frozenSnapshot: newFrozenSnapshot,
  };
}

export function pageUpTimelineViewport(
  viewport: TimelineViewportState,
  liveSnapshot: TimelineSnapshot,
  viewportRows: number,
): TimelineViewportState {
  if (liveSnapshot.totalRows === 0) {
    return createFollowTailViewport(0);
  }

  const frozenSnapshot = getFrozenSnapshot(viewport, liveSnapshot);
  const tailRow = Math.max(0, frozenSnapshot.totalRows - 1);
  const currentAnchor = viewport.followTail
    ? tailRow
    : clampAnchorRow(viewport.anchorRow, frozenSnapshot.totalRows);
  const nextAnchor = Math.max(getFirstPageAnchor(frozenSnapshot.totalRows, viewportRows), currentAnchor - Math.max(1, viewportRows));

  return {
    anchorRow: nextAnchor,
    followTail: false,
    unseenItems: Math.max(0, liveSnapshot.itemCount - frozenSnapshot.itemCount),
    unseenRows: Math.max(0, liveSnapshot.totalRows - frozenSnapshot.totalRows),
    frozenSnapshot,
  };
}

export function pageDownTimelineViewport(
  viewport: TimelineViewportState,
  liveSnapshot: TimelineSnapshot,
  viewportRows: number,
): TimelineViewportState {
  if (liveSnapshot.totalRows === 0 || viewport.followTail) {
    return viewport;
  }

  const frozenSnapshot = viewport.frozenSnapshot ?? liveSnapshot;
  const tailRow = Math.max(0, frozenSnapshot.totalRows - 1);
  const currentAnchor = clampAnchorRow(viewport.anchorRow, frozenSnapshot.totalRows);
  if (currentAnchor >= tailRow) {
    return createFollowTailViewport(liveSnapshot.totalRows);
  }

  const nextAnchor = Math.min(tailRow, currentAnchor + Math.max(1, viewportRows));
  if (nextAnchor >= tailRow) {
    return createFollowTailViewport(liveSnapshot.totalRows);
  }

  return {
    anchorRow: nextAnchor,
    followTail: false,
    unseenItems: Math.max(0, liveSnapshot.itemCount - frozenSnapshot.itemCount),
    unseenRows: Math.max(0, liveSnapshot.totalRows - frozenSnapshot.totalRows),
    frozenSnapshot,
  };
}

export function halfPageUpTimelineViewport(
  viewport: TimelineViewportState,
  liveSnapshot: TimelineSnapshot,
  viewportRows: number,
): TimelineViewportState {
  if (liveSnapshot.totalRows === 0) {
    return createFollowTailViewport(0);
  }

  const frozenSnapshot = getFrozenSnapshot(viewport, liveSnapshot);
  const tailRow = Math.max(0, frozenSnapshot.totalRows - 1);
  const currentAnchor = viewport.followTail
    ? tailRow
    : clampAnchorRow(viewport.anchorRow, frozenSnapshot.totalRows);
  const halfPage = Math.max(1, Math.floor(viewportRows / 2));
  const nextAnchor = Math.max(getFirstPageAnchor(frozenSnapshot.totalRows, viewportRows), currentAnchor - halfPage);

  return {
    anchorRow: nextAnchor,
    followTail: false,
    unseenItems: Math.max(0, liveSnapshot.itemCount - frozenSnapshot.itemCount),
    unseenRows: Math.max(0, liveSnapshot.totalRows - frozenSnapshot.totalRows),
    frozenSnapshot,
  };
}

export function halfPageDownTimelineViewport(
  viewport: TimelineViewportState,
  liveSnapshot: TimelineSnapshot,
  viewportRows: number,
): TimelineViewportState {
  if (liveSnapshot.totalRows === 0 || viewport.followTail) {
    return viewport;
  }

  const frozenSnapshot = viewport.frozenSnapshot ?? liveSnapshot;
  const tailRow = Math.max(0, frozenSnapshot.totalRows - 1);
  const currentAnchor = clampAnchorRow(viewport.anchorRow, frozenSnapshot.totalRows);
  if (currentAnchor >= tailRow) {
    return createFollowTailViewport(liveSnapshot.totalRows);
  }

  const halfPage = Math.max(1, Math.floor(viewportRows / 2));
  const nextAnchor = Math.min(tailRow, currentAnchor + halfPage);
  if (nextAnchor >= tailRow) {
    return createFollowTailViewport(liveSnapshot.totalRows);
  }

  return {
    anchorRow: nextAnchor,
    followTail: false,
    unseenItems: Math.max(0, liveSnapshot.itemCount - frozenSnapshot.itemCount),
    unseenRows: Math.max(0, liveSnapshot.totalRows - frozenSnapshot.totalRows),
    frozenSnapshot,
  };
}

export function stepUpTimelineViewport(
  viewport: TimelineViewportState,
  liveSnapshot: TimelineSnapshot,
  viewportRows: number,
): TimelineViewportState {
  if (liveSnapshot.totalRows === 0) {
    return createFollowTailViewport(0);
  }

  const frozenSnapshot = getFrozenSnapshot(viewport, liveSnapshot);
  const tailRow = Math.max(0, frozenSnapshot.totalRows - 1);
  const currentAnchor = viewport.followTail
    ? tailRow
    : clampAnchorRow(viewport.anchorRow, frozenSnapshot.totalRows);
  const floor = getFirstPageAnchor(frozenSnapshot.totalRows, viewportRows);

  return {
    anchorRow: Math.max(floor, currentAnchor - 1),
    followTail: false,
    unseenItems: Math.max(0, liveSnapshot.itemCount - frozenSnapshot.itemCount),
    unseenRows: Math.max(0, liveSnapshot.totalRows - frozenSnapshot.totalRows),
    frozenSnapshot,
  };
}

export function stepDownTimelineViewport(
  viewport: TimelineViewportState,
  liveSnapshot: TimelineSnapshot,
  _viewportRows?: number,
): TimelineViewportState {
  if (liveSnapshot.totalRows === 0 || viewport.followTail) {
    return viewport;
  }

  const frozenSnapshot = viewport.frozenSnapshot ?? liveSnapshot;
  const tailRow = Math.max(0, frozenSnapshot.totalRows - 1);
  const currentAnchor = clampAnchorRow(viewport.anchorRow, frozenSnapshot.totalRows);
  if (currentAnchor >= tailRow) {
    return createFollowTailViewport(liveSnapshot.totalRows);
  }

  const nextAnchor = Math.min(tailRow, currentAnchor + 1);
  if (nextAnchor >= tailRow) {
    return createFollowTailViewport(liveSnapshot.totalRows);
  }

  return {
    anchorRow: nextAnchor,
    followTail: false,
    unseenItems: Math.max(0, liveSnapshot.itemCount - frozenSnapshot.itemCount),
    unseenRows: Math.max(0, liveSnapshot.totalRows - frozenSnapshot.totalRows),
    frozenSnapshot,
  };
}

export function scrollTimelineViewport(
  viewport: TimelineViewportState,
  liveSnapshot: TimelineSnapshot,
  viewportRows: number,
  deltaRows: number,
): TimelineViewportState {
  if (liveSnapshot.totalRows === 0) {
    return createFollowTailViewport(0);
  }
  if (deltaRows === 0) {
    return viewport;
  }

  const frozenSnapshot = getFrozenSnapshot(viewport, liveSnapshot);
  const tailRow = Math.max(0, frozenSnapshot.totalRows - 1);

  if (deltaRows > 0 && viewport.followTail) {
    return viewport;
  }

  const currentAnchor = viewport.followTail
    ? tailRow
    : clampAnchorRow(viewport.anchorRow, frozenSnapshot.totalRows);

  const floor = getFirstPageAnchor(frozenSnapshot.totalRows, viewportRows);

  let nextAnchor = currentAnchor + deltaRows;

  if (nextAnchor >= tailRow) {
    return createFollowTailViewport(liveSnapshot.totalRows);
  }

  if (nextAnchor < floor) {
    nextAnchor = floor;
  }

  return {
    anchorRow: nextAnchor,
    followTail: false,
    unseenItems: Math.max(0, liveSnapshot.itemCount - frozenSnapshot.itemCount),
    unseenRows: Math.max(0, liveSnapshot.totalRows - frozenSnapshot.totalRows),
    frozenSnapshot,
  };
}

export function homeTimelineViewport(
  viewport: TimelineViewportState,
  liveSnapshot: TimelineSnapshot,
  viewportRows: number,
): TimelineViewportState {
  if (liveSnapshot.totalRows === 0) {
    return createFollowTailViewport(0);
  }

  const frozenSnapshot = getFrozenSnapshot(viewport, liveSnapshot);
  return {
    anchorRow: getFirstPageAnchor(frozenSnapshot.totalRows, viewportRows),
    followTail: false,
    unseenItems: Math.max(0, liveSnapshot.itemCount - frozenSnapshot.itemCount),
    unseenRows: Math.max(0, liveSnapshot.totalRows - frozenSnapshot.totalRows),
    frozenSnapshot,
  };
}

export function endTimelineViewport(totalRows: number): TimelineViewportState {
  return createFollowTailViewport(totalRows);
}

// ─── Row selection & render items ────────────────────────────────────────────

export function selectTimelineRows(
  liveSnapshot: TimelineSnapshot,
  viewport: TimelineViewportState,
  viewportRows: number,
): {
  sourceSnapshot: TimelineSnapshot;
  visibleRows: TimelineRow[];
  window: {
    startRow: number;
    endRow: number;
    anchorRow: number;
  };
} {
  const sourceSnapshot = viewport.followTail || viewport.frozenSnapshot === null
    ? liveSnapshot
    : viewport.frozenSnapshot;
  const safeViewportRows = Math.max(1, viewportRows);

  if (sourceSnapshot.totalRows === 0) {
    return {
      sourceSnapshot,
      visibleRows: [],
      window: { startRow: 0, endRow: 0, anchorRow: 0 },
    };
  }

  const anchorRow = viewport.followTail
    ? sourceSnapshot.totalRows - 1
    : clampAnchorRow(viewport.anchorRow, sourceSnapshot.totalRows);
  const endRow = Math.max(1, anchorRow + 1);
  const startRow = Math.max(0, endRow - safeViewportRows);

  const visibleRows = sourceSnapshot.rows.slice(startRow, endRow);

  // Aggressive fallback: if slicing returned nothing but we have rows,
  // return at least the last row to avoid a blank screen.
  if (visibleRows.length === 0 && sourceSnapshot.totalRows > 0) {
    const fallbackRow = sourceSnapshot.rows[sourceSnapshot.totalRows - 1]!;
    return {
      sourceSnapshot,
      visibleRows: [fallbackRow],
      window: {
        startRow: sourceSnapshot.totalRows - 1,
        endRow: sourceSnapshot.totalRows,
        anchorRow: sourceSnapshot.totalRows - 1,
      },
    };
  }

  return {
    sourceSnapshot,
    visibleRows,
    window: {
      startRow,
      endRow,
      anchorRow,
    },
  };
}

export function buildStaticRenderItems(
  items: TimelineItem[],
  turnIds: number[],
  activeTurnId: number | null,
  questionTurnId: number | null,
  question: string | null,
): RenderTimelineItem[] {
  const resolveOpacity = createTurnOpacityResolver(turnIds);
  return items.map((item) => {
    if (item.type === "event") {
      return {
        key: `event-${item.event.id}`,
        type: "event",
        padded: false,
        event: item.event,
      };
    }

    return {
      key: `turn-${item.turnId}`,
      type: "turn",
      padded: false,
      item,
      renderState: {
        opacity: resolveOpacity(item.turnId, activeTurnId),
        question: questionTurnId === item.turnId ? question : null,
        runPhase: resolveTurnRunPhase(item.run, item.assistant, { kind: "IDLE" }, item.turnId),
      },
    };
  });
}

export function buildActiveRenderItems(
  items: TimelineItem[],
  turnIds: number[],
  uiState: UIState,
): RenderTimelineItem[] {
  const activeTurnId = getActiveTurnId(uiState);
  const questionTurnId = uiState.kind === "AWAITING_USER_ACTION" ? uiState.turnId : null;
  const question = uiState.kind === "AWAITING_USER_ACTION" ? uiState.question : null;
  const resolveOpacity = createTurnOpacityResolver(turnIds);

  return items.map((item) => {
    if (item.type === "event") {
      return {
        key: `event-${item.event.id}`,
        type: "event",
        padded: true,
        event: item.event,
      };
    }

    return {
      key: `turn-${item.turnId}`,
      type: "turn",
      padded: false,
      item,
      renderState: {
        opacity: resolveOpacity(item.turnId, activeTurnId),
        question: questionTurnId === item.turnId ? question : null,
        runPhase: resolveTurnRunPhase(item.run, item.assistant, uiState, item.turnId),
      },
    };
  });
}

function formatAuthLabel(authState: CodexAuthState): string {
  const raw = getAuthStateLabel(authState);
  return raw.length > 0 ? raw[0]!.toUpperCase() + raw.slice(1) : raw;
}

export function buildIntroRenderItem(params: {
  authState: CodexAuthState;
  workspaceLabel: string;
  layout: Layout;
  startupHeaderMode?: StartupHeaderMode;
  providerLabel?: string | null;
}): IntroRenderTimelineItem {
  return {
    key: "codexa-intro",
    type: "intro",
    padded: true,
    intro: {
      version: formatCodexaVersionLabel(APP_VERSION),
      layoutMode: params.layout.mode,
      startupHeaderMode: params.startupHeaderMode,
      authLabel: formatAuthLabel(params.authState),
      workspaceLabel: params.workspaceLabel,
      providerLabel: params.providerLabel ?? null,
    },
  };
}

// ─── Row rendering ────────────────────────────────────────────────────────────

function getToneColor(theme: ReturnType<typeof useTheme>, tone: TimelineTone | undefined): string | undefined {
  switch (tone) {
    case "text": return theme.text;
    case "dim": return theme.textDim;
    case "muted": return theme.textMuted;
    case "accent": return theme.accent;
    case "info": return theme.info;
    case "error": return theme.error;
    case "warning": return theme.warning;
    case "success": return theme.success;
    case "borderSubtle": return theme.border;
    case "borderActive": return theme.borderFocused;
    case "panel": return theme.surface;
    case "star": return theme.warning;
    case "logoPrimary": return theme.logoPrimary;
    case "logoSecondary": return theme.logoSecondary;
    case "logoShadow": return theme.logoShadow;
    default: return undefined;
  }
}

export const TimelineRowView = memo(function TimelineRowView({ row }: { row: TimelineRow }) {
  const isActionRow = row.key.includes("-action-");
  renderDebug.useRenderDebug("TimelineRow", {
    rowKey: row.key,
    row,
  });
  if (isActionRow) {
    renderDebug.traceFlickerEvent("timelineRowRender", {
      rowKey: row.key,
      spanToken: row.spans.map((span) => span.text).join("|"),
    });
  }

  useEffect(() => {
    if (!isActionRow) return;
    renderDebug.traceFlickerEvent("timelineRowMount", { rowKey: row.key });
    renderDebug.traceLifecycleEvent("ActionRow", "mount", { rowKey: row.key });
    renderDebug.traceLifecycleEvent("ActionBlock", "mount", { rowKey: row.key });
    return () => {
      renderDebug.traceFlickerEvent("timelineRowUnmount", { rowKey: row.key });
      renderDebug.traceLifecycleEvent("ActionRow", "unmount", { rowKey: row.key });
      renderDebug.traceLifecycleEvent("ActionBlock", "unmount", { rowKey: row.key });
    };
  }, [isActionRow, row.key]);

  const theme = useTheme();

  return (
    <Box width="100%" overflow="hidden">
      <Text>
        {row.spans.map((span, index) => (
          <Text
            key={index}
            color={getToneColor(theme, span.tone)}
            backgroundColor={getToneColor(theme, span.backgroundTone)}
            bold={span.bold}
          >
            {span.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
}, (prev, next) => prev.row === next.row);

function rowArraysEqual(left: TimelineRow[], right: TimelineRow[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

const TimelineRowsView = memo(function TimelineRowsView({ rows }: { rows: TimelineRow[] }) {
  return (
    <>
      {rows.map((row) => (
        <TimelineRowView key={row.key} row={row} />
      ))}
    </>
  );
}, (prev, next) => rowArraysEqual(prev.rows, next.rows));

// ─── Component ────────────────────────────────────────────────────────────────

export const Timeline = memo(function Timeline({
  staticEvents,
  activeEvents,
  layout,
  uiState,
  viewportRows,
  verboseMode = false,
  authState = "checking",
  workspaceLabel = "",
  workspaceRoot = null,
  providerLabel = null,
  startupHeaderMode,
  showIntro = true,
  contentSized = false,
}: TimelineProps) {
  renderDebug.useRenderDebug("Timeline", {
    staticEvents,
    activeEvents,
    staticEventsLength: staticEvents.length,
    activeEventsLength: activeEvents.length,
    cols: layout.cols,
    rows: layout.rows,
    mode: layout.mode,
    uiStateKind: uiState.kind,
    viewportRows,
    verboseMode,
    authState,
    workspaceLabel,
    workspaceRoot,
  });
  renderDebug.useLifecycleDebug("Timeline", {
    cols: layout.cols,
    rows: layout.rows,
    mode: layout.mode,
    viewportRows,
  });
  renderDebug.traceLayoutValidity("Timeline", {
    cols: layout.cols,
    rows: layout.rows,
    viewportRows,
  });
  renderDebug.useFlickerDebug("timelineRender", {
    staticEvents,
    activeEvents,
    staticEventsLength: staticEvents.length,
    activeEventsLength: activeEvents.length,
    cols: layout.cols,
    rows: layout.rows,
    mode: layout.mode,
    uiStateKind: uiState.kind,
    viewportRows,
    verboseMode,
    authState,
    workspaceLabel,
  });
  renderDebug.useRenderDebug("Transcript", {
    staticEvents,
    activeEvents,
    staticEventsLength: staticEvents.length,
    activeEventsLength: activeEvents.length,
    cols: layout.cols,
    rows: layout.rows,
    mode: layout.mode,
    uiStateKind: uiState.kind,
    viewportRows,
    verboseMode,
    workspaceRoot,
  });

  const theme = useTheme();

  const staticItems = useMemo(() => buildTimelineItems(staticEvents), [staticEvents]);
  const activeItems = useMemo(() => buildTimelineItems(activeEvents), [activeEvents]);
  const activeTurnId = getActiveTurnId(uiState);
  const runningTurnIds = useMemo(() => getRunningTurnIds(activeEvents), [activeEvents]);
  const finalizedTurnIds = useMemo(() => getFinalizedTurnIds(staticEvents), [staticEvents]);
  const finalizedPlanAtTail = useMemo(() => latestFinalizedRunEndsWithPlan(staticEvents), [staticEvents]);
  const finalizeTransitionRef = useRef<{
    runningTurnIds: number[];
    finalizedTurnIds: number[];
    busy: boolean;
  }>({
    runningTurnIds,
    finalizedTurnIds,
    busy: isBusyUiState(uiState),
  });
  const finalizeTransition = hasFinalizeTransition({
    previousRunningTurnIds: finalizeTransitionRef.current.runningTurnIds,
    nextRunningTurnIds: runningTurnIds,
    nextFinalizedTurnIds: finalizedTurnIds,
    previousBusy: finalizeTransitionRef.current.busy,
    nextBusy: isBusyUiState(uiState),
  });
  const questionTurnId = uiState.kind === "AWAITING_USER_ACTION" ? uiState.turnId : null;
  const question = uiState.kind === "AWAITING_USER_ACTION" ? uiState.question : null;
  const staticTurnIds = useMemo(
    () => staticItems.filter((item): item is TurnTimelineItem => item.type === "turn").map((item) => item.turnId),
    [staticItems],
  );
  const activeTurnIds = useMemo(
    () => activeItems.filter((item): item is TurnTimelineItem => item.type === "turn").map((item) => item.turnId),
    [activeItems],
  );
  const allTurnIds = useMemo(
    () => [...staticTurnIds, ...activeTurnIds],
    [activeTurnIds, staticTurnIds],
  );
  const staticRenderItems = useMemo(
    () => [
      ...(showIntro ? [buildIntroRenderItem({
        authState,
        workspaceLabel,
        layout,
        providerLabel,
        startupHeaderMode,
      })] : []),
      ...buildStaticRenderItems(staticItems, allTurnIds, activeTurnId, questionTurnId, question),
    ],
    [activeTurnId, allTurnIds, authState, layout, providerLabel, question, questionTurnId, showIntro, startupHeaderMode, staticItems, workspaceLabel],
  );
  const activeRenderItems = useMemo(
    () => buildActiveRenderItems(activeItems, allTurnIds, uiState),
    [activeItems, allTurnIds, uiState],
  );
  // ── Split snapshot building ──────────────────────────────────────────────
  // During streaming, activeEvents change every frame but staticEvents stay
  // the same.  We further split the active items into "stable" (user prompt,
  // run header — don't change during streaming) and "streaming" (assistant
  // content — changes every frame).  This gives us three cached tiers so only
  // the streaming assistant item is rebuilt each frame.
  const snapshotWidth = Math.max(10, getShellWidth(layout.cols) - 1);
  const staticSnapshot = useMemo(
    () => buildTimelineSnapshot(staticRenderItems, { totalWidth: snapshotWidth, verboseMode, debugLabel: "static", workspaceRoot }),
    [snapshotWidth, staticRenderItems, verboseMode, workspaceRoot],
  );
  // Partition active items: non-assistant items are stable during streaming
  const isStreaming = uiState.kind === "RESPONDING";
  const activeStableItems = useMemo(
    () => isStreaming
      ? activeRenderItems.filter((item) => !(item.type === "turn" && item.item.assistant))
      : [],
    [activeRenderItems, isStreaming],
  );
  const activeStreamingItems = useMemo(
    () => isStreaming
      ? activeRenderItems.filter((item) => item.type === "turn" && item.item.assistant)
      : activeRenderItems,
    [activeRenderItems, isStreaming],
  );
  const activeStableSnapshot = useMemo(
    () => STABLE_RENDER_ENABLED
      ? { items: [], rows: [], totalRows: 0, itemCount: 0 }
      : activeStableItems.length > 0
      ? buildTimelineSnapshot(activeStableItems, { totalWidth: snapshotWidth, verboseMode, debugLabel: "active-stable", workspaceRoot })
      : { items: [], rows: [], totalRows: 0, itemCount: 0 },
    [snapshotWidth, activeStableItems, verboseMode, workspaceRoot],
  );
  const activeStreamingSnapshot = useMemo(
    () => STABLE_RENDER_ENABLED
      ? { items: [], rows: [], totalRows: 0, itemCount: 0 }
      : buildTimelineSnapshot(activeStreamingItems, { totalWidth: snapshotWidth, verboseMode, debugLabel: "active-streaming", workspaceRoot }),
    [snapshotWidth, activeStreamingItems, verboseMode, workspaceRoot],
  );
  const stableActiveSnapshot = useMemo(
    () => STABLE_RENDER_ENABLED
      ? buildStableTimelineSnapshot(activeRenderItems, { totalWidth: snapshotWidth, verboseMode, debugLabel: "active-stable-render", workspaceRoot })
      : null,
    [snapshotWidth, activeRenderItems, verboseMode, workspaceRoot],
  );
  const liveSnapshot = useMemo(
    () => {
      if (stableActiveSnapshot) {
        return {
          items: [...staticSnapshot.items, ...stableActiveSnapshot.snapshot.items],
          rows: [...staticSnapshot.rows, ...stableActiveSnapshot.snapshot.rows],
          totalRows: staticSnapshot.totalRows + stableActiveSnapshot.snapshot.totalRows,
          itemCount: staticSnapshot.itemCount + stableActiveSnapshot.snapshot.itemCount,
        };
      }

      return {
        items: [...staticSnapshot.items, ...activeStableSnapshot.items, ...activeStreamingSnapshot.items],
        rows: [...staticSnapshot.rows, ...activeStableSnapshot.rows, ...activeStreamingSnapshot.rows],
        totalRows: staticSnapshot.totalRows + activeStableSnapshot.totalRows + activeStreamingSnapshot.totalRows,
        itemCount: staticSnapshot.itemCount + activeStableSnapshot.itemCount + activeStreamingSnapshot.itemCount,
      };
    },
    [staticSnapshot, stableActiveSnapshot, activeStableSnapshot, activeStreamingSnapshot],
  );

  const lastNonEmptySnapshotRef = useRef<TimelineSnapshot>(liveSnapshot);
  if (liveSnapshot.totalRows > 0) {
    lastNonEmptySnapshotRef.current = liveSnapshot;
  }

  const isBusy = uiState.kind === "THINKING"
    || uiState.kind === "RESPONDING"
    || uiState.kind === "ANSWER_VISIBLE"
    || uiState.kind === "SHELL_RUNNING";

  const transcriptEventCount = staticEvents.length + activeEvents.length;

  const effectiveSnapshot = useMemo(() => {
    // If we have events but the live snapshot is empty, fallback to the last
    // known good snapshot to avoid blanking the screen during transitions.
    if (liveSnapshot.totalRows === 0 && transcriptEventCount > 0 && lastNonEmptySnapshotRef.current.totalRows > 0) {
      renderDebug.traceFlickerEvent("snapshotFallback", {
        reason: "empty-while-busy-with-events",
        uiStateKind: uiState.kind,
        previousTotalRows: lastNonEmptySnapshotRef.current.totalRows,
        transcriptEventCount,
      });
      return lastNonEmptySnapshotRef.current;
    }
    return liveSnapshot;
  }, [liveSnapshot, transcriptEventCount, uiState.kind]);
  const snapshotForViewport = effectiveSnapshot;

  const [viewport, setViewport] = useState<TimelineViewportState>(() => createFollowTailViewport(snapshotForViewport.totalRows));
  // Tracks the previous snapshotWidth so we can detect width changes inside
  // the liveSnapshot effect and dispatch reflowTimelineViewport instead of
  // syncTimelineViewport when the terminal has been resized.
  const snapshotWidthRef = useRef(snapshotWidth);
  // Tracks previous totalRows so we can skip setViewport when no new rows
  // arrived — avoiding a second React render / Ink stdout write per streaming
  // flush when the viewport already reflects the correct state.
  const prevTotalRowsRef = useRef(effectiveSnapshot.totalRows);
  useEffect(() => {
    const widthChanged = snapshotWidthRef.current !== snapshotWidth;
    snapshotWidthRef.current = snapshotWidth;

    const totalRows = snapshotForViewport.totalRows;
    const previousTotalRows = prevTotalRowsRef.current;
    const rowGrowth = totalRows - previousTotalRows;
    const totalRowsGrew = rowGrowth > 0;
    prevTotalRowsRef.current = totalRows;

    setViewport((current) => {
      // Width change: always reflow or sync to wrap text at the new width.
      if (widthChanged) {
        const next = !current.followTail && current.frozenSnapshot !== null
          ? reflowTimelineViewport(current, snapshotForViewport)
          : syncTimelineViewport(current, snapshotForViewport);
        renderDebug.traceFlickerEvent("viewportSync", {
          reason: "width-change",
          result: next === current ? "skipped" : "updated",
          previousTotalRows,
          totalRows,
          rowGrowth,
          previousAnchorRow: current.anchorRow,
          anchorRow: next.anchorRow,
          followTail: next.followTail,
          viewportRows,
        });
        return next;
      }

      // Frozen (user scrolled up): keep the frozen snapshot fresh when rows
      // grow or the stream finalizes so the unseen-item counters and
      // jump-to-bottom affordance stay accurate.
      if (!current.followTail) {
        const next = totalRowsGrew || finalizeTransition
          ? syncTimelineViewport(current, snapshotForViewport)
          : current;
        renderDebug.traceFlickerEvent("viewportSync", {
          reason: finalizeTransition
            ? (totalRowsGrew ? "detached-finalize-growth" : "detached-finalize")
            : (totalRowsGrew ? "detached-growth" : "detached-no-growth"),
          result: next === current ? "skipped" : "updated",
          previousTotalRows,
          totalRows,
          rowGrowth,
          previousAnchorRow: current.anchorRow,
          anchorRow: next.anchorRow,
          followTail: next.followTail,
          viewportRows,
        });
        return next;
      }

      // Follow-tail: only advance anchorRow when content actually grew.
      // Streaming is append-only so shrinking rows is rare; if it happens the
      // anchorRow stays at the old position until the next growth tick.
      if (!totalRowsGrew) {
        renderDebug.traceFlickerEvent("viewportSync", {
          reason: "follow-tail-no-growth",
          result: "skipped",
          previousTotalRows,
          totalRows,
          rowGrowth,
          previousAnchorRow: current.anchorRow,
          anchorRow: current.anchorRow,
          followTail: current.followTail,
          viewportRows,
        });
        return current;
      }

      const useFinalizeContinuity = finalizeTransition
        && !finalizedPlanAtTail
        && rowGrowth > Math.max(1, Math.floor(viewportRows / 2));
      const next = syncTimelineViewport(current, snapshotForViewport, {
        finalizeContinuity: useFinalizeContinuity
          ? { previousTotalRows, viewportRows }
          : undefined,
      });
      renderDebug.traceFlickerEvent("viewportSync", {
        reason: useFinalizeContinuity ? "finalize-continuity" : "follow-tail-growth",
        result: next === current ? "skipped" : "updated",
        previousTotalRows,
        totalRows,
        rowGrowth,
        previousAnchorRow: current.anchorRow,
        anchorRow: next.anchorRow,
        followTail: next.followTail,
        viewportRows,
      });
      return next;
    });
  }, [finalizeTransition, finalizedPlanAtTail, snapshotForViewport, snapshotWidth, viewportRows]);

  useEffect(() => {
    finalizeTransitionRef.current = {
      runningTurnIds,
      finalizedTurnIds,
      busy: isBusyUiState(uiState),
    };
  }, [finalizedTurnIds, runningTurnIds, uiState]);

  const userPromptCount = useMemo(() => {
    return [...staticEvents, ...activeEvents].filter((event) => event.type === "user").length;
  }, [activeEvents, staticEvents]);

  const prevUserPromptCountRef = useRef(userPromptCount);

  useEffect(() => {
    if (userPromptCount > prevUserPromptCountRef.current) {
      setViewport(createFollowTailViewport(snapshotForViewport.totalRows));
    }
    prevUserPromptCountRef.current = userPromptCount;
  }, [userPromptCount, snapshotForViewport.totalRows]);

  const { visibleRows } = useMemo(() => {
    const selection = selectTimelineRows(snapshotForViewport, viewport, viewportRows);
    renderDebug.traceEvent("viewport", "slice", {
      providerState: uiState.kind,
      visibleRows: selection.visibleRows.length,
      visibleStart: selection.window.startRow,
      visibleEnd: selection.window.endRow,
      anchorRow: selection.window.anchorRow,
      maxScrollOffset: Math.max(0, selection.sourceSnapshot.totalRows - viewportRows),
      followTail: viewport.followTail,
      totalItems: selection.sourceSnapshot.itemCount,
      totalRows: selection.sourceSnapshot.totalRows,
      availableTimelineRows: viewportRows,
      sliceEmpty: selection.visibleRows.length === 0 && selection.sourceSnapshot.totalRows > 0,
      fallbackSnapshot: snapshotForViewport !== liveSnapshot,
    });
    renderDebug.traceFlickerEvent("viewportSlice", {
      visibleRows: selection.visibleRows.length,
      startRow: selection.window.startRow,
      endRow: selection.window.endRow,
      anchorRow: selection.window.anchorRow,
      followTail: viewport.followTail,
      totalRows: selection.sourceSnapshot.totalRows,
      fallbackSnapshot: snapshotForViewport !== liveSnapshot,
    });
    return selection;
  }, [snapshotForViewport, viewport, viewportRows]);
  const lastNonEmptyVisibleRowsRef = useRef<TimelineRow[]>([]);
  if (visibleRows.length > 0) {
    lastNonEmptyVisibleRowsRef.current = visibleRows;
  }
  const usingLastGoodFrameFallback = visibleRows.length === 0 && transcriptEventCount > 0;
  if (usingLastGoodFrameFallback) {
    renderDebug.traceEvent("viewport", "lastGoodFrameFallback", {
      providerState: uiState.kind,
      totalRows: liveSnapshot.totalRows,
      availableTimelineRows: viewportRows,
      preservedRows: lastNonEmptyVisibleRowsRef.current.length,
    });
  }
  const preservedVisibleRows = usingLastGoodFrameFallback
    ? lastNonEmptyVisibleRowsRef.current
    : visibleRows;

  const rowsForDisplay = preservedVisibleRows;

  if (visibleRows.length === 0) {
    renderDebug.traceBlankFrame("Timeline", {
      reason: transcriptEventCount > 0 ? "visible-rows-zero-with-events" : "visible-rows-zero-no-events",
      staticEventsLength: staticEvents.length,
      activeEventsLength: activeEvents.length,
      transcriptEventCount,
      totalRows: liveSnapshot.totalRows,
      viewportRows,
      preservedRows: preservedVisibleRows.length,
      uiStateKind: uiState.kind,
    });
  }

  if (preservedVisibleRows.length === 0) {
    renderDebug.traceBlankFrame("Timeline", {
      reason: "empty-root-layout-return",
      staticEventsLength: staticEvents.length,
      activeEventsLength: activeEvents.length,
      transcriptEventCount,
      totalRows: liveSnapshot.totalRows,
      effectiveTotalRows: snapshotForViewport.totalRows,
      viewportRows,
      uiStateKind: uiState.kind,
    });
    return <Box flexDirection="column" width="100%" height={contentSized ? undefined : Math.max(1, viewportRows)} />;
  }

  return (
    <Box
      flexDirection="column"
      width="100%"
      height={contentSized ? undefined : Math.max(1, viewportRows)}
      overflow="hidden"
    >
      <TimelineRowsView rows={rowsForDisplay} />
    </Box>
  );
}, (prev, next) => {
  return (
    prev.staticEvents === next.staticEvents &&
    prev.activeEvents === next.activeEvents &&
    prev.layout.cols === next.layout.cols &&
    prev.layout.rows === next.layout.rows &&
    prev.layout.mode === next.layout.mode &&
    prev.uiState === next.uiState &&
    prev.viewportRows === next.viewportRows &&
    prev.verboseMode === next.verboseMode &&
    prev.authState === next.authState &&
    prev.workspaceLabel === next.workspaceLabel &&
    prev.workspaceRoot === next.workspaceRoot &&
    prev.providerLabel === next.providerLabel &&
    prev.startupHeaderMode === next.startupHeaderMode &&
    prev.showIntro === next.showIntro &&
    prev.contentSized === next.contentSized
  );
});

export { Timeline as ActiveTimeline };
