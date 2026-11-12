#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== System tools verification ==="
echo "Node: $(node -v)"
echo "NPM: $(npm -v)"
if [[ "$(uname -s)" != Linux ]]; then
  echo "Build Linux packages on Linux (or use the Linux build workflow)." >&2
  exit 1
fi
if ! command -v rpmbuild >/dev/null; then
  echo "Install rpm-build on Fedora or rpm on Debian/Ubuntu before building." >&2
  exit 1
fi

VERSION="$(node -p 'require("./package.json").version')"
echo "=== Building Linux distributions (AppImage, deb, rpm, tar.gz) for version $VERSION ==="
npm run dist:linux
cd dist
sha256sum "agent-terminal-ide-${VERSION}-"*.AppImage \
  "agent-terminal-ide-${VERSION}-"*.deb \
  "agent-terminal-ide-${VERSION}-"*.rpm \
  "agent-terminal-ide-${VERSION}-"*.tar.gz > "SHA256SUMS-${VERSION}-linux.txt"

