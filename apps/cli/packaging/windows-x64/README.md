# Windows x64 offline package

This directory builds `deepseek-harness-windows-x64-setup.exe`, the offline installer of the dsh CLI for 64-bit Windows. The [.github/workflows/windows-offline-package.yml](../../../../../.github/workflows/windows-offline-package.yml) workflow builds it on a Windows runner; the same steps run locally on any x64 Windows machine with Node 24.9+, pnpm, and NSIS 3.

## Installer behavior

The NSIS installer copies the payload into `$PROGRAMFILES64\deepseek-harness`, appends that folder to the machine PATH (broadcasting the environment change), and registers an uninstaller with Add or Remove Programs. It touches no system component beyond its own directory and that PATH entry; uninstalling removes both.

The payload is fully self-contained: it bundles its own Node.js, pnpm, and Python (the locked primary runtime for `win-x64`, prepared by `scripts/primary-runtime/prepare.ts` from sha256-verified upstream archives), the `@deepseek-ai/dsh` CLI installed from the packed workspace tarballs (dsh and vendor release families), and the Office skill assets. Windows has no system-package database to disturb, so unlike the [Kylin deb](../linux/kylin-v10-sp1/README.md) there is no dependency closure and no system-component risk. The native system package (Landlock launcher, flock addons) is Linux/macOS-only and resolves from its published npm version, whose Windows consumers load no platform binary.

## Build

On a runner, dispatch the workflow; locally (NSIS on PATH — GitHub's Windows runners ship it):

```powershell
pnpm install --frozen-lockfile
pnpm run build:official
pnpm exec tsx apps/cli/packaging/windows-x64/build-installer.ts `
  --output dist/win --work dist/win/work --cache dist/win/cache
```

The script verifies the official client build record (the dsh release family refuses anything else), packs the release families, prepares the runtime, installs the CLI with a lockfile-first two-pass pnpm install, dereferences pnpm's junctions into the staged folder, and compiles [installer.nsi](installer.nsi) with makensis. The build host smoke — running the bundled `node.exe` against the packaged CLI entry — lives in the workflow so the script itself never executes a variable executable.

## Local testing

After building (or after downloading the workflow artifact), run the setup exe and verify from a new terminal:

```powershell
.\deepseek-harness-windows-x64-setup.exe
dsh --version
dsh --profile headless "hello"
```

Headless runs need `DEEPSEEK_API_KEY` in the environment (or a root `.env`); everything else works offline. Uninstall with `uninstall.exe` in the install folder or Add or Remove Programs.

## Handling failures

- `makensis is not on PATH` — install NSIS 3 and add its install directory to PATH, or build on the workflow runner.
- `official build artifacts` verification failure means the tree was not built with `pnpm run build:official`; rebuild.
- A missing-payload assertion catches a staged folder that lost part of its tree; rerun the build before suspecting the installer.
