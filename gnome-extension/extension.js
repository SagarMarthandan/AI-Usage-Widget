import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'ai-usage']);
const STATUS_PATH = GLib.build_filenamev([CACHE_DIR, 'status.json']);
const CONFIG_PATH = GLib.build_filenamev([
    GLib.get_user_config_dir(), 'ai-usage', 'config.json',
]);
const REFRESH_BIN = GLib.build_filenamev([
    GLib.get_home_dir(), '.local', 'bin', 'ai-usage',
]);
const DASHBOARD_URL = 'https://openrouter.ai/settings/credits';

const PROVIDER_ORDER = ['claude', 'codex', 'opencode-go'];
const PROVIDER_ICONS = {
    'claude': 'claude.svg',
    'codex': 'codex.svg',
    'opencode-go': 'opencode.svg',
};
const PROVIDER_IDS = ['claude', 'codex', 'opencode-go', 'openrouter'];
const PROVIDER_LABELS = {
    'claude': 'Claude',
    'codex': 'Codex',
    'opencode-go': 'OpenCode Go',
    'openrouter': 'OpenRouter',
};
const DEFAULT_PROVIDERS = [...PROVIDER_IDS];
const WINDOW_NAMES = {
    '5h': '5 hours',
    '7d': '7 days',
    'weekly': 'Weekly',
    'monthly': 'Monthly',
};
const MAX_WINDOW_ROWS = 5;

const STALE_SECONDS = 120;
const TICK_SECONDS = 30;
const DEFAULTS = {
    low_threshold: 5.0,
    critical_threshold: 1.0,
    providers: DEFAULT_PROVIDERS,
};
const CURRENCY = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
});

function roundedRect(cr, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    cr.newSubPath();
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.arc(x + width - r, y + r, r, 1.5 * Math.PI, 2 * Math.PI);
    cr.arc(x + width - r, y + height - r, r, 0, 0.5 * Math.PI);
    cr.arc(x + r, y + height - r, r, 0.5 * Math.PI, Math.PI);
    cr.closePath();
}

export default class AiUsageExtension extends Extension {
    enable() {
        GLib.mkdir_with_parents(CACHE_DIR, 0o755);

        this._status = null;
        this._refreshing = false;
        this._panelKey = null;
        this._chipRefs = {};
        this._providerMenu = null;
        this._providerKey = null;
        this._config = this._loadConfig();
        this._stylesheet = Gio.File.new_for_path(
            GLib.build_filenamev([this.path, 'stylesheet.css'])
        );
        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._theme.load_stylesheet(this._stylesheet);

        this._button = new PanelMenu.Button(0.0, 'AI Usage', false);
        this._button.add_style_class_name('ai-usage-button');
        this._button.accessible_name = 'AI usage';

        this._chipBox = new St.BoxLayout({
            style_class: 'ai-usage-panel',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._button.add_child(this._chipBox);
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');

        this._buildMenu();

        this._monitor = Gio.File.new_for_path(CACHE_DIR).monitor_directory(
            Gio.FileMonitorFlags.WATCH_MOVES, null
        );
        this._monitor.connect('changed', (_monitor, file, otherFile) => {
            const names = [file, otherFile]
                .filter(actor => actor !== null)
                .map(actor => actor.get_basename());
            if (names.includes('status.json'))
                this._reload();
        });

        this._tickId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
                this._reload();
                return GLib.SOURCE_CONTINUE;
            }
        );

        this._reload();
    }

