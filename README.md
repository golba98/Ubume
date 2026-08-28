# Codexa

Codexa is a terminal coding workspace for provider CLIs and local
OpenAI-compatible models.

## Install

```bash
npm install -g @golba98/codexa
codexa
```

Requires Node.js and one supported provider CLI, unless you use a local model.

Update Codexa with:

```bash
npm install -g @golba98/codexa@latest
codexa --version
```

## Providers

Codexa can use these routes:

| Provider | Setup |
| --- | --- |
| OpenAI / Codex | Install and authenticate the `codex` CLI. |
| Anthropic / Claude | Install and authenticate the `claude` CLI. |
| Mistral Vibe | Install and authenticate the `vibe` CLI. |
| Antigravity | Install and authenticate the `agy` CLI. |
| Local model | Open Local, choose LM Studio or Unsloth, and use a model loaded in that server. |
| Codexa Native | Available only from the local `codexa-dev` channel. |

Credentials remain with the provider CLI or local server.

## Usage

```bash
codexa --version
codexa exec "summarize this project"
codexa --model gpt-5.4
```

Useful commands inside Codexa:

```text
/help       Show commands
/model       Choose a model
/providers   Choose a provider
/permissions Configure safety
/settings    Open settings
/update      Check for updates
```

Press Shift+Tab to rotate Plan, Read-only, Auto, and Full Access without
opening a panel. Large pastes are displayed as `[Pasted Content … chars]`
while their complete content is sent to the model.

## Development

```bash
bun install
bun run dev
bun test
bun run build
```

Install the separate local development launcher with:

```bash
bun run install:dev-bin
codexa-dev
```

Developer references:

- [Architecture](docs/ARCHITECTURE.md)
- [Source guide](docs/SOURCE_GUIDE.md)
- [Documentation guide](docs/DOCUMENTATION.md)
- [Release guide](docs/RELEASING.md)

## Versions

Read [VERSIONS.md](VERSIONS.md) for a plain-language explanation of each
release. [CHANGELOG.md](CHANGELOG.md) contains the detailed technical record.
