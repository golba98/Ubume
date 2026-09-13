# Ubume CLI Versions

This file explains what users get in each release. For exact implementation
details and test notes, see the [changelog](CHANGELOG.md).

## v0.1.1 — 2026-09-13

Ubume no longer adds files to your project on its own. Local chats used to
create an empty `.ubume/scratch` folder in the workspace every turn, even when
nothing was put in it. That folder now only appears if the agent actually saves
a throwaway test or debug file there, and it is removed again when it ends up
empty.

## v0.1.0 — 2026-09-13

Initial pre-1.0 release of **Ubume CLI** (`ubume`).
- Renamed project from Codexa CLI to Ubume CLI across all launchers, UI chrome, settings, persistence stores, and scripts.
- Existing `CODEXA_*` environment variables, `codexa.mode` config keys, and `--codexa-prompt-policy` keep working.
- The local native models keep their Codexa name ("Codexa Native").
- Introduced `ubume` binary with `bin/codexa.js` as a backward-compatibility deprecation wrapper.
- Renamed configuration and state directories to `.ubume/` (`~/.local/share/ubume`, `~/.ubume-settings.json`, `.ubume/scratch`) with automated, non-destructive migration of existing `.codexa` settings and workspaces.
- Rebranded ASCII logo art, top header, status indicators, and wordmarks to Ubume.
- Set initial package version to 0.1.0.

## v1.0.28 — 2026-09-12

`/resume` now brings back the whole conversation. Replies from runs you
interrupted, runs that failed, or runs still going when you quit are saved
instead of lost, and each reply notes which files changed and which commands
ran. Resuming also no longer prints the Codexa logo twice, new prompts no
longer get mixed into restored messages, and the context meter keeps its value
after a failed request. Resumed Local chats reconnect to the backend they were
using, so an Unsloth model no longer fails with a connection error because
Codexa tried LM Studio instead.

## v1.0.27 — 2026-09-12

Approving a plan no longer prints the whole plan a second time underneath the
"Plan approved" line — Codexa goes straight from approval into the work. Long
cards in a running turn also stay properly framed when they are taller than the
terminal: instead of a borderless box that starts mid-sentence, the card keeps
its title and shows how many rows are hidden above.

## v1.0.26 — 2026-09-03

Shell command blocks are now deliberately plain and copy-ready: the commands
have no line numbers, border text, or fake copy control. Clipboard screenshots
and images can also be attached with Ctrl+V or `/paste-image` when using Codex
CLI or a vision-enabled Local model; unsupported routes are blocked without
discarding the draft.

## v1.0.25 — 2026-09-03

Long Local responses no longer stop abruptly when a model fills one output
window. Codexa now continues the same task automatically in the same Harness
session, keeping the composer locked and preserving the accumulated answer,
tool work, approvals, context compaction, and workspace state until the model
actually finishes. The result is saved as one complete assistant message.

Continuation stays bounded when a model stalls: Codexa allows any number of
windows that produce text or tool progress, but stops with an actionable error
after two consecutive windows do neither. Canceling a run also prevents another
continuation from starting.

## v1.0.24 — 2026-09-03

Codexa no longer slows down the longer a session runs. Typing used to get
laggy and the terminal felt heavy after enough turns because Codexa was
quietly rebuilding the entire visible history on every keystroke and hashing
the whole scrollback on every screen update; both now scale with what's
actually changing, not with how long the session has been running. Only the
most recent 200 turns are kept fully in memory — earlier ones stay visible in
your terminal's scrollback, so nothing is lost, but redraws after resizing the
window only cover the recent window.

Local models that think a lot before answering (reasoning models) could
previously hit their internal output limit mid-thought and fail with a
confusing "no visible output" error even though they were clearly working.
Codexa now recognizes this, automatically asks the model to wrap up and
answer, and raises the default output limit so it happens less often. If it
still can't get an answer, the error now explains what actually happened
instead of suggesting the model itself might be broken.

## v1.0.23 — 2026-09-03

Plan mode is fixed on the Local provider. Previously the model's exploration
commentary could open the plan panel above the tool calls it ran and end up
mixed into the plan text; now that commentary renders as normal conversation
and the plan panel only ever holds the plan itself, placed after the tool
calls. Pressing "Implement" on an approved plan now reliably writes the
changes instead of just producing more text and leaving you stuck in plan
mode — approving a plan turns plan mode off and switches to a mode that can
actually edit files.

Scrolling up in the terminal while Codexa is streaming a response no longer
gets yanked back down to the bottom. You can now read earlier output while a
long response keeps streaming, the same way any normal terminal program
behaves.

## v1.0.22 — 2026-09-02

Codexa no longer goes unresponsive right after startup. Previously, once the
startup update check finished and the main screen appeared, keyboard input
(including Ctrl+C) could stop working entirely because moving the input box
between screens briefly detached it from the terminal. Codexa now keeps that
connection alive for the whole session, so typing always works after the
updater closes.

## v1.0.21 — 2026-09-01

Codexa's updater now behaves as one coherent state machine: starting an install
replaces the available-update card, and pressing Escape cancels safely back to
that card without clearing or partially repainting the terminal. Canceled
attempts cannot leak stale progress or completion, and the updater keeps focus
so it can be used again immediately.

