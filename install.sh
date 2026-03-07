#!/bin/bash
set -e

EXT_UUID="tabby-windows@custom"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "=== Tabby Windows Extension Install ==="

# Clean previous installation
if [ -d "$EXT_DIR" ]; then
    echo "Removing previous installation..."
    rm -rf "$EXT_DIR"
fi

# Create extension directory
mkdir -p "$EXT_DIR/schemas"

# Copy files
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/metadata.json" "$EXT_DIR/"
cp "$SCRIPT_DIR/extension.js" "$EXT_DIR/"
cp "$SCRIPT_DIR/stylesheet.css" "$EXT_DIR/"
cp "$SCRIPT_DIR/schemas/org.gnome.shell.extensions.tabby-windows.gschema.xml" "$EXT_DIR/schemas/"

# Compile schemas
echo "Compiling schemas..."
glib-compile-schemas "$EXT_DIR/schemas/"

# Enable extension
echo "Enabling extension..."
gnome-extensions enable "$EXT_UUID" 2>/dev/null || true

echo ""
echo "=== Installation complete! ==="
echo ""
echo "Log out and log back in (Wayland) or press Alt+F2 → r → Enter (X11)."
echo ""
echo "Shortcuts:"
echo "  Super+T       → Group / Ungroup windows"
echo "  Super+Shift+T → Remove window from group"
echo "  Ctrl+Super+Right → Next tab"
echo "  Ctrl+Super+Left  → Previous tab"
echo ""
echo "Usage:"
echo "  1. Focus an application window."
echo "  2. Press Super+T: all windows of the same app are grouped as tabs."
echo "  3. Use Ctrl+Super+Right / Ctrl+Super+Left to switch between tabs."
