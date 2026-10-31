# Kylin V10 SP1 offline package

This directory builds `deepseek-harness-kylin-v10-sp1-aarch64.deb`, the offline installer of the dsh CLI for Galaxy Kylin V10 SP1 on arm64. The [.github/workflows/kylin-package.yml](../../../../../.github/workflows/kylin-package.yml) workflow builds and verifies it; every step below is reproducible locally on an arm64 Linux machine.

## Why a dedicated target

Kylin V10 SP1 is Ubuntu 20.04-lineage with glibc 2.31 and GCC 9/10 runtime libraries. Binaries built on newer hosts carry newer glibc symbol requirements and fail at startup with `version 'GLIBC_x.yy' not found`. The package therefore enforces a symbol baseline instead of hoping: glibc up to 2.31 and GLIBCXX up to 3.4.28, checked over every ELF in the payload.

## Package contents

The payload is self-contained and installs under `/opt/deepseek-harness`:

- `runtime/primary-runtime/` — the locked primary runtime for `linux-arm64` (Node.js, pnpm, Python 3.12 with the locked wheels), prepared by `scripts/primary-runtime/prepare.ts` from sha256-verified upstream archives.
- `office-skills/` — the Office skill asset tree from the same preparation.
- `dsh/` — a pnpm runtime project that installs `@deepseek-ai/dsh` from the packed workspace tarballs (dsh and vendor release families plus the closure remainder, such as the native system entry package). The generated lockfile ships with the tree.
- `deps/` — the offline dependency closure staged by `focal-container.sh fetch-deps` from the focal arm64 archive: git, tmux, openssh-client and the dependency trees apt resolves as missing, for machines that cannot reach an archive. `install-deps.sh` installs only what the target machine lacks.
- `/usr/bin/dsh` — a launcher with absolute paths into the tree.

`Depends: libc6 (>= 2.28)` (the official Node.js floor).

## Offline safety rules

Three defenses keep the package from ever touching system components on the target machine; all three are load-bearing:

1. The payload bundles its interpreters, so nothing from the target system is needed beyond glibc.
2. `deps/install-deps.sh` installs only packages missing on the machine — it never upgrades an installed package — installs the missing set in one dpkg transaction so dependencies resolve, and refuses glibc, systemd, dbus, PAM, udev, login, passwd, `libgcc*`/`libstdc*`, and anything marked `Essential=yes`.
3. The build-time symbol gate fails the build if any payload ELF exceeds the baseline, and the closure is downloaded from the focal arm64 archive against the baseline container's own state, so no core component is ever staged.

The verification job re-checks the rules from outside: it records the full dpkg state before `dpkg -i`, after it, and again after `install-deps.sh`, failing if any package was upgraded or replaced at either step; it then runs `ldd` over the payload expecting zero unresolved libraries.

## Build and verify pipeline

Kylin V10 SP1 is Ubuntu 20.04-lineage, so the build itself runs inside a focal (`ubuntu:20.04`) container on an arm64 runner — the same-source baseline (glibc 2.31, GCC 9) — and the runner host never contributes compiled bytes. The workflow runs in two jobs:

- **Build** prepares the focal container (git, compiler toolchain, musl), installs the workspace, runs `pnpm run build:official` (the dsh release family refuses to pack from anything else), then runs the two `focal-container.sh` stages: `refit` recompiles the native system binaries with focal's `cc` and `musl-gcc`, and `fetch-deps` stages the offline dependency closure from the focal arm64 archive. `build-deb.ts` then packs the closure, prepares the primary runtime, installs the CLI, gates the symbols, and emits the deb. The payload smoke runs the bundled Node.js on the focal baseline itself, proving the glibc requirement before the package leaves the machine.
- **Verify** installs the artifact in an `ubuntu:20.04` container and runs the two zero-upgrade gates (after the deb install and again after the closure install), the ldd gate, the closure tool checks, and the CLI smoke. Both container images are workflow inputs, so a real `distrotwin/kylin` `v10sp1` image can replace focal without code changes.

The native refit exists because the release-built `flock` addon is compiled on a newer host; `focal-container.sh refit` recompiles the static musl Landlock launcher and the glibc/musl flock addons with focal's `cc` and `musl-gcc` through the single-source `native/system` build script.

## Local builds

Inside an arm64 focal container with Node 24 and pnpm on PATH (the setup node provides both; for plain Docker, mount a Node.js 24 dist and prepend its `bin` to PATH):

```sh
pnpm install --frozen-lockfile
pnpm run build:official
bash apps/cli/packaging/linux/kylin-v10-sp1/focal-container.sh refit fetch-deps
pnpm exec tsx apps/cli/packaging/linux/kylin-v10-sp1/build-deb.ts \
  --output dist/kylin --work dist/kylin/work --cache dist/kylin/cache
```

Run the container stages before `build-deb.ts`; run the verify script inside an `ubuntu:20.04` container against the built deb.

## Handling gate failures

- A symbol-gate violation names the file and the offending version. Fix the source of the binary (usually a dependency that must be rebuilt on the baseline) rather than raising the gate; raising it ships a package that fails at startup on the target machine.
- A zero-upgrade violation means something in the payload or its closure tried to replace a system package. Never solve it by relaxing the gate — remove the package from the closure.
- `dpkg-deb -c` payload assertions catch a deb that lost part of its payload during assembly.

## Known constraints

- The Landlock launcher needs Linux 5.13+ for sandbox enforcement; on older Kylin kernels the harness falls back the same way it does on other platforms.
- The deb carries one architecture. An x64 target duplicates this directory with `arm64` replaced by `x64` and the same gates.
- If a payload dependency needs a system package on Kylin, add it to `deps/` from the focal arm64 archive and follow the rules in `deps/README.txt`.
- This payload has no Chromium component, so the Electron `--password-store=basic` keyring workaround does not apply here; the desktop shell sets it platform-guarded in `apps/desktop/src/main.ts`, and any future Kylin `.desktop` launcher for an Electron build must repeat it on the `Exec=` line.
