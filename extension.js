// Multi-Provider Usage — GNOME Shell panel indicator.
//
// A THIN CLIENT of usage-daemon (github.com/bubbabright/usage-daemon). It shows
// EVERY provider the daemon publishes, discovered at runtime via GET /usage/providers
// — nothing here names a specific provider. Three surfaces, three densities:
//   - panel: ONE provider at a time, auto-rotating on a configurable interval (glance)
//   - popup: ALL configured providers at once, compact (overview)
//   - report: opened from prefs, all providers over time (analysis)
//
// CONTRACT = the daemon's `windows[]` descriptor, same as ollama-cloud-usage-extension:
// each window is a meter descriptor {id, label, pct, color, resets_at, will_deplete}.
// A provider's identity (id, label, windows, colors, auth kind) comes ONLY from the
// daemon's GET /usage/providers + GET /usage/{id}/config + GET /usage/{id}/current
// responses. Adding a new daemon provider requires ZERO changes to this file.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TRACK_W = 46; // px width of a panel bar track

function resetsIn(iso) {
    if (!iso)
        return '';
    const ms = Date.parse(iso) - Date.now();
    if (Number.isNaN(ms))
        return '';
    if (ms <= 0)
        return 'Resets now';
    const mins = Math.round(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h >= 24)
        return `Resets in ${Math.floor(h / 24)}d ${h % 24}h`;
    if (h > 0)
        return `Resets in ${h}h ${m}m`;
    return `Resets in ${m}m`;
}

// Fixed-width (5 chars, right-padded to the left) so the percent column
// never resizes as digit count varies between providers (claude rounds to
// whole numbers, ollama reports one decimal, e.g. "60.3%") — pairs with
// .mp-bar-percent's monospace font in stylesheet.css. That combination (fixed
// char count + monospace) makes the rendered width invariant to which font
// actually resolves, unlike guessing a pixel width against one font's
// metrics (breaks on a wider font like OpenDyslexic).
function fmtPct(pct) {
    const s = pct == null ? '-' : (Number.isInteger(pct) ? pct : pct.toFixed(1)) + '%';
    return s.padStart(5);
}

// Panel abbreviation for a descriptor: explicit `letter` used verbatim (may be
// multiple chars, e.g. '5h', 'Wk', 'Mo', 'Se'); else first letter of label as
// a generic fallback for providers that don't set one. Column width is fixed
// in CSS (.mp-bar-letter) so 1- and 2-char abbreviations align.
function letterFor(win) {
    if (win.letter)
        return win.letter.toString();
    return (win.label ?? win.id ?? '?').toString().charAt(0).toUpperCase();
}

