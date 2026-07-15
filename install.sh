#!/usr/bin/env bash
# Installs the Multi-Provider Usage GNOME Shell extension for the current user.
#
# Copies this repo's runtime files into
# ~/.local/share/gnome-shell/extensions/<uuid>, compiles the GSettings schema,
# and enables the extension. Safe to re-run (idempotent) — e.g. after `git pull`
# to pick up an update.
#
# Fail-closed: verify-keys.sh runs first and aborts the install if prefs.js /
# extension.js reference a GSettings key the schema does not define (the drift
# that otherwise ships a broken preferences window).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="$(sed -n 's/.*"uuid": *"\(.*\)".*/\1/p' "$REPO/metadata.json")"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) echo "usage: $0 [--dry-run]"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

run() { if [[ "$DRY_RUN" -eq 1 ]]; then echo "+ $*"; else "$@"; fi; }

# Guard: keys must exist in schema before we ship anything.
"$REPO/verify-keys.sh"

echo "Installing $UUID to $DEST"

run mkdir -p "$DEST/schemas"
run cp "$REPO/extension.js" "$DEST/extension.js"
run cp "$REPO/prefs.js" "$DEST/prefs.js"
run cp "$REPO/stylesheet.css" "$DEST/stylesheet.css"
run cp "$REPO/metadata.json" "$DEST/metadata.json"
run cp "$REPO/schemas/org.gnome.shell.extensions.multi-provider-usage.gschema.xml" \
  "$DEST/schemas/org.gnome.shell.extensions.multi-provider-usage.gschema.xml"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "+ glib-compile-schemas $DEST/schemas"
  echo "+ gnome-extensions enable $UUID"
  exit 0
fi

glib-compile-schemas "$DEST/schemas"

if command -v gnome-extensions >/dev/null 2>&1; then
  gnome-extensions enable "$UUID" || true
fi

cat <<EOF

Installed. Restart GNOME Shell to load it:
  Wayland: log out and back in
  X11:     Alt+F2, type r, press Enter

Then enable it (if not already) via the Extensions app, or:
  gnome-extensions enable $UUID
EOF
