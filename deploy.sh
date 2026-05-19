#!/usr/bin/env bash
set -euo pipefail

# el5/deploy.sh — rsync the web-servable files to el5.io.
#
# Pattern mirrors hacktrader/deploy.sh:
#   - SSH via ~/.ssh/pengo (override with SSH_KEY env var)
#   - rsync excludes everything that's research/dev cruft
#   - only ships files that should be served from the webroot

REMOTE="${EL5_REMOTE:-el5user@el5.io}"
REMOTE_PATH="${EL5_PATH:-/home/el5user/el5.io}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/pengo}"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> el5 deploy"
echo "    local:  ${LOCAL_DIR}"
echo "    remote: ${REMOTE}:${REMOTE_PATH}"
echo "    key:    ${SSH_KEY}"
echo

if [ ! -f "${SSH_KEY}" ]; then
  echo "ERROR: SSH key not found at ${SSH_KEY}" >&2
  echo "  Set SSH_KEY env var if your key is elsewhere." >&2
  exit 1
fi

# Excludes: research/dev files that should NOT land in the web root.
EXCLUDES=(
  --exclude='.git/'
  --exclude='.venv/'
  --exclude='.DS_Store'
  --exclude='__pycache__/'
  --exclude='*.pyc'
  --exclude='spike.py'
  --exclude='requirements.txt'
  --exclude='deploy.sh'
  --exclude='README.md'
  --exclude='data/'
  --exclude='results/'
  --exclude='docs/'
  --exclude='*.log'
  --exclude='*.tmp'
)

rsync -avz --delete "${EXCLUDES[@]}" \
  -e "ssh -i ${SSH_KEY} -o StrictHostKeyChecking=accept-new" \
  "${LOCAL_DIR}/" \
  "${REMOTE}:${REMOTE_PATH}/"

echo
echo "==> Done. Visit https://el5.io to verify."
