This directory holds the offline dependency closure: the .deb files the payload may need
on a machine that cannot reach an archive. It is staged by `focal-container.sh fetch-deps`
from the focal (Ubuntu 20.04) arm64 archive — the same lineage as Kylin V10 SP1 — and
currently carries git, tmux, openssh-client and the dependencies apt resolves as missing.

Rules for anyone adding packages here:
- install-deps.sh installs only what the machine is missing, never upgrades anything
  already installed, and installs the missing set in one dpkg transaction.
- Never add glibc, systemd, dbus, PAM, udev, login, passwd, libgcc, libstdc++, or any
  Essential=yes package. install-deps.sh refuses them; shipping one can destroy the
  target system.
- Packages must come from the Kylin V10 SP1 / Ubuntu 20.04 (focal) arm64 archive — same
  lineage as the target machine — so installing them never upgrades a system component.
- Run install-deps.sh after adding packages; it verifies every payload binary with ldd.
