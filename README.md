# Yandex Disk Sync

Two-way sync between your Obsidian vault and Yandex Disk over the official Disk REST API.

Unofficial third-party plugin. Always keep an independent backup of your vault.

## Features

- Two-way sync with SHA-256 change detection — only modified files are transferred.
- Conflict resolution: ask, skip, prefer local, prefer remote, or keep both.
- Soft delete: removed files go to a dated trash folder on Yandex Disk with configurable retention.
- Confirmation dialogs with per-file checkboxes and search before any deletion.
  - **Restore** button on the local-delete dialog re-uploads files instead of removing them.
- Auto-sync on a timer, on Obsidian startup, and on file change (debounced).
- Reliable transfers powered by `cloud-api.yandex.net` — no WebDAV, no XML, no large-file stalls.
- Configurable parallelism with retries on `429` / `5xx` / timeouts.
- Dry-run mode and Markdown sync logs inside the vault.
- **Optional**: sync your `.obsidian/` config (settings, hotkeys, themes, plugin list) between devices.
- **One-click bootstrap** for a new device — pull notes + config in a single step.
- Works on desktop and mobile.
- English and Russian UI.

## Installation

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/bodyalis/YandexDiskSync/releases/latest).
2. Copy them into `<your-vault>/.obsidian/plugins/yandex-disk-sync/`.
3. Open **Settings → Community plugins**, reload the list, and enable **Yandex Disk Sync**.

### From community plugins

Once approved, find it in **Settings → Community plugins → Browse → "Yandex Disk Sync"**.

## Setup

### 1. Get a Yandex OAuth token

The plugin authenticates with the Yandex Disk REST API using an OAuth token.
The legacy WebDAV app password is **not** accepted by this API.

1. Open the Yandex Disk Polygon: <https://yandex.ru/dev/disk/poligon/>.
2. Click **Get OAuth token** and authorize the app.
3. Make sure both `cloud_api:disk.read` and `cloud_api:disk.write` scopes are granted.
4. Copy the token — you will not see it again.

The token can be revoked at any time from <https://id.yandex.ru/security/applications-and-services> without changing your account password.

### 2. Configure the plugin

Open **Settings → Yandex Disk Sync** and fill in:

| Field | Value |
|---|---|
| Yandex OAuth token | The token from step 1 |
| Folder on Yandex Disk | Where the vault will be mirrored, e.g. `/Obsidian` |
| File extensions to sync | Comma-separated list. Default covers Markdown, Canvas and common image/PDF formats. |
| Exclude paths *(optional)* | Glob patterns to skip, one per line. Example: `Drafts/**`, `**/Inbox/*.md`. |

Click **Test connection**. If the folder does not exist on Yandex Disk yet, the plugin will offer to create it.

### 3. First sync

1. Run **Sync now** from the ribbon, status bar or the command palette.
2. On the very first sync, files that exist only on one side are uploaded/downloaded; nothing is deleted.
3. Open **Open last sync log** to review what happened.

### Recommended settings

- **Soft delete** — on. Trash retention 7–30 days.
- **Conflict strategy** — *Ask each time* until you trust the sync, then switch to *Keep both*.
- **Auto-sync interval** — 5–15 minutes if you sync continuously, otherwise off.
- **Sync on startup** — on for read-only devices, off if you often open the vault offline.

## Commands

| Command | Description |
|---|---|
| Sync now | Run a full sync immediately. |
| Sync (dry run) | Compute the plan and write a log without changing any file. |
| Open last sync log | Open the most recent log file. |
| Test connection | Verify credentials and folder access. |
| Bootstrap vault from Yandex Disk | Pull all notes and the `.obsidian/` config from Yandex Disk in one step. Use on a fresh device. |

## Sync Obsidian config (.obsidian/)

The plugin can optionally sync your `.obsidian/` folder — settings, hotkeys, themes, snippets and the list of installed community plugins — between devices through the same Yandex Disk folder. Stored on the server under `<sync folder>/.obsidian-config/`.

