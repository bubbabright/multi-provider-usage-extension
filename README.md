# Multi-Provider Usage: GNOME Shell extension

Shows usage for **every provider** a [usage-daemon](https://github.com/bubbabright/usage-daemon)
publishes, in one panel indicator. Three surfaces, three densities:

- **Panel** — one provider at a time, auto-rotating on a configurable interval (glance).
- **Popup** — every configured provider at once, compact (overview).
- **Report** (in Preferences) — every provider over time (analysis), by opening each
  provider's own daemon-served report together in one page.

It is a **thin client**: the daemon owns polling, auth, history and burn-rate. This
extension only reads the daemon's snapshots over localhost and renders them. It never
polls an upstream provider API itself.

**A new daemon provider requires zero changes to this extension.** Every provider-specific
fact — id, label, windows, colors, letters, tier, auth kind — comes only from
`GET /usage/providers` + `GET /usage/{id}/config` + `GET /usage/{id}/current` at runtime.
The only place behavior branches at all is the generic `auth.kind` enum
(`'cookie' | 'oauth-file'`), never a provider name.

## Requires

- GNOME Shell 46–49
- [usage-daemon](https://github.com/bubbabright/usage-daemon) running (default
  `http://127.0.0.1:8787`) with one or more providers enabled

## Install (dev)

```bash
./install.sh            # copies into ~/.local/share/gnome-shell/extensions/, compiles schema, enables
./install.sh --dry-run  # show what it would do
```

Wayland: log out/in (or use a nested shell) to pick it up.

## Panel

- Icon + active provider's name + its bars, one letter per window, cycling every
  **rotation interval** (Preferences → General).
- If **any** provider's window is projected to hit 100% before its reset (and the
  depletion warning is enabled), the panel **icon flashes** — rotation keeps cycling
  normally, the flash is the only signal. Snooze support is planned, ported from the
  standalone per-provider extensions once this build is proven.
- When the daemon is unreachable, or a provider's data is stale, that's reflected with a
  dimmed style + a status line in the menu.

## Popup

Every configured provider, header (label + tier + status) followed by its windows
(percent + reset time), all at once — independent of what the panel is currently rotated to.

## Preferences

- **General**: daemon URL, client refresh interval, panel rotation interval.
- **Display**: show/hide icon, provider name, bar letters; stack bars; depletion warning.
- **Auth**: one row per configured provider, rendered generically from its `auth.kind` —
  a cookie-paste field for `'cookie'` providers, a read-only token-expiry status for
  `'oauth-file'` providers.
- **Report**: generates + opens a local page embedding every provider's own daemon report.
- **About**.

## v1 scope notes

- All daemon-configured providers rotate in the panel; per-provider inclusion checkboxes
  are a planned v1.1 addition.
- Rotation is pure auto-advance — no manual advance/pause, no alarm-interrupt. A depleting
  provider flashes the logo instead of pinning the rotation.

## Related projects

- [usage-daemon](https://github.com/bubbabright/usage-daemon) — the daemon this extension requires.
- [claude-usage-extension](https://github.com/bubbabright/claude-usage-extension) — Claude Code usage, standalone (no daemon).
- [grok-usage-extension](https://github.com/bubbabright/supergrok-usage-extension) — SuperGrok / Grok Build usage, standalone.
- [ollama-cloud-usage-extension](https://github.com/bubbabright/ollama-cloud-usage-extension) — single-provider thin daemon client; this extension generalizes that template to N providers.

## License

MIT, see [LICENSE](LICENSE).
