import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BAR_HEIGHT = 28;
const ICON_SIZE = 18;
const DRAG_THRESHOLD = 8;
const TITLE_BUDGET = 50;
const POSITION_EASE_MS = 60;

// Fallback accent (light gray)
const FALLBACK_ACCENT = 'background-color: rgba(255,255,255,0.18);';
const FALLBACK_ACCENT_DIM = 'background-color: rgba(255,255,255,0.10);';

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
        accent:   FALLBACK_ACCENT,
        dragBg:   FALLBACK_ACCENT_DIM,
        fgDim:    rgba(255, 255, 255, 0.55),
        fgActive: rgba(255, 255, 255, 1.0),
    };

    try {
        Main.panel.ensure_style();
        const node = Main.panel.get_theme_node();
        const bg = node.get_background_color();
        if (bg.alpha > 0) {
            c.barBg = rgba(bg.red, bg.green, bg.blue, 0.97);
            c.tabBg = rgba(clamp255(bg.red + 20), clamp255(bg.green + 20), clamp255(bg.blue + 20), 0.35);
            c.tabHover = rgba(clamp255(bg.red + 40), clamp255(bg.green + 40), clamp255(bg.blue + 40), 0.5);
            c.accent = `background-color: ${rgba(clamp255(bg.red + 50), clamp255(bg.green + 50), clamp255(bg.blue + 50), 0.7)};`;
            c.dragBg = `background-color: ${rgba(clamp255(bg.red + 50), clamp255(bg.green + 50), clamp255(bg.blue + 50), 0.4)};`;
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

function workAreaOf(win) {
    return global.workspace_manager
        .get_active_workspace()
        .get_work_area_for_monitor(win.get_monitor());
}

function getBarRect(win) {
    const wa = workAreaOf(win);
    return {
        x: wa.x,
        y: wa.y,
        width: wa.width,
    };
}


class TabGroup {
    constructor(id, ext) {
        this._id = id;
        this._ext = ext;
        this._windows = [];
        this._activeIndex = 0;
        this._bar = null;
        this._signals = new Map();
        this._positionSignals = [];
        this._trackedWindow = null;
        this._frame = null;
        this._drag = null;
        this._barRect = null;
        this._titleSignals = [];
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
        this._ext._forgetWindow(win);

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
        if (i >= 0 && i < this._windows.length)
            this._switchTab(i);
    }

    activateNext() {
        if (this._windows.length <= 1) return;
        this._switchTab((this._activeIndex + 1) % this._windows.length);
    }

    activatePrev() {
        if (this._windows.length <= 1) return;
        this._switchTab((this._activeIndex - 1 + this._windows.length) % this._windows.length);
    }

    _switchTab(newIndex) {
        if (newIndex === this._activeIndex) return;
        const prevIndex = this._activeIndex;
        this._activeIndex = newIndex;
        this._syncWindows();

        if (!this._bar || !this._tc) {
            this._rebuildBar();
            return;
        }

        const children = this._bar.get_children();
        if (prevIndex >= children.length || newIndex >= children.length) {
            this._rebuildBar();
            return;
        }

        this._applyTabStyle(children[prevIndex], false);
        this._applyTabStyle(children[newIndex], true);
        this._watchPosition();
    }

    _applyTabStyle(btn, isActive) {
        const tc = this._tc;
        const style = isActive ? tc.accent : `background-color: ${tc.tabBg};`;
        btn.set_style(style);
        btn._tabbyBaseStyle = style;
        btn._tabbyIsActive = isActive;

        const content = btn.get_child();
        if (!content) return;
        for (const child of content.get_children()) {
            if (child.style_class === 'tabby-tab-label') {
                child.set_style(isActive
                    ? `color: ${tc.fgActive}; font-weight: 600;`
                    : `color: ${tc.fgDim};`);
            } else if (child.style_class === 'tabby-close-btn') {
                if (!child.hover)
                    child.set_style(`opacity: ${isActive ? 180 : 120};`);
            } else if (child.icon_size === ICON_SIZE) {
                child.set_opacity(isActive ? 255 : 160);
            }
        }
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
                if (w.is_fullscreen())
                    w.unmake_fullscreen();
                if (w.get_maximized())
                    w.unmaximize(Meta.MaximizeFlags.BOTH);
                if (this._frame) {
                    const wa = workAreaOf(w);
                    const minY = wa.y + BAR_HEIGHT;
                    const y = Math.max(this._frame.y, minY);
                    const maxH = wa.y + wa.height - y;
                    const h = Math.min(this._frame.height, maxH);
                    w.move_resize_frame(false, wa.x, y, wa.width, h);
                }
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

    _rebuildBar(animate = true) {
        this._destroyBar();
        if (this._windows.length < 2) return;

        const active = this.activeWindow;
        if (!active) return;

        const rect = getBarRect(active);
        const tc = readThemeColors();
        this._tc = tc;

        this._bar = new St.BoxLayout({
            style_class: 'tabby-bar',
            style: `background-color: ${tc.barBg};`,
            reactive: true,
            x: rect.x,
            y: rect.y,
            height: BAR_HEIGHT,
            width: rect.width,
        });
        this._barRect = rect;
        this._bar.get_layout_manager().homogeneous = true;
        if (animate) this._bar.opacity = 0;

        const tracker = Shell.WindowTracker.get_default();
        const maxLen = Math.max(12, Math.floor(TITLE_BUDGET / this._windows.length));

        for (let i = 0; i < this._windows.length; i++) {
            const isActive = i === this._activeIndex;
            const app = tracker.get_window_app(this._windows[i]);
            const title = this._windows[i].get_title() || app?.get_name() || 'Window';
            const label = title.length > maxLen ? title.substring(0, maxLen - 1) + '…' : title;

            const btnStyle = isActive ? tc.accent : `background-color: ${tc.tabBg};`;
            const btn = new St.Button({
                style_class: 'tabby-tab-btn',
                style: btnStyle,
                reactive: true,
                track_hover: true,
                x_expand: true,
            });
            btn._tabbyBaseStyle = btnStyle;
            btn._tabbyIsActive = isActive;
            btn._tabbyWin = this._windows[i];

            // Hover: cursor + color
            btn.connect('notify::hover', () => {
                if (this._drag?.dragging)
                    return;
                if (btn.hover) {
                    global.display.set_cursor(Meta.Cursor.POINTING_HAND);
                    if (!btn._tabbyIsActive)
                        btn.set_style(`background-color: ${tc.tabHover};`);
                } else {
                    global.display.set_cursor(Meta.Cursor.DEFAULT);
                    if (!btn._tabbyIsActive)
                        btn.set_style(btn._tabbyBaseStyle);
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

            const labelWidget = new St.Label({
                text: label,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'tabby-tab-label',
                style: isActive
                    ? `color: ${tc.fgActive}; font-weight: 600;`
                    : `color: ${tc.fgDim};`,
            });
            content.add_child(labelWidget);

            // Track title changes
            const winRef = this._windows[i];
            const titleSigId = winRef.connect('notify::title', () => {
                const t = winRef.get_title() || app?.get_name() || 'Window';
                labelWidget.set_text(t.length > maxLen ? t.substring(0, maxLen - 1) + '…' : t);
            });
            this._titleSignals.push({win: winRef, id: titleSigId});

            // Close button (system icon)
            const closeIcon = new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: 12,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const closeBtn = new St.Button({
                style_class: 'tabby-close-btn',
                style: `opacity: ${isActive ? 180 : 120};`,
                reactive: true,
                track_hover: true,
                child: closeIcon,
            });
            closeBtn.connect('notify::hover', () => {
                if (this._drag?.dragging)
                    return;
                closeBtn.set_style(closeBtn.hover
                    ? 'opacity: 255; background-color: rgba(255,70,70,0.6); border-radius: 99px;'
                    : `opacity: ${btn._tabbyIsActive ? 180 : 120};`);
                if (closeBtn.hover)
                    global.display.set_cursor(Meta.Cursor.POINTING_HAND);
                else
                    global.display.set_cursor(Meta.Cursor.DEFAULT);
            });
            closeBtn.connect('clicked', () => {
                if (!btn._tabbyWin) return;
                btn._tabbyWin.delete(global.get_current_time());
            });
            content.add_child(closeBtn);

            btn.set_child(content);
            this._connectDrag(btn, btnStyle, tc.dragBg);
            this._bar.add_child(btn);
        }

        this._bar.connect('button-release-event', () => {
            if (this._drag) {
                this._endDrag();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });


        Main.layoutManager.addChrome(this._bar, {trackFullscreen: false});
        if (animate) {
            this._bar.ease({
                opacity: 255,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this._watchPosition();
    }

    // --- Drag-to-reorder ---

    _connectDrag(btn, origStyle, dragBg) {
        // pressX is local per button — only tracks pre-drag press position.
        // this._drag is only created when threshold is actually exceeded.
        let pressX = null;

        btn.connect('button-press-event', (_a, ev) => {
            if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            pressX = ev.get_coords()[0];
            return Clutter.EVENT_PROPAGATE;
        });

        btn.connect('button-release-event', () => {
            pressX = null;
            if (this._drag) {
                this._endDrag();
            } else {
                const idx = this._windows.indexOf(btn._tabbyWin);
                if (idx !== -1) this.activateByIndex(idx);
            }
            return Clutter.EVENT_STOP;
        });

        btn.connect('motion-event', (_a, ev) => {
            // Safety: if mouse button not held, clean up any stale state
            if (!(ev.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
                pressX = null;
                if (this._drag) this._endDrag();
                return Clutter.EVENT_PROPAGATE;
            }

            // Pre-drag: detect threshold
            if (pressX !== null && !this._drag) {
                const [x] = ev.get_coords();
                if (Math.abs(x - pressX) <= DRAG_THRESHOLD)
                    return Clutter.EVENT_PROPAGATE;

                const idx = this._windows.indexOf(btn._tabbyWin);
                if (idx === -1) { pressX = null; return Clutter.EVENT_PROPAGATE; }

                const children = this._bar.get_children();
                const positions = children.map(c => c.get_transformed_position()[0]);
                const tabWidth = children[0].get_width();
                const spacing = children.length > 1 ? positions[1] - positions[0] : tabWidth;

                this._drag = {
                    sourceIndex: idx,
                    insertIndex: idx,
                    startX: pressX,
                    actor: btn,
                    origStyle,
                    dragBg,
                    positions,
                    tabWidth,
                    spacing,
                };
                pressX = null;

                btn.set_style(`${dragBg} opacity: 220;`);
                btn.set_z_position(1);
                global.display.set_cursor(Meta.Cursor.DND_IN_DRAG);

                // Stage handler: end drag if cursor leaves bar vertically
                this._drag._stageId = global.stage.connect('captured-event', (_s, event) => {
                    if (event.type() !== Clutter.EventType.MOTION || !this._bar)
                        return Clutter.EVENT_PROPAGATE;
                    const [, y] = event.get_coords();
                    const [, barY] = this._bar.get_transformed_position();
                    if (y < barY || y > barY + this._bar.get_height())
                        this._endDrag();
                    return Clutter.EVENT_PROPAGATE;
                });
            }

            if (!this._drag) return Clutter.EVENT_PROPAGATE;

            // Active drag: move tab
            const [x] = ev.get_coords();
            const dx = x - this._drag.startX;
            this._drag.actor.translation_x = dx;

            const src = this._drag.sourceIndex;
            const tw = this._drag.tabWidth;
            const sp = this._drag.spacing;
            const firstPos = this._drag.positions[0];
            const draggedCenter = this._drag.positions[src] + tw / 2 + dx;
            let slot = Math.round((draggedCenter - firstPos - tw / 2) / sp);
            slot = Math.max(0, Math.min(this._windows.length - 1, slot));

            if (slot !== this._drag.insertIndex) {
                this._drag.insertIndex = slot;
                const children = this._bar.get_children();
                for (let j = 0; j < children.length; j++) {
                    if (j === src) continue;
                    let shift = 0;
                    if (src < slot && j > src && j <= slot) shift = -sp;
                    else if (src > slot && j < src && j >= slot) shift = sp;

                    children[j].remove_all_transitions();
                    children[j].ease({
                        translation_x: shift,
                        duration: 200,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
            }
            return Clutter.EVENT_STOP;
        });
    }

    _moveTab(from, to) {
        const win = this._windows.splice(from, 1)[0];
        this._windows.splice(to, 0, win);

        // Update active index to follow the active window
        if (this._activeIndex === from) {
            this._activeIndex = to;
        } else if (from < this._activeIndex && to >= this._activeIndex) {
            this._activeIndex--;
        } else if (from > this._activeIndex && to <= this._activeIndex) {
            this._activeIndex++;
        }
    }

    _endDrag() {
        if (!this._drag) return;

        if (this._drag._stageId) {
            global.stage.disconnect(this._drag._stageId);
        }

        // Restore dragged tab's original style
        this._drag.actor.set_style(this._drag.origStyle);

        const from = this._drag.sourceIndex;
        const to = this._drag.insertIndex;

        const children = this._bar.get_children();
        for (const child of children) {
            child.remove_all_transitions();
            child.translation_x = 0;
            child.set_z_position(0);
        }

        this._drag = null;

        if (to !== from) {
            this._moveTab(from, to);
            const child = children[from];
            this._bar.remove_child(child);
            this._bar.insert_child_at_index(child, to);
        }

        global.display.set_cursor(Meta.Cursor.DEFAULT);
    }

    // --- Position tracking ---

    _watchPosition() {
        this._clearPositionWatch();

        const win = this.activeWindow;
        if (!this._bar || !win)
            return;

        this._trackedWindow = win;
        this._positionSignals.push(win.connect('position-changed', () => this._syncBarPosition(true)));
        this._positionSignals.push(win.connect('workspace-changed', () => this._syncBarPosition(false)));

        this._syncBarPosition(false);
    }

    _syncBarPosition(animate) {
        if (!this._bar || !this._trackedWindow)
            return;

        try {
            const r = getBarRect(this._trackedWindow);
            if (this._barRect &&
                this._barRect.x === r.x &&
                this._barRect.y === r.y &&
                this._barRect.width === r.width)
                return;

            this._barRect = r;
            this._bar.remove_all_transitions();

            if (animate) {
                this._bar.ease({
                    x: r.x,
                    y: r.y,
                    width: r.width,
                    duration: POSITION_EASE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                this._bar.set_position(r.x, r.y);
                this._bar.set_width(r.width);
            }
        } catch (_) {
            this._clearPositionWatch();
        }
    }

    _clearPositionWatch() {
        if (this._trackedWindow) {
            for (const sid of this._positionSignals) {
                try { this._trackedWindow.disconnect(sid); } catch (_) {}
            }
        }
        this._positionSignals = [];
        this._trackedWindow = null;
    }

    _destroyBar() {
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        this._clearPositionWatch();
        if (this._drag?._stageId) {
            global.stage.disconnect(this._drag._stageId);
        }
        this._drag = null;
        this._barRect = null;
        for (const {win, id} of this._titleSignals) {
            try { win.disconnect(id); } catch (_) {}
        }
        this._titleSignals = [];
        if (this._bar) {
            Main.layoutManager.removeChrome(this._bar);
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
            if (groupApp === app && group.windows[0]?.get_workspace() === win.get_workspace()) {
                group.addWindow(win);
                this._winMap.set(win, group);
                group.sync();
                return;
            }
        }
    }

    _forgetWindow(win) {
        this._winMap.delete(win);
    }

    _removeGroup(group) {
        const idx = this._groups.indexOf(group);
        if (idx !== -1) this._groups.splice(idx, 1);
        for (const [w, g] of this._winMap) {
            if (g === group) this._winMap.delete(w);
        }
    }
}
