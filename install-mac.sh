#!/bin/bash
# Installs MS Render via Adobe's own plugin installer (UPIA), so Creative Cloud keeps it.
# Restart Photoshop afterwards: Plugins > MS Render.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
mkdir -p "$HERE/dist" && rm -f "$HERE/dist/MS-Render.ccx"
(cd "$HERE/render" && zip -qr "$HERE/dist/MS-Render.ccx" . -x '.*')
# only remove if installed (removing a missing plugin hangs the installer)
if "$UPIA" --list all 2>/dev/null | grep -q "MS Render "; then "$UPIA" --remove "MS Render" >/dev/null 2>&1 || true; fi
"$UPIA" --install "$HERE/dist/MS-Render.ccx"
echo "Done. Restart Photoshop > Plugins > MS Render"
