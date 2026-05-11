import { App, Notice } from 'obsidian';
import {
    BINARY_EXTENSIONS,
    MTIME_TOLERANCE_MS,
    OBSIDIAN_CONFIG_FORCED_EXCLUDES,
    OBSIDIAN_CONFIG_REMOTE_SUBFOLDER,
    SELF_PLUGIN_ID,
} from '../constants';
import { t } from '../i18n';
import { ManifestEntry, YandexSyncSettings } from '../settings/types';
import { RemoteEntry, YandexApiError, YandexClient } from '../api/client';
import { errorMessage } from '../util/errors';
import { sha256 } from './hash';
import { runWithConcurrency } from './concurrency';

export interface ConfigSyncReport {
    uploaded: string[];
    downloaded: string[];
    deletedRemote: string[];
    deletedLocal: string[];
    skipped: string[];
    errors: { path: string; reason: string }[];
    aborted: boolean;
    cancelled: boolean;
}

export interface ConfigSyncCallbacks {
    isCancelled?: () => boolean;
    onProgress?: (current: number, total: number, file: string) => void;
}

// Obsidian's configuration folder is normally `.obsidian`, but the user may
// override it via `app.vault.configDir`. Always read it from the live vault
// instead of hardcoding the name.

/**
 * Syncs the entire .obsidian/ directory (settings, hotkeys, themes, snippets,
 * community plugin metadata) between the vault and Yandex Disk.
 *
 * Independent from the main note SyncEngine:
 *   - uses vault.adapter (notes engine uses TFile API, which doesn't see .obsidian/)
 *   - has its own manifest (configManifest)
 *   - last-write-wins (no UI conflict resolution \u2014 config files are not user prose)
 *   - hard-excludes session/cache files and own plugin folder
 */
export class ConfigSyncEngine {
    constructor(
        private app: App,
        private settings: YandexSyncSettings,
        private client: YandexClient,
        private saveSettings: () => Promise<void>,
    ) { }

    private get configRoot(): string {
        return this.app.vault.configDir;
    }

