// Preferences for Multi-Provider Usage.
//
// The Auth page is GENERIC — it discovers configured providers from the daemon
// and renders UI per `auth.kind`, never per provider name. Today the daemon
// knows two kinds: 'cookie' (client must paste + forward a session cookie) and
// 'oauth-file' (daemon reads a token file itself; nothing to configure here
// beyond showing its expiry). A third provider reusing either kind needs no
// changes to this file.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function daemonUrl(settings) {
    return settings.get_string('daemon-url').replace(/\/+$/, '');
}

// Per-provider display overrides (provider-alias / provider-subtitle) are
// GSettings dict types (a{ss}) — settings.bind() only works on scalars, so
// these two helpers do the read-modify-write by hand.
function getDictEntry(settings, key, id) {
    return settings.get_value(key).deep_unpack()[id] ?? '';
}

function setDictEntry(settings, key, id, value) {
    const dict = settings.get_value(key).deep_unpack();
    if (value)
        dict[id] = value;
    else
        delete dict[id]; // empty override = fall back to the daemon's own label/no subtitle
    settings.set_value(key, new GLib.Variant('a{ss}', dict));
}

// Caption-above-widget cell, same building block _displayPage's columnsBox
// uses for its switches — reused here so the Providers page reads as the
// same left-to-right "picture of the panel" pattern, not a different idiom.
function captionedCell(caption, widget) {
    const cell = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, halign: Gtk.Align.CENTER});
    const label = new Gtk.Label({label: caption, halign: Gtk.Align.CENTER});
    label.add_css_class('caption');
    cell.append(label);
    cell.append(widget);
    return cell;
}

// Clickable ActionRow — whole row activates, external-link glyph signals it.
// Gio.AppInfo.launch_default_for_uri hands off to the system browser; prefs
// windows have no Soup-safe reason to render link content themselves.
function linkRow(title, subtitle, uri) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic', valign: Gtk.Align.CENTER}));
    row.connect('activated', () => Gio.AppInfo.launch_default_for_uri(uri, null));
    return row;
}

