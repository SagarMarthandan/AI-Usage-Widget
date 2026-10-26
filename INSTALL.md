# Installation

Tested on GNOME Shell 46 (Zorin OS 18.1, X11) with Dash to Panel. The widget
uses the standard GNOME panel APIs and also works without Dash to Panel.

## Prerequisites

- GNOME Shell 46 session (X11 or Wayland).
- `python3` ≥ 3.9.
- OMP installed and authenticated (`omp usage --json` works).
- An OpenRouter API key from <https://openrouter.ai/keys>.

## Automatic install

```bash
git clone https://github.com/SagarMarthandan/AI-Usage-Widget.git ~/Projects/AI-Usage-Widget
cd ~/Projects/AI-Usage-Widget
./install.sh
```

`install.sh` performs the manual steps below. It is idempotent and refuses to
replace an existing real extension directory (a symlink is fine). On first run
it prompts for the OpenRouter key unless `OPENROUTER_API_KEY` is already set;
leave the prompt empty to configure the key later.

Then load the extension:

- **X11:** `Alt+F2`, type `r`, Enter — with no popup menu open.
- **Wayland:** log out and back in.

> Do **not** `systemctl restart` or `systemctl kill org.gnome.Shell@x11.service`.
> That tears down the session; it does not reexec the shell.

## Manual install

Clone anywhere (examples use `~/Projects/AI-Usage-Widget`):

```bash
git clone https://github.com/SagarMarthandan/AI-Usage-Widget.git ~/Projects/AI-Usage-Widget
REPO="$HOME/Projects/AI-Usage-Widget"
UUID="openrouter-credits@sagar.marthandan"
```

### 1. Symlink the collector, extension and units

```bash
mkdir -p ~/.local/bin ~/.config/ai-usage ~/.config/systemd/user \
         ~/.local/share/gnome-shell/extensions

ln -sfn "$REPO/bin/ai-usage" ~/.local/bin/ai-usage
ln -sfn "$REPO/gnome-extension" \
        ~/.local/share/gnome-shell/extensions/$UUID

ln -sf "$REPO/systemd/ai-usage.service" ~/.config/systemd/user/ai-usage.service
ln -sf "$REPO/systemd/ai-usage.timer"   ~/.config/systemd/user/ai-usage.timer
```

If `~/.local/share/gnome-shell/extensions/$UUID` already exists as a real
directory, move it away first; do not overwrite it.

### 2. Store the OpenRouter key

```bash
printf 'OPENROUTER_API_KEY=%s\n' 'sk-or-v1-...' > ~/.config/ai-usage/env
chmod 600 ~/.config/ai-usage/env
```

The key can also be exported as `OPENROUTER_API_KEY` for a one-off run.

### 3. Enable the timer

```bash
systemctl --user daemon-reload
systemctl --user enable --now ai-usage.timer
systemctl --user start ai-usage.service
ai-usage                      # verify the collector works
```

### 4. Register the extension

```bash
python3 - <<'PY'
import ast, subprocess
schema = 'org.gnome.shell'
uuid = 'openrouter-credits@sagar.marthandan'
out = subprocess.run(['gsettings', 'get', schema, 'enabled-extensions'],
                     capture_output=True, text=True, check=True).stdout
items = ast.literal_eval(out.strip())
if uuid not in items:
    items.append(uuid)
    subprocess.run(['gsettings', 'set', schema, 'enabled-extensions',
                    '[' + ', '.join(repr(i) for i in items) + ']'], check=True)
PY
```

After the shell has scanned the directory, `gnome-extensions enable
openrouter-credits@sagar.marthandan` also works.

### 5. Restart the shell once

A newly added extension directory is only scanned at shell startup:

- X11: `Alt+F2` → `r` → Enter.
- Wayland: log out / log in.

Check:

```bash
gnome-extensions info openrouter-credits@sagar.marthandan
gnome-extensions list --enabled | grep openrouter
ai-usage providers
```

## Configure providers

Menu → **Providers**, or:

```bash
ai-usage providers
ai-usage set-provider claude off
ai-usage set-provider opencode-go on
```

Selection lives in `~/.config/ai-usage/config.json` and takes effect
immediately (the collector rewrites the visible cache).

## Updating

Because the live paths are symlinks into the clone, pulling is enough for the
collector and docs:

```bash
cd ~/Projects/AI-Usage-Widget
git pull --ff-only
systemctl --user restart ai-usage.service   # optional; timer picks it up
```

Extension code is cached per shell session: reload the shell once after a pull
that changes `gnome-extension/`.

## Uninstall

```bash
systemctl --user disable --now ai-usage.timer
systemctl --user stop ai-usage.service 2>/dev/null || true

gnome-extensions disable openrouter-credits@sagar.marthandan 2>/dev/null || true
rm -f ~/.local/share/gnome-shell/extensions/openrouter-credits@sagar.marthandan
rm -f ~/.local/bin/ai-usage
rm -f ~/.config/systemd/user/ai-usage.service ~/.config/systemd/user/ai-usage.timer
systemctl --user daemon-reload

rm -rf ~/.config/ai-usage ~/.cache/ai-usage
```

Optionally remove the UUID from `org.gnome.shell enabled-extensions`.

## Notes

- The extension UUID intentionally remains `openrouter-credits@sagar.marthandan`
  for upgrade compatibility; the display name is **AI Usage**.
- `providers` / `openrouter` in `status.json` are the selected view;
  `providers_all` / `openrouter_all` keep every source for instant toggles.
- The extension never reads the OpenRouter key. Only `bin/ai-usage` does.
- If the collector cannot reach a source, it keeps the last known values and
  sets `ok: false` plus an error; the menu shows `Last error`.