    async run(callbacks: ConfigSyncCallbacks = {}, dryRun = false, downloadOnly = false): Promise<ConfigSyncReport> {
        const report: ConfigSyncReport = {
            uploaded: [],
            downloaded: [],
            deletedRemote: [],
            deletedLocal: [],
            skipped: [],
            errors: [],
            aborted: false,
            cancelled: false,
        };
        const cancelled = () => callbacks.isCancelled?.() === true;

        try {
            const syncFolder = this.normalizeRemote(this.settings.syncFolder);
            const remoteRoot = `${syncFolder}/${OBSIDIAN_CONFIG_REMOTE_SUBFOLDER}`;
            await this.client.ensureFolder(remoteRoot);

            // 1. Walk local .obsidian/ recursively
            const localFiles = new Map<string, { mtime: number; size: number }>();
            await this.walkLocal(this.configRoot, localFiles);

            // 2. Apply excludes
            const isExcluded = this.makeExcluder();
            for (const p of [...localFiles.keys()]) {
                if (isExcluded(p)) localFiles.delete(p);
            }

            // 3. List remote
            let remoteFiles = new Map<string, RemoteEntry>();
            try {
                remoteFiles = await this.client.list(remoteRoot, null, []);
            } catch (e: unknown) {
                if (!(e instanceof YandexApiError && e.status === 404)) {
                    console.warn('Config-sync remote listing failed:', e);
                    report.errors.push({ path: remoteRoot, reason: errorMessage(e) });
                }
            }
            for (const p of [...remoteFiles.keys()]) {
                if (isExcluded(`${this.configRoot}/${p}`)) remoteFiles.delete(p);
            }

            if (cancelled()) {
                report.cancelled = true;
                return report;
            }

            // 4. Plan actions
            const allPaths = new Set<string>();
            for (const p of localFiles.keys()) allPaths.add(p);
            for (const p of remoteFiles.keys()) allPaths.add(`${this.configRoot}/${p}`);
            for (const p of Object.keys(this.settings.configManifest)) allPaths.add(p);

            const uploadList: string[] = [];
            const downloadList: string[] = [];
            const remoteDeleteList: string[] = [];
            const localDeleteList: string[] = [];

            for (const vaultPath of allPaths) {
                const remoteRel = vaultPath.startsWith(this.configRoot + '/')
                    ? vaultPath.substring(this.configRoot.length + 1)
                    : vaultPath;
                const local = localFiles.get(vaultPath);
                const remote = remoteFiles.get(remoteRel);
                const manifest = this.settings.configManifest[vaultPath];

                if (local && !remote && !manifest) {
                    uploadList.push(vaultPath);
                } else if (!local && remote && !manifest) {
                    downloadList.push(vaultPath);
                } else if (local && remote && !manifest) {
                    // Both exist, never tracked: newer wins
                    if (local.mtime >= (remote.mtime || 0)) uploadList.push(vaultPath);
                    else downloadList.push(vaultPath);
                } else if (local && !remote && manifest) {
                    // In manifest, local present, remote gone => deleted remotely
                    if (Math.abs(manifest.localMtime - local.mtime) < MTIME_TOLERANCE_MS) {
                        // Unchanged locally => follow remote: delete locally
                        localDeleteList.push(vaultPath);
                    } else {
                        // Changed locally after last sync => re-upload
                        uploadList.push(vaultPath);
                    }
                } else if (!local && remote && manifest) {
                    // Local was deleted => delete remote too
                    remoteDeleteList.push(vaultPath);
                } else if (!local && !remote && manifest) {
                    // Tombstone: clean from manifest
                    delete this.settings.configManifest[vaultPath];
                } else if (local && remote && manifest) {
                    // Compare each side vs manifest
                    const localChanged =
                        local.size !== manifest.size ||
                        Math.abs(local.mtime - manifest.localMtime) >= MTIME_TOLERANCE_MS;
                    const remoteChanged =
                        remote.mtime > 0 &&
                        remote.mtime > manifest.remoteMtime + MTIME_TOLERANCE_MS;
                    if (!localChanged && !remoteChanged) {
                        report.skipped.push(vaultPath);
                    } else if (localChanged && !remoteChanged) {
                        uploadList.push(vaultPath);
                    } else if (!localChanged && remoteChanged) {
                        downloadList.push(vaultPath);
                    } else {
                        // Both changed: last-write-wins by mtime
                        if (local.mtime >= remote.mtime) uploadList.push(vaultPath);
                        else downloadList.push(vaultPath);
                    }
                }
            }

            if (downloadOnly) {
                // Bootstrap mode: pure pull from remote.
                // Files queued for upload or for any kind of deletion are intentionally
                // skipped \u2014 we don't touch the remote at all and we don't remove anything
                // local. Whatever is on remote is added/overwritten locally; everything
                // else is left alone for the user to decide later.
                for (const p of uploadList) report.skipped.push(p);
                for (const p of remoteDeleteList) report.skipped.push(p);
                for (const p of localDeleteList) report.skipped.push(p);
                uploadList.length = 0;
                remoteDeleteList.length = 0;
                localDeleteList.length = 0;
            }

            const totalOps = uploadList.length + downloadList.length + remoteDeleteList.length + localDeleteList.length;
            let opCounter = 0;
            const tick = (file: string) => {
                opCounter++;
                callbacks.onProgress?.(opCounter, totalOps, file);
            };

            // 5. Uploads
            const uploadTasks = uploadList.map((vaultPath) => async () => {
                if (cancelled()) return;
                tick(vaultPath);
                if (dryRun) {
                    report.uploaded.push(vaultPath);
                    return;
                }
                try {
                    await this.uploadOne(vaultPath, syncFolder);
                    report.uploaded.push(vaultPath);
                } catch (e: unknown) {
                    report.errors.push({ path: vaultPath, reason: errorMessage(e) });
                }
            });

            // 6. Downloads
            const downloadTasks = downloadList.map((vaultPath) => async () => {
                if (cancelled()) return;
                tick(vaultPath);
                if (dryRun) {
                    report.downloaded.push(vaultPath);
                    return;
                }
                try {
                    const remoteRel = vaultPath.substring(this.configRoot.length + 1);
                    const entry = remoteFiles.get(remoteRel);
                    await this.downloadOne(vaultPath, syncFolder, entry);
                    report.downloaded.push(vaultPath);
                } catch (e: unknown) {
                    report.errors.push({ path: vaultPath, reason: errorMessage(e) });
                }
            });

            await runWithConcurrency(uploadTasks, this.settings.maxConcurrency, cancelled);
            if (cancelled()) {
                report.cancelled = true;
                return report;
            }
            await runWithConcurrency(downloadTasks, this.settings.maxConcurrency, cancelled);
            if (cancelled()) {
                report.cancelled = true;
                return report;
            }

            // 7. Deletions (sequential, respect enableDelete + useTrash via direct DELETE \u2014
            //    config files don't go to trash; restoring random hotkeys.json is rarely useful)
            if (this.settings.enableDelete) {
                for (const vaultPath of remoteDeleteList) {
                    if (cancelled()) break;
                    tick(vaultPath);
                    if (dryRun) {
                        report.deletedRemote.push(vaultPath);
                        continue;
                    }
                    try {
                        const remoteRel = vaultPath.substring(this.configRoot.length + 1);
                        await this.client.delete(`${syncFolder}/${OBSIDIAN_CONFIG_REMOTE_SUBFOLDER}/${remoteRel}`);
                        delete this.settings.configManifest[vaultPath];
                        report.deletedRemote.push(vaultPath);
                    } catch (e: unknown) {
                        report.errors.push({ path: vaultPath, reason: errorMessage(e) });
                    }
                }
                for (const vaultPath of localDeleteList) {
                    if (cancelled()) break;
                    tick(vaultPath);
                    if (dryRun) {
                        report.deletedLocal.push(vaultPath);
                        continue;
                    }
                    try {
                        await this.app.vault.adapter.remove(vaultPath);
                        delete this.settings.configManifest[vaultPath];
                        report.deletedLocal.push(vaultPath);
                    } catch (e: unknown) {
                        report.errors.push({ path: vaultPath, reason: errorMessage(e) });
                    }
                }
            }

            if (!dryRun) await this.saveSettings();
        } catch (e: unknown) {
            console.error('Config-sync fatal:', e);
            report.aborted = true;
            report.errors.push({ path: '', reason: errorMessage(e) });
            new Notice(t('errorSync'));
        }

        return report;
    }

