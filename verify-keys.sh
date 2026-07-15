#!/usr/bin/env bash
# Fails if prefs.js or extension.js reference a GSettings key that the extension's
# own schema XML does not define. This is the drift that silently ships a broken
# prefs window ("GSettings key <x> not found in schema ...") on every update.
#
# Run standalone or via install.sh (which calls it before copying anything).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

schema="$(ls "$REPO"/schemas/*.gschema.xml 2>/dev/null | head -1 || true)"
[[ -n "$schema" ]] || { echo "verify-keys: no *.gschema.xml under $REPO/schemas" >&2; exit 1; }

srcs=()
for f in prefs.js extension.js; do [[ -f "$REPO/$f" ]] && srcs+=("$REPO/$f"); done

# Keys the extension's own schema defines.
schema_keys="$(grep -oE 'name="[a-z][a-z0-9-]+"' "$schema" \
  | grep -oE '"[a-z][a-z0-9-]+"' | tr -d '"' | sort -u)"

methods='get_boolean|get_string|get_int|get_uint|get_double|get_value|get_strv|get_enum|get_flags|set_boolean|set_string|set_int|set_uint|set_double|set_value|set_strv|bind'

# Referenced keys against the extension's OWN settings object:
#   1. .get_*('key') / .set_*('key') / .bind('key', ...) accessors, minus any line
#      whose receiver is the foreign org.gnome.desktop.interface settings object
#      (theme / text-scaling reads — a different schema, not ours).
#   2. ['key', 'Human Label'] pair arrays fed to a settings.bind loop — recognised
#      by the second element being a human label (has an uppercase letter, space,
#      or slash), which excludes CSS-class arrays (['dim-label','caption']) and
#      argv arrays (['claude','-p',...]).
#
# Deliberately NOT scanned: connect('changed::key') signals. Those calls span
# multiple lines, so the foreign-receiver (interface settings) filter can't see
# the object and would false-positive on color-scheme / text-scaling-factor. Any
# key worth watching is also read via get_*/bind above, so coverage is unaffected.
ref_keys="$( {
  { grep -rhE "\.(${methods})\((['\"])[a-z][a-z0-9-]+\2" "${srcs[@]}" 2>/dev/null \
    | grep -vi interface \
    | grep -oE "\.(${methods})\((['\"])[a-z][a-z0-9-]+" | grep -oE '[a-z][a-z0-9-]+$'; } || true

  { grep -rhoE "\[(['\"])[a-z][a-z0-9-]+\1, *(['\"])[^'\"]*[A-Z/ ][^'\"]*\2" "$REPO/prefs.js" 2>/dev/null \
    | sed -E "s/^\[(['\"])([a-z0-9-]+)\1.*/\2/"; } || true
} | sort -u )"

missing=()
while IFS= read -r tok; do
  [[ -z "$tok" ]] && continue
  grep -qx "$tok" <<<"$schema_keys" || missing+=("$tok")
done <<<"$ref_keys"

if ((${#missing[@]})); then
  echo "verify-keys: FAIL — key(s) referenced in JS but absent from $(basename "$schema"):" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  echo "Fix: add the key to the schema, or correct the name in prefs.js/extension.js." >&2
  exit 1
fi

echo "verify-keys: OK — $(grep -c . <<<"$ref_keys") referenced keys all exist in $(basename "$schema")"
