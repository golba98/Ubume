import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.tsx"), "utf8");
const appShellSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ui", "chrome", "AppShell.tsx"), "utf8");
const transcriptShellSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ui", "timeline", "TranscriptShell.tsx"), "utf8");
const composerSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ui", "chrome", "BottomComposer.tsx"), "utf8");
const launcherSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "ubume.js"), "utf8");
const indexSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.tsx"), "utf8");
const layoutSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ui", "layout.ts"), "utf8");
const clearBoundarySource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "core", "terminal", "clearFrameBoundary.ts"), "utf8");

test("App does not start terminal title guards during busy rendering", () => {
  assert.doesNotMatch(appSource, /debugEventName: "busy-guard"/);
  assert.doesNotMatch(appSource, /acquireTerminalTitleGuard/);
  assert.doesNotMatch(appSource, /setInterval\(\(\) => \{[\s\S]*?refreshTerminalTitle/);
});

test("App does not write terminal title OSC sequences while Ink is active", () => {
  assert.doesNotMatch(appSource, /\\x1b\]0;UBUME/);
  assert.doesNotMatch(appSource, /\\x1b\]2;UBUME/);
});

test("App root does not own the busy status animation frame", () => {
  assert.doesNotMatch(appSource, /busyStatusFrame/);
  assert.doesNotMatch(appSource, /useBusyStatusFrame/);
  assert.doesNotMatch(appSource, /BUSY_STATUS_FRAME_MS/);
  assert.doesNotMatch(composerSource, /busyStatusFrame/);
});

