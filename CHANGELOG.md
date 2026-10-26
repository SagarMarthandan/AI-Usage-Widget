# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-10-26

Initial public release. Extension metadata version 3.

### Added

- GNOME Shell 46 panel indicator with one chip per provider (icon, name,
  percentage used, reset countdown) and a detail popup.
- Provider cards with usage meter, prorated pace (`ahead of pace` /
  `behind pace` and expected usage), and every limit window.
- Providers: Claude, Codex, OpenCode Go and OpenRouter balance.
- Red/amber state when a provider is ahead of its prorated window; balance
  thresholds are configurable.
- Provider selection from the menu (`Providers` submenu) or CLI
  (`ai-usage set-provider <id> <on|off>`), persisted in `config.json`.
- Collector (`bin/ai-usage`) combining `omp usage --json` with OpenRouter
  `/credits` and `/auth/key`; atomic cache writes and last-known-value fallback
  with `Last error` reporting.
- systemd user timer refreshing every 5 minutes, menu auto-refresh on stale
  data, and a **Refresh now** action.
- Full-data keys (`providers_all`, `openrouter_all`) so selection toggles apply
  without an API round trip; legacy `providers` / `openrouter` keys keep older
  loaded extension modules correct.
- Installer (`install.sh`), manual install/upgrade/uninstall guide, MIT license,
  and panel preview.