Always excluded (hard-coded, cannot be enabled):

- `workspace`, `workspace.json`, `workspace-mobile.json` — change on every click, would constantly conflict.
- `cache`, `.DS_Store`, `Thumbs.db`.
- This plugin's own folder (`plugins/yandex-disk-sync/`) — your manifest and credentials must stay device-local.

Recommended optional excludes (on by default):

- **Plugin data (`data.json`)** — often contains API keys, OAuth tokens, or per-machine state.
- **Compiled plugin files** (`main.js`, `styles.css`, `manifest.json`) — re-installed automatically when you enable a plugin from `community-plugins.json`.

Optional excludes (off by default):

- **Hotkeys** — recommended on mixed Windows + macOS setups (Ctrl vs Cmd differ).

Conflict policy for config files: **last write wins by mtime** (no UI prompt). Deletions are mirrored. Restoring deleted config files from trash is not supported.

> Use with care: a broken setting on one machine will propagate to every device on the next sync. The first time you enable this in Settings, you'll see a warning.

## Setting up a new device

1. Install Obsidian → create an empty vault → close it.
2. Open Obsidian → install **Yandex Disk Sync** from Community plugins → enable.
3. **Settings → Yandex Disk Sync** → paste your OAuth token and pick the sync folder.
4. Toggle **Sync Obsidian config** → confirm the warning dialog.
5. Click **Bootstrap from Yandex Disk** (or run the command). All notes and your `.obsidian/` config are downloaded.
6. **Quit and restart Obsidian** so it re-reads the freshly downloaded settings.
7. Obsidian will warn about plugins listed in `community-plugins.json` that are not installed locally. Install missing ones from **Community plugins → Browse** and restart once more.

> The OAuth token is never synced — you must paste it on every new device.

## How conflicts work

After every successful sync the plugin records each file's hash, size and timestamps (the *manifest*). On the next sync, for each file:

1. Neither side changed → skip.
2. Only local changed → upload.
3. Only remote changed → download.
4. Both sides changed → conflict, resolved by your chosen strategy. With **Keep both**, the remote copy is downloaded as `name.conflict-<timestamp>.<ext>`.

If the manifest gets out of sync (e.g. you restored from a backup), use **Reset manifest** in settings — the next sync will treat both sides as new and merge them.

## Trash

When **Soft delete** is enabled, deletions on either side are mirrored into `<sync folder>/.trash/<YYYY-MM-DD>/...` on Yandex Disk and cleaned up automatically after the retention period.

## Mobile

`isDesktopOnly` is `false`, so the plugin runs on Android and iOS. The status bar item is hidden by Obsidian on mobile — use the ribbon icon or commands.

## Security

- All traffic goes to `https://cloud-api.yandex.net` over HTTPS via Obsidian's `requestUrl`.
- The OAuth token is stored in plain text in `<vault>/.obsidian/plugins/yandex-disk-sync/data.json` (Obsidian has no secure key store). Always use a token you can revoke from id.yandex.ru rather than your account password.
- No telemetry, no third-party network code.

## Building from source

```bash
git clone https://github.com/bodyalis/YandexDiskSync.git
cd YandexDiskSync
npm install
npm run dev      # watch mode
npm run build    # production build
```

For local testing, symlink the project into your vault:

```powershell
# Windows (run as Administrator)
mklink /D "C:\path\to\vault\.obsidian\plugins\yandex-disk-sync" "C:\path\to\YandexDiskSync"
```

```bash
# macOS / Linux
ln -s "$PWD" "/path/to/vault/.obsidian/plugins/yandex-disk-sync"
```

## Reporting issues

Open an issue at <https://github.com/bodyalis/YandexDiskSync/issues> with:

- Obsidian version, OS, plugin version.
- Steps to reproduce.
- Relevant excerpt from the latest log in `<vault>/Sync/YandexDiskSync/Logs/` and from the developer console (`Ctrl+Shift+I`).

## License

[MIT](LICENSE) © 2026 Bogdan Listopad
