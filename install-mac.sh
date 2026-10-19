#!/bin/bash
# Installs Headliner via Adobe's own plugin installer (UPIA), so Creative Cloud keeps it.
# Restart Photoshop afterwards: Plugins > Headliner.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
node "$HERE/tools/bundle.js"
mkdir -p "$HERE/dist" && rm -f "$HERE/dist/Headliner.ccx"
(cd "$HERE/render" && zip -qr "$HERE/dist/Headliner.ccx" . -x '.*')
# only remove if installed (removing a missing plugin hangs the installer)
if "$UPIA" --list all 2>/dev/null | grep -q "Headliner "; then "$UPIA" --remove "Headliner" >/dev/null 2>&1 || true; fi
"$UPIA" --install "$HERE/dist/Headliner.ccx"
echo "Done. Restart Photoshop > Plugins > Headliner"
