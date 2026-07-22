#!/usr/bin/env bash
set -euo pipefail

# Rsync the web-servable files to a locally configured destination.
# Connection details are intentionally not stored in the repository.

REMOTE="${EL5_REMOTE:?Set EL5_REMOTE to the SSH destination}"
REMOTE_PATH="${EL5_PATH:?Set EL5_PATH to the remote web root}"
SSH_KEY="${SSH_KEY:?Set SSH_KEY to the local private key path}"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> el5 deploy"
echo "    local:  ${LOCAL_DIR}"
echo "    remote: ${REMOTE}:${REMOTE_PATH}"
echo "    key:    ${SSH_KEY}"
echo

if [ ! -f "${SSH_KEY}" ]; then
  echo "ERROR: SSH key not found at ${SSH_KEY}" >&2
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
  --exclude='gen_replay.py'
  --exclude='gen_macro.py'
  --exclude='requirements.txt'
  --exclude='deploy.sh'
  --exclude='README.md'
  --exclude='ios/'
  --include='data/'
  --include='data/replay.json'
  --exclude='data/**'
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
