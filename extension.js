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

const TRACK_W = 46; // px width of a panel bar track — ALWAYS fixed (see the
                     // "columns are rigid" rule): width never scales with
                     // window count, only height/rowSpan does (_syncBar).
const TRACK_H = 11;  // px height of one bar "cell" in stacked mode — the unit
                     // a provider's bar(s) multiply when they have fewer
                     // windows than the rotation's global max (see barRowSpan
                     // in _renderPanelActive).

// Ultra-compact single-unit duration for timeline tick labels ("4h", "16d") —
// deliberately less precise than resetsIn()'s "4h 30m" rows; a tick label is
// read at a glance next to N others, not on its own.
function durationShort(ms) {
    if (Number.isNaN(ms))
        return '?';
    if (ms <= 0)
        return 'now';
    const mins = Math.round(ms / 60000);
    const h = Math.floor(mins / 60);
    if (h >= 24)
        return `${Math.floor(h / 24)}d`;
    if (h > 0)
        return `${h}h`;
    return `${mins}m`;
}

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
function letterFor(providerId, win, settings) {
    const overrides = settings.get_value('bar-label').deep_unpack();
    const override = overrides[`${providerId}:${win.id}`];
    if (override)
        return override;
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
        this._iconVariants = new Map(); // provider id -> variant string the cached path was fetched for

        this._buildPanel();
        this._buildMenuSkeleton();

        this._settingsChanged = this._settings.connect('changed', () => {
            this._applyVisibility();
            this._restartPollTimer();
            this._restartRotateTimer();
            this._refreshChangedIcons();
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
    // Width is ALWAYS TRACK_W — fixed, per the "columns are rigid" rule, same
    // basis as the tag/subtitle fixed-width fix. rowSpan is THIS render's bar
    // thickness multiplier (see _renderPanelActive): a provider with fewer
    // windows than the rotation's global max gets proportionally TALLER bars
    // (spanning the rows a fuller provider would otherwise use), not wider
    // ones — height is the axis that absorbs "how many metrics" varies by,
    // width never does.
    _syncBar(providerId, win, rowSpan) {
        let bar = this._bars.get(win.id);
        if (!bar) {
            bar = this._makeBar();
            this._bars.set(win.id, bar);
        }
        bar.label.text = letterFor(providerId, win, this._settings);
        bar.label.style = `color:${win.color ?? ''};`;
        const h = TRACK_H * rowSpan;
        bar.track.style = `width:${TRACK_W}px; height:${h}px;`;
        const pct = win.pct == null ? null : Math.max(0, Math.min(100, win.pct));
        const px = pct == null ? 0 : Math.round((pct / 100) * TRACK_W);
        bar.fill.style = `width:${px}px; height:${h}px; background-color:${win.color ?? '#888'};`;
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

    // Max window count across every provider in the current rotation, not
    // just whoever is active — the shared basis for both row count (stacked
    // mode) and per-bar width (see _globalRows and the perBarW comment in
    // _renderPanelActive).
    _globalMaxWindows() {
        let max = 1;
        for (const entry of this._providers.values()) {
            const n = entry?.snapshot?.windows?.length ?? 0;
            if (n > max)
                max = n;
        }
        return max;
    }

    // Row count for the CURRENT rotation set, not just whoever is active —
    // see the comment at its call site in _renderPanelActive for why this
    // must be global rather than per-provider.
    _globalRows(stacked) {
        return stacked ? this._globalMaxWindows() : 1;
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

        // R = how many rows the panel has, PER THE WHOLE PROVIDER SET, not
        // just whoever is active this render. Providers have different
        // window counts (mistral: 1 without an admin key, grok: 2, opencode-go:
        // 3) — if R tracked only the active provider, every column after the
        // icon would shift left/right as rotation switched between them (and
        // the whole panel would grow/shrink), which reads as the indicator
        // jittering. Basing R on the global max keeps icon/tag/bar columns
        // (and total panel height) identical across every provider in
        // rotation; a provider with fewer windows than the max just leaves
        // its unused rows empty instead of collapsing the columns.
        const rows = this._globalRows(stacked);

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
        // Reserved bar-row space is fixed at `rows` (global max windows,
        // stacked mode only), then split evenly by THIS provider's own
        // window count: 1 window gets a bar `rows`-tall (fills the whole
        // reserved area), 2 windows split it half each, 3 split it in
        // thirds — height/rowSpan is the axis that absorbs "how many
        // windows", never width (see TRACK_W/_syncBar) — a 1-window
        // provider's bar getting WIDER instead of TALLER would vary the
        // column layout per rotation, reintroducing the exact jitter
        // _globalRows/fixed-width-tag already fix. Unstacked has no spare
        // rows to absorb (rows is always 1), so it's always rowSpan 1.
        const barRowSpan = stacked
            ? Math.max(1, Math.round(rows / Math.max(windows.length, 1)))
            : 1;
        let col = barStartCol;
        let rowCursor = 0;
        windows.forEach((win) => {
            const bar = this._syncBar(id, win, barRowSpan);
            const row = stacked ? rowCursor : 0;
            if (stacked) {
                col = barStartCol;
                rowCursor += barRowSpan;
            }
            const place = (actor, attachedKey, want) => {
                this._attachIfNeeded(actor, bar, attachedKey, want, col, row, 1, barRowSpan);
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

        // Rank-order reset timeline — left = soonest, right = latest, across
        // EVERY provider/window at once. Deliberately NOT proportional to
        // real time (a 20-min window and a 16-day window would collapse onto
        // the same pixel) — evenly-spaced ticks in sorted order, color =
        // each window's own Okabe-Ito color, tiny duration label per tick.
        // See _rebuildTimeline().
        this._timelineItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._timelineTrack = new St.BoxLayout({style_class: 'mp-menu-timeline', x_expand: true});
        this._timelineItem.add_child(this._timelineTrack);
        this.menu.addMenuItem(this._timelineItem);
        this._timelineItem.visible = false; // no data yet; _rebuildTimeline reveals it

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
                    // 3 real columns (name/pct/reset), not one label with
                    // manual space-padding — spaces don't align in a
                    // proportional font, and label length varies per
                    // provider ("5h"/"Wk" vs "Session"/"Weekly"). See
                    // .mp-menu-window-* in stylesheet.css.
                    row = new PopupMenu.PopupMenuItem('', {reactive: false});
                    row.label.add_style_class_name('mp-menu-window-name');
                    row.pctLabel = new St.Label({style_class: 'mp-menu-window-pct', y_align: Clutter.ActorAlign.CENTER});
                    row.resetLabel = new St.Label({style_class: 'mp-menu-window-reset', y_align: Clutter.ActorAlign.CENTER});
                    row.add_child(row.pctLabel);
                    row.add_child(row.resetLabel);
                    m.rows.set(win.id, row);
                    m.section.addMenuItem(row);
                }
                row.label.text = win.label ?? win.id;
                row.pctLabel.text = fmtPct(win.pct);
                row.resetLabel.text = resetsIn(win.resets_at);
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

        this._rebuildTimeline();
    }

    // Flat list of every (provider, window) pair with a valid resets_at,
    // sorted soonest-first, rendered as evenly-spaced colored ticks. Rebuilt
    // from scratch each call (cheap — at most a handful of windows) rather
    // than diffed, same tradeoff _renderPanelActive makes for bars.
    _rebuildTimeline() {
        const entries = [];
        for (const id of this._order) {
            const windows = this._providers.get(id)?.snapshot?.windows ?? [];
            for (const win of windows) {
                const ms = Date.parse(win.resets_at);
                if (!Number.isNaN(ms))
                    entries.push({ms, color: win.color});
            }
        }
        entries.sort((a, b) => a.ms - b.ms);

        this._timelineTrack.remove_all_children();
        this._timelineItem.visible = entries.length > 1; // nothing to compare with 0-1 windows
        const now = Date.now();
        for (const e of entries) {
            // x_expand on every cell: St.BoxLayout has no `homogeneous` prop
            // (that's Clutter.BoxLayout/Gtk, not St) — expand-on-all is the
            // St equivalent, splits leftover space evenly across cells.
            const cell = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'mp-menu-timeline-cell'});
            const tick = new St.Widget({
                style_class: 'mp-menu-timeline-tick',
                style: `background-color:${e.color ?? '#888'};`,
                x_align: Clutter.ActorAlign.CENTER,
            });
            const label = new St.Label({
                text: durationShort(e.ms - now),
                style_class: 'mp-menu-timeline-label',
                x_align: Clutter.ActorAlign.CENTER,
            });
            cell.add_child(tick);
            cell.add_child(label);
            this._timelineTrack.add_child(cell);
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

    // Fetch a provider's icon (GET /usage/{id}/icon[?variant=x]) and cache it
    // to disk so St.Icon can load it by path. Nothing here names a specific
    // provider — any daemon plugin that ships an icon file just starts
    // appearing. No icon -> cached as null, panel falls back to the stock
    // icon for that provider. Re-fetched whenever the user's chosen variant
    // for this provider changes (see _refreshChangedIcons).
    async _ensureIcon(id) {
        const EXT_BY_TYPE = {
            'image/svg+xml': 'svg',
            'image/png': 'png',
            'image/jpeg': 'jpg',
        };
        const variant = this._iconVariantFor(id);
        try {
            const qs = variant ? `?variant=${encodeURIComponent(variant)}` : '';
            const {bytes, contentType} = await this._getBytes(`/usage/${id}/icon${qs}`);
            const ext = EXT_BY_TYPE[contentType.split(';')[0].trim()];
            if (!ext) {
                this._iconPaths.set(id, null);
                return;
            }
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'multi-provider-usage', 'icons']);
            GLib.mkdir_with_parents(dir, 0o755);
            const path = GLib.build_filenamev([dir, `${id}-${variant || 'default'}.${ext}`]);
            GLib.file_set_contents(path, bytes);
            this._iconPaths.set(id, path);
        } catch (_e) {
            // Fetch failed (daemon restart, transient network blip, etc).
            // Keep whatever icon path — good or already-null — was cached
            // before this attempt, same last-known-good policy the daemon
            // itself uses for snapshots. Only set null if we've never had a
            // path for this id at all, so a provider that HAD a working icon
            // doesn't lose it over one bad fetch (icon fetch is fire-once
            // per session, not retried, so overwriting here was permanent).
            if (!this._iconPaths.has(id))
                this._iconPaths.set(id, null);
        }
    }

    _iconVariantFor(id) {
        return this._settings.get_value('provider-icon-variant').deep_unpack()[id] ?? '';
    }

    // Compares each known provider's current icon-variant setting against
    // what its cached icon was fetched for; re-fetches (and re-renders if
    // active) any that changed. Cheap no-op on unrelated settings changes.
    _refreshChangedIcons() {
        for (const id of this._order) {
            const variant = this._iconVariantFor(id);
            if (this._iconVariants.get(id) === variant)
                continue;
            this._iconVariants.set(id, variant);
            this._ensureIcon(id).then(() => {
                if (this._order[this._activeIdx % this._order.length] === id)
                    this._renderPanelActive();
            });
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
                this._iconVariants.set(id, this._iconVariantFor(id));
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
