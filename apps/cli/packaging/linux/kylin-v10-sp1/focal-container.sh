#!/bin/sh
# Stages for the Kylin V10 SP1 offline package, run inside a focal (Ubuntu 20.04)
# container with the repository checkout as the working directory — the same
# same-source baseline as Kylin V10 SP1 (Ubuntu 20.04 lineage, glibc 2.31, GCC 9).
# The GitHub build job runs entirely in that container, so the stages execute directly;
# a local build can run them the same way inside any focal container that has Node.js 24
# and pnpm on PATH. Run one or more stages in order:
#
#   focal-container.sh refit       rebuild the linux-arm64 native system binaries with the
#                                  focal toolchain so the shipped flock addon and Landlock
#                                  launcher never exceed the glibc 2.31 symbol baseline
#                                  (uses the Node.js installation already on PATH, whose
#                                  development headers are compiled against)
#   focal-container.sh fetch-deps  download the offline dependency closure (git, tmux,
#                                  openssh-client and the dependencies apt resolves as
#                                  missing) from the focal arm64 archive into the
#                                  packaging deps/ directory
set -eu

cd "${GITHUB_WORKSPACE:-$PWD}"
HOST_ARCH=linux-arm64
BIN_DIR="native/system/packages/$HOST_ARCH/bin"
DEPS_OUT="apps/cli/packaging/linux/kylin-v10-sp1/deps"
SEEDS='git tmux openssh-client'

# Focal is past standard support, so Release expiry checks are disabled and apt gets hard
# timeouts — an unbounded apt update has hung for 45+ minutes on a runner.
export DEBIAN_FRONTEND=noninteractive
cat > /etc/apt/apt.conf.d/99-dsh-kylin-build <<'CONF'
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::Retries "3";
Acquire::Check-Valid-Until "false";
CONF

toolchain=''
for stage in "$@"; do
  case "$stage" in
    refit) toolchain='build-essential musl-tools' ;;
    fetch-deps) ;;
    *) echo "focal: unknown stage ${stage}; use refit or fetch-deps" >&2; exit 1 ;;
  esac
done

apt_ready=0
for attempt in 1 2 3; do
  if timeout 300 apt-get update && { [ -z "$toolchain" ] || timeout 600 apt-get install -y --no-install-recommends $toolchain; }; then
    apt_ready=1
    break
  fi
  echo "focal: apt attempt ${attempt} failed; retrying against the old-releases archive" >&2
  sed -i 's|//ports.ubuntu.com/ubuntu-ports|//old-releases.ubuntu.com/ubuntu-ports|g; s|//archive.ubuntu.com/ubuntu|//old-releases.ubuntu.com/ubuntu|g' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null || true
done
if [ "$apt_ready" -ne 1 ]; then
  echo "focal: apt could not install the toolchain packages" >&2
  exit 1
fi

for stage in "$@"; do
  case "$stage" in
    refit)
      # The single-source build script compiles every binary declared for this host: the
      # static musl Landlock launcher and the glibc/musl flock Node-API addons, all with
      # focal's cc and musl-gcc, against the Node development headers beside the running
      # node.
      mkdir -p "$BIN_DIR"
      node node_modules/tsx/dist/cli.mjs native/system/scripts/build.ts

      echo "focal: refit rebuilt binaries:"
      for binary in "$BIN_DIR/landlock-run" "$BIN_DIR/glibc/system.node" "$BIN_DIR/musl/system.node"; do
        [ -f "$binary" ] || { echo "focal: missing $binary" >&2; exit 1; }
        echo "  ${binary#"$BIN_DIR/"}: $(wc -c < "$binary") bytes"
      done

      # The launcher must be static musl; a dynamically linked launcher would drag the
      # build machine's libc into the payload.
      linkage=$(ldd "$BIN_DIR/landlock-run" 2>&1 || true)
      case "$linkage" in
        *'not a dynamic executable'*|*'statically linked'*) ;;
        *)
          echo "focal: landlock-run is not statically linked:" >&2
          echo "$linkage" >&2
          exit 1
          ;;
      esac
      echo "focal: refit complete"
      ;;

    fetch-deps)
      # The recursive apt-cache idiom resolves each seed's FULL dependency tree regardless
      # of what this container happens to have installed — otherwise a container that
      # already carries libssl1.1 (because git was installed for the checkout) produces a
      # closure that fails on machines without it. Essential and core system packages are
      # dropped here, and install-deps.sh enforces the same rule on the target machine.
      mkdir -p "$DEPS_OUT"
      rm -f "$DEPS_OUT"/*.deb
      seeds_closure=''
      for seed in $SEEDS; do
        closure=$(apt-cache depends --recurse --no-recommends --no-suggests \
          --no-conflicts --no-breaks --no-replaces --no-enhances "$seed" \
          | grep -E '^[a-z0-9]' | sort -u)
        seeds_closure="$seeds_closure $closure"
      done
      for package in $seeds_closure; do
        ( cd "$DEPS_OUT" && apt-get download "$package" ) \
          || echo "focal: could not download ${package}" >&2
      done
      count=0
      for deb in "$DEPS_OUT"/*.deb; do
        [ -f "$deb" ] || continue
        name=$(dpkg-deb -f "$deb" Package)
        essential=$(dpkg-deb -f "$deb" Essential || true)
        if [ "$essential" = "yes" ]; then
          echo "focal: dropping Essential=yes package ${name}"
          rm -f "$deb"
          continue
        fi
        case "$name" in
          libc6|libc-bin|locales|systemd*|dbus*|libpam*|udev|login|passwd|libgcc*|libstdc*)
            echo "focal: dropping core system package ${name}"
            rm -f "$deb"
            continue
            ;;
        esac
        count=$((count + 1))
      done
      echo "focal: closure staged: ${count} package(s) in ${DEPS_OUT}"
      ls -la "$DEPS_OUT"
      ;;

    *)
      echo "focal: unknown stage ${stage}; use refit or fetch-deps" >&2
      exit 1
      ;;
  esac
done
