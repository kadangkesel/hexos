#!/bin/bash
# Update hexos.kadangkesel.net after a new release
# Run on VPS: bash update-vps.sh <version>
# Or from CI: ssh user@vps 'bash -s' < deploy/update-vps.sh 0.2.0

set -euo pipefail

VERSION="${1:-}"
GITHUB_REPO="kadangkesel/hexos"
GITHUB_RAW="https://raw.githubusercontent.com/$GITHUB_REPO/master"
WEB_ROOT="/var/www/hexos"

if [ -z "$VERSION" ]; then
  echo "Usage: bash update-vps.sh <version>"
  echo "Example: bash update-vps.sh 0.2.0"
  exit 1
fi

echo "==> Updating hexos.kadangkesel.net to v$VERSION..."

# Update version file
echo "$VERSION" > "$WEB_ROOT/version"
echo "==> Updated version to $VERSION"

# Update installer scripts
curl -fsSL "$GITHUB_RAW/install.sh" -o "$WEB_ROOT/install.sh"
curl -fsSL "$GITHUB_RAW/install.ps1" -o "$WEB_ROOT/install.ps1"
echo "==> Updated installer scripts"

echo "==> Done! https://hexos.kadangkesel.net/version → $VERSION"
