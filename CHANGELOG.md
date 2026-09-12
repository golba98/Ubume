# Changelog

## Unreleased

No changes yet.

---

## [1.0.27] — 2026-09-12 — Plan Approval Cleanup

### Fixed

- **The approved plan is no longer printed twice** — pressing `Implement
  changes` seeded the execution run with the approved plan, which re-rendered
  the entire `Plan` card directly under the `Plan approved. Plan mode off` line.
  The plan is already finalized in the transcript whenever that picker is shown,
  so the echo was always a duplicate. The provider still receives the plan
  through the execution prompt.
- **A live card taller than the viewport keeps its frame** — the live-row
  window sliced the running turn from the end without regard for card
  boundaries, leaving a borderless box that began mid-sentence. When a cut lands
  inside a bordered card, the card is now re-capped with its own top border plus
  an `⋯ N rows hidden` notice, still within the row budget that keeps Ink from
  wiping the scrollback.

### Maintenance

- Timeline rows carry optional frame metadata (`top`/`content`/`bottom`) set by
  the two box builders and preserved through row wrapping, with coverage for
  card-aware windowing, padded-card alignment, and the narrow-terminal label
  fallback.

---

## [1.0.26] — 2026-09-03 — Image Paste and Copy-Ready Commands

### Added

- **Clipboard images can be attached to supported models** — press `Ctrl+V` or
  use `/paste-image` to add an attachment chip. Codexa forwards images through
  Codex CLI and vision-enabled Local Harness models, and preserves the draft
  with an actionable error when the selected route cannot accept images.

### Fixed

- **Shell commands are copy-ready** — shell fences now use a small comment-style
  language label followed by raw, unnumbered commands, without a decorative box
  or a misleading `Copy Code` title becoming part of the terminal selection.

### Maintenance

- Added coverage for clipboard capture, atomic image chips, Codex image
  arguments, Local Harness image content blocks, and `/paste-image` routing.

---

## [1.0.25] — 2026-09-03 — Automatic Local Output Continuation

### Fixed

- **Long Local Harness responses now continue automatically across output
  windows** — reaching a model's per-request output-token limit sends a focused
  continuation prompt through the existing Harness session instead of
  finalizing a truncated answer. Assistant text, tool state, approvals, context
  compaction, and workspace tracking remain part of one logical Codexa run.
- **Continued responses persist as one complete assistant message** — streamed
  display content and the final conversation payload are tracked separately so
  the saved history contains the entire answer without duplicate rendering.
- **Stalled continuations fail safely** — productive text and tool activity may
  roll over without a fixed limit, while two consecutive windows with no
  visible progress return an actionable error. Cancellation prevents further
  continuation prompts or final callbacks.

### Maintenance

- Added Local Harness regression coverage for multi-window output, reasoning-only
  exhaustion, tool progress, cancellation, stable progress updates, final
  session metadata, and single-response finalization.

---

## [1.0.24] — 2026-09-03 — Long-Session Performance and Local Reasoning Recovery

### Fixed

- **Long sessions no longer get slower with every turn** — the frame boundary
  hashed and scanned Ink's whole accumulated transcript on every frame for
  trace payloads that were discarded when tracing was off, and the transcript
  shell rebuilt the row model for every finalized turn on each keystroke and
  streaming tick. Trace work now runs only while tracing is enabled, finalized
  turns are built once and cached by event identity, and a keystroke rebuilds
  nothing.
- **Old history is bounded** — only the newest 200 turns keep rendered rows in
  memory. Older turns stay in the terminal's scrollback; after a width resize
  only the retained window is redrawn. `/clear` and conversation resume also
  drop the row caches.
- **Local reasoning models that exhaust their output budget while thinking are
  recovered instead of failing with "no visible output"** — Codexa now reads
  the harness stop reason, sends one "continue and act" prompt in the same
  session, and otherwise reports the real cause with token counts. The default
  output budget scales with the context window (8K–32K), and a Local model can
  opt in to `supports_reasoning_effort` so the active reasoning level is
  forwarded to the model.

---

## [1.0.23] — 2026-09-03 — Plan Mode and Streaming Scroll Fixes

### Fixed

- **Plan mode no longer shows the model's exploration chatter inside the plan
  box, or above the tool calls it ran to build the plan** — text streamed
  before a tool call is now rendered as ordinary prose in place, and the plan
  panel only ever contains the section generated after the last tool call, at
  the end of the transcript. The planning prompt also now asks for a final
  message that is only the plan.
