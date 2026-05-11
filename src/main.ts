import { Notice, Plugin, TAbstractFile } from 'obsidian';
import { t } from './i18n';
import { LogWriter } from './logging/writer';
import { YandexSyncSettingTab } from './settings/SettingsTab';
import { DEFAULT_SETTINGS, YandexSyncSettings, migrateSettings } from './settings/types';
import { SyncEngine, SyncCallbacks } from './sync/SyncEngine';
import { ConfigSyncEngine, ConfigSyncReport } from './sync/configSync';
import { SessionReport } from './sync/SessionReport';
import { ConflictModal, ConfirmModal, ProgressModal, SelectionModal } from './ui/modals';
import { YandexWebDavClient } from './webdav/client';

export default class YandexSyncPlugin extends Plugin {
    settings!: YandexSyncSettings;
    private statusBar!: HTMLElement;
    private isSyncing = false;
    private autoSyncTimer: number | null = null;
    private modifyDebounceTimer: number | null = null;
    /** Set true if any vault mutation happens during a sync; triggers a follow-up sync. */
    private dirtyDuringSync = false;
    /** Paths the plugin is itself writing/deleting; vault events for them are ignored. */
    private selfWriteGuard = new Set<string>();
    /** Debounced settings persistence. */
    private saveDebounceTimer: number | null = null;
    private savePending = false;

    async onload(): Promise<void> {
        await this.loadSettings();

        // Ribbon
        this.addRibbonIcon('cloud', t('ribbonTitle'), () => {
            void this.startSync(false);
        });

        // Status bar
        this.statusBar = this.addStatusBarItem();
        this.statusBar.addClass('yds-status');
        this.statusBar.setText(t('statusIdle'));
        this.statusBar.addEventListener('click', () => void this.startSync(false));

        // Commands
        this.addCommand({
            id: 'yds-sync-now',
            name: t('commandSync'),
            callback: () => void this.startSync(false),
        });
        this.addCommand({
            id: 'yds-sync-dry-run',
            name: t('commandSyncDryRun'),
            callback: () => void this.startSync(true),
        });
        this.addCommand({
            id: 'yds-open-last-log',
            name: t('commandOpenLastLog'),
            callback: () => void this.openLastLog(),
        });
        this.addCommand({
            id: 'yds-test-connection',
            name: t('commandTestConnection'),
            callback: () => void this.testConnection(),
        });
        this.addCommand({
            id: 'yds-bootstrap',
            name: t('commandBootstrap'),
            callback: () => void this.bootstrapFromRemote(),
        });

        this.addSettingTab(new YandexSyncSettingTab(this.app, this));

        // Auto-sync schedule
        this.app.workspace.onLayoutReady(() => {
            this.rescheduleAutoSync();
            if (this.settings.syncOnStartup && this.settings.yandexToken && this.settings.yandexLogin) {
                window.setTimeout(() => void this.startSync(false), 4000);
            }
        });

        // File-modify debounced trigger
        this.registerEvent(
            this.app.vault.on('modify', (file: TAbstractFile) => this.onVaultMutation(file)),
        );
        this.registerEvent(
            this.app.vault.on('delete', (file: TAbstractFile) => this.onVaultMutation(file)),
        );
        this.registerEvent(
            this.app.vault.on('create', (file: TAbstractFile) => this.onVaultMutation(file)),
        );
        this.registerEvent(
            this.app.vault.on('rename', (file: TAbstractFile) => this.onVaultMutation(file)),
        );
    }

    onunload(): void {
        if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
        if (this.modifyDebounceTimer !== null) window.clearTimeout(this.modifyDebounceTimer);
        if (this.saveDebounceTimer !== null) {
            window.clearTimeout(this.saveDebounceTimer);
            // Best-effort flush — fire-and-forget; Obsidian shutdown will await microtasks.
            void this.flushSettings();
        }
    }

