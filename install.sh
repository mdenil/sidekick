#!/usr/bin/env bash
# Sidekick — one-command install for Mac / Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jscholz/sidekick/master/install.sh | bash
#
# Clones to ./sidekick in your CURRENT directory (cd into where you
# want it before running). Override with SIDEKICK_INSTALL_DIR=/abs/path.
#
# What it does:
#   1. Verifies node >= 22 (sidekick uses node 22's
#      --experimental-strip-types flag at runtime).
#   2. Clones the repo to ./sidekick (or pulls latest if already there).
#   3. Runs `npm install` at root + under `backends/stub/`.
#   4. Copies `.env.example` to `.env` (idempotent).
#   5. Starts the proxy + the in-tree stub agent (echo LLM) — no API
#      keys required. Open the printed URL.
#
# After it boots, point at a real backend by editing `./sidekick/.env`
# (uncomment SIDEKICK_PLATFORM_URL) and restarting `npm start`.

set -euo pipefail

INSTALL_DIR="${SIDEKICK_INSTALL_DIR:-$(pwd)/sidekick}"
REPO_URL="https://github.com/jscholz/sidekick.git"

echo "==> sidekick install — target: $INSTALL_DIR"

# 1. Node version check
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not installed. Install Node 22+ first:"
  echo "  macOS:   brew install node"
  echo "  Linux:   https://nodejs.org or your package manager"
  exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: node $(node -v) is too old. Sidekick requires Node 22+."
  echo "  Update via brew (\`brew upgrade node\`) or nvm."
  exit 1
fi
echo "==> node $(node -v) ✓"

# 2. Clone or pull
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "==> existing checkout — pulling latest"
  git -C "$INSTALL_DIR" pull --ff-only origin master
else
  echo "==> cloning $REPO_URL → $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# 3. npm install (root + agent)
echo "==> installing root dependencies"
npm install --no-audit --no-fund
if [ -f "backends/stub/package.json" ]; then
  echo "==> installing stub agent dependencies"
  (cd backends/stub && npm install --no-audit --no-fund)
fi

# 4. .env (idempotent)
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "==> created .env (copy of .env.example — edit to override)"
else
  echo "==> .env already exists (preserved)"
fi

# 5. Start
echo ""
echo "================================================================"
echo "  Sidekick is starting up."
echo ""
echo "  Defaults: proxy on :3001, in-tree stub agent on :4001 (echo"
echo "  LLM, no API keys required). Both ports auto-shift if busy"
echo "  (3002/4002, etc.)."
echo ""
echo "  Open the URL printed below in your browser."
echo "  Stop with Ctrl+C."
echo "================================================================"
echo ""

exec npm start