    // ---------- helpers ----------

    private async walkLocal(
        dir: string,
        out: Map<string, { mtime: number; size: number }>,
    ): Promise<void> {
        const adapter = this.app.vault.adapter;
        let listing: { files: string[]; folders: string[] };
        try {
            listing = await adapter.list(dir);
        } catch {
            // .obsidian/ might not exist on a brand-new vault
            return;
        }
        for (const f of listing.files) {
            try {
                const stat = await adapter.stat(f);
                if (stat) {
                    out.set(f, { mtime: stat.mtime, size: stat.size });
                }
            } catch (e) {
                console.warn('config-sync: stat failed for', f, e);
            }
        }
        for (const sub of listing.folders) {
            await this.walkLocal(sub, out);
        }
    }

    private makeExcluder(): (vaultPath: string) => boolean {
        const forced = OBSIDIAN_CONFIG_FORCED_EXCLUDES;
        const selfPluginPrefix = `${this.configRoot}/plugins/${SELF_PLUGIN_ID}/`;
        const excludeData = this.settings.excludeObsidianPluginData;
        const excludeBins = this.settings.excludeObsidianPluginBinaries;
        const excludeHotkeys = this.settings.excludeObsidianHotkeys;
        return (p: string) => {
            // Always skip own plugin folder (avoid clobbering settings/manifest across machines).
            if (p.startsWith(selfPluginPrefix)) return true;
            const rel = p.startsWith(this.configRoot + '/') ? p.substring(this.configRoot.length + 1) : p;
            const basename = rel.split('/').pop() ?? '';
            if (forced.includes(basename)) return true;
            if (excludeHotkeys && rel === 'hotkeys.json') return true;
            // plugins/<id>/<file>
            if (rel.startsWith('plugins/')) {
                const parts = rel.split('/');
                if (parts.length >= 3) {
                    const file = parts[2];
                    if (excludeData && file === 'data.json') return true;
                    if (
                        excludeBins &&
                        (file === 'main.js' || file === 'styles.css' || file === 'manifest.json')
                    )
                        return true;
                }
            }
            return false;
        };
    }