- **Scrolling up while a response streams no longer snaps back to the
  bottom** — the live transcript region is tail-windowed to the terminal
  height so Ink never has to clear the scrollback mid-stream; the complete
  turn is still committed to scrollback once it finishes.
- **Pressing "Implement" on an approved plan now actually writes files
  instead of producing text and staying in plan mode** — approving a plan
  upgrades a read-only execution mode to a writable one and turns plan mode
  off for the session, so the local provider's sandbox can perform the
  approved changes and the footer reflects the new mode.

---

## [1.0.22] — 2026-09-02 — Startup Input Reliability

### Fixed

- **Keyboard input survives the startup update check** — the App root now holds
  Ink's raw-mode lease for the process lifetime, so moving the composer between
  the overlay and transcript shells no longer detaches stdin input handling
  (typing and Ctrl+C were dead after "Checking for Codexa updates...").

---

## [1.0.21] — 2026-09-01 — Reliable Updater Rendering

### Fixed

- **Installation replaces the available-update card** — the updater now uses
  mutually exclusive available, installing, success, and failure states instead
  of stacking installation progress beneath the original prompt.
- **Canceling an installation preserves the complete TUI** — Escape cancels the
  active updater process, restores the available-update state, retains keyboard
  focus, and ignores stale output or completion from the canceled attempt.
- **Startup update checks no longer hide the Codexa header** — the normal
  transcript buffer receives a fresh static logo, workspace, and provider frame
  before it is exposed, preventing the composer-only blank-screen state.
- **Local API-key fingerprints are no longer reusable offline digests** —
  Harness credential-change detection now uses process-salted scrypt instead
  of hashing the configured secret directly.

### Maintenance

- Added updater lifecycle, immediate and repeated cancellation, full-shell,
  initial alternate-buffer, and credential-fingerprint regression coverage.

---

## [1.0.19] — 2026-08-30 — Reliable Local Workflows

### Added

- **Local conversations roll over context without losing task continuity** —
  long-running sessions create a persisted semantic checkpoint before moving
  older transcript content out of the active request window.
- **Local streaming diagnostics are available on demand** — privacy-aware,
  environment-gated traces help diagnose LM Studio, Unsloth, and Codexa Native
  response streams without recording response text by default.

### Fixed

- **Local agents can finish workflows longer than ten tool calls** — progress
  is bounded by completion, cancellation, or repeated unchanged results instead
  of an arbitrary total-call limit, so explicitly requested commits, pushes,
  and pull requests are not handed back as unfinished user commands.
- **Restored Local models show their discovered context size** — startup model
  discovery now refreshes the active route metadata even when the persisted
  model ID did not change, replacing the temporary `Unknown` context label.
- **Failed context rollovers cannot affect later token accounting** — transient
  response coverage resets at each run boundary and stored checkpoints receive
  strict validation when conversations are reopened.
- **Runtime mode persistence is failure-tolerant** — filesystem errors no longer
  escape into the terminal UI.

### Maintenance

- Simplified transcript rendering around native terminal scrollback and removed
  obsolete mouse-capture, plan-review, and timeline-navigation code.
- Added focused Local streaming, context rollover, agent-loop, persistence, and
  terminal-render regression coverage.

---

## [1.0.18] — 2026-08-28 — Unsloth Local Backend

### Added

- **Unsloth Studio is available as a Local backend** — Codexa can discover
  loaded Unsloth models, select the Unsloth route, and use its OpenAI-compatible
  inference endpoint alongside LM Studio.
- **Local backend selection is persistent** — workspace routes retain whether
  Local should use LM Studio or Unsloth, with independent status checks in the
  provider picker.

### Fixed

- **Local backend diagnostics are explicit** — unavailable servers, missing
  models, and authentication requirements are reported per backend without
  changing the stable Local provider identity.

### Maintenance

- Added Unsloth routing, discovery, workspace configuration, provider-picker,
  and regression coverage for the new backend.

---

## [1.0.17] — 2026-08-24 — Native Local Tools and Provider Clarity

### Added

- **Local models can use native OpenAI-compatible tools** — verified model profiles receive structured tool definitions, assistant tool-call IDs are preserved, and matching tool results are returned across multi-step agent turns.
- **DeepSeek-family Local models receive compatibility defaults** — family detection fills missing reasoning, system-prompt, streaming, and tool-call capabilities without inventing context or output-token limits.
- **Codexa Native models have a focused child picker** — PyTorch and CuPy routes appear under one Codexa Native provider entry while retaining their distinct model identities.

