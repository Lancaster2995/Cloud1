#!/usr/bin/env bash
# Takes screenshots of the app in an iOS simulator with demo data.
# Usage (from ios/): scripts/screenshots.sh <simulator-udid> <path/to/Relevo.app> <output-dir>
set -euo pipefail
UDID="$1"
APP="$2"
OUT="$3"
BUNDLE=io.github.lancaster2995.relevo
mkdir -p "$OUT"

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl status_bar "$UDID" override --time "9:41" --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3 || true
xcrun simctl ui "$UDID" appearance light || true
xcrun simctl install "$UDID" "$APP"

shot() {
  local name="$1" screen="$2" wait="${3:-6}"
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
  xcrun simctl launch "$UDID" "$BUNDLE" -RelevoDemo -RelevoScreen "$screen"
  sleep "$wait"
  xcrun simctl io "$UDID" screenshot "$OUT/ios-$name.png"
  echo "captured ios-$name.png"
}

shot 1-proyectos projects
shot 2-cuentas accounts
shot 3-proyecto detail
shot 4-sesion session 18
shot 5-guia guide
xcrun simctl ui "$UDID" appearance dark || true
shot 6-proyectos-oscuro projects
shot 7-sesion-oscuro session 18
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
