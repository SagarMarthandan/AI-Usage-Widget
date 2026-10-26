# AI Usage Widget

[![GNOME Shell 46](https://img.shields.io/badge/GNOME%20Shell-46-4a86cf)](https://gnome.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

AI subscription and credit usage in your GNOME panel: weekly Claude, Codex and
OpenCode Go limits, prorated pace, reset countdowns, and your OpenRouter balance.

![AI Usage chips in the GNOME panel](docs/preview.png)

*Example with Claude hidden via provider selection; OpenRouter balance on the right.*

## Features

- **One chip per provider** — icon, name, percentage used and reset countdown,
  e.g. `Claude 31% · 16h` or `Go 6% · 4d 23h`.
- **Pace awareness** — a provider turns red when its usage is ahead of the
  prorated share of its window (70% of the week elapsed, 76% used = behind pace).
- **Detail popup** — per provider: percent used, reset countdown, a meter,
  `ahead of pace` / `behind pace`, expected usage, and every limit window
  (5-hour, weekly, monthly). OpenRouter shows remaining credit and
  today/7d/30d/all-time spend.
- **Provider selection** — show only the providers you care about, from the
  menu or the CLI; the choice is persisted.
- **Refresh on demand** — a 5-minute systemd timer, automatic refresh when the
  menu opens on stale data, and a **Refresh now** action.
- **Fail-safe cache** — API failures keep the last known numbers and surface
  `Last error` instead of blanking the panel.
- **No secrets in the panel or repo** — the collector reads the OpenRouter key
  from a `600` file and the extension only reads a JSON cache.

## Requirements

| Requirement | Notes |
| --- | --- |
| GNOME Shell 46 | Tested on 46.0 (Zorin OS 18.1, X11) with Dash to Panel; stock panel also works. |
| `python3` | Collector uses the standard library only. |
| OMP (`omp`) | Authenticated; `omp usage --json` must return reports for Codex/OpenCode Go. |
| OpenRouter API key | Used for `/api/v1/credits` and `/api/v1/auth/key`. |

The widget still runs with only OpenRouter configured; missing sources show an
actionable error.

## Install

```bash
git clone https://github.com/SagarMarthandan/AI-Usage-Widget.git ~/Projects/AI-Usage-Widget
cd ~/Projects/AI-Usage-Widget
./install.sh
```

The installer symlinks the collector, extension and systemd units, asks for your
OpenRouter key on first run, enables the timer and registers the extension.
Then restart GNOME Shell **once** so it scans the new extension directory:

- X11: `Alt+F2`, type `r`, Enter (with no popup menu open).
- Wayland: log out and back in.

Never `systemctl restart`/`kill org.gnome.Shell@x11.service` — that ends the
session instead of reexecing the shell.

Manual steps, upgrades and uninstall: **[INSTALL.md](INSTALL.md)**.

## Provider selection

Menu → **Providers** → click a provider to toggle it (`✓` = shown). Changes are
written to `config.json` and applied immediately.

```bash
ai-usage providers                    # list on/off state
ai-usage set-provider claude off      # hide Claude
ai-usage set-provider opencode-go on  # show OpenCode Go
ai-usage set-provider codex off
ai-usage set-provider openrouter on   # balance chip
```

Provider IDs: `claude`, `codex`, `opencode-go`, `openrouter`. Selecting none is
allowed; the panel then shows a neutral `AI` label.

## Configuration

`~/.config/ai-usage/config.json`:

```json
{
  "low_threshold": 5.0,
  "critical_threshold": 1.0,
  "providers": ["codex", "opencode-go", "openrouter"]
}
```

- `providers` — chip/card order follows the fixed order above, filtered by this
  list.
- `low_threshold` / `critical_threshold` — color the OpenRouter balance amber /
  red. Re-read on every refresh.

Other paths:

| Path | Purpose |
| --- | --- |
| `~/.config/ai-usage/env` | `OPENROUTER_API_KEY=…`, mode `600`. |
| `~/.cache/ai-usage/status.json` | Collector output; the extension only reads this. |
| `~/.local/bin/ai-usage` | Collector/CLI (symlink into this repo). |

## How it works

```
systemd timer (5 min)
        │
        ▼
bin/ai-usage ──► omp usage --json          (limits, plans, reset windows)
        │      └► openrouter.ai/api/v1/…    (balance, per-key spend)
        ▼
~/.cache/ai-usage/status.json
        │
        ▼
GNOME Shell extension (chips + popup)
```

- Codex: 5-hour and 7-day windows, plan and saved reset count.
- OpenCode Go: 5-hour, weekly and monthly windows.
- Claude: Anthropic limits when OMP has an Anthropic credential; otherwise the
  Claude-scoped share of Antigravity's `Claude & GPT` pool.
- OpenRouter: remaining credit (`total_credits - total_usage`) and key usage
  (today / 7d / 30d / all time).

### Claude

With no Anthropic credential the Claude chip is fed by Google Antigravity's
`Claude & GPT (shared)` weekly window and the card is labeled `shared with GPT`.
To use real Claude Code limits instead:

```bash
omp login anthropic
```

The collector prefers the `anthropic` report automatically; the chip switches on
the next refresh. No code change is needed.

## CLI

```bash
ai-usage                # human-readable report
ai-usage --json         # full status JSON
ai-usage --quiet        # for timers/hooks
ai-usage providers      # selection state
ai-usage set-provider <id> <on|off>
```

Useful checks:

```bash
systemctl --user list-timers ai-usage.timer
systemctl --user status ai-usage.service
gnome-extensions info openrouter-credits@sagar.marthandan
journalctl --user -b | grep -i ai-usage
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No widget after install | Extension directories are scanned at shell start: log out/in, or `Alt+F2` → `r` on X11. |
| **Providers** submenu missing | The shell cached the previous ESM module: reload the shell once (same as above). |
| `Last error` in the menu | Run `ai-usage` in a terminal; the panel keeps the last good numbers. |
| `omp` not found | Install/authenticate OMP, or set `OMP_BIN` to its absolute path. |
| Claude shows `shared with GPT` | No Anthropic login; run `omp login anthropic`. |
| OpenRouter chip missing | No key in `~/.config/ai-usage/env` (mode `600`), or provider disabled. |
| Extension edits do nothing | ESM modules are cached; log out/in or `Alt+F2` → `r`. Never kill the shell service. |

## Project structure

```
bin/ai-usage              collector + selection CLI (Python, stdlib)
gnome-extension/          GNOME Shell 46 extension (ESM)
  extension.js            chips, popup, meters, provider toggles
  stylesheet.css          chip/meter/status styles
  icons/                  Claude, Codex, OpenCode marks
systemd/                  oneshot collector + 5-minute timer
docs/preview.png          panel preview used above
install.sh                idempotent user-level installer
INSTALL.md                manual install, upgrade, uninstall
CHANGELOG.md              Keep a Changelog history
```

The extension UUID is `openrouter-credits@sagar.marthandan` (kept stable for
upgrades even though the display name is **AI Usage**).

## Development

The installed paths are symlinks into the clone, so edits are live. After
changing `extension.js` or `stylesheet.css`, reload the shell once (ESM cache
rule above). For the collector:

```bash
python3 -m py_compile bin/ai-usage
bin/ai-usage --json | jq .
```

Issues and pull requests are welcome. Keep provider-specific logic in the
collector and UI-only logic in the extension.

## License

[MIT](LICENSE) © 2026 Sagar Marthandan