### Fixed

- **Fragmented Local tool calls are reconstructed safely** — streamed IDs, function names, JSON arguments, reasoning content, malformed calls, and finish reasons are normalized before execution.
- **Local agent loops preserve native protocol state** — multiple tool calls, duplicate-call protection, approval decisions, malformed-call feedback, and final-answer recovery now retain the correct call IDs and roles.
- **Header rendering tests are stable across terminal redraw timing** — assertions inspect individual Ink writes instead of treating accumulated redraw history as one frame.

### Maintenance

- Added repository-level deterministic Bun test concurrency for reliable local and prepublish validation.
- Configured the scoped npm package for publication to GitHub Packages.
- Updated package, lockfile, generated build metadata, release documentation, architecture notes, and regression coverage for `1.0.17`.

---

## [1.0.16] — 2026-08-16 — Resumable Conversations and Compact Imports

### Added

- **Workspace-scoped conversation history** — Codexa stores durable conversation metadata and messages outside the project, restores previous chats through `/resume`, and carries bounded history into supported provider routes.
- **Responsive resume picker** — previous conversations can be selected from a keyboard-driven panel that adapts to the available terminal rows.

### Fixed

- **Local import confirmation no longer clips its primary action** — long attachment paths are shortened below the home directory, file details are compacted, and the horizontal Import/Cancel choices now use matching Left/Right navigation.
- **Restored conversations render complete assistant turns** — resumed timeline events retain both user and assistant content before the next prompt.

### Maintenance

- Removed unused conversation-route state and an unconsumed conversation-title export found during the release audit.
- Updated architecture and source documentation for conversation persistence and resume flow.
- Removed the duplicate root documentation file; `docs/DOCUMENTATION.md` is now the single technical documentation guide.
- Updated package metadata for the `1.0.16` patch release.

---

## [1.0.15] — 2026-08-15 — Reliable Long Local Responses

### Fixed

- **Long Local-model generations no longer fail at the HTTP header timeout** — Codexa requests streaming completions by default, allowing LM Studio to establish the response immediately while large models continue reasoning.
- **Streaming remains compatible with the Local agent loop** — fragmented assistant text, reasoning-only output, and OpenAI-style tool-call names and arguments are reconstructed before execution without exposing tool protocol markup in chat.
- **Explicit non-streaming models keep their supported path** — models reporting `supports_streaming: false` continue using ordinary JSON completions.

### Tests

- Added Local-provider regression coverage for default streaming, SSE text reconstruction, fragmented tool calls, and the non-streaming capability fallback.

---

## [1.0.14] — 2026-08-15 — Repository Cleanup

### Changed

- **The project landing page is easier to scan** — installation, providers, core controls, and development links are presented without duplicated operational detail.
- **Release documentation identifies the current package correctly** — stale current-version wording was removed and the publishing guide now targets `1.0.14`.

---

## [1.0.13] — 2026-08-15 — One-Key Update Restart

### Added

- **Successful updates can close Codexa immediately** — the completion panel now provides a focused `Restart now` button; pressing Enter exits the current process cleanly so the newly installed version can be launched.

### Tests

- Added update-completion keyboard coverage for the restart action and its visible instructions.

---

## [1.0.12] — 2026-08-15 — Update Overlay Stability

### Fixed

- **Returning from the update prompt restores the full home screen** — the overlay exit now resets the Ink frame cache and repaints the static Codexa header instead of leaving a large blank area above the composer.
- **Horizontal update selection is visible and terminal-compatible** — the selected action has an explicit `❯` marker, with raw VTE, application-cursor, xterm, and Kitty arrow sequences supported.

### Tests

- Added raw arrow-protocol and overlay-exit repaint ownership coverage.

---

## [1.0.11] — 2026-08-15 — Update Menu Navigation

### Changed

- **Update actions follow their visual layout** — the horizontal Update now and Later choices use Left/Right navigation and show the matching keyboard hint.
- **Startup updates appear before chat input** — Codexa opens a cached update immediately or briefly checks npm before enabling the composer, preventing a delayed prompt from interrupting typing.

### Tests

- Updated update-prompt navigation and startup-render coverage for horizontal selection and pre-composer checks.