Startup update checks also preserve the complete Codexa screen. The logo,
workspace/provider details, composer, and model/context footer now appear
together when the checker closes instead of leaving a large blank area.

## v1.0.19 — 2026-08-30

Codexa now keeps long Local workflows moving beyond ten tool calls and completes
explicitly authorized Git and pull-request work instead of stopping early with
commands for the user. Restored Local models refresh their discovered context
size after startup, so the header no longer remains at `Unknown` when the model
server reports a limit.

Long Local conversations also preserve continuity through validated semantic
checkpoints, Local streaming has opt-in privacy-aware diagnostics, runtime mode
choices persist safely, and terminal history uses native scrollback with less
obsolete mouse and viewport machinery.

## v1.0.18 — 2026-08-28

Codexa now supports Unsloth Studio as a selectable Local backend. It discovers
loaded Unsloth models, routes inference through the OpenAI-compatible Studio
endpoint, persists the selected Local backend per workspace, and shows
independent backend diagnostics in the provider picker.

## v1.0.17 — 2026-08-24

Codexa now supports native OpenAI-compatible tool calls for verified Local
models, including structured multi-call turns, streamed argument assembly,
reasoning preservation, matching tool-result IDs, approvals, and malformed-call
recovery. DeepSeek-family Local models receive bounded compatibility defaults
without guessed context limits. Codexa Native also groups its PyTorch and CuPy
routes behind one provider entry with a dedicated model picker.

This release makes terminal-render tests deterministic and prepares the scoped
package for publication through GitHub Packages.

## v1.0.16 — 2026-08-16

Codexa now saves conversations per workspace and lets you reopen them with
`/resume`. Restored chats keep their user and assistant messages and continue
with bounded history for the selected provider. The Local file-import panel is
also more compact: long home paths are shortened, its actions remain visible,
and Import/Cancel navigation follows the horizontal Left/Right layout.
This patch also removes the duplicate root documentation file and keeps the
package metadata aligned at version `1.0.16`.

## v1.0.15 — 2026-08-15

Long responses from Local models such as Qwen now keep their LM Studio
connection alive while the model reasons. Codexa also reconstructs streamed
tool calls correctly, while models that explicitly do not support streaming
continue using the compatible non-streaming path.
## v1.0.14 — 2026-08-15

This maintenance release simplifies the repository landing page and refreshes
the public release documentation. Runtime behavior is unchanged from v1.0.13.

## v1.0.13 — 2026-08-15

After Codexa installs an update, the success panel now includes a focused
Restart now button. Press Enter to close the current Codexa process cleanly,
then launch Codexa again to use the newly installed version. Press Esc to stay
in the current session.

## v1.0.12 — 2026-08-15

This patch restores the complete Codexa home screen after closing the startup
update prompt. The selected update action now has a visible pointer, and more
terminal Left/Right arrow encodings are supported.

## v1.0.11 — 2026-08-15

This patch makes the update prompt match its horizontal layout. Use Left and
Right to move between Update now and Later, then press Enter to confirm.
Update checks now finish before chat input becomes available, so an update
prompt cannot suddenly interrupt text entered just after Codexa opens.
## v1.0.10 — 2026-08-15

Large pastes now stay readable as compact content markers while the full text
still reaches the model. Outside-file imports have clear, keyboard-navigable
one-time consent.

Codex, Claude, Mistral, Antigravity, and Local now share the full Plan review
workflow. Shift+Tab rotates Plan, Read-only, Auto, and Full Access directly in
the composer footer without opening a mode panel or adding notices to chat.
Planning is read-only, and local writes, patches, and shell commands obey the
configured approval policy with an interactive permission prompt.

## v1.0.9 — 2026-08-14

This was the previous patch release.

### Easier terminal panels

Provider, model, theme, settings, and authentication panels now adapt to the
available terminal space. Short terminals show more of the available options,
while longer lists scroll continuously and keep the selected item visible.

### More reliable themes and startup

Theme previews update immediately. Compact terminals keep their choices
readable, and the local development launcher no longer prints an unnecessary
startup block after launch or `/clear`.

### Safer provider behavior

Codexa Native is clearly limited to the local `codexa-dev` channel. Published
Codexa installations continue to use supported external provider routes.

### Security and dependency maintenance

Process argument handling, Windows command validation, workspace checks, and
Cargo diagnostic matching were hardened. The release also updates the
validated Ink, React, TypeScript, and Node type-definition dependencies.

## v1.0.8 — 2026-07-14

This was a packaging-only release. It corrected the published `codexa` binary
metadata without changing the runtime.

## v1.0.7 — 2026-07-14

Provider settings, attachments, and diagnostic logs moved out of project
directories and into user data. Existing `.codexa` files remain available as a
legacy fallback and are not removed automatically.

## v1.0.6 — 2026-07-14

Codexa began checking for newer releases on each interactive startup. Update
messages wait until Codexa is idle, and the suggested command matches the
package manager that installed Codexa.

## v1.0.4 and earlier

Earlier releases introduced the update checker, package-ready startup UI,
provider routing, responsive terminal branding, and the initial Codexa command
line experience. See [CHANGELOG.md](CHANGELOG.md) for the complete history.

## Release policy

- Published npm versions are immutable.
- The `latest` npm tag points to the current public release.
- Local development builds use the separate `codexa-dev` channel.