    async loadSettings(): Promise<void> {
        const raw = await this.loadData();
        const migrated = migrateSettings(raw ?? {});
        this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated);
        if (!this.settings.manifest || typeof this.settings.manifest !== 'object') {
            this.settings.manifest = {};
        }
        if (!Array.isArray(this.settings.includedExtensions) || this.settings.includedExtensions.length === 0) {
            this.settings.includedExtensions = [...DEFAULT_SETTINGS.includedExtensions];
        }
        if (!Array.isArray(this.settings.excludeGlobs)) {
            this.settings.excludeGlobs = [];
        }
    }

    /**
     * Schedule a settings write. Coalesces bursts so a sync touching thousands of
     * manifest entries doesn't translate into thousands of disk writes.
     */
    saveSettings(): Promise<void> {
        this.savePending = true;
        if (this.saveDebounceTimer !== null) window.clearTimeout(this.saveDebounceTimer);
        return new Promise<void>((resolve) => {
            this.saveDebounceTimer = window.setTimeout(async () => {
                this.saveDebounceTimer = null;
                await this.flushSettings();
                resolve();
            }, 400);
        });
    }

    private async flushSettings(): Promise<void> {
        if (!this.savePending) return;
        this.savePending = false;
        try {
            await this.saveData(this.settings);
        } catch (e) {
            console.error('Yandex Disk Sync: saveData failed', e);
            // Re-mark as pending so a later attempt retries.
            this.savePending = true;
        }
    }

    rescheduleAutoSync(): void {
        if (this.autoSyncTimer !== null) {
            window.clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }
        const minutes = this.settings.syncIntervalMinutes;
        if (minutes > 0) {
            const ms = minutes * 60 * 1000;
            this.autoSyncTimer = window.setInterval(() => {
                if (!this.isSyncing && this.settings.yandexToken && this.settings.yandexLogin) {
                    void this.startSync(false, /*silent*/ true);
                }
            }, ms);
            this.registerInterval(this.autoSyncTimer);
        }
    }

    private onVaultMutation(file: TAbstractFile): void {
        // Suppress events the plugin itself caused (downloads, local deletes).
        if (this.selfWriteGuard.has(file.path)) return;

        // If a sync is currently running, mark dirty so we run another pass after it.
        if (this.isSyncing) {
            this.dirtyDuringSync = true;
            return;
        }

        if (!this.settings.syncOnFileModify) return;
        if (!this.settings.yandexToken || !this.settings.yandexLogin) return;
        const lf = this.settings.localLogFolder.replace(/^\/+|\/+$/g, '') + '/';
        if (file.path.startsWith(lf)) return;
        if (this.modifyDebounceTimer !== null) window.clearTimeout(this.modifyDebounceTimer);
        const delay = Math.max(1, this.settings.syncOnFileModifyDelaySec) * 1000;
        this.modifyDebounceTimer = window.setTimeout(() => {
            this.modifyDebounceTimer = null;
            if (!this.isSyncing) void this.startSync(false, true);
        }, delay);
    }

    async testConnection(): Promise<void> {
        if (!this.settings.yandexToken) {
            new Notice(t('errorNoToken'));
            return;
        }
        if (!this.settings.yandexLogin) {
            new Notice(t('errorNoLogin'));
            return;
        }
        const client = this.makeClient();
        const folder = this.normalizeRemote(this.settings.syncFolder);
        const res = await client.testConnection(folder);
        if (res.ok) {
            new Notice(t('noticeTestOk', res.count, folder));
            return;
        }
        if (res.notFound) {
            new ConfirmModal(
                this.app,
                t('confirmCreateFolderTitle'),
                t('confirmCreateFolderDesc', folder),
                t('confirmCreateFolderBtn'),
                false,
                async (ok) => {
                    if (!ok) return;
                    try {
                        await client.ensureFolder(folder);
                    } catch (e: any) {
                        new Notice(t('noticeFolderCreateFail', e?.message ?? String(e)));
                        return;
                    }
                    new Notice(t('noticeFolderCreated', folder));
                    const recheck = await client.testConnection(folder);
                    if (recheck.ok) {
                        new Notice(t('noticeTestOk', recheck.count, folder));
                    } else {
                        new Notice(t('noticeTestFail', recheck.message));
                    }
                },
            ).open();
            return;
        }
        new Notice(t('noticeTestFail', res.message));
    }

    /**
     * One-shot helper for fresh installs on a new device. Verifies connection,
     * temporarily forces config-sync ON, runs a regular sync, then restores
     * the previous config-sync setting and shows a "please restart Obsidian"
     * dialog. Existing local files are NOT wiped \u2014 sync engine still uses
     * mtime/hash to decide what to overwrite.
     */
    async bootstrapFromRemote(): Promise<void> {
        if (!this.settings.yandexLogin || !this.settings.yandexToken) {
            new Notice(t('bootstrapNoCreds'));
            return;
        }
        const folder = this.normalizeRemote(this.settings.syncFolder);
        const client = this.makeClient();

        // Verify the remote folder is there \u2014 nothing to bootstrap from otherwise.
        const probe = await client.testConnection(folder);
        if (!probe.ok) {
            if (probe.notFound) {
                new Notice(t('bootstrapFolderMissing', folder));
            } else {
                new Notice(t('noticeTestFail', probe.message));
            }
            return;
        }

        // Confirm with user (destructive-style \u2014 will overwrite differing files).
        new ConfirmModal(
            this.app,
            t('bootstrapConfirmTitle'),
            t('bootstrapConfirmDesc', folder),
            t('bootstrapConfirmBtn'),
            true,
            async (ok) => {
                if (!ok) return;
                new Notice(t('bootstrapStarting'));

                // Force config-sync ON for this run; restore afterwards regardless of outcome.
                const prevConfigSync = this.settings.syncObsidianConfig;
                this.settings.syncObsidianConfig = true;

                // Snapshot counters to compute "downloaded during bootstrap".
                // We track via a one-shot wrapper that captures the report from startSync.
                const before = {
                    notes: 0,
                    config: 0,
                };
                this.bootstrapResultSink = (notes, config) => {
                    before.notes = notes;
                    before.config = config;
                };

                try {
                    await this.startSync(false, /*silent*/ false, /*downloadOnly*/ true);
                } finally {
                    this.settings.syncObsidianConfig = prevConfigSync;
                    this.bootstrapResultSink = null;
                    await this.flushSettings();
                }

                // Show the restart prompt regardless of file counts \u2014 the user
                // explicitly opted in and might want to restart anyway.
                new ConfirmModal(
                    this.app,
                    t('bootstrapDoneTitle'),
                    t('bootstrapDoneDesc', before.notes, before.config),
                    t('bootstrapDoneBtn'),
                    false,
                    () => {
                        /* nothing to do \u2014 user restarts Obsidian themselves */
                    },
                ).open();
            },
        ).open();
    }

    /** Set by bootstrapFromRemote() so startSync() can report file counts back. */
    private bootstrapResultSink: ((notes: number, config: number) => void) | null = null;

    async openLastLog(): Promise<void> {
        const writer = new LogWriter(this.app, this.settings, this.makeClient());
        const path = writer.findLatestLog();
        if (!path) {
            new Notice(t('noticeNoLog'));
            return;
        }
        const leaf = this.app.workspace.getLeaf(true);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file && 'extension' in file) {
            await leaf.openFile(file as any);
        }
    }

    async startSync(dryRun: boolean, silent = false, downloadOnly = false): Promise<void> {
        if (this.isSyncing) {
            if (!silent) new Notice(t('noticeSyncRunning'));
            return;
        }
        if (!this.settings.yandexToken) {
            if (!silent) new Notice(t('errorNoToken'));
            return;
        }
        if (!this.settings.yandexLogin) {
            if (!silent) new Notice(t('errorNoLogin'));
            return;
        }

        this.isSyncing = true;
        this.dirtyDuringSync = false;
        if (!silent) new Notice(dryRun ? t('noticeDryRunStarting') : t('noticeStarting'));

        const client = this.makeClient();
        const engine = new SyncEngine(this.app, this.settings, client, () => this.saveSettings());

        const progress = new ProgressModal(this.app);
        progress.open();
        let cancelledByUser = false;
        progress.onCancelled = () => {
            cancelledByUser = true;
        };

        const callbacks: SyncCallbacks = {
            onProgress: (u) => {
                let phaseLabel = '';
                if (u.phase === 'planning') phaseLabel = t('progressPhasePlanning');
                else if (u.phase === 'downloading') phaseLabel = t('progressPhaseDownloading', u.file ?? '');
                else if (u.phase === 'uploading') phaseLabel = t('progressPhaseUploading', u.file ?? '');
                else if (u.phase === 'deleting') phaseLabel = t('progressPhaseDeleting', u.file ?? '');
                else phaseLabel = t('progressPhaseFinishing');
                progress.update(phaseLabel, u.current, u.total, u.file);
                this.statusBar.setText(t('statusSyncing', u.current, u.total));
            },
            isCancelled: () => cancelledByUser,
            resolveConflicts: (paths) => this.resolveConflictsModal(paths),
            confirmRemoteDelete: (paths) => this.confirmDeleteModal(paths, false),
            confirmLocalDelete: (paths) => this.confirmDeleteModal(paths, true),
            onSelfWriteLocal: (path) => {
                this.selfWriteGuard.add(path);
                return () => {
                    // Defer removal — vault events arrive asynchronously after writes.
                    window.setTimeout(() => this.selfWriteGuard.delete(path), 500);
                };
            },
            onRetry: (attempt, status, delay) => {
                console.warn(`Yandex sync retry #${attempt} (status=${status}) in ${delay}ms`);
            },
        };

        let session: SessionReport | null = null;
        let configReport: ConfigSyncReport | null = null;
        try {
            session = await engine.run(callbacks, dryRun, downloadOnly);
            // Run config sync after main note sync, only if enabled and main sync wasn't aborted/cancelled.
            if (
                this.settings.syncObsidianConfig &&
                session &&
                !session.cancelled &&
                !session.aborted
            ) {
                const configEngine = new ConfigSyncEngine(
                    this.app,
                    this.settings,
                    client,
                    () => this.saveSettings(),
                );
                configReport = await configEngine.run(
                    {
                        isCancelled: () => cancelledByUser,
                        onProgress: (current, total, file) => {
                            progress.update(
                                t('progressPhaseSyncingConfig', file),
                                current,
                                total,
                                file,
                            );
                        },
                    },
                    dryRun,
                    downloadOnly,
                );
            }
        } finally {
            progress.close();
            this.isSyncing = false;
            // Make sure manifest changes from this run are persisted before any
            // follow-up sync reads them back.
            await this.flushSettings();
        }

        if (this.settings.enableLogs && session) {
            try {
                const writer = new LogWriter(this.app, this.settings, client);
                await writer.write(session);
            } catch (e: any) {
                console.error('Log writer error:', e);
            }
        }

        if (session) {
            if (session.cancelled) {
                new Notice(t('noticeCancelled'));
                this.statusBar.setText(t('statusError'));
            } else if (session.aborted) {
                new Notice(t('noticeInterrupted', session.uploaded.length, session.downloaded.length));
                this.statusBar.setText(t('statusError'));
            } else if (dryRun) {
                new Notice(t('noticeDryRunDone'));
                this.statusBar.setText(t('statusOk', new Date().toLocaleTimeString()));
            } else {
                if (!silent) {
                    new Notice(
                        t(
                            'noticeSuccess',
                            session.uploaded.length,
                            session.downloaded.length,
                            session.deletedRemote.length + session.deletedLocal.length,
                            session.conflicts.length,
                        ),
                    );
                }
                this.statusBar.setText(t('statusOk', new Date().toLocaleTimeString()));
            }
        } else {
            this.statusBar.setText(t('statusError'));
        }

        // Surface config-sync results in a small follow-up notice (non-silent only).
        if (configReport && !silent && !configReport.cancelled && !configReport.aborted) {
            const up = configReport.uploaded.length;
            const dn = configReport.downloaded.length;
            const del = configReport.deletedRemote.length + configReport.deletedLocal.length;
            if (up + dn + del > 0) {
                new Notice(t('noticeConfigSynced', up, dn, del));
            }
        }

        // Bootstrap mode: report download counts back to caller.
        if (this.bootstrapResultSink) {
            this.bootstrapResultSink(
                session?.downloaded.length ?? 0,
                configReport?.downloaded.length ?? 0,
            );
        }

        // If files changed during the sync, run another silent pass to pick them up.
        // Only for real syncs (dry-run wouldn't have produced manifest changes anyway).
        if (
            !dryRun &&
            this.dirtyDuringSync &&
            session &&
            !session.cancelled &&
            !session.aborted &&
            this.settings.syncOnFileModify
        ) {
            this.dirtyDuringSync = false;
            window.setTimeout(() => {
                if (!this.isSyncing) void this.startSync(false, true);
            }, 1000);
        }
    }

    private resolveConflictsModal(
        paths: string[],
    ): Promise<Map<string, 'skip' | 'overwrite' | 'keep-both' | 'prefer-remote'>> {
        return new Promise((resolve) => {
            new ConflictModal(this.app, paths, (action) => {
                const map = new Map<string, 'skip' | 'overwrite' | 'keep-both' | 'prefer-remote'>();
                for (const p of paths) map.set(p, action);
                resolve(map);
            }).open();
        });
    }

    private confirmDeleteModal(paths: string[], local: boolean): Promise<string[] | null> {
        return new Promise((resolve) => {
            new SelectionModal(
                this.app,
                local ? t('confirmLocalDeleteTitle') : t('confirmDeleteTitle'),
                local ? t('confirmLocalDeleteDesc') : t('confirmDeleteDesc'),
                paths,
                (n) => t('confirmDeleteBtn', n),
                true,
                resolve,
            ).open();
        });
    }

    private makeClient(): YandexWebDavClient {
        return new YandexWebDavClient(this.settings.yandexLogin, this.settings.yandexToken, {
            maxRetries: this.settings.maxRetries,
        });
    }

    private normalizeRemote(p: string): string {
        let s = (p || '').replace(/\\+/g, '/').replace(/\/+/g, '/');
        if (!s.startsWith('/')) s = '/' + s;
        if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
        return s;
    }
}
