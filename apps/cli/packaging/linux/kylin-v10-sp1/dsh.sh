#!/bin/sh
# DeepSeek Harness CLI launcher installed by the deepseek-harness offline package.
# Absolute paths only: the machine needs nothing on PATH except this script.
exec /opt/deepseek-harness/runtime/primary-runtime/dependencies/node/bin/node \
  /opt/deepseek-harness/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
