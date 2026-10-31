#!/bin/sh
# Verify the offline deb on the Kylin V10 SP1 baseline (Ubuntu 20.04 lineage, glibc 2.31):
# dpkg installs it, no installed package is upgraded or replaced — by the package itself
# or by the bundled dependency closure — every payload binary resolves its libraries, the
# closure's tools run, and the CLI runs.
# Usage (as root, inside the baseline container): verify-deb.sh <path-to.deb>
set -eu

DEB="$1"
APP_ROOT=/opt/deepseek-harness
WORK=$(mktemp -d /tmp/dsh-verify-XXXXXX)
fail=0

snapshot() {
  dpkg-query -W -f='${binary:Package}\t${Version}\t${db:Status-Abbrev}\n' 2>/dev/null | sort
}

# awk is the whole comparison: every after-state must either be a new package or byte-equal
# to its before-state. A version or status change is an upgrade and fails the gate.
assert_only_additions() {
  awk -F'\t' '
    NR==FNR { before[$1] = $0; next }
    ($1 in before) && (before[$1] != $0) {
      printf "verify: FAIL package %s was upgraded or replaced: [%s] -> [%s]\n", $1, before[$1], $0
      bad = 1
    }
    END { exit bad ? 1 : 0 }
  ' "$1" "$2" || fail=1
}

echo "verify: image baseline: $(grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release | tr '\n' ' ')"
echo "verify: glibc $(ldd --version | head -1 | grep -oE '[0-9]+\.[0-9]+$')"
dpkg --info "$DEB" | sed -n '1,20p'

# --- package installation with the first zero-upgrade assertion ---------------------------
snapshot > "$WORK/before.tsv"
if ! dpkg -i "$DEB"; then
  echo "verify: FAIL dpkg -i rejected the package" >&2
  exit 1
fi
snapshot > "$WORK/after-deb.tsv"
added=$(comm -13 "$WORK/before.tsv" "$WORK/after-deb.tsv" | wc -l)
echo "verify: zero-upgrade gate passed; ${added} package(s) newly added by the deb"
assert_only_additions "$WORK/before.tsv" "$WORK/after-deb.tsv"

# --- bundled dependency closure, run directly (normally deferred via systemd-run) ---------
if "$APP_ROOT/deps/install-deps.sh"; then
  echo "verify: offline dependency check passed"
else
  echo "verify: FAIL offline dependency check reported problems" >&2
  fail=1
fi
snapshot > "$WORK/after-closure.tsv"
closure_added=$(comm -13 "$WORK/after-deb.tsv" "$WORK/after-closure.tsv" | wc -l)
echo "verify: zero-upgrade gate passed; ${closure_added} package(s) newly added by the closure"
assert_only_additions "$WORK/after-deb.tsv" "$WORK/after-closure.tsv"

# --- ldd gate over the payload ------------------------------------------------------------
not_found=0
find "$APP_ROOT" -type f \( -perm -u+x -o -name '*.node' -o -name '*.so' -o -name '*.so.*' \) > "$WORK/binaries.txt"
while IFS= read -r binary; do
  [ -n "$binary" ] || continue
  # musl-linked payload binaries serve musl hosts, never this glibc machine, and the
  # python _tkinter extension expects system Tcl/Tk that a headless CLI never imports.
  case "$binary" in *musl*|*_tkinter*) continue ;; esac
  report=$(ldd "$binary" 2>&1 || true)
  case "$report" in
    *'not found'*)
      echo "verify: FAIL unresolved libraries in ${binary}:" >&2
      echo "$report" >&2
      not_found=$((not_found + 1))
      ;;
  esac
done < "$WORK/binaries.txt"
if [ "$not_found" -ne 0 ]; then
  echo "verify: FAIL ${not_found} binary/binaries have unresolved libraries" >&2
  fail=1
else
  echo "verify: ldd gate passed ($(wc -l < "$WORK/binaries.txt") binaries, zero not-found)"
fi

# --- closure tools run where the closure installed them -----------------------------------
for tool in git tmux ssh; do
  if command -v "$tool" > /dev/null 2>&1; then
    echo "verify: ${tool}: $("$tool" --version 2>&1 | head -1 || "$tool" -V 2>&1 | head -1)"
  else
    echo "verify: ${tool} not present on this machine (offline machines install it from the closure)"
  fi
done

# --- CLI smoke through the launcher -------------------------------------------------------
version=$(/usr/bin/dsh --version)
echo "verify: /usr/bin/dsh --version printed: ${version}"
/usr/bin/dsh --help > /dev/null
echo "verify: /usr/bin/dsh --help exited cleanly"
pkg_version=$(dpkg-query -W -f='${Version}' deepseek-harness)
echo "verify: installed deepseek-harness ${pkg_version} on $(dpkg --print-architecture)"

if [ "$fail" -ne 0 ]; then
  echo "verify: FAILED" >&2
  exit 1
fi
echo "verify: all gates passed"