---

## [1.0.10] — 2026-08-15 — Local Planning and Permission Controls

### Added

- **Plan mode works across every supported provider** — Codex, Claude, Mistral, Antigravity, and Local use the shared plan-review workflow with an explicit read-only planning turn.
- **Safety modes rotate without an overlay** — Shift+Tab cycles Plan, Read-only, Auto, and Full Access while the active mode stays visible in the footer.
- **Local model mutations require real approval** — On request and Untrusted policies pause before writes, patches, and shell commands with Allow once, Allow for run, and Deny choices.

### Changed

- **Large pastes stay compact** — bracketed pastes of 1,000 or more characters render as `[Pasted Content … chars]` while the complete content is retained for the provider.
- **Outside-file imports explain their scope** — the confirmation panel now provides keyboard-navigable Import once and Cancel actions and makes clear that no folder access is granted.

### Fixed

- **Overlay focus is unambiguous** — the composer caret is hidden while another panel owns keyboard focus.
- **Shift+Tab works across terminal protocols** — VTE, xterm, Kitty CSI-u, and modifyOtherKeys backtab encodings are recognized without adding mode-change notices to chat.

### Tests

- Added paste-boundary, raw-payload, atomic-navigation, import-navigation, provider planning, safety-mode rotation, terminal backtab, local approval, and read-only Plan-mode coverage.

---

## [1.0.9] — 2026-08-14 — Responsive UI and Security Maintenance

### Changed

- **Codexa Native is restricted to the local-development channel** — the native runtime remains available for local development while published routing continues to use supported external providers.
- **Dependency maintenance is consolidated** — Ink, React, TypeScript, and Node type definitions were updated to the validated release set.

### Security

- **Process and workspace validation is hardened** — shell execution keeps argument boundaries explicit, Windows batch arguments are validated, and workspace/Cargo path checks use bounded, anchored matching.

### Fixed

- **Provider and model pickers now consume the terminal space available to them** — fixed three/five-row-style windowing has been replaced by a shared responsive capacity and continuous scroll offset. Short lists render in full; overflowing lists show the selected position rather than artificial page ranges.
- **Picker resize and compact behavior is stable** — selection remains visible while navigating or resizing, offsets and invalid dimensions are clamped, and 80×20 panel screens use the existing compact header so list rows take priority. At 100×22 all current provider rows fit alongside the composer and runtime status.
- **Narrow and wide picker rows remain bounded** — secondary metadata yields to names at narrow widths, display-width-aware ellipses prevent border wrapping, and wider layouts retain aligned provider capability metadata.
- **All short-terminal overlay panels expose their options** — Theme (`Ctrl+T`), Mode (`Ctrl+P`), Settings, Auth, provider, and model screens use the compact one-line Codexa header at 24 rows or fewer and no longer lose rows to a redundant close-panel hint.
- **Dense Auth and Settings panels remain readable** — Auth collapses secondary guidance before hiding its three preferences, while Settings keeps each option group on one clipped row so neighboring labels cannot overlap.
- **Theme and generic selection lists no longer drop options** — the fixed `ink-select-input` viewport and stacked padded cards were replaced with the shared continuous responsive list. All nine themes fit at 100×22, the current item owns the cursor, and arrow-key theme previews apply immediately.
- **Development startup is cleaner** — `codexa-dev` no longer prints the `Launch mode` readiness/tip transcript block on startup or after `/clear`; the relaunch command itself remains available.

### Tests

- Added shared viewport tests for complete-list fit, continuous scrolling, larger-terminal capacity, data/resize clamping, and invalid dimensions; updated provider, model, and shell integration coverage for responsive indicators and row use.
- Manually verified the live provider and model panels at 80×20, 100×22, 120×30, and 160×40, including resizing an open 20-model list with its selected item retained.

---

## [1.0.8] — 2026-07-14 — Packaging Maintenance

### Changed

- **Published executable metadata is normalized** — the package now records the `codexa` binary as `bin/codexa.js`, matching npm's canonical package format and avoiding publish-time normalization warnings.
- **Runtime behavior is unchanged** — this maintenance release contains no CLI, configuration, provider, or UI behavior changes.

---

## [1.0.7] — 2026-07-14 — Clean Workspaces

### Changed

