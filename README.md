# Yandex Disk Sync

Two-way sync between your Obsidian vault and Yandex Disk over WebDAV.

Unofficial third-party plugin. Always keep an independent backup of your vault.

## Features

- Two-way sync with SHA-256 change detection — only modified files are transferred.
- Conflict resolution: ask, skip, prefer local, prefer remote, or keep both.
- Soft delete: removed files go to a dated trash folder on Yandex Disk with configurable retention.
- Confirmation dialogs with per-file checkboxes and search before any deletion.
- Auto-sync on a timer, on Obsidian startup, and on file change (debounced).
- Parallel transfers with retries on `429` / `5xx` / timeouts.
- Dry-run mode and Markdown sync logs inside the vault.
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

### 1. Get a Yandex app password

Yandex requires a separate password for WebDAV access — your main account password will not work.

1. Open <https://id.yandex.ru/security/app-passwords>.
2. Create a new password, choose category **WebDAV / Файлы**, give it a name (e.g. `Obsidian`).
3. Copy the generated 16-character password. You will not see it again.

> The app password can be revoked at any time from the same page without changing your main account password.

### 2. Configure the plugin

Open **Settings → Yandex Disk Sync** and fill in:

| Field | Value |
|---|---|
| Login | Your Yandex email — `user@yandex.ru` |
| App password | The 16-character password from step 1 |
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

- All traffic goes to `https://webdav.yandex.ru` over HTTPS via Obsidian's `requestUrl`.
- Credentials are stored in plain text in `<vault>/.obsidian/plugins/yandex-disk-sync/data.json` (Obsidian has no secure key store). Always use an app password so you can revoke access without changing your main password.
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
