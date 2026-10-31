#!/bin/sh
# Install only the system packages this machine is missing, from the bundled offline
# closure next to this script. The payload under /opt/deepseek-harness is self-contained;
# the closure carries the optional tools (git, tmux, openssh-client and their dependency
# trees) an offline machine cannot get from an archive.
#
# Rules, by design and not up for debate on a target machine:
#   - never upgrade a package that is already installed in any state;
#   - never install core system components (glibc, systemd, dbus, PAM, udev, login,
#     passwd, libgcc/libstdc++) or anything dpkg marks Essential — finding one in the
#     closure is a packaging bug and aborts here;
#   - install every missing package in ONE dpkg transaction so dpkg orders the
#     dependencies itself, then re-verify the payload with ldd and report what is missing.
set -u

APP_ROOT=/opt/deepseek-harness
DEPS_DIR="$APP_ROOT/deps"
fail=0
kept=0
missing=""

for deb in "$DEPS_DIR"/*.deb; do
  [ -f "$deb" ] || continue
  name=$(dpkg-deb -f "$deb" Package)
  essential=$(dpkg-deb -f "$deb" Essential || true)
  if [ "$essential" = "yes" ]; then
    echo "install-deps: refusing Essential=yes package ${name}; remove it from the closure" >&2
    fail=1
    continue
  fi
  case "$name" in
    libc6|libc-bin|locales|systemd*|dbus*|libpam*|udev|login|passwd|libgcc*|libstdc*)
      echo "install-deps: refusing core system package ${name}; remove it from the closure" >&2
      fail=1
      continue
      ;;
  esac
  status=$(dpkg-query -W -f='${db:Status-Abbrev}' "$name" 2>/dev/null || true)
  case "$status" in
    ii*)
      kept=$((kept + 1))
      continue
      ;;
  esac
  missing="$missing $deb"
done

if [ "$fail" -ne 0 ]; then
  echo "install-deps: closure contains refused packages; nothing was installed" >&2
  exit 1
fi

if [ -n "$missing" ]; then
  echo "install-deps: installing missing packages in one transaction:$missing"
  if ! dpkg -i $missing; then
    echo "install-deps: FAILED to install the missing packages" >&2
    exit 1
  fi
fi

missing_libs=0
candidates=$(find "$APP_ROOT" -type f \( -perm -u+x -o -name '*.node' -o -name '*.so' -o -name '*.so.*' \))
printf '%s\n' "$candidates" | while IFS= read -r binary; do
  [ -n "$binary" ] || continue
  # musl-linked payload binaries serve musl hosts, never this glibc machine.
  case "$binary" in */musl/*) continue ;; esac
  report=$(ldd "$binary" 2>&1 || true)
  case "$report" in
    *'not found'*)
      echo "install-deps: unresolved libraries in ${binary}:" >&2
      echo "$report" >&2
      echo unresolved >> "$DEPS_DIR/.ldd-unresolved"
      ;;
  esac
done
if [ -f "$DEPS_DIR/.ldd-unresolved" ]; then
  missing_libs=$(wc -l < "$DEPS_DIR/.ldd-unresolved")
  rm -f "$DEPS_DIR/.ldd-unresolved"
fi

if [ "$missing_libs" -ne 0 ]; then
  echo "install-deps: NOT READY — ${missing_libs} binary/binaries with unresolved libraries" >&2
  exit 1
fi
echo "install-deps: all dependencies ready (installed the missing set, already present ${kept})"