- **Codexa no longer creates `.codexa` directories in projects** — provider preferences, imported attachments, and default diagnostic logs now use platform user-data storage instead of the active workspace.
- **Provider settings remain workspace-specific without becoming project files** — Codexa stores each workspace's route, model, and reasoning preferences under a hashed user-data directory.

### Migration

- Existing `.codexa/providers.json` files remain untouched and load as a legacy fallback. When you next save provider settings, Codexa writes the migrated configuration to user data only.
- Existing `.codexa` directories are never deleted automatically.

---

## [1.0.6] — 2026-07-14 — Startup Update Notice

### Fixed

- **New releases are checked on every interactive startup** — Codexa now fetches npm's `latest` tag each time the TUI opens, so a release published after a previous launch is detected on the next run instead of waiting for a cached check to expire.
- **Update prompts are delivered safely** — if Codexa is busy or another panel is open when npm responds, the update prompt waits until the user returns to the idle main screen. Choosing “Later” dismisses it only for that session.
- **Package-manager guidance matches the install** — passive update notices now show the detected npm, pnpm, Yarn, or Bun update command.

### Notes

- Automatic checks remain disabled for local development launches. Headless `codexa exec` output is unchanged.

---

## [1.0.4] — 2026-05-30 — Update Notice Reliability

### Fixed

- **Update notices now use the npm `latest` tag reliably** — Codexa compares the running version against `dist-tags.latest` for `@golba98/codexa` and shows a clear prompt when the installed version is older.
- **Manual `/update check` bypasses stale cache** — explicit checks fetch fresh npm metadata and report update available, already up to date, or a short failure reason.
- **Failed update checks are not cached as success** — startup still fails silently on network or malformed-registry errors, but those failures no longer hide future updates.

### Notes

- Published npm versions are immutable. v1.0.2 contains update-check code, but any runtime prompt defects in that published package cannot be patched retroactively. Users on older versions should run `npm install -g @golba98/codexa@latest`.

---

## [1.0.3] — 2026-05-30 — Package-Ready Release

**This is the package-ready release.** The installed/downloaded Codexa package now includes the full startup UI and matches the working dev/local version.

### Fixed

- **Installed package now shows full Codexa UI** — the large ASCII logo/header, version line, workspace, provider, and footer are all present after `npm install -g @golba98/codexa`. Previously, the published tarball predated the UI overhaul and produced a stripped-down startup screen.
- **`gen-build-info` now runs as part of `prepublishOnly`** — the `APP_VERSION` constant embedded in the package (`src/config/buildInfo.ts`) is guaranteed to match `package.json` at publish time. Previously, publishing without running `npm run build` first could leave a stale version constant in the tarball, causing the header brand line and `codexa --version` to disagree.

### Changed

- **Semantic color-token system** — theme tokens are now lowercase (`logoPrimary`, `text`, `textMuted`, etc.) rather than the legacy uppercase API. This was a ground-up refactor of `src/ui/theme.tsx` and all consuming components.
- **Responsive ASCII logo** — `src/ui/logoVariants.ts` introduces three logo variants (full block-art wordmark, 4-row ASCII fallback, compact single-line) selected by viewport size. Minimum column/row thresholds ensure the logo degrades gracefully on small terminals.
- **Package exclusions corrected** — test files (`*.test.ts`, `*.test.tsx`) and dev-only scripts are excluded from the published tarball. Runtime source is included in full.
- **Linux and Windows package paths verified** — `bin/codexa.js` uses `import.meta.url`-relative `packageRoot` resolution and `join()` throughout; Windows selects `bun.exe`, Linux/macOS selects `bun`.

### Notes

- Dev and production share the same UI renderer. The installed `codexa` command shows `Codexa v1.0.3`; the dev launchers (`codexa-dev` / `cxd`) show `Codexa v1.0.3-dev local`.
- This release does not include new features. It is a package correctness and release-process fix.

### Update checker behavior (for users on v1.0.2)

v1.0.2 contains update-check code, but any prompt defects in the published v1.0.2 package cannot be patched retroactively. If the notice does not appear, run `npm install -g @golba98/codexa@latest`.

The update checker fetches `dist-tags.latest` from `https://registry.npmjs.org/@golba98%2Fcodexa` and compares it against the running version. Update checks are disabled for local dev builds.

---

## [1.0.2] — internal

Color system and package cleanup pass. Not re-released as a standalone version; improvements folded into v1.0.3.

## [1.0.1] — initial release

Initial published release of Codexa.
