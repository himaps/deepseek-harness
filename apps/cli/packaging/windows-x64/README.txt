DeepSeek Harness CLI — Windows x64
==================================

This folder is self-contained: it bundles its own Node.js, pnpm, Python runtime and the
@deepseek-ai/dsh CLI. It needs nothing from the machine except 64-bit Windows itself and
works fully offline. The installer placed it in %PROGRAMFILES%\deepseek-harness and added
that folder to the machine PATH, so `dsh` works from any terminal.

Quick start
  dsh --version
  dsh --profile headless "your task"
  (headless mode needs a DEEPSEEK_API_KEY environment variable or a root .env;
  everything else works offline)

Layout
  runtime\primary-runtime\   bundled Node.js, pnpm and Python (do not modify)
  dsh\                       the installed @deepseek-ai/dsh CLI and its dependencies
  office-skills\             Office skill assets used by the harness
  dsh.cmd                    CLI launcher with absolute paths into this folder
  uninstall.exe              removes the folder and the machine PATH entry

Notes
  - First runs create session state under your profile (DSH home), never inside this
    folder.
  - To uninstall: run uninstall.exe in this folder, or use "Add or Remove Programs".