const MultiProviderUsageIndicator = GObject.registerClass(
class MultiProviderUsageIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Multi-Provider Usage');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._session = new Soup.Session({timeout: 10});

        this._order = [];            // provider ids, in daemon-reported order
        this._providers = new Map(); // provider id -> {config, snapshot}
        this._activeIdx = 0;
        this._bars = new Map();      // window.id -> bar actors (reused across rotation)
        this._menuSections = new Map(); // provider id -> {header, section}
        this._iconPaths = new Map(); // provider id -> cached icon file path, or null if none

        this._buildPanel();
        this._buildMenuSkeleton();

        this._settingsChanged = this._settings.connect('changed', () => {
            this._applyVisibility();
            this._restartPollTimer();
            this._restartRotateTimer();
        });

        this._applyVisibility();
        this._pollAll();
        this._restartPollTimer();
        this._restartRotateTimer();
    }

    // ---- panel ----
    // Everything — icon, provider tag, subtitle, every bar — is ONE
    // Clutter.GridLayout. Explicit (col, row) cells for every piece is what
    // actually fixes the layout bugs (stacked-mode overflow, column
    // collisions): BoxLayout's implicit sizing was the root cause, not a CSS
    // tuning problem. Icon = col 0, tag = col 1, subtitle = col 2, bars start
    // at col 3. Cell map lives in _renderPanelActive, the only place that
    // knows the current settings.
    _buildPanel() {
        this._panelGrid = new Clutter.GridLayout();
        this._panelGrid.set_column_spacing(8);
        this._panelGrid.set_row_spacing(2);
        this._panelBox = new St.Widget({
            style_class: 'panel-status-menu-box mp-panel',
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: this._panelGrid,
        });
        this.add_child(this._panelBox);

        // Icon starts generic; swapped per-provider once its icon is fetched
        // from the daemon (GET /usage/{id}/icon) and cached to disk. Falls
        // back to this stock icon if the provider ships none.
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string('utilities-system-monitor-symbolic'),
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._iconAttached = false;

        this._providerTag = new St.Label({
            text: '',
            style_class: 'mp-provider-tag',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Shrink-to-fit, not wrap: a 2nd line would grow this cell taller
        // than the panel, same overflow bug the bars had. max-width (CSS)
        // caps the column; ellipsize (Pango, not a CSS property) truncates
        // the text itself once it hits that cap.
        this._providerTag.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._tagAttached = false;

        // User-chosen alias override for the tag (`provider-alias` setting)
        // shows in _providerTag itself, same cell — this is a SEPARATE,
        // optional side-by-side box (`provider-subtitle`, e.g. "API"), not a
        // second line. Same shrink-to-fit treatment.
        this._providerSubtitle = new St.Label({
            text: '',
            style_class: 'mp-provider-subtitle',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._providerSubtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._subtitleAttached = false;
    }

    // Per-provider display overlay: user can name-and-tag a provider in
    // Settings without touching the daemon's own identity. Unset id ->
    // daemon's own label / no subtitle, so a brand new provider needs no
    // per-provider code — same zero-touch rule as everything else here.
    _aliasFor(id, config) {
        const aliases = this._settings.get_value('provider-alias').deep_unpack();
        return aliases[id] || config?.label || id;
    }

    _subtitleFor(id) {
        const subs = this._settings.get_value('provider-subtitle').deep_unpack();
        return subs[id] || '';
    }

    // Attach/detach/reposition an actor in the panel grid based on a setting.
    // `stateObj` holds the attached-flag (either `this`, for icon/tag, or a
    // per-bar object, since bars need their own independent flags) under
    // `attachedKey`. Two things this must get right:
    //   - Detach entirely when off (not just hide) — an invisible-but-attached
    //     actor still reserves its column's grid space.
    //   - Clutter.GridLayout.attach() asserts the child has no parent yet, so
    //     repositioning an already-attached actor by calling attach() again
    //     crashes (`assertion 'child->priv->parent == NULL' failed`, hit on
    //     every render since rotation/polling repositions bars constantly).
    //     Detach-then-reattach avoids it using only the two calls already
    //     proven safe, rather than the unverified child-property API.
    _attachIfNeeded(actor, stateObj, attachedKey, want, col, row, colSpan, rowSpan) {
        if (want) {
            if (stateObj[attachedKey])
                this._panelBox.remove_child(actor);
            this._panelGrid.attach(actor, col, row, colSpan, rowSpan);
            stateObj[attachedKey] = true;
        } else if (stateObj[attachedKey]) {
            this._panelBox.remove_child(actor);
            stateObj[attachedKey] = false;
        }
    }

    _makeBar() {
        const label = new St.Label({
            style_class: 'mp-bar-letter',
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const track = new St.Widget({
            style_class: 'mp-bar-track',
            style: `width:${TRACK_W}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const fill = new St.Widget({style_class: 'mp-bar-fill'});
        track.add_child(fill);
        const percent = new St.Label({
            style_class: 'mp-bar-percent',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // labelAttached/trackAttached/percentAttached track this bar's own
        // grid attachment state, same reasoning as _attachIfNeeded: detach
        // entirely (not just hide) so a disabled column doesn't reserve space.
        return {label, track, fill, percent, labelAttached: false, trackAttached: false, percentAttached: false};
    }

    // Ensure a bar exists for a descriptor and update its visual state (text/
    // fill/color/visibility flags). Grid placement happens separately in
    // _renderPanelActive, which knows the full window list and stack setting.
    _syncBar(win) {
        let bar = this._bars.get(win.id);
        if (!bar) {
            bar = this._makeBar();
            this._bars.set(win.id, bar);
        }
        bar.label.text = letterFor(win);
        bar.label.style = `color:${win.color ?? ''};`;
        const pct = win.pct == null ? null : Math.max(0, Math.min(100, win.pct));
        const px = pct == null ? 0 : Math.round((pct / 100) * TRACK_W);
        bar.fill.style = `width:${px}px; background-color:${win.color ?? '#888'};`;
        bar.percent.text = fmtPct(win.pct);
        bar.percent.style = `color:${win.color ?? ''};`;
        return bar;
    }

    _applyVisibility() {
        // show-icon/show-provider-tag/stack-panel-bars/show-bar-labels all
        // change grid attachment, not just a style class — recompute the
        // actual cell map, not just visibility flags.
        this._renderPanelActive();
    }

    // Render the panel for whichever provider is currently active (rotated
    // to). Owns the ENTIRE grid cell map — icon, tag, and every bar — since
    // it's the only place that knows both the current settings and the
    // current window list together.
    _renderPanelActive() {
        const stacked = this._settings.get_boolean('stack-panel-bars');
        const showIcon = this._settings.get_boolean('show-icon');
        const showTag = this._settings.get_boolean('show-provider-tag');

        if (this._order.length === 0) {
            this._attachIfNeeded(this._icon, this, '_iconAttached', showIcon, 0, 0, 1, 1);
            this._attachIfNeeded(this._providerTag, this, '_tagAttached', showTag, 1, 0, 1, 1);
            this._attachIfNeeded(this._providerSubtitle, this, '_subtitleAttached', false, 2, 0, 1, 1);
            this._providerTag.text = '';
            for (const [id, bar] of this._bars) {
                bar.label.destroy();
                bar.track.destroy();
                bar.percent.destroy();
                this._bars.delete(id);
            }
            this._panelBox.remove_style_class_name('mp-stale');
            return;
        }

        const id = this._order[this._activeIdx % this._order.length];
        const entry = this._providers.get(id);
        const config = entry?.config;
        const snap = entry?.snapshot;
        const windows = snap?.windows ?? [];
        const ids = new Set(windows.map(w => w.id));

        // R = how many rows the panel actually has right now. 1 whenever
        // bars are side by side; when stacked, R = however many windows this
        // provider has THIS render — not a hardcoded 2. A 3-window provider
        // just gets 3 rows, no code change. Every placement below derives
        // from R instead of branching separately on the stacked boolean.
        const rows = stacked ? Math.max(windows.length, 1) : 1;

        this._attachIfNeeded(this._icon, this, '_iconAttached', showIcon, 0, 0, 1, rows);

        this._providerTag.text = this._aliasFor(id, config);
        const subtitleText = this._subtitleFor(id);
        this._providerSubtitle.text = subtitleText;
        const subtitleWant = showTag && !!subtitleText;
        this._attachIfNeeded(this._providerTag, this, '_tagAttached', showTag, 1, 0, 1, 1);
        // R>=2: subtitle stacks under the tag, same column (row 1) — mirrors
        // the bar rows beside it. R===1: no second row to put it in, so it
        // goes beside the tag instead, its own column — same reason bars
        // start one column later (3, not 2) whenever R===1.
        if (rows >= 2)
            this._attachIfNeeded(this._providerSubtitle, this, '_subtitleAttached', subtitleWant, 1, 1, 1, 1);
        else
            this._attachIfNeeded(this._providerSubtitle, this, '_subtitleAttached', subtitleWant, 2, 0, 1, 1);
        const barStartCol = rows >= 2 ? 2 : 3;

        const iconPath = this._iconPaths.get(id);
        this._icon.gicon = Gio.icon_new_for_string(iconPath || 'utilities-system-monitor-symbolic');

        // Each bar's own label/track/percent columns go through the same
        // _attachIfNeeded as icon/tag (detach-then-reattach, per-bar
        // attached-flags on the bar object itself). Stacked = one row per
        // window, column cursor resets each row; unstacked = one row total,
        // cursor keeps advancing.
        const showLabel = this._settings.get_boolean('show-bar-labels');
        const showBar = this._settings.get_boolean('show-panel-bar');
        const showPercent = this._settings.get_boolean('show-panel-percent');
        let col = barStartCol;
        windows.forEach((win, i) => {
            const bar = this._syncBar(win);
            const row = stacked ? i : 0;
            if (stacked)
                col = barStartCol;
            const place = (actor, attachedKey, want) => {
                this._attachIfNeeded(actor, bar, attachedKey, want, col, row, 1, 1);
                if (want)
                    col++;
            };
            place(bar.label, 'labelAttached', showLabel);
            place(bar.track, 'trackAttached', showBar);
            place(bar.percent, 'percentAttached', showPercent);
        });
        for (const [wid, bar] of this._bars) {
            if (!ids.has(wid)) {
                bar.label.destroy();
                bar.track.destroy();
                bar.percent.destroy();
                this._bars.delete(wid);
            }
        }

        const stale = snap?.stale ?? true;
        this._panelBox[stale ? 'add_style_class_name' : 'remove_style_class_name']('mp-stale');
    }

    // Any provider/window projected to deplete flashes the logo (not a rotation
    // interrupt — the panel keeps cycling normally). Snooze is a future addition,
    // ported from the standalone exts after this build is proven.
    _applyAlarmState() {
        const warn = this._settings.get_boolean('warn-on-projected-depletion');
        let alarming = false;
        if (warn) {
            for (const {snapshot} of this._providers.values()) {
                if (snapshot?.windows?.some(w => w.will_deplete)) {
                    alarming = true;
                    break;
                }
            }
        }
        this._icon[alarming ? 'add_style_class_name' : 'remove_style_class_name']('mp-icon-alarm');
    }

    // ---- menu ----
    _buildMenuSkeleton() {
        this._menuHeader = new PopupMenu.PopupMenuItem('Multi-Provider Usage', {
            reactive: false,
            style_class: 'mp-menu-header',
        });
        this.menu.addMenuItem(this._menuHeader);

        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._statusItem.label.style_class = 'mp-menu-status';
        this.menu.addMenuItem(this._statusItem);
        this._statusItem.visible = false;

        // one dynamic section per provider, keyed by provider id
        this._providersSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._providersSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => this._refreshAll());
        this.menu.addMenuItem(refresh);

        const settings = new PopupMenu.PopupMenuItem('Settings');
        settings.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settings);
    }

    // Combined popup: every configured provider, all at once, compact.
    _rebuildMenu() {
        const seen = new Set(this._order);

        for (const id of this._order) {
            const entry = this._providers.get(id);
            const config = entry?.config;
            const snap = entry?.snapshot;

            let m = this._menuSections.get(id);
            if (!m) {
                const header = new PopupMenu.PopupMenuItem('', {
                    reactive: false,
                    style_class: 'mp-menu-provider-header',
                });
                const section = new PopupMenu.PopupMenuSection();
                const rows = new Map();
                this._providersSection.addMenuItem(header);
                this._providersSection.addMenuItem(section);
                m = {header, section, rows};
                this._menuSections.set(id, m);
            }

            const tier = snap?.tier && snap.tier !== 'unknown' ? ` (${snap.tier})` : '';
            const status = snap?.status && snap.status !== 'ok' ? `  —  ${snap.status.replace('_', ' ')}` : '';
            m.header.label.text = `${config?.label ?? id}${tier}${status}`;

            const windows = snap?.windows ?? [];
            const wids = new Set(windows.map(w => w.id));
            for (const win of windows) {
                let row = m.rows.get(win.id);
                if (!row) {
                    row = new PopupMenu.PopupMenuItem('', {reactive: false});
                    m.rows.set(win.id, row);
                    m.section.addMenuItem(row);
                }
                const reset = resetsIn(win.resets_at);
                row.label.text = `   ${win.label ?? win.id}   ${fmtPct(win.pct)}${reset ? '   ' + reset : ''}`;
            }
            for (const [wid, row] of m.rows) {
                if (!wids.has(wid)) {
                    row.destroy();
                    m.rows.delete(wid);
                }
            }
        }

        // drop sections for providers the daemon no longer publishes
        for (const [id, m] of this._menuSections) {
            if (!seen.has(id)) {
                m.header.destroy();
                m.section.destroy();
                this._menuSections.delete(id);
            }
        }
    }

    // ---- data ----
    _daemonUrl() {
        return this._settings.get_string('daemon-url').replace(/\/+$/, '');
    }

    _restartPollTimer() {
        if (this._pollTimer)
            GLib.source_remove(this._pollTimer);
        const secs = this._settings.get_int('poll-interval');
        this._pollTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._pollAll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _restartRotateTimer() {
        if (this._rotateTimer) {
            GLib.source_remove(this._rotateTimer);
            this._rotateTimer = null;
        }
        const secs = this._settings.get_int('rotate-interval');
        this._rotateTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            if (this._order.length > 1) {
                this._activeIdx = (this._activeIdx + 1) % this._order.length;
                this._renderPanelActive();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _getJson(path) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', `${this._daemonUrl()}${path}`);
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    if (msg.get_status() !== Soup.Status.OK) {
                        reject(new Error(`daemon returned ${msg.get_status()} for ${path}`));
                        return;
                    }
                    resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    // Raw bytes + content-type — used for icons (binary), unlike _getJson.
    _getBytes(path) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', `${this._daemonUrl()}${path}`);
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    if (msg.get_status() !== Soup.Status.OK) {
                        reject(new Error(`daemon returned ${msg.get_status()} for ${path}`));
                        return;
                    }
                    const contentType = msg.get_response_headers().get_one('Content-Type') ?? '';
                    resolve({bytes: bytes.get_data(), contentType});
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    // Fetch a provider's icon once (GET /usage/{id}/icon) and cache it to disk
    // so St.Icon can load it by path. Nothing here names a specific provider —
    // any daemon plugin that ships an icon file just starts appearing. No icon
    // -> cached as null, panel falls back to the stock icon for that provider.
    async _ensureIcon(id) {
        const EXT_BY_TYPE = {
            'image/svg+xml': 'svg',
            'image/png': 'png',
            'image/jpeg': 'jpg',
        };
        try {
            const {bytes, contentType} = await this._getBytes(`/usage/${id}/icon`);
            const ext = EXT_BY_TYPE[contentType.split(';')[0].trim()];
            if (!ext) {
                this._iconPaths.set(id, null);
                return;
            }
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'multi-provider-usage', 'icons']);
            GLib.mkdir_with_parents(dir, 0o755);
            const path = GLib.build_filenamev([dir, `${id}.${ext}`]);
            GLib.file_set_contents(path, bytes);
            this._iconPaths.set(id, path);
        } catch (_e) {
            this._iconPaths.set(id, null);
        }
    }

    async _pollAll() {
        let list;
        try {
            list = await this._getJson('/usage/providers');
        } catch (_e) {
            this._renderOffline('Daemon offline');
            return;
        }

        this._order = list.map(p => p.provider);
        if (this._activeIdx >= this._order.length)
            this._activeIdx = 0;

        await Promise.all(this._order.map(async id => {
            const entry = this._providers.get(id) ?? {};
            if (!entry.config) {
                try {
                    entry.config = await this._getJson(`/usage/${id}/config`);
                } catch (_e) { /* config rarely changes; retry next poll */ }
            }
            try {
                entry.snapshot = await this._getJson(`/usage/${id}/current`);
            } catch (_e) { /* keep last-known snapshot */ }
            this._providers.set(id, entry);

            // Icon fetch is once-per-session, fire-and-forget; re-render the
            // panel if it lands while this provider happens to be active.
            if (!this._iconPaths.has(id)) {
                this._iconPaths.set(id, null);
                this._ensureIcon(id).then(() => {
                    if (this._order[this._activeIdx % this._order.length] === id)
                        this._renderPanelActive();
                });
            }
        }));

        this._statusItem.visible = false;
        this._panelBox.remove_style_class_name('mp-stale');

        this._rebuildMenu();
        this._renderPanelActive();
        this._applyAlarmState();
    }

    async _refreshAll() {
        await Promise.all(this._order.map(async id => {
            try {
                const snap = await this._postEmpty(`/usage/${id}/refresh`);
                const entry = this._providers.get(id) ?? {};
                entry.snapshot = snap;
                this._providers.set(id, entry);
            } catch (_e) { /* leave last-known; next poll retries */ }
        }));
        this._rebuildMenu();
        this._renderPanelActive();
        this._applyAlarmState();
    }

    _postEmpty(path) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('POST', `${this._daemonUrl()}${path}`);
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _renderOffline(msg) {
        this._statusItem.visible = true;
        this._statusItem.label.text = msg;
        this._panelBox.add_style_class_name('mp-stale');
    }

    destroy() {
        if (this._pollTimer) {
            GLib.source_remove(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._rotateTimer) {
            GLib.source_remove(this._rotateTimer);
            this._rotateTimer = null;
        }
        if (this._settingsChanged) {
            this._settings.disconnect(this._settingsChanged);
            this._settingsChanged = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        super.destroy();
    }
});

export default class MultiProviderUsageExtension extends Extension {
    enable() {
        this._indicator = new MultiProviderUsageIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
