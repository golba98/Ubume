# Codexa Release Guide

This guide documents how to publish the npm package `@golba98/codexa` to the
public npm registry.

## Prepare version 1.0.19

Run these commands from the repository root. NPM versions are immutable, so
never reuse a version that has already been published.

```bash
npm version 1.0.19 --no-git-tag-version
npm run gen-build-info
npm pkg get name version
```

Continue only after the printed version is `1.0.19`.

## Validate the release

```bash
npm whoami --registry=https://registry.npmjs.org
npm view @golba98/codexa version --registry=https://registry.npmjs.org
bun install
npm run prepublishOnly
npm run audit:codexa-gap
npm run smoke:terminal-bench
npm audit --audit-level=low
git diff --check
npm pack --dry-run --json
```

Inspect the dry-run output to confirm that only the intended package files are
included.

## Authenticate and publish to npm

Authenticate to npmjs.com if needed:

```bash
npm login --registry=https://registry.npmjs.org
```

The package `publishConfig` selects the public npm registry:

```bash
npm publish --access public
```

The `prepublishOnly` lifecycle script automatically regenerates build metadata,
runs the TypeScript typecheck, and runs the full Bun test suite.

## Verify the published package

```bash
npm view @golba98/codexa@1.0.19 version --registry=https://registry.npmjs.org
npm install -g @golba98/codexa@1.0.19 --registry=https://registry.npmjs.org
codexa --version
```

After npm's `latest` tag has propagated, verify the tagged package:

```bash
npm view @golba98/codexa dist-tags --json --registry=https://registry.npmjs.org
npm install -g @golba98/codexa@latest --registry=https://registry.npmjs.org
codexa --version
```

## Commit and tag the release

```bash
git add -A
git commit -m "release: prepare Codexa v1.0.19"
git tag v1.0.19
git push origin agent/prepare-codexa-v1-0-19 --follow-tags
```