    disable() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (this._monitor) {
            this._monitor.cancel();
            this._monitor = null;
        }
        if (this._theme && this._stylesheet)
            this._theme.unload_stylesheet(this._stylesheet);
        if (this._button) {
            this._button.destroy();
            this._button = null;
        }
        this._status = null;
        this._rows = null;
        this._cards = null;
        this._providerMenu = null;
        this._providerKey = null;
        this._chipRefs = {};
        this._panelKey = null;
        this._theme = null;
        this._stylesheet = null;
    }

    _loadConfig() {
        const config = Object.assign(
            {}, DEFAULTS, this._readJson(CONFIG_PATH) ?? {}
        );
        for (const name of ['low_threshold', 'critical_threshold']) {
            const value = Number(config[name]);
            config[name] = Number.isFinite(value) ? value : DEFAULTS[name];
        }
        const selected = Array.isArray(config.providers)
            ? config.providers
            : DEFAULT_PROVIDERS;
        config.providers = PROVIDER_IDS.filter(id => selected.includes(id));
        return config;
    }

    _readJson(path) {
        try {
            const [, contents] = GLib.file_get_contents(path);
            return JSON.parse(new TextDecoder().decode(contents));
        } catch {
            return null;
        }
    }

    // ------------------------------------------------------------- panel
    _allProviders(status) {
        return status?.providers_all ?? status?.providers ?? [];
    }

    _allOpenRouter(status) {
        return status?.openrouter_all ?? status?.openrouter ?? null;
    }

    _syncPanel(status) {
        const providers = this._allProviders(status)
            .filter(provider => this._enabled(provider.id));
        const balance = this._enabled('openrouter') &&
            typeof this._allOpenRouter(status)?.remaining === 'number'
            ? this._allOpenRouter(status).remaining
            : null;
        const key = providers.map(provider => provider.id).join('|') + '|' +
            (balance === null ? '' : 'balance');

        if (key !== this._panelKey) {
            this._buildChips(providers, balance);
            this._panelKey = key;
        }
        this._updateChips(providers, balance);
    }

    _buildChips(providers, balance) {
        this._chipBox.destroy_all_children();
        this._chipRefs = {};

        providers.forEach((provider, index) => {
            if (index > 0)
                this._chipBox.add_child(this._separator());
            this._chipRefs[provider.id] = this._providerChip(provider);
        });

        if (balance !== null) {
            if (providers.length > 0)
                this._chipBox.add_child(this._separator());
            this._chipRefs.__balance = this._balanceChip();
        }

        if (!providers.length && balance === null) {
            const label = new St.Label({
                text: this._status?.ok === false ? 'AI !' : 'AI',
                style_class: 'ai-usage-chip-name',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._chipBox.add_child(label);
        }
    }

    _separator() {
        return new St.Widget({style_class: 'ai-usage-sep'});
    }

    _icon(providerId, size) {
        const file = PROVIDER_ICONS[providerId];
        if (!file)
            return null;
        const path = GLib.build_filenamev([this.path, 'icons', file]);
        return new St.Icon({
            gicon: new Gio.FileIcon({file: Gio.File.new_for_path(path)}),
            icon_size: size,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _providerChip(provider) {
        const box = new St.BoxLayout({
            style_class: 'ai-usage-chip',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const icon = this._icon(provider.id, 12);
        if (icon)
            box.add_child(icon);

        const name = new St.Label({
            text: provider.short ?? provider.name,
            style_class: 'ai-usage-chip-name',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const value = new St.Label({
            text: '…',
            style_class: 'ai-usage-chip-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(name);
        box.add_child(value);
        this._chipBox.add_child(box);
        return {name, value};
    }

    _balanceChip() {
        const value = new St.Label({
            text: '…',
            style_class: 'ai-usage-chip-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._chipBox.add_child(value);
        return {name: null, value};
    }

    _updateChips(providers, balance) {
        for (const provider of providers) {
            const chip = this._chipRefs[provider.id];
            if (!chip)
                continue;
            const limit = this._primaryLimit(provider);
            const behind = limit ? (this._pace(limit)?.behind ?? false) : false;
            if (limit) {
                chip.value.set_text(
                    `${Math.round(limit.used * 100)}% · ${this._countdown(limit.resets_at)}`
                );
            } else {
                chip.value.set_text('—');
            }
            this._setBehind(chip.name, behind);
            this._setBehind(chip.value, behind);
        }

        const chip = this._chipRefs.__balance;
        if (chip && balance !== null) {
            chip.value.set_text(this._money(balance));
            chip.value.remove_style_class_name('ai-usage-low');
            chip.value.remove_style_class_name('ai-usage-critical');
            if (balance <= this._config.critical_threshold)
                chip.value.add_style_class_name('ai-usage-critical');
            else if (balance <= this._config.low_threshold)
                chip.value.add_style_class_name('ai-usage-low');
        }
    }

    _setBehind(label, behind) {
        if (!label)
            return;
        if (behind)
            label.add_style_class_name('ai-usage-behind');
        else
            label.remove_style_class_name('ai-usage-behind');
    }

    // -------------------------------------------------------------- menu
    _buildMenu() {
        const menu = this._button.menu;
        this._rows = {};
        this._cards = {};

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('AI Usage'));
        for (const providerId of PROVIDER_ORDER)
            this._cards[providerId] = this._buildProviderCard(providerId);

        this._missingRows = [];
        for (let index = 0; index < 3; index++) {
            const row = this._addRow(menu, '');
            row.item.visible = false;
            this._missingRows.push(row);
        }

        this._buildOpenRouterCard();

        this._providerMenu = new PopupMenu.PopupSubMenuMenuItem('Providers');
        menu.addMenuItem(this._providerMenu);
        this._providerKey = null;

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._rows.checked = this._addRow(menu, 'Checked');
        this._rows.error = this._addRow(menu, 'Last error', 'ai-usage-error');

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._refresh());
        menu.addMenuItem(refreshItem);

        const dashboardItem = new PopupMenu.PopupMenuItem('Open OpenRouter credits');
        dashboardItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(DASHBOARD_URL, null);
        });
        menu.addMenuItem(dashboardItem);

        menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen)
                return;
            this._reload();
            const checked = this._status?.checked_at ?? 0;
            if (Date.now() / 1000 - checked > STALE_SECONDS)
                this._refresh();
        });
    }

    _buildProviderCard(providerId) {
        const menu = this._button.menu;
        const card = {id: providerId, items: []};

        const add = item => {
            menu.addMenuItem(item);
            card.items.push(item);
            return item;
        };

        const header = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const headBox = new St.BoxLayout({x_expand: true, style_class: 'ai-usage-card-head'});
        const icon = this._icon(providerId, 18);
        if (icon)
            headBox.add_child(icon);
        card.name = new St.Label({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ai-usage-card-name',
        });
        card.plan = new St.Label({
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ai-usage-card-plan dim-label',
        });
        headBox.add_child(card.name);
        headBox.add_child(card.plan);
        header.add_child(headBox);
        add(header);

        card.note = this._plainItem(add, 'ai-usage-source dim-label');
        card.noteItem = card.note.get_parent();

        card.summary = this._plainItem(add, 'ai-usage-summary');

        const meterItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        card.meter = new St.DrawingArea({
            height: 8,
            x_expand: true,
            style_class: 'ai-usage-meter',
        });
        card.meter._fraction = 0;
        card.meter._behind = false;
        card.meter.connect('repaint', area => this._drawMeter(area));
        meterItem.add_child(card.meter);
        add(meterItem);

        const pace = this._rowItem(add);
        card.paceItem = pace.item;
        card.paceLeft = pace.name;
        card.paceRight = pace.value;
        card.paceLeft.add_style_class_name('dim-label');
        card.paceRight.add_style_class_name('dim-label');

        card.windows = [];
        for (let index = 0; index < MAX_WINDOW_ROWS; index++) {
            const row = this._rowItem(add);
            row.name.add_style_class_name('ai-usage-window');
            row.item.visible = false;
            card.windows.push(row);
        }

        add(new PopupMenu.PopupSeparatorMenuItem());
        return card;
    }

    _buildOpenRouterCard() {
        const menu = this._button.menu;
        const card = {items: []};
        const add = item => {
            menu.addMenuItem(item);
            card.items.push(item);
            return item;
        };

        add(new PopupMenu.PopupSeparatorMenuItem('OpenRouter'));
        card.remaining = this._addRow(menu, 'Remaining');
        card.purchased = this._addRow(menu, 'Purchased');
        card.spent = this._addRow(menu, 'Total spent');
        card.today = this._addRow(menu, 'Today');
        card.week = this._addRow(menu, 'Last 7 days');
        card.month = this._addRow(menu, 'Last 30 days');
        card.total = this._addRow(menu, 'All time');

        // _addRow already added its items; collect them for show/hide.
        for (const row of [card.remaining, card.purchased, card.spent, card.today,
            card.week, card.month, card.total])
            card.items.push(row.item);

        this._openrouterCard = card;
    }

    _plainItem(add, styleClass) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const label = new St.Label({x_expand: true, style_class: styleClass});
        item.add_child(label);
        add(item);
        return label;
    }

    _rowItem(add) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const box = new St.BoxLayout({x_expand: true});
        const name = new St.Label({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const value = new St.Label({
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ai-usage-value',
        });
        box.add_child(name);
        box.add_child(value);
        item.add_child(box);
        add(item);
        return {item, name, value};
    }

    _addRow(menu, labelText, valueStyleClass = null) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const box = new St.BoxLayout({x_expand: true});
        const name = new St.Label({
            text: labelText,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const value = new St.Label({
            text: '—',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ai-usage-value',
        });
        if (valueStyleClass)
            value.add_style_class_name(valueStyleClass);
        box.add_child(name);
        box.add_child(value);
        item.add_child(box);
        menu.addMenuItem(item);
        return {item, name, value};
    }

    // ------------------------------------------------------------ render
    _reload() {
        this._config = this._loadConfig();
        this._status = this._readJson(STATUS_PATH);
        this._render();
    }

    _enabled(providerId) {
        return this._config.providers.includes(providerId);
    }

    _render() {
        const status = this._status;
        const providers = this._allProviders(status);
        const byId = Object.fromEntries(providers.map(provider => [provider.id, provider]));

        this._syncPanel(status);
        this._syncProviderMenu();

        for (const providerId of PROVIDER_ORDER) {
            this._renderProviderCard(
                providerId,
                this._enabled(providerId) ? byId[providerId] : null
            );
        }

        this._renderMissing(
            this._enabled('claude') ? (status?.unavailable ?? []) : []
        );
        this._renderOpenRouter(
            this._enabled('openrouter') ? this._allOpenRouter(status) : null
        );

        this._rows.checked.value.set_text(
            typeof status?.checked_at === 'number' ? this._ago(status.checked_at) : 'never'
        );

        const failed = status !== null && status.ok === false;
        this._rows.error.item.visible = failed;
        if (failed)
            this._rows.error.value.set_text(status.error ?? 'update failed');
    }

    _syncProviderMenu() {
        if (!this._providerMenu)
            return;
        const key = this._config.providers.join(',');
        if (key === this._providerKey)
            return;
        this._providerKey = key;

        const menu = this._providerMenu.menu;
        menu.removeAll();
        for (const providerId of PROVIDER_IDS) {
            const enabled = this._enabled(providerId);
            const item = new PopupMenu.PopupMenuItem(
                `${enabled ? '✓' : '  '} ${PROVIDER_LABELS[providerId]}`
            );
            item.connect('activate', () => this._toggleProvider(providerId));
            menu.addMenuItem(item);
        }
    }

    _toggleProvider(providerId) {
        const argv = [
            REFRESH_BIN, 'set-provider', providerId,
            this._enabled(providerId) ? 'off' : 'on',
        ];
        let process;
        try {
            process = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_SILENCE |
                Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (error) {
            logError(error, 'ai-usage: provider toggle failed');
            return;
        }

        process.wait_check_async(null, (subprocess, result) => {
            try {
                subprocess.wait_check_finish(result);
            } catch (error) {
                logError(error, 'ai-usage: provider toggle failed');
            }
            this._providerKey = null;
            this._reload();
        });
    }

    _renderProviderCard(providerId, provider) {
        const card = this._cards[providerId];
        const visible = Boolean(provider);
        for (const item of card.items)
            item.visible = visible;
        if (!provider)
            return;

        const limit = this._primaryLimit(provider);
        const pace = limit ? this._pace(limit) : null;
        card.name.set_text(provider.name ?? providerId);

        const sharedClaude = provider.id === 'claude' && provider.source !== 'anthropic';
        const plan = provider.plan ?? '';
        card.plan.set_text(
            plan && plan !== provider.name && !sharedClaude ? plan : ''
        );

        let note = '';
        if (sharedClaude)
            note = `${plan} · shared with GPT`.replace(/^ · /, '');
        else if (provider.resets_available)
            note = `${provider.resets_available} saved resets`;
        card.note.set_text(note);
        card.noteItem.visible = note !== '';

        if (limit) {
            const reset = this._countdown(limit.resets_at);
            const windowName = limit.window === 'monthly'
                ? ' monthly'
                : '';
            card.summary.set_text(
                `${Math.round(limit.used * 100)}%${windowName} used` +
                (reset ? ` · resets in ${reset}` : '')
            );
        } else {
            card.summary.set_text('No limit data');
        }

        card.meter._fraction = limit?.used ?? 0;
        card.meter._behind = pace?.behind ?? false;
        card.meter.queue_repaint();

        card.paceItem.visible = Boolean(pace);
        if (pace) {
            const delta = Math.round(Math.abs(pace.delta) * 100);
            card.paceLeft.set_text(
                delta === 0 ? 'On pace' : `${delta}% ${pace.behind ? 'behind' : 'ahead of'} pace`
            );
            card.paceRight.set_text(`Expected ${Math.round(pace.elapsed * 100)}% used`);
            card.paceLeft.remove_style_class_name('ai-usage-urgent');
            if (pace.behind)
                card.paceLeft.add_style_class_name('ai-usage-urgent');
        } else {
            card.paceLeft.set_text('');
            card.paceRight.set_text('');
        }

        const limits = provider.limits ?? [];
        for (let index = 0; index < card.windows.length; index++) {
            const row = card.windows[index];
            const entry = limits[index];
            row.item.visible = Boolean(entry);
            if (!entry)
                continue;
            row.name.set_text(WINDOW_NAMES[entry.window] ?? entry.window ?? entry.label);
            row.value.set_text(
                `${Math.round(entry.used * 100)}% · ${this._countdown(entry.resets_at)}`
            );
        }
    }

    _renderMissing(unavailable) {
        for (let index = 0; index < this._missingRows.length; index++) {
            const row = this._missingRows[index];
            const missing = unavailable[index];
            row.item.visible = Boolean(missing);
            if (!missing)
                continue;
            row.name.set_text(missing.name ?? missing.id);
            row.value.set_text(missing.reason ?? 'unavailable');
            row.value.add_style_class_name('dim-label');
        }
    }

    _renderOpenRouter(openrouter) {
        const card = this._openrouterCard;
        const visible = Boolean(openrouter);
        for (const item of card.items)
            item.visible = visible;
        if (!openrouter)
            return;

        card.remaining.value.set_text(this._money(openrouter.remaining));
        card.purchased.value.set_text(this._money(openrouter.total_credits));
        card.spent.value.set_text(this._money(openrouter.total_usage));
        const key = openrouter.key ?? {};
        card.today.value.set_text(this._money(key.usage_daily));
        card.week.value.set_text(this._money(key.usage_weekly));
        card.month.value.set_text(this._money(key.usage_monthly));
        card.total.value.set_text(this._money(key.usage));
    }

    _drawMeter(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0)
            return;

        cr.setSourceRGBA(0.55, 0.55, 0.55, 0.30);
        roundedRect(cr, 0, 0, width, height, height / 2);
        cr.fill();

        const fraction = Math.max(0, Math.min(1, area._fraction ?? 0));
        if (fraction > 0) {
            if (area._behind)
                cr.setSourceRGBA(0.878, 0.106, 0.141, 1);
            else
                cr.setSourceRGBA(0.208, 0.518, 0.894, 1);
            roundedRect(cr, 0, 0, Math.max(height, width * fraction), height, height / 2);
            cr.fill();
        }
    }

    // ----------------------------------------------------------- helpers
    _primaryLimit(provider) {
        if (!provider?.limits?.length)
            return null;
        return provider.limits.find(limit => limit.id === provider.primary) ??
            provider.limits[0];
    }

    _pace(limit) {
        if (!limit || !limit.duration_ms || !limit.resets_at)
            return null;
        const remaining = limit.resets_at - Date.now();
        const elapsed = Math.min(1, Math.max(0, 1 - remaining / limit.duration_ms));
        const delta = limit.used - elapsed;
        return {elapsed, delta, behind: delta > 0.005};
    }

    _countdown(resetsAt) {
        if (typeof resetsAt !== 'number')
            return '';
        const remaining = resetsAt - Date.now();
        if (remaining <= 0)
            return 'now';
        const minutes = Math.max(0, Math.floor(remaining / 60000));
        const days = Math.floor(minutes / 1440);
        const hours = Math.floor((minutes % 1440) / 60);
        const mins = minutes % 60;
        if (days > 0)
            return `${days}d ${hours}h`;
        if (hours > 0)
            return `${hours}h ${mins}m`;
        return `${mins}m`;
    }

    _money(value) {
        if (typeof value !== 'number' || !Number.isFinite(value))
            return '—';
        if (value !== 0 && Math.abs(value) < 0.005)
            return '<$0.01';
        return CURRENCY.format(value);
    }

    _ago(epochSeconds) {
        const seconds = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
        if (seconds < 60)
            return 'just now';
        if (seconds < 3600)
            return `${Math.floor(seconds / 60)} min ago`;
        if (seconds < 86400)
            return `${Math.floor(seconds / 3600)} h ago`;
        return `${Math.floor(seconds / 86400)} d ago`;
    }

    _refresh() {
        if (this._refreshing)
            return;
        this._refreshing = true;
        this._rows.checked.value.set_text('refreshing…');

        let process;
        try {
            process = Gio.Subprocess.new(
                [REFRESH_BIN, '--quiet'],
                Gio.SubprocessFlags.STDOUT_SILENCE |
                Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (error) {
            this._refreshing = false;
            this._rows.error.item.visible = true;
            this._rows.error.value.set_text(`cannot run ${REFRESH_BIN}: ${error.message}`);
            return;
        }

        process.wait_check_async(null, (subprocess, result) => {
            this._refreshing = false;
            try {
                subprocess.wait_check_finish(result);
            } catch (error) {
                logError(error, 'ai-usage: refresh failed');
            }
            this._reload();
        });
    }
}
