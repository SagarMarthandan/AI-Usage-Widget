#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UUID="openrouter-credits@sagar.marthandan"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ai-usage"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
BIN_LINK="$HOME/.local/bin/ai-usage"

say() { printf '%s\n' "$*"; }

command -v python3 >/dev/null || { say "python3 is required."; exit 1; }
command -v systemctl >/dev/null || { say "a systemd user session is required."; exit 1; }

if command -v gnome-shell >/dev/null; then
  shell_major="$(gnome-shell --version | awk '{print $3}' | cut -d. -f1)"
  if [ "$shell_major" != "46" ]; then
    say "Warning: developed for GNOME Shell 46, found ${shell_major}. Continuing."
  fi
fi

mkdir -p "$HOME/.local/bin" "$CONFIG_DIR" "$UNIT_DIR" \
         "$(dirname "$EXT_DIR")"

if [ -e "$EXT_DIR" ] && [ ! -L "$EXT_DIR" ]; then
  say "Refusing to replace existing directory: $EXT_DIR"
  say "Move it away, then re-run this installer."
  exit 1
fi

ln -sfn "$REPO_DIR/bin/ai-usage" "$BIN_LINK"
ln -sfn "$REPO_DIR/gnome-extension" "$EXT_DIR"
ln -sf "$REPO_DIR/systemd/ai-usage.service" "$UNIT_DIR/ai-usage.service"
ln -sf "$REPO_DIR/systemd/ai-usage.timer" "$UNIT_DIR/ai-usage.timer"
say "Linked collector, extension and systemd units."

if [ ! -f "$CONFIG_DIR/env" ]; then
  key="${OPENROUTER_API_KEY:-}"
  if [ -z "$key" ] && [ -t 0 ]; then
    read -rsp "OpenRouter API key (leave empty to skip): " key || true
    printf '\n'
  fi
  if [ -n "$key" ]; then
    umask 077
    printf 'OPENROUTER_API_KEY=%s\n' "$key" > "$CONFIG_DIR/env"
    chmod 600 "$CONFIG_DIR/env"
    say "Stored OpenRouter key in $CONFIG_DIR/env (mode 600)."
  else
    say "No OpenRouter key stored; write it to $CONFIG_DIR/env before relying on the balance chip."
  fi
fi

systemctl --user daemon-reload
systemctl --user enable --now ai-usage.timer
systemctl --user start ai-usage.service || \
  say "Initial collection failed; run: ai-usage"

python3 - "$UUID" <<'PY'
import ast
import subprocess
import sys

schema = 'org.gnome.shell'
uuid = sys.argv[1]
out = subprocess.run(
    ['gsettings', 'get', schema, 'enabled-extensions'],
    capture_output=True, text=True, check=True,
).stdout
items = ast.literal_eval(out.strip())
if uuid not in items:
    items.append(uuid)
    value = '[' + ', '.join(repr(item) for item in items) + ']'
    subprocess.run(
        ['gsettings', 'set', schema, 'enabled-extensions', value],
        check=True,
    )
PY

gnome-extensions enable "$UUID" 2>/dev/null || true

say ""
say "Installed."
say "Restart GNOME Shell once to load the extension:"
say "  X11:     Alt+F2, type r, Enter (no popup menu open)"
say "  Wayland: log out and back in"
say "Do not restart/kill org.gnome.Shell@x11.service; that ends the session."
say ""
say "Verify with:"
say "  ai-usage"
say "  gnome-extensions info $UUID"
