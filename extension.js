import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BAR_HEIGHT = 36;
const BAR_GAP = 1;
const ICON_SIZE = 18;
const DRAG_THRESHOLD = 8;
const BAR_POLL_MS = 200;
const TITLE_BUDGET = 50;

const ACCENT_MAP = {
    blue:   {r: 53,  g: 132, b: 228},
    teal:   {r: 33,  g: 144, b: 164},
    green:  {r: 58,  g: 148, b: 74},
    yellow: {r: 200, g: 136, b: 0},
    orange: {r: 237, g: 91,  b: 0},
    red:    {r: 230, g: 45,  b: 66},
    pink:   {r: 213, g: 97,  b: 153},
    purple: {r: 145, g: 65,  b: 172},
    slate:  {r: 111, g: 131, b: 150},
};

function rgba(r, g, b, a) {
    return `rgba(${r},${g},${b},${a})`;
}

function clamp255(v) {
    return Math.min(v, 255);
}

function readThemeColors() {
    const c = {
        barBg:    rgba(24, 24, 24, 0.97),
        tabBg:    rgba(255, 255, 255, 0.06),
        tabHover: rgba(255, 255, 255, 0.12),
        accent:   rgba(53, 132, 228, 0.92),
        dragBg:   rgba(53, 132, 228, 0.5),
        fgDim:    rgba(255, 255, 255, 0.55),
        fgActive: rgba(255, 255, 255, 1.0),
    };

    try {
        Main.panel.ensure_style();
        const bg = Main.panel.get_theme_node().get_background_color();
        if (bg.alpha > 0) {
            c.barBg = rgba(bg.red, bg.green, bg.blue, 0.97);
            c.tabBg = rgba(clamp255(bg.red + 20), clamp255(bg.green + 20), clamp255(bg.blue + 20), 0.35);
            c.tabHover = rgba(clamp255(bg.red + 40), clamp255(bg.green + 40), clamp255(bg.blue + 40), 0.5);
        }
    } catch (_) {}

    try {
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (dateMenu) {
            dateMenu.ensure_style();
            const fg = dateMenu.get_theme_node().get_foreground_color();
            if (fg.alpha > 0) {
                c.fgDim = rgba(fg.red, fg.green, fg.blue, 0.55);
                c.fgActive = rgba(fg.red, fg.green, fg.blue, 1.0);
            }
        }
    } catch (_) {}

    try {
        const name = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})
            .get_string('accent-color');
        const ac = ACCENT_MAP[name];
        if (ac) {
            c.accent = rgba(ac.r, ac.g, ac.b, 0.92);
            c.dragBg = rgba(ac.r, ac.g, ac.b, 0.5);
        }
    } catch (_) {}

    return c;
}

function skipEffect(win) {
    const actor = win.get_compositor_private();
    if (actor) Main.wm.skipNextEffect(actor);
}

function frameOf(win) {
    const r = win.get_frame_rect();
    return {x: r.x, y: r.y, width: r.width, height: r.height};
}


class TabGroup {
    constructor(id, ext) {
        this._id = id;
        this._ext = ext;
        this._windows = [];
        this._activeIndex = 0;
        this._bar = null;
        this._signals = new Map();
        this._timerId = null;
        this._frame = null;
        this._drag = null;
    }

    get windows() { return this._windows; }
    get activeWindow() { return this._windows[this._activeIndex] ?? null; }

    addWindow(win) {
        if (this._windows.includes(win)) return;
        if (!this._frame) this._frame = frameOf(win);

        this._windows.push(win);
        this._signals.set(win, win.connect('unmanaging', () => this.removeWindow(win)));
        this._activeIndex = this._windows.length - 1;
    }

    removeWindow(win) {
        const idx = this._windows.indexOf(win);
        if (idx === -1) return;

        const sid = this._signals.get(win);
        if (sid) { try { win.disconnect(sid); } catch (_) {} }
        this._signals.delete(win);
        this._windows.splice(idx, 1);

        if (this._windows.length === 0) {
            this.destroy();
            this._ext._removeGroup(this);
            return;
        }

        if (this._activeIndex >= this._windows.length)
            this._activeIndex = this._windows.length - 1;
        this.sync();
    }

