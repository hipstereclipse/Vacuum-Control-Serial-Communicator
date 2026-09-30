#!/bin/bash
# macOS / Linux launcher for the Gauge Serial Communicator.
# Double-click on macOS (you may need to allow it in System Settings > Privacy & Security
# the first time), or run `bash "Launch Gauge Communicator.command"` from a terminal.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js was not found. Install the LTS version from https://nodejs.org/ and try again."
  echo
  exit 1
fi

node "scripts/launch.mjs"
