# Multi-Provider Usage (GNOME)

One panel for **every provider** my [usage-daemon](https://github.com/bubbabright/usage-daemon)
publishes. I do not edit this extension when I add a plugin on the daemon.

Repo: [`bubbabright/multi-provider-usage-extension`](https://github.com/bubbabright/multi-provider-usage-extension)  
UUID: `multi-provider-usage@bubbabright`

## Why this exists

Standalone Claude / Grok / Ollama bars are right for one product. I run several. I want
one glance surface and one place to handle secrets, without N pollers and N slightly
different truths.

This extension is a **thin client**. The daemon owns polling, auth, history, and burn-rate.
I only read localhost snapshots and render `windows[]`. I never call Anthropic, xAI, or
ollama.com myself.

**Proof:** Grok landed as a daemon plugin only. This extension needed **no code change and
no disable/enable ritual**. Panel, popup, and settings showed it from
`GET /usage/providers` + config + current.

## Densities

- **Panel**: one provider at a time, auto-rotate on a configurable interval (glance).
- **Popup**: every configured provider at once (overview), independent of rotation.
- **Prefs → Report**: builds a local page that embeds each provider's daemon-served
  report (analysis stays on the daemon; this shell stays light).

## User knows all

The daemon publishes everything it has. I do not invent short vs long bands as product law.
One provider's short window can be the same wall-clock as another's long.

Today:

- **Dashboard** (`GET /` on the daemon) multi-selects which providers get cards.
- **This extension** shows every provider the daemon has configured (panel rotates through
  all of them; popup lists all). Per-provider **display** overrides (alias, subtitle, icon
  variant, bar letters) are mine. Hide-from-rotation checkboxes are not implemented yet.

Window multi-select on one timeline is a daemon/web job (planned), not this panel's job.

## Zero-touch contract

Every provider-specific fact comes at runtime from:

- `GET /usage/providers`
- `GET /usage/{id}/config`
- `GET /usage/{id}/current`
- `GET /usage/{id}/icon` (and `/icons` for variants)

The only code branch on auth is the generic `auth.kind` enum (`cookie` | `oauth-file`),
never a provider name string. Cookie paste posts to `POST /usage/{id}/cookie`. OAuth-file
providers show token expiry from the snapshot when the daemon exposes it. The cookie is
never stored in GSettings.

## Requires

- GNOME Shell 46-49
- [usage-daemon](https://github.com/bubbabright/usage-daemon) running (default
  `http://127.0.0.1:8787`) with one or more providers enabled

## Install (dev)

```bash
./install.sh            # copies into ~/.local/share/gnome-shell/extensions/, compiles schema, enables
./install.sh --dry-run  # show what it would do
```

Wayland: log out/in (or use a nested shell) on first install.

## Panel

- Icon + active provider display name (daemon label, or my alias) + its bars, one letter
  per window, cycling every **rotation interval** (Preferences → General).
- If **any** provider has a window with `will_deplete` and depletion flash is on, the
  panel **icon flashes**. Rotation keeps cycling. Flash is the signal; I do not pin the
  rotation to the depleting provider.
- When the daemon is unreachable or a provider's data is stale, that shows as dimmed style
  plus a status line in the menu.

## Popup

Every configured provider: header (label + tier + status) then its windows (percent +
reset), all at once.

## Preferences

- **General**: daemon URL, client refresh interval, panel rotation interval.
- **Display**: global show/hide for icon, provider name, bar letters, bars, percents;
  stack bars; flash logo on projected depletion.
- **Providers**: optional display overlays only (alias, subtitle, icon variant, bar letter
  overrides keyed by `providerId:windowId`). Daemon labels are not rewritten server-side.
- **Auth**: one row per configured provider, from `auth.kind` (cookie paste vs oauth-file
  status).
- **Report**: generate + open a local page embedding each provider's daemon report.
- **About**.

## Related projects

- [usage-daemon](https://github.com/bubbabright/usage-daemon) (required hub)
- [claude-usage-extension](https://github.com/bubbabright/claude-usage-extension) (Claude standalone)
- [supergrok-usage-extension](https://github.com/bubbabright/supergrok-usage-extension) (Grok standalone)
- [ollama-cloud-usage-extension](https://github.com/bubbabright/ollama-cloud-usage-extension) (single-provider thin client this generalizes to N)

## License

MIT, see [LICENSE](LICENSE).