    sync() {
        this._syncWindows();
        this._rebuildBar();
    }

    activateByIndex(i) {
        if (i >= 0 && i < this._windows.length) {
            this._activeIndex = i;
            this.sync();
        }
    }

    activateNext() {
        if (this._windows.length <= 1) return;
        this._activeIndex = (this._activeIndex + 1) % this._windows.length;
        this.sync();
    }

    activatePrev() {
        if (this._windows.length <= 1) return;
        this._activeIndex = (this._activeIndex - 1 + this._windows.length) % this._windows.length;
        this.sync();
    }

    // --- Window management ---

    _syncWindows() {
        const active = this._windows[this._activeIndex];
        if (!active) return;

        // Capture latest frame from any visible window
        for (const w of this._windows) {
            if (!w.minimized) {
                this._frame = frameOf(w);
                break;
            }
        }

        const time = global.get_current_time();
        for (let i = 0; i < this._windows.length; i++) {
            const w = this._windows[i];
            if (i === this._activeIndex) {
                if (this._frame)
                    w.move_resize_frame(false, this._frame.x, this._frame.y, this._frame.width, this._frame.height);
                skipEffect(w);
                w.unminimize();
                w.activate(time);
            } else if (!w.minimized) {
                skipEffect(w);
                w.minimize();
            }
        }
    }

    // --- Tab bar ---