    private async uploadOne(vaultPath: string, syncFolder: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        const remoteRel = vaultPath.substring(this.configRoot.length + 1);
        const remotePath = `${syncFolder}/${OBSIDIAN_CONFIG_REMOTE_SUBFOLDER}/${remoteRel}`;
        const ext = remoteRel.split('.').pop()?.toLowerCase() ?? '';
        const isBinary = BINARY_EXTENSIONS.has(ext);

        // Ensure parent folder
        const lastSlash = remotePath.lastIndexOf('/');
        if (lastSlash > 0) {
            await this.client.ensureFolder(remotePath.substring(0, lastSlash));
        }

        let body: string | ArrayBuffer;
        let size: number;
        let hash: string;
        if (isBinary) {
            const buf = await adapter.readBinary(vaultPath);
            body = buf;
            size = buf.byteLength;
            hash = await sha256(buf);
        } else {
            const text = await adapter.read(vaultPath);
            body = text;
            size = text.length;
            hash = await sha256(text);
        }
        const { remoteMtime } = await this.client.put(remotePath, body);
        const stat = await adapter.stat(vaultPath);
        this.settings.configManifest[vaultPath] = {
            hash,
            localMtime: stat?.mtime ?? Date.now(),
            size,
            remoteMtime: remoteMtime || Date.now(),
        };
    }

    private async downloadOne(
        vaultPath: string,
        syncFolder: string,
        entry: RemoteEntry | undefined,
    ): Promise<void> {
        const adapter = this.app.vault.adapter;
        const remoteRel = vaultPath.substring(this.configRoot.length + 1);
        const remotePath = `${syncFolder}/${OBSIDIAN_CONFIG_REMOTE_SUBFOLDER}/${remoteRel}`;
        const ext = remoteRel.split('.').pop()?.toLowerCase() ?? '';
        const isBinary = BINARY_EXTENSIONS.has(ext);

        // Ensure parent dir locally
        const lastSlash = vaultPath.lastIndexOf('/');
        if (lastSlash > 0) {
            const parent = vaultPath.substring(0, lastSlash);
            try {
                await adapter.mkdir(parent);
            } catch {
                /* already exists */
            }
        }

        let size: number;
        let hash: string;
        if (isBinary) {
            const buf = await this.client.getBinary(remotePath);
            await adapter.writeBinary(vaultPath, buf);
            size = buf.byteLength;
            hash = await sha256(buf);
        } else {
            const text = await this.client.getText(remotePath);
            await adapter.write(vaultPath, text);
            size = text.length;
            hash = await sha256(text);
        }
        const stat = await adapter.stat(vaultPath);
        this.settings.configManifest[vaultPath] = {
            hash,
            localMtime: stat?.mtime ?? Date.now(),
            size,
            remoteMtime: entry?.mtime ?? Date.now(),
        };
    }

    private normalizeRemote(p: string): string {
        let s = (p || '').replace(/\\+/g, '/').replace(/\/+/g, '/');
        if (!s.startsWith('/')) s = '/' + s;
        if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
        return s;
    }
}

// Type-only re-export to keep main.ts imports tidy.
export type { ManifestEntry as ConfigManifestEntry };