test("App leaves mouse and history navigation to the native terminal", () => {
  assert.doesNotMatch(appSource, /effectiveMouseCapture|setMouseReporting\(true/);
  assert.match(transcriptShellSource, /<Static/);
  assert.doesNotMatch(transcriptShellSource, /mouseCapture|History |PageUp\/PageDown/);
});

test("Workspace display changes do not force AppShell remounts or viewport clears", () => {
  assert.doesNotMatch(appSource, /workspaceLabelEpoch/);
  assert.doesNotMatch(appSource, /workspaceDisplayChange/);
  assert.doesNotMatch(appSource, /key=\{`app-shell-\$\{sessionState\.clearCount\}-/);
});

test("TranscriptShell owns native static history while AppShell remains the overlay renderer", () => {
  assert.match(transcriptShellSource, /\bStatic\b/);
  assert.doesNotMatch(transcriptShellSource, /<Timeline\s/);
  assert.match(transcriptShellSource, /resolveStartupHeaderMode/);
  assert.match(transcriptShellSource, /providerLabel: runtimeSummary\?\.providerLabel/);
  assert.doesNotMatch(transcriptShellSource, /staticOffsetRef/);
  assert.doesNotMatch(transcriptShellSource, /clear-offset-\$\{clearCount\}/);
  assert.match(transcriptShellSource, /key=\{`clear-\$\{props\.clearCount \?\? 0\}-repaint-\$\{props\.repaintGeneration \?\? 0\}`\}/);
  assert.match(appShellSource, /MemoizedTopHeader/);
  assert.doesNotMatch(appShellSource, /import \{[^}]*Static[^}]*\} from "ink"/);
  assert.doesNotMatch(appShellSource, /<Static\b/);
});

test("App routes main chat to TranscriptShell and gates AppShell to overlays", () => {
  assert.match(appSource, /<TranscriptShell[\s\S]*visible=\{screen === "main"\}/);
  assert.match(appSource, /\{screen !== "main" && \(\s*<AppShell/);
  assert.match(appSource, /panel=\{\s*<>\s*\{screen === "backend-picker"/);
  assert.match(appSource, /screen === "provider-picker"/);
  assert.match(appSource, /screen === "model-picker"/);
});

test("Local startup discovery refreshes active context metadata without a model switch", () => {
  const capabilitiesMemo = appSource.match(
    /const activeRouteModelCapabilities = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[([^\]]+)\]\);/,
  );
  assert.ok(capabilitiesMemo, "active route capabilities memo should exist");
  assert.match(capabilitiesMemo[2] ?? "", /registryNonce/);
  assert.match(appSource, /currentModelRawMetadataKey/);
});

test("Update prompt owns the visible update notice so the header card is not duplicated", () => {
  assert.match(
    appSource,
    /screen !== "update-prompt" && updateCheckResult\?\.status === "update-available"/,
  );
  assert.match(appSource, /screen === "update-prompt"[\s\S]*?<UpdatePromptPanel/);
});

test("startup update overlay defers TranscriptShell's first Static mount until main is visible", () => {
  assert.match(appSource, /const transcriptHasMountedRef = useRef\(screen === "main"\)/);
  assert.match(appSource, /const shouldMountTranscript = screen === "main" \|\| transcriptHasMountedRef\.current/);
  assert.match(appSource, /\{shouldMountTranscript && \(\s*<TranscriptShell/);
  assert.match(appSource, /if \(screen === "main"\) \{\s*transcriptHasMountedRef\.current = true/);
  assert.doesNotMatch(appSource, /returnFromUpdateOverlay[\s\S]*?clearViewport/);
});

test("startup update checks run before the composer can accept input", () => {
  assert.match(appSource, /Check npm on every interactive startup before enabling the composer/);
  assert.doesNotMatch(appSource, /isCacheValid\(cache, ucSettings\.intervalHours/);
  assert.match(appSource, /startupUpdateEnabled\.current \? "update-prompt" : "main"/);
  assert.match(appSource, /initialUpdateCheckResult/);
  assert.doesNotMatch(appSource, /startupUpdateDismissed \|\| busy \|\| screen !== "main"/);
  assert.match(appSource, /handleSkipUpdateForSession[\s\S]*?setScreen\("main"\)/);
  assert.match(appSource, /isCacheForRunningVersion\(cache, APP_VERSION\)/);
  assert.doesNotMatch(appSource, /updateOverlay:viewportClear/);
});

test("Startup provider migration notice is seeded before the first composer frame", () => {
  assert.match(appSource, /function createStartupStaticEvents/);
  assert.doesNotMatch(appSource, /createLaunchModeEvent|buildDevLaunchNotice/);
  assert.match(appSource, /createProviderMigrationNoticeEvent\(providerWorkspaceConfig\.migrationNotice\)/);
  assert.match(appSource, /useAppSessionState\(\(\) => \{\s*return createStartupStaticEvents\(/);
  assert.match(
    appSource,
    /providerMigrationNoticeShownRef = useRef\(Boolean\(initialProviderWorkspaceConfig\.current\.migrationNotice\)\)/,
  );
  assert.doesNotMatch(appSource, /appendSystemEvent\(\s*"Provider migrated"/);
});

test("TranscriptShell never keeps its composer mounted while hidden behind an overlay", () => {
  // Both TranscriptShell and AppShell are handed the same composer element
  // (app.tsx passes composerElement into both). TranscriptShell only toggles
  // display:none when hidden, so if it kept rendering {composer} unconditionally,
  // a second live BottomComposer instance (with the same useFocus id) would exist
  // alongside AppShell's overlay composer whenever a picker/panel is open —
  // causing duplicate keystroke handling and focus corruption. It must render the
  // composer only while visible so the instance actually unmounts.
  assert.match(transcriptShellSource, /\{visible && composer\}/);
  assert.doesNotMatch(transcriptShellSource, /\n\s*\{composer\}\s*\n/);
});

test("TranscriptShell commits history natively and keeps only mutable rows live", () => {
  assert.match(transcriptShellSource, /buildNativeTranscriptParts/);
  assert.match(transcriptShellSource, /<Static\b/);
  assert.match(transcriptShellSource, /nativeTranscript\.liveRows/);
  assert.doesNotMatch(transcriptShellSource, /<Timeline\s|mouseCapture|History /);
  assert.doesNotMatch(transcriptShellSource, /clearTranscript|clearViewport|resetInkOutputForFreshFrame/);
});

test("/clear and conversation resume drop the timeline row caches", () => {
  const clearBody = appSource.match(/const handleClear = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[/);
  assert.ok(clearBody, "handleClear should exist");
  assert.match(clearBody[1]!, /resetTimelineMeasureCaches\(\)/);
  const resumeBody = appSource.match(/const resumeConversation = useCallback\(\(id: string\) => \{([\s\S]*?)\n  \}, \[/);
  assert.ok(resumeBody, "resumeConversation should exist");
  assert.match(resumeBody[1]!, /resetTimelineMeasureCaches\(\)/);
});

test("Settings panel workspace display save path does not append Settings transcript events", () => {
  const match = appSource.match(/const saveSettingsFromPanel = useCallback\(\(nextSettings: UserSettingValues\) => \{([\s\S]*?)\n  \}, \[/);
  assert.ok(match, "saveSettingsFromPanel callback should exist");
  assert.doesNotMatch(match[1] ?? "", /appendSystemEvent\("Settings"/);
});

test("Settings panel terminal title save path updates only persisted title state", () => {
  assert.match(appSource, /if \(nextSettings\.terminalTitleMode !== terminalTitleMode\) \{\s*setTerminalTitleMode\(nextSettings\.terminalTitleMode\);/);
  assert.doesNotMatch(appSource, /setIntendedTerminalTitle\(terminalTitleLabel/);
  assert.doesNotMatch(appSource, /refreshTerminalTitle\(/);
});

test("App does not reassert terminal titles from live UI state", () => {
  assert.doesNotMatch(appSource, /debugEventName: "busy-start"/);
  assert.doesNotMatch(appSource, /debugEventName: "busy-end"/);
  assert.doesNotMatch(appSource, /terminal-title-label-change/);
});

test("Index owns a single startup terminal title write before Ink renders", () => {
  const writes = indexSource.match(/setIntendedTerminalTitle\(/g) ?? [];
  assert.equal(writes.length, 1);
  assert.match(indexSource, /reason: "startup-title"/);
  assert.doesNotMatch(indexSource, /startTerminalTitleStartupGuard/);
  assert.doesNotMatch(indexSource, /reassertIntendedTerminalTitle/);
});

test("Prompt and shell busy paths do not write titles before state dispatch", () => {
  assert.doesNotMatch(appSource, /writeCurrentTerminalTitleBeforeStateChange/);
  assert.match(appSource, /type: "SUBMIT_PROMPT_RUN"/);
  assert.match(appSource, /dispatchSession\(\{ type: "UI_ACTION", action: \{ type: "SHELL_STARTED"/);
});

test("Terminal title cold-start retries are not mounted inside App", () => {
  assert.doesNotMatch(appSource, /beginColdStartSequence/);
  assert.doesNotMatch(appSource, /postMountTerminalTitleRefreshRef/);
  assert.doesNotMatch(appSource, /retryDelaysMs/);
});

test("App has no live terminal title write helper calls", () => {
  assert.doesNotMatch(appSource, /reassertTerminalTitle/);
  assert.doesNotMatch(appSource, /setIntendedTerminalTitle/);
  assert.doesNotMatch(appSource, /reassertIntendedTerminalTitle/);
  assert.doesNotMatch(appSource, /deriveTerminalTitle\(workspaceRoot, terminalTitleMode\)/);
});

test("App does not reassert titles around child process lifecycle events", () => {
  assert.doesNotMatch(appSource, /codex-process-\$\{event\}/);
  assert.doesNotMatch(appSource, /shell-process-\$\{event\}/);
});

test("Installed launcher preserves inherited stdio for interactive TTY launches", () => {
  assert.match(launcherSource, /const parentHasTTY = parentStdinIsTTY && parentStdoutIsTTY/);
  assert.match(launcherSource, /if \(!isHeadlessMode && parentHasTTY\)/);
  assert.match(launcherSource, /parentHasTTY\s*\?\s*\["inherit", "inherit", "inherit"\]/);
  assert.match(launcherSource, /UBUME_DEBUG_LAUNCH/);
});

test("Installed launcher does not own terminal titles for interactive TTY launches", () => {
  const launchStartIndex = launcherSource.indexOf('markExecTiming("launcher_start"');
  const helpIndex = launcherSource.indexOf('hasFlag(forwardArgs, "--help", "-h")');

  assert.ok(launchStartIndex >= 0);
  assert.ok(helpIndex > launchStartIndex);
  assert.match(launcherSource, /UBUME_INITIAL_TERMINAL_TITLE: intendedTerminalTitle/);
  assert.doesNotMatch(launcherSource, /writeIntendedTitle/);
  assert.doesNotMatch(launcherSource, /startLauncherTitleGuard/);
  assert.doesNotMatch(launcherSource, /createTitleStripper/);
  assert.match(launcherSource, /process\.stdout\.write\(chunk\)/);
  assert.match(launcherSource, /process\.stderr\.write\(chunk\)/);
  assert.match(launcherSource, /\/\^\[a-zA-Z\]:\[\\\\\/\]\//);
  assert.doesNotMatch(launcherSource, /intendedTerminalTitle\s*=\s*workspaceRoot/);
});

test("/clear resolves the live Ink instance behind stdout and memoizes it", () => {
  assert.match(appSource, /const inkInstance = useMemo\(\(\) => resolveInkRenderInstance\(stdout\), \[stdout\]\)/);
  assert.match(appSource, /import \{ resolveInkRenderInstance, resetInkOutputForFreshFrame \} from "\.\/core\/terminal\/inkRenderReset\.js"/);
  assert.match(appSource, /import \{ createClearFrameBoundaryController \} from "\.\/core\/terminal\/clearFrameBoundary\.js"/);
});

test("/clear arms a fresh render generation before transcript reset", () => {
  const armMatch = appSource.match(/const armTranscriptReplacement = useCallback\(\(source: string\) => \{([\s\S]*?)\n  \}, \[/);
  assert.ok(armMatch, "shared transcript-replacement arming should exist");
  assert.ok((armMatch[1] ?? "").includes("beginClearGeneration(clearGeneration)"), "arming should begin a clear generation");
  const handleClearMatch = appSource.match(/const handleClear = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[/);
  assert.ok(handleClearMatch, "handleClear callback should exist");
  const body = handleClearMatch[1] ?? "";
  const armBoundaryIndex = body.indexOf('armTranscriptReplacement("src/app.tsx:handleClear")');
  const seedEventsIndex = body.indexOf("createStartupStaticEvents({");
  const resetToHomeIndex = body.indexOf("resetToHomeScreen(createStartupStaticEvents({");
  const finishIndex = body.indexOf("replacement.finish()");
  assert.ok(armBoundaryIndex >= 0, "handleClear should arm clear-generation boundary");
  assert.ok(seedEventsIndex >= 0, "handleClear should create fresh home-screen seed events");
  assert.ok(resetToHomeIndex >= 0, "handleClear should reset through the shared home-screen path");
  assert.ok(armBoundaryIndex < resetToHomeIndex, "clear generation should be armed before transcript reset");
  assert.ok(finishIndex > resetToHomeIndex, "the fallback check runs after the transcript reset");
  assert.match(appSource, /const resetToHomeScreen = useCallback/);
  assert.match(appSource, /type: "CLEAR_TRANSCRIPT",\s*seedEvents/s, "home reset should seed the transcript reset");
  assert.match(appSource, /focusManager\.focus\(FOCUS_IDS\.composer\)/, "clear should return focus to the prompt");
});

test("/resume arms the clear boundary before swapping the transcript so the logo is not printed twice", () => {
  const resumeMatch = appSource.match(/const resumeConversation = useCallback\(\(id: string\) => \{([\s\S]*?)\n  \}, \[/);
  assert.ok(resumeMatch, "resumeConversation callback should exist");
  const body = resumeMatch[1] ?? "";
  const armIndex = body.indexOf('armTranscriptReplacement("src/app.tsx:resumeConversation")');
  const swapIndex = body.indexOf('type: "CLEAR_TRANSCRIPT"');
  const finishIndex = body.indexOf("replacement.finish()");
  assert.ok(armIndex >= 0, "resume should arm the clear boundary");
  assert.ok(swapIndex > armIndex, "the clear must be armed before the transcript swap");
  assert.ok(finishIndex > swapIndex, "the fallback check runs after the transcript swap");
});

test("Ink render-cache reset is reserved for explicit transcript clear", () => {
  // The repaint authority is clearFrameBoundary's wrapped renderInteractiveFrame:
  // it resets caches both on the /clear boundary AND on width-changing resizes,
  // atomically with the very frame it writes (no transient blank). It must NOT be
  // called from the out-of-band resize paths (index.tsx onResize / ui/layout.ts),
  // where a clear/reset would blank the screen until the next React commit.
  assert.match(clearBoundarySource, /resetInkOutputForFreshFrame/, "render-path wrapper owns the cache reset");
  const appResetCalls = appSource.match(/resetInkOutputForFreshFrame\(/g) ?? [];
  assert.equal(appResetCalls.length, 1, "app.tsx resets only for the /clear fallback");
  assert.doesNotMatch(appSource, /theme:viewportClear|updateOverlay:viewportClear/);
  assert.doesNotMatch(indexSource, /resetInkOutputForFreshFrame/);
  assert.doesNotMatch(layoutSource, /resetInkOutputForFreshFrame/);
});

test("Width resize repaints the transcript through the frame boundary", () => {
  // A width change must re-flush <Static> at the new width and commit it
  // atomically with a scrollback-inclusive clear — see CLAUDE.md's terminal
  // lifecycle invariants. Deleting this machinery leaves the transcript frozen
  // at the pre-resize width with the composer stranded mid-screen.
  assert.match(clearBoundarySource, /widthRepaintArmed/);
  assert.match(clearBoundarySource, /"resizeRefresh"/);
  assert.match(clearBoundarySource, /armWidthRepaint\("overlayExitWidthChanged"\)/);
  assert.match(appSource, /onWidthResizeRefresh: \(\) => bumpStaticRepaintGeneration/);
  // Viewport-only clears are reserved for the alternate screen buffer, which has
  // no scrollback (overlay enter / overlay resize) — never for the transcript.
  const viewportClearReasons = [...clearBoundarySource.matchAll(/clearViewport\(`\$\{source\}:([a-zA-Z]+)`\)/g)]
    .map((match) => match[1]);
  assert.ok(viewportClearReasons.length > 0, "overlay paths home/clear the alternate buffer");
  assert.equal(
    viewportClearReasons.every((reason) => reason?.startsWith("overlay")),
    true,
    `viewport-only clears must be overlay-scoped, got: ${viewportClearReasons.join(", ")}`,
  );
});

test("/clear fallback preserves clear-then-reset ordering when boundary cannot arm", () => {
  const armMatch = appSource.match(/const armTranscriptReplacement = useCallback\(\(source: string\) => \{([\s\S]*?)\n  \}, \[/);
  assert.ok(armMatch, "shared transcript-replacement arming should exist");
  const body = armMatch[1] ?? "";
  const fallbackIndex = body.indexOf("if (clearBoundaryArmed) return;");
  const clearIndex = body.indexOf("terminalControl.clearTranscript(`${source}:fallback`)");
  const resetIndex = body.indexOf("resetInkOutputForFreshFrame({ instance: inkInstance");
  assert.ok(fallbackIndex >= 0, "fallback block should exist for unresolved Ink boundary");
  assert.ok(clearIndex > fallbackIndex, "fallback should physically clear the terminal");
  assert.ok(resetIndex > clearIndex, "fallback should reset Ink caches after physical clear");
});

test("/clear forces a deterministic post-clear repaint when the boundary signals readiness", () => {
  // Ink writes a frame during the React commit (resetAfterCommit), before passive
  // effects run, so the cleared frame is suppressed against the boundary's stale
  // gate. The syncRenderState effect must consume the boundary's readiness signal
  // and force exactly one more commit so the authoritative post-clear frame is
  // flushed deterministically instead of waiting on an incidental later render.
  assert.match(appSource, /const postClearRepaintPending = clearFrameBoundaryController\.syncRenderState\(/);
  assert.match(appSource, /if \(postClearRepaintPending\) \{[\s\S]*?bumpPostClearRepaint\(/);
});

test("Startup keeps a single resize listener and disables Ink's competing handler", () => {
  const resizeRegistrations = indexSource.match(/stdout\.on\("resize"/g) ?? [];
  assert.equal(resizeRegistrations.length, 1, "exactly one resize listener is registered");
  assert.match(indexSource, /inkInstance\?\.unsubscribeResize/);
  // onResize stays imperative-free: it must not force Ink renders or clears.
  const onResizeMatch = indexSource.match(/const onResize = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(onResizeMatch, "onResize handler should exist");
  assert.doesNotMatch(onResizeMatch[1] ?? "", /clearTranscript|clearViewport|resetInkOutputForFreshFrame|\.clear\(\)/);
});

test("Main UI starts in the normal buffer and overlays own alternate screen mode", () => {
  // index.tsx deliberately stays out of alternate screen so terminal scrollback
  // remains available; cleanup may still defensively disable alternate screen.
  assert.doesNotMatch(indexSource, /performStartupClear|startupClear/);
  assert.doesNotMatch(indexSource, /traceTerminalClear\("src\/index\.tsx:startup"/);
  assert.doesNotMatch(indexSource, /setAlternateScreen\(true/);
  assert.match(indexSource, /setAlternateScreen\(false/);
  assert.match(appSource, /const overlayMode = screen !== "main";/);
  assert.match(appSource, /setAlternateScreen\(\s*overlayMode,/);
  assert.match(appSource, /overlay\.enterAlternateScreen/);
  assert.match(appSource, /overlay\.exitAlternateScreen/);
  assert.doesNotMatch(appSource, /\\x1b\[\?1049h/);
  const renderRoots = indexSource.match(/renderApp\(<App /g) ?? [];
  assert.equal(renderRoots.length, 1, "exactly one Ink root is mounted");
});

test("VTE terminal trace records startup root, logo branch, composer count, and footer count", () => {
  assert.match(appSource, /renderDebug\.traceEvent\("startup", "state"/);
  assert.match(appSource, /activeRoot: activeRootComponent/);
  assert.match(appSource, /logoBranchSelected: startupHeaderMode === "large"/);
  assert.match(transcriptShellSource, /renderDebug\.traceEvent\("startup", "homeRender"/);
  assert.match(transcriptShellSource, /selectedLogoVariant/);
  assert.match(transcriptShellSource, /logoHiddenReason/);
  assert.match(transcriptShellSource, /homeScreenRendererUsed: homeScreenActive/);
  assert.match(clearBoundarySource, /ubumeLogoCount/);
  assert.match(clearBoundarySource, /composerCount/);
  assert.match(clearBoundarySource, /footerCount/);
  assert.match(clearBoundarySource, /currentCols/);
  assert.match(clearBoundarySource, /currentRows/);
  assert.match(clearBoundarySource, /buildFrameText\(instance, output, staticOutput\)/);
});

test("App holds a process-lifetime stdin raw-mode lease so composer shell swaps never detach Ink input", () => {
  // Without this lease, Ink's raw-mode refcount hits zero every time the
  // composer moves between AppShell and TranscriptShell (overlay exit), which
  // removes/re-adds its 'readable' listener; two such cycles in one tick flip
  // stdin into flowing mode and Ink never receives input again.
  assert.match(appSource, /import \{ useStdinRawModeLease \} from "\.\/ui\/input\/useStdinRawModeLease\.js"/);
  assert.match(appSource, /const \{ stdin \} = useStdin\(\);\s*(?:\/\/[^\n]*\n\s*)*useStdinRawModeLease\(\);/);
});