    _rebuildBar() {
        this._destroyBar();
        if (this._windows.length < 2) return;

        const active = this.activeWindow;
        if (!active) return;

        const rect = active.get_frame_rect();
        const tc = readThemeColors();

        this._bar = new St.BoxLayout({
            style_class: 'tabby-bar',
            style: `background-color: ${tc.barBg};`,
            reactive: true,
            x: rect.x,
            y: Math.max(0, rect.y - BAR_HEIGHT - BAR_GAP),
            height: BAR_HEIGHT,
            width: rect.width,
        });

        const tracker = Shell.WindowTracker.get_default();
        const maxLen = Math.max(12, Math.floor(TITLE_BUDGET / this._windows.length));

        for (let i = 0; i < this._windows.length; i++) {
            const isActive = i === this._activeIndex;
            const app = tracker.get_window_app(this._windows[i]);
            const title = this._windows[i].get_title() || app?.get_name() || 'Window';
            const label = title.length > maxLen ? title.substring(0, maxLen - 1) + '…' : title;

            const btnStyle = `background-color: ${isActive ? tc.accent : tc.tabBg};`;
            const btn = new St.Button({
                style_class: 'tabby-tab-btn',
                style: btnStyle,
                reactive: true,
                track_hover: true,
                x_expand: true,
            });

            // Hover: cursor + color
            btn.connect('notify::hover', () => {
                if (btn.hover) {
                    global.display.set_cursor(Meta.Cursor.POINTING_HAND);
                    if (!isActive && !this._drag?.dragging)
                        btn.set_style(`background-color: ${tc.tabHover};`);
                } else {
                    global.display.set_cursor(Meta.Cursor.DEFAULT);
                    if (!isActive && !this._drag?.dragging)
                        btn.set_style(`background-color: ${tc.tabBg};`);
                }
            });

            const content = new St.BoxLayout({
                style_class: 'tabby-tab-content',
                vertical: false,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            });

            if (app) {
                try {
                    const icon = app.create_icon_texture(ICON_SIZE);
                    icon.set_y_align(Clutter.ActorAlign.CENTER);
                    if (!isActive) icon.set_opacity(160);
                    content.add_child(icon);
                } catch (_) {}
            }

            content.add_child(new St.Label({
                text: label,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'tabby-tab-label',
                style: isActive
                    ? `color: ${tc.fgActive}; font-weight: 600;`
                    : `color: ${tc.fgDim};`,
            }));

            // Close button
            const closeBtn = new St.Button({
                style_class: 'tabby-close-btn',
                style: `color: ${isActive ? tc.fgActive : tc.fgDim};`,
                reactive: true,
                track_hover: true,
                child: new St.Label({
                    text: '×',
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'font-size: 14px; font-weight: bold;',
                }),
            });
            closeBtn.connect('notify::hover', () => {
                closeBtn.set_style(closeBtn.hover
                    ? 'color: #ff5555; font-size: 14px;'
                    : `color: ${isActive ? tc.fgActive : tc.fgDim};`);
                if (closeBtn.hover)
                    global.display.set_cursor(Meta.Cursor.POINTING_HAND);
            });
            const closeIdx = i;
            closeBtn.connect('clicked', () => {
                const w = this._windows[closeIdx];
                if (!w) return;
                this._ext._winMap.delete(w);
                this.removeWindow(w);
                w.unminimize();
            });
            content.add_child(closeBtn);

            btn.set_child(content);
            this._connectDrag(btn, i, btnStyle, tc.dragBg);
            this._bar.add_child(btn);
        }

        this._bar.connect('button-release-event', () => {
            if (this._drag?.dragging) {
                this._endDrag();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        Main.layoutManager.uiGroup.add_child(this._bar);
        this._watchPosition();
    }

    // --- Drag-to-reorder ---

    _connectDrag(btn, idx, origStyle, dragBg) {
        btn.connect('button-press-event', (_a, ev) => {
            if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            this._drag = {
                index: idx,
                startX: ev.get_coords()[0],
                dragging: false,
                actor: btn,
                origStyle,
                dragBg,
            };
            return Clutter.EVENT_PROPAGATE;
        });

        btn.connect('button-release-event', () => {
            if (!this._drag) return Clutter.EVENT_PROPAGATE;
            if (this._drag.dragging) {
                this._endDrag();
            } else {
                this._drag = null;
                this.activateByIndex(idx);
            }
            return Clutter.EVENT_STOP;
        });

        btn.connect('motion-event', (_a, ev) => {
            if (!this._drag) return Clutter.EVENT_PROPAGATE;
            const [x] = ev.get_coords();

            if (!this._drag.dragging && Math.abs(x - this._drag.startX) > DRAG_THRESHOLD) {
                this._drag.dragging = true;
                this._drag.actor.set_style(`background-color: ${this._drag.dragBg}; opacity: 180;`);
            }

            if (this._drag.dragging) {
                const children = this._bar.get_children();
                for (let j = 0; j < children.length; j++) {
                    if (j === this._drag.index) continue;
                    const cx = children[j].get_transformed_position()[0];
                    const cw = children[j].get_width();
                    if (x > cx && x < cx + cw) {
                        this._swapTabs(this._drag.index, j);
                        this._drag.index = j;
                        break;
                    }
                }
            }
            return Clutter.EVENT_STOP;
        });
    }

    _swapTabs(from, to) {
        [this._windows[from], this._windows[to]] = [this._windows[to], this._windows[from]];

        if (this._activeIndex === from) this._activeIndex = to;
        else if (this._activeIndex === to) this._activeIndex = from;

        const children = this._bar.get_children();
        const child = children[from];
        this._bar.remove_child(child);
        const ref = this._bar.get_children()[to];
        if (ref) this._bar.insert_child_below(child, ref);
        else this._bar.add_child(child);
    }

    _endDrag() {
        if (this._drag) {
            this._drag.actor.set_style(this._drag.origStyle);
            this._drag = null;
        }
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        this._rebuildBar();
    }

    // --- Position tracking ---

    _watchPosition() {
        this._clearTimer();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BAR_POLL_MS, () => {
            const win = this.activeWindow;
            if (!this._bar || !win) {
                this._timerId = null;
                return GLib.SOURCE_REMOVE;
            }
            try {
                const r = win.get_frame_rect();
                this._bar.set_position(r.x, Math.max(0, r.y - BAR_HEIGHT - BAR_GAP));
                this._bar.set_width(r.width);
            } catch (_) {
                this._timerId = null;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _destroyBar() {
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        this._clearTimer();
        this._drag = null;
        if (this._bar) {
            this._bar.destroy();
            this._bar = null;
        }
    }

    destroy() {
        this._destroyBar();
        for (const w of this._windows) {
            const sid = this._signals.get(w);
            if (sid) { try { w.disconnect(sid); } catch (_) {} }
            try { w.unminimize(); } catch (_) {}
        }
        this._signals.clear();
        this._windows = [];
    }
}


const KEYBINDINGS = ['tabby-toggle-group', 'tabby-next-tab', 'tabby-prev-tab', 'tabby-close-tab'];

export default class TabbyExtension extends Extension {
    enable() {
        this._groups = [];
        this._groupCounter = 0;
        this._winMap = new Map();

        const actions = {
            'tabby-toggle-group': () => this._toggleGroup(),
            'tabby-next-tab':     () => this._cycleTab(1),
            'tabby-prev-tab':     () => this._cycleTab(-1),
            'tabby-close-tab':    () => this._closeTab(),
        };

        const settings = this.getSettings();
        for (const key of KEYBINDINGS) {
            Main.wm.addKeybinding(key, settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL, actions[key]);
        }

        // Auto-add new windows of already-grouped apps
        this._windowCreatedId = global.display.connect('window-created', (_display, win) => {
            if (win.get_window_type() !== Meta.WindowType.NORMAL) return;
            // Delay slightly so the window has an app assigned
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._autoAddWindow(win);
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    disable() {
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = null;
        }
        for (const key of KEYBINDINGS)
            Main.wm.removeKeybinding(key);
        for (const g of this._groups)
            g.destroy();
        this._groups = [];
        this._winMap.clear();
    }

    _toggleGroup() {
        const win = global.display.focus_window;
        if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) return;

        // Ungroup if already grouped
        if (this._winMap.has(win)) {
            const group = this._winMap.get(win);
            for (const w of group.windows) this._winMap.delete(w);
            group.destroy();
            this._groups.splice(this._groups.indexOf(group), 1);
            Main.notify('Tabby', 'Group dissolved. All windows are independent.');
            return;
        }

        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        if (!app) return;

        const appWindows = global.display
            .get_tab_list(Meta.TabList.NORMAL, win.get_workspace())
            .filter(w => tracker.get_window_app(w) === app && !this._winMap.has(w));

        if (appWindows.length < 2) {
            Main.notify('Tabby', `${app.get_name()} — only 1 window, cannot create group.`);
            return;
        }

        const group = new TabGroup(++this._groupCounter, this);

        // Add focused window first, then the rest
        group.addWindow(win);
        this._winMap.set(win, group);
        for (const w of appWindows) {
            if (w !== win) {
                group.addWindow(w);
                this._winMap.set(w, group);
            }
        }
        group._activeIndex = 0;

        this._groups.push(group);
        group.sync();
        Main.notify('Tabby', `${app.get_name()} — ${appWindows.length} windows grouped as tabs.`);
    }

    _cycleTab(direction) {
        const group = this._winMap.get(global.display.focus_window);
        if (!group) return;
        if (direction > 0) group.activateNext();
        else group.activatePrev();
    }

    _closeTab() {
        const win = global.display.focus_window;
        if (!win) return;
        const group = this._winMap.get(win);
        if (!group) return;
        group.removeWindow(win);
        this._winMap.delete(win);
        win.unminimize();
    }

    _autoAddWindow(win) {
        if (this._winMap.has(win)) return;
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return;

        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        if (!app) return;

        // Find an existing group for this app
        for (const group of this._groups) {
            const groupApp = tracker.get_window_app(group.windows[0]);
            if (groupApp === app) {
                group.addWindow(win);
                this._winMap.set(win, group);
                group.sync();
                return;
            }
        }
    }

    _removeGroup(group) {
        const idx = this._groups.indexOf(group);
        if (idx !== -1) this._groups.splice(idx, 1);
        for (const [w, g] of this._winMap) {
            if (g === group) this._winMap.delete(w);
        }
    }
}
