# Codexa Release Guide

This guide documents how to publish the npm package `@golba98/codexa` to
GitHub Packages.

## Prepare version 1.0.17

Run these commands from the repository root. NPM versions are immutable, so
never reuse a version that has already been published.

```bash
npm version 1.0.17 --no-git-tag-version
npm pkg get name version
```

Continue only after the printed version is `1.0.17`.

## Validate the release

```bash
npm whoami --registry=https://npm.pkg.github.com
npm view @golba98/codexa version --registry=https://npm.pkg.github.com
bun install
bun run typecheck
bun test
git diff --check
npm pack --dry-run
```

Inspect the dry-run output to confirm that only the intended package files are
included.

## Authenticate and publish to GitHub Packages

Use the GitHub username as the login name and a personal access token with
`write:packages` as the password:

```bash
npm login --scope=@golba98 --registry=https://npm.pkg.github.com
```

The package `publishConfig` already selects GitHub Packages:

```bash
npm publish --access public
```

The `prepublishOnly` lifecycle script automatically regenerates build metadata,
runs the TypeScript typecheck, and runs the full Bun test suite.

## Verify the published package

```bash
npm view @golba98/codexa@1.0.17 version --registry=https://npm.pkg.github.com
npm install -g @golba98/codexa@1.0.17 --registry=https://npm.pkg.github.com
codexa --version
```

After GitHub Packages' `latest` tag has propagated, verify the tagged package:

```bash
npm view @golba98/codexa dist-tags --json --registry=https://npm.pkg.github.com
npm install -g @golba98/codexa@latest --registry=https://npm.pkg.github.com
codexa --version
```

## Commit and tag the release

```bash
git add package.json package-lock.json CHANGELOG.md README.md src/config/buildInfo.ts docs/RELEASING.md
git commit -m "release: prepare Codexa v1.0.17"
git tag v1.0.17
git push origin main --follow-tags
```
