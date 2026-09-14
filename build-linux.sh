#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== System tools verification ==="
echo "Node: $(node -v)"
echo "NPM: $(npm -v)"
echo "RPM build: $(rpmbuild --version)"
echo "DPKG: $(dpkg --version | head -n 1)"

echo "=== Building Linux distributions (AppImage, deb, rpm, tar.gz) for version 8.0.0 ==="
node ./node_modules/electron-builder/out/cli/cli.js --linux AppImage deb rpm tar.gz --x64