function getJson(session, url) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', url);
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK) {
                    reject(new Error(`HTTP ${msg.get_status()}`));
                    return;
                }
                resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export default class MultiProviderUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const session = new Soup.Session({timeout: 15});

        window.add(this._generalPage(settings));
        window.add(this._displayPage(settings));
        const providersPage = this._providersPage(settings);
        window.add(providersPage);
        const authPage = this._authPage(settings, session);
        window.add(authPage);
        window.add(this._reportPage(settings, session));
        window.add(this._aboutPage());

        this._loadProviders(settings, session, authPage, providersPage);
    }

    _providersPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Providers',
            icon_name: 'font-x-generic-symbolic',
        });
        this._namesGroup = new Adw.PreferencesGroup({
            title: 'Display names',
            description: 'Optional per-provider overrides — daemon’s own label/letters are never changed, this is just a display overlay. Each row is left-to-right in panel order, same as the Display tab: Logo, Name, Label. Loading configured providers…',
        });
        page.add(this._namesGroup);
        return page;
    }

    // One horizontal row per provider, cells left-to-right in PANEL order —
    // Logo, Name, Label — mirroring _displayPage's columnsBox so the two
    // pages read as the same picture. Subtitle rides inside the Name cell
    // (stacked under the entry) since it has no separate panel column of its
    // own. `windows` (from the provider's live snapshot, may be []) drives
    // one Label entry per window — bar-label overrides are keyed
    // "providerId:windowId" since window ids repeat across providers.
    _nameRow(settings, id, config, iconVariants, windows) {
        const row = new Adw.PreferencesRow({activatable: false, selectable: false, title: config?.label ?? id});
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        row.set_child(box);

        const heading = new Gtk.Label({label: config?.label ?? id, width_chars: 10, xalign: 0});
        heading.add_css_class('heading');
        box.append(heading);

        // Logo
        if (iconVariants?.length > 1) {
            const names = ['default', ...iconVariants.filter(v => v !== 'default')];
            const icon = new Gtk.DropDown({model: Gtk.StringList.new(names)});
            const current = getDictEntry(settings, 'provider-icon-variant', id) || 'default';
            icon.selected = Math.max(0, names.indexOf(current));
            icon.connect('notify::selected', () => {
                const chosen = names[icon.selected];
                setDictEntry(settings, 'provider-icon-variant', id, chosen === 'default' ? '' : chosen);
            });
            box.append(captionedCell('Logo', icon));
        }

        // Name (+ subtitle, stacked underneath — no panel column of its own)
        const nameBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
        const alias = new Gtk.Entry({placeholder_text: config?.label ?? id, width_chars: 12});
        alias.set_text(getDictEntry(settings, 'provider-alias', id));
        alias.connect('changed', () =>
            setDictEntry(settings, 'provider-alias', id, alias.get_text().trim()));
        nameBox.append(alias);
        const subtitle = new Gtk.Entry({placeholder_text: 'Subtitle', width_chars: 12});
        subtitle.set_text(getDictEntry(settings, 'provider-subtitle', id));
        subtitle.connect('changed', () =>
            setDictEntry(settings, 'provider-subtitle', id, subtitle.get_text().trim()));
        subtitle.add_css_class('caption');
        nameBox.append(subtitle);
        box.append(captionedCell('Name', nameBox));

        // Label — one small entry per window, in the same order the panel
        // shows the bars (windows[] order IS display order, see README).
        for (const win of windows ?? []) {
            const dictId = `${id}:${win.id}`;
            const defaultLetter = win.letter?.toString()
                ?? (win.label ?? win.id ?? '?').toString().charAt(0).toUpperCase();
            const entry = new Gtk.Entry({placeholder_text: defaultLetter, width_chars: 3, max_length: 4});
            entry.set_text(getDictEntry(settings, 'bar-label', dictId));
            entry.connect('changed', () =>
                setDictEntry(settings, 'bar-label', dictId, entry.get_text().trim()));
            box.append(captionedCell(win.label ?? win.id, entry));
        }

        return row;
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Daemon',
            description: 'This extension reads every provider from a local usage-daemon.',
        });
        page.add(group);

        const url = new Adw.EntryRow({title: 'Daemon URL'});
        url.text = settings.get_string('daemon-url');
        url.connect('changed', () =>
            settings.set_string('daemon-url', url.text.trim()));
        group.add(url);

        const interval = new Adw.SpinRow({
            title: 'Client refresh interval (seconds)',
            subtitle: 'How often to re-read the daemon (the daemon does the real polling)',
            adjustment: new Gtk.Adjustment({lower: 10, upper: 3600, step_increment: 10}),
        });
        settings.bind('poll-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(interval);

        const rotate = new Adw.SpinRow({
            title: 'Panel rotation interval (seconds)',
            subtitle: 'How often the panel switches which provider it is showing. The popup always shows all providers regardless.',
            adjustment: new Gtk.Adjustment({lower: 2, upper: 300, step_increment: 1}),
        });
        settings.bind('rotate-interval', rotate, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(rotate);

        return page;
    }

    _displayPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Display',
            icon_name: 'view-reveal-symbolic',
        });

        // Horizontal toggle row, same pattern as claude-usage-extension's
        // prefs — one switch per panel column, left-to-right in panel order,
        // so the row is a literal picture of the bar. These are GLOBAL: they
        // apply to every provider's row(s) at once, not per-provider — there
        // is only one panel, showing whichever provider is currently active.
        const show = new Adw.PreferencesGroup({
            title: 'Show',
            description: 'The panel columns, in panel order. Applies to every provider — there is one panel, not one per provider.',
        });
        page.add(show);

        const columnsRow = new Adw.PreferencesRow({activatable: false, selectable: false});
        const columnsBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            homogeneous: true,
            spacing: 6,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        columnsRow.set_child(columnsBox);

        const panelColumns = [
            {key: 'show-icon', caption: 'Logo'},
            {key: 'show-provider-tag', caption: 'Name'},
            {key: 'show-bar-labels', caption: 'Label'},
            {key: 'show-panel-bar', caption: 'Bar'},
            {key: 'show-panel-percent', caption: 'Percent'},
        ];
        for (const col of panelColumns) {
            const cell = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 6,
                halign: Gtk.Align.CENTER,
            });
            const caption = new Gtk.Label({label: col.caption, halign: Gtk.Align.CENTER});
            caption.add_css_class('caption');
            const sw = new Gtk.Switch({halign: Gtk.Align.CENTER});
            settings.bind(col.key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
            cell.append(caption);
            cell.append(sw);
            columnsBox.append(cell);
        }
        show.add(columnsRow);

        const layout = new Adw.PreferencesGroup({title: 'Layout'});
        page.add(layout);
        const stack = new Adw.SwitchRow({
            title: 'Stack bars vertically',
            subtitle: 'Applies to whichever provider is currently showing in the panel',
        });
        settings.bind('stack-panel-bars', stack, 'active', Gio.SettingsBindFlags.DEFAULT);
        layout.add(stack);

        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        page.add(behaviour);
        const warn = new Adw.SwitchRow({
            title: 'Flash logo on projected depletion',
            subtitle: 'Flashes the panel icon if ANY provider is projected to hit 100% before reset. Rotation keeps cycling normally.',
        });
        settings.bind('warn-on-projected-depletion', warn, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(warn);

        return page;
    }

    _authPage(settings, session) {
        const page = new Adw.PreferencesPage({
            title: 'Auth',
            icon_name: 'dialog-password-symbolic',
        });
        this._authGroup = new Adw.PreferencesGroup({
            title: 'Provider authentication',
            description: 'Loading configured providers…',
        });
        page.add(this._authGroup);
        return page;
    }

    // Discovers configured providers + their auth.kind, then renders one row
    // per provider in BOTH the Auth and Providers groups — generic dispatch
    // on kind for auth, but Providers needs no dispatch at all (same fields
    // for every provider regardless of auth kind).
    async _loadProviders(settings, session, authPage, providersPage) {
        let list;
        try {
            list = await getJson(session, `${daemonUrl(settings)}/usage/providers`);
        } catch (e) {
            this._authGroup.description = `Could not reach daemon: ${e.message}`;
            this._namesGroup.description = `Could not reach daemon: ${e.message}`;
            return;
        }

        this._authGroup.description = '';
        this._namesGroup.description = '';
        for (const {provider: id} of list) {
            let config, snap;
            try {
                config = await getJson(session, `${daemonUrl(settings)}/usage/${id}/config`);
            } catch (_e) { continue; }
            try {
                snap = await getJson(session, `${daemonUrl(settings)}/usage/${id}/current`);
            } catch (_e) { /* no snapshot yet */ }
            let iconVariants = [];
            try {
                iconVariants = await getJson(session, `${daemonUrl(settings)}/usage/${id}/icons`);
            } catch (_e) { /* no icon(s) for this provider */ }

            const kind = config?.auth?.kind;
            if (kind === 'cookie')
                this._authGroup.add(this._cookieRow(settings, id, config));
            else if (kind === 'oauth-file')
                this._authGroup.add(this._oauthFileRow(config, snap));
            else
                this._authGroup.add(new Adw.ActionRow({
                    title: config?.label ?? id,
                    subtitle: `Unrecognized auth kind '${kind}' — nothing to configure here yet.`,
                }));

            this._namesGroup.add(this._nameRow(settings, id, config, iconVariants, snap?.windows));
        }
    }

    _cookieRow(settings, id, config) {
        const expander = new Adw.ExpanderRow({
            title: config?.label ?? id,
            subtitle: 'Session cookie — paste it here and it is sent to the daemon, which stores and uses it.',
        });

        const entry = new Adw.PasswordEntryRow({title: 'Cookie'});
        expander.add_row(entry);

        const status = new Gtk.Label({label: '', wrap: true, xalign: 0, margin_top: 6, margin_bottom: 6});
        status.add_css_class('dim-label');

        const send = new Gtk.Button({
            label: 'Send to daemon',
            halign: Gtk.Align.START,
            margin_top: 6,
            margin_bottom: 6,
            css_classes: ['suggested-action'],
        });
        send.connect('clicked', () => {
            const cookie = entry.text.trim();
            if (!cookie) {
                status.label = 'Nothing to send — paste a cookie first.';
                return;
            }
            status.label = 'Sending…';
            this._postCookie(settings, id, cookie, (ok, detail) => {
                status.label = ok ? `✓ ${detail}` : `✗ ${detail}`;
                if (ok)
                    entry.text = '';
            });
        });

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, margin_start: 12, margin_end: 12});
        box.append(send);
        box.append(status);
        const row = new Adw.ActionRow();
        row.set_child(box);
        expander.add_row(row);

        return expander;
    }

    _oauthFileRow(config, snap) {
        const expiresAt = snap?.token_expires_at;
        const subtitle = expiresAt
            ? `Reads its own credentials file directly — nothing to configure here. Token expires ${new Date(expiresAt).toLocaleString()}.`
            : 'Reads its own credentials file directly — nothing to configure here.';
        return new Adw.ActionRow({
            title: config?.label ?? config?.id,
            subtitle,
        });
    }

    _postCookie(settings, id, cookie, cb) {
        try {
            const session = new Soup.Session({timeout: 15});
            const msg = Soup.Message.new('POST', `${daemonUrl(settings)}/usage/${id}/cookie`);
            msg.set_request_body_from_bytes(
                'text/plain',
                new GLib.Bytes(new TextEncoder().encode(cookie)));
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    const code = msg.get_status();
                    if (code !== Soup.Status.OK) {
                        cb(false, `Daemon returned HTTP ${code}.`);
                        return;
                    }
                    const snap = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    if (snap.status === 'ok')
                        cb(true, 'Daemon accepted the cookie — live usage now flowing.');
                    else if (snap.status === 'auth_expired')
                        cb(false, 'Daemon stored it but the provider rejected it — cookie may be wrong or expired.');
                    else
                        cb(true, `Stored (status: ${snap.status}).`);
                } catch (e) {
                    cb(false, `Bad response from daemon: ${e.message}`);
                }
            });
        } catch (e) {
            cb(false, `Could not reach daemon: ${e.message}`);
        }
    }

    _reportPage(settings, session) {
        const page = new Adw.PreferencesPage({
            title: 'Report',
            icon_name: 'x-office-spreadsheet-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Combined usage report',
            description: 'All providers, over time. Reuses each provider\'s own daemon-served report ' +
                '(chart + table) — this just opens them together in one local page.',
        });
        page.add(group);

        const status = new Gtk.Label({label: '', wrap: true, xalign: 0, margin_top: 6});
        status.add_css_class('dim-label');

        const open = new Gtk.Button({
            label: 'Generate + open report',
            halign: Gtk.Align.START,
            margin_top: 6,
            css_classes: ['suggested-action'],
        });
        open.connect('clicked', async () => {
            status.label = 'Generating…';
            try {
                const uri = await this._generateReport(settings, session);
                Gio.AppInfo.launch_default_for_uri(uri, null);
                status.label = 'Opened.';
            } catch (e) {
                status.label = `Error: ${e.message}`;
            }
        });

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(open);
        box.append(status);
        const holder = new Adw.PreferencesGroup();
        holder.add(box);
        page.add(holder);

        return page;
    }

    // One page, one <iframe> per provider, each pointing straight at the
    // daemon's own existing per-provider report (report.js) — no chart code
    // duplicated here.
    async _generateReport(settings, session) {
        const base = daemonUrl(settings);
        const list = await getJson(session, `${base}/usage/providers`);
        const frames = list.map(({provider}) => `
            <h2 style="text-transform:capitalize">${provider}</h2>
            <iframe src="${base}/?provider=${encodeURIComponent(provider)}"></iframe>`).join('\n');

        const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Multi-Provider Usage report</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; max-width: 960px; }
  iframe { width: 100%; height: 460px; border: 1px solid #8884; border-radius: 6px; }
  h1 { font-size: 1.3rem; }
  h2 { font-size: 1rem; margin-top: 2rem; }
</style>
</head>
<body>
<h1>Multi-Provider Usage report</h1>
<p>Generated ${new Date().toLocaleString()}</p>
${frames}
</body>
</html>`;

        const outDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'multi-provider-usage']);
        GLib.mkdir_with_parents(outDir, 0o755);
        const outPath = GLib.build_filenamev([outDir, 'report.html']);
        GLib.file_set_contents(outPath, html);
        return GLib.filename_to_uri(outPath, null);
    }

    _aboutPage() {
        const page = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });

        const header = new Adw.PreferencesGroup();
        page.add(header);
        const headerBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
            margin_top: 12,
            margin_bottom: 12,
        });
        headerBox.append(new Gtk.Image({icon_name: 'utilities-system-monitor-symbolic', pixel_size: 48}));
        const title = new Gtk.Label({label: `<b>${this.metadata.name}</b>`, use_markup: true});
        headerBox.append(title);
        headerBox.append(new Gtk.Label({label: `v${this.metadata.version ?? 1}`, css_classes: ['dim-label']}));
        headerBox.append(new Gtk.Label({
            label: 'One panel indicator for every provider usage-daemon publishes. Thin\nclient only — reads localhost, never polls an upstream API itself.',
            justify: Gtk.Justification.CENTER,
            css_classes: ['dim-label'],
        }));
        const headerRow = new Adw.PreferencesRow({activatable: false, selectable: false});
        headerRow.set_child(headerBox);
        header.add(headerRow);

        const daemon = new Adw.PreferencesGroup({title: 'Daemon'});
        page.add(daemon);
        daemon.add(linkRow('usage-daemon', 'Owns polling, auth, history, burn-rate — required',
            'https://github.com/bubbabright/usage-daemon'));

        const standalones = new Adw.PreferencesGroup({
            title: 'Standalone extensions',
            description: 'Same providers, no daemon required — each polls and authenticates on its own.',
        });
        page.add(standalones);
        standalones.add(linkRow('Claude Usage', 'Claude Code usage, standalone (own engine)',
            'https://github.com/bubbabright/claude-usage-extension'));
        standalones.add(linkRow('SuperGrok Usage', 'SuperGrok / Grok Build usage, standalone (own engine)',
            'https://github.com/bubbabright/supergrok-usage-extension'));
        standalones.add(linkRow('Ollama Cloud Usage', 'Daemon-only descriptor-client template, superseded by this extension',
            'https://github.com/bubbabright/ollama-cloud-usage-extension'));

        const footer = new Adw.PreferencesGroup();
        page.add(footer);
        footer.add(linkRow('Report an issue', 'GitHub issues on this repo',
            `${this.metadata.url}/issues`));
        footer.add(new Adw.ActionRow({title: 'License', subtitle: 'MIT — see LICENSE in the repo'}));

        return page;
    }
}
