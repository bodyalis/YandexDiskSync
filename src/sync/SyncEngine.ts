import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import { BINARY_EXTENSIONS, LARGE_FILE_CACHE_THRESHOLD, MTIME_TOLERANCE_MS, REMOTE_LOGS_SUBFOLDER } from '../constants';
import { t } from '../i18n';
import { ManifestEntry, YandexSyncSettings, ConflictStrategy } from '../settings/types';
import { DavEntry, WebDavError, YandexWebDavClient } from '../webdav/client';
import { sha256 } from './hash';
import { runWithConcurrency } from './concurrency';
import { compileGlobs } from './glob';
import { ConflictAction, SessionReport, newSession } from './SessionReport';

export type SyncPhase = 'planning' | 'downloading' | 'uploading' | 'deleting' | 'finishing';

export interface ProgressUpdate {
    phase: SyncPhase;
    current: number;
    total: number;
    file?: string;
    /** File size in bytes — provided for uploading/downloading phases so the UI can show it. */
    sizeBytes?: number;
}

export interface SyncCallbacks {
    onProgress?: (u: ProgressUpdate) => void;
    /** Resolve conflicts; called once with the list of conflict paths. */
    resolveConflicts?: (paths: string[]) => Promise<Map<string, ConflictAction>>;
    /** Confirm remote deletions. Returns selected subset (or null = cancel all). */
    confirmRemoteDelete?: (paths: string[]) => Promise<string[] | null>;
    /** Confirm local deletions (files removed on the other side). */
    confirmLocalDelete?: (paths: string[]) => Promise<string[] | null>;
    /** Called every retry attempt for a request. */
    onRetry?: (attempt: number, status: number, delayMs: number) => void;
    /** Polled regularly; if true, sync stops gracefully. */
    isCancelled?: () => boolean;
    /**
     * Called right before the engine writes or deletes a file in the local vault,
     * so the host can suppress its own auto-sync trigger. Should return a
     * disposer to call after the operation completes.
     */
    onSelfWriteLocal?: (path: string) => () => void;
}

interface ClassifiedLocal {
    file: TFile;
    kind: 'new' | 'unchanged' | 'local-newer' | 'remote-newer' | 'conflict' | 'remote-deleted';
    /** Pre-computed local hash (when read in classifier). */
    localHash?: string;
    /** Pre-read content (text or binary), reused at upload time. */
    content?: string | ArrayBuffer;
    /** Whether the file is binary. */
    isBinary?: boolean;
}

export class SyncEngine {
    /** Active callbacks for the current run, accessible to private helpers. */
    private cb: SyncCallbacks = {};

    constructor(
        private app: App,
        private settings: YandexSyncSettings,
        private client: YandexWebDavClient,
        private saveSettings: () => Promise<void>,
    ) { }

    async run(callbacks: SyncCallbacks, dryRun = false, downloadOnly = false): Promise<SessionReport> {
        this.cb = callbacks;
        const session = newSession(dryRun);
        const cb = callbacks;
        const cancelled = () => cb.isCancelled?.() === true;

        try {
            cb.onProgress?.({ phase: 'planning', current: 0, total: 1 });

            const syncFolder = this.normalizeRemote(this.settings.syncFolder);
            const logFolderPrefix = this.normalizeLocal(this.settings.localLogFolder) + '/';
            const trashSub = this.settings.trashFolder.replace(/^\/+|\/+$/g, '') || '.trash';
            const exts = new Set(this.settings.includedExtensions.map((e) => e.toLowerCase()));

            await this.client.ensureFolder(syncFolder);
            this.client.clearFolderCache();

            // Trash retention cleanup BEFORE syncing
            if (!dryRun && this.settings.useTrash && this.settings.trashRetentionDays > 0) {
                try {
                    await this.cleanTrash(syncFolder, trashSub, session);
                } catch (e: any) {
                    console.warn('Trash cleanup failed:', e);
                }
            }

            // 1. Local files (filter by extension, exclude log folder, apply user globs)
            const isExcluded = compileGlobs(this.settings.excludeGlobs ?? []);
            const allFiles = this.app.vault.getFiles();
            const localFiles = allFiles.filter(
                (f) =>
                    exts.has(f.extension.toLowerCase()) &&
                    !f.path.startsWith(logFolderPrefix) &&
                    !isExcluded(f.path),
            );
            const localPaths = new Set(localFiles.map((f) => f.path));

            // 2. Remote listing (needed for two-way sync, conflict detection, reconcile)
            let remote = new Map<string, DavEntry>();
            const remoteFolders = new Set<string>();
            const needRemote =
                this.settings.twoWaySync ||
                this.settings.enablePropfindReconcile ||
                this.settings.conflictStrategy !== 'overwrite';
            if (needRemote) {
                try {
                    remote = await this.client.listFiles(
                        syncFolder,
                        exts,
                        [REMOTE_LOGS_SUBFOLDER, trashSub],
                        remoteFolders,
                    );
                } catch (e: any) {
                    console.error('PROPFIND failed:', e);
                    // 429 = rate limited: Yandex will likely throttle subsequent
                    // PUT/GET requests too. Abort now instead of hanging for minutes.
                    if (e instanceof WebDavError && e.status === 429) {
                        session.aborted = true;
                        session.otherErrors.push({ reason: 'Rate limited (429) — try again in a minute' });
                        new Notice(t('errRateLimit'));
                        return session;
                    }
                    session.otherErrors.push({ reason: `PROPFIND failed: ${e?.message ?? e}` });
                }
            }

            // Apply user excludes to remote listing too — otherwise an excluded
            // file present on the server would be classified as `remote-deleted`
            // (locally filtered out) and offered for local deletion.
            if (remote.size > 0) {
                for (const p of [...remote.keys()]) {
                    if (isExcluded(p)) remote.delete(p);
                }
            }

            if (cancelled()) {
                session.cancelled = true;
                return session;
            }

            // 3. Classify local files
            const classified: ClassifiedLocal[] = [];
            for (let i = 0; i < localFiles.length; i++) {
                const f = localFiles[i];
                cb.onProgress?.({
                    phase: 'planning',
                    current: i + 1,
                    total: localFiles.length,
                    file: f.path,
                });
                if (cancelled()) {
                    session.cancelled = true;
                    return session;
                }
                const c = await this.classifyOne(f, remote);
                classified.push(c);
            }

            // 4. Discover remote-only files (two-way sync)
            const remoteOnly: string[] = [];
            if (this.settings.twoWaySync) {
                for (const [rp] of remote) {
                    if (!localPaths.has(rp)) remoteOnly.push(rp);
                }
            }
            // Among remote-only: split into "new on remote, never seen" (download) vs
            // "in manifest -> deleted locally" (will be handled by deletion phase).
            const remoteNewToDownload = remoteOnly.filter((p) => !this.settings.manifest[p]);

            // 5. Resolve conflicts in bulk
            const conflictPaths = classified
                .filter((c) => c.kind === 'conflict')
                .map((c) => c.file.path);
            const conflictDecisions =
                conflictPaths.length > 0 && cb.resolveConflicts
                    ? await cb.resolveConflicts(conflictPaths)
                    : this.applyAutoStrategy(conflictPaths);

            if (cancelled()) {
                session.cancelled = true;
                return session;
            }

            // 6. Build upload tasks
            const uploadTasks: Array<() => Promise<void>> = [];
            let uploadCounter = 0;
            const uploadTotal = { v: 0 };

            for (const c of classified) {
                if (c.kind === 'unchanged') {
                    session.skipped.push(c.file.path);
                    continue;
                }
                if (c.kind === 'remote-newer') {
                    // Will be handled in download phase
                    continue;
                }
                if (c.kind === 'remote-deleted') {
                    // Will be handled in deletion phase (after verification).
                    continue;
                }
                if (downloadOnly) {
                    // Bootstrap mode: never push local state to the remote.
                    session.skipped.push(c.file.path);
                    continue;
                }

                let action: ConflictAction = 'overwrite';
                if (c.kind === 'conflict') {
                    const d = conflictDecisions.get(c.file.path) ?? 'skip';
                    session.conflicts.push({ path: c.file.path, action: d });
                    if (d === 'skip') continue;
                    if (d === 'prefer-remote') {
                        // Treat as a remote-newer: download instead of upload
                        if (!remoteOnly.includes(c.file.path) && remote.has(c.file.path)) {
                            // Reclassify so the download phase below picks it up.
                            c.kind = 'remote-newer';
                            continue;
                        }
                    }
                    action = d as ConflictAction;
                    if (action === 'keep-both') {
                        if (!dryRun) {
                            try {
                                await this.saveRemoteAsConflictCopy(c.file, syncFolder);
                            } catch (e: any) {
                                session.uploadFailed.push({
                                    path: c.file.path,
                                    reason: `keep-both download failed: ${e?.message ?? e}`,
                                });
                                continue;
                            }
                        }
                        action = 'overwrite';
                    }
                }

                uploadTotal.v++;
                uploadTasks.push(async () => {
                    if (cancelled()) return;
                    const folder = c.file.parent?.path;
                    if (folder && folder !== '/' && !dryRun) {
                        await this.client.ensureFolder(`${syncFolder}/${folder}`);
                    }
                    // Show "uploading X" BEFORE the transfer starts (not after),
                    // so the user knows which file is being sent right now.
                    cb.onProgress?.({
                        phase: 'uploading',
                        current: ++uploadCounter,
                        total: uploadTotal.v,
                        file: c.file.path,
                        sizeBytes: c.file.stat.size,
                    });
                    if (dryRun) {
                        session.uploaded.push(c.file.path);
                        return;
                    }
                    try {
                        const { content, isBinary } = await this.readContent(c.file);
                        const remotePath = `${syncFolder}/${c.file.path}`;
                        const { remoteMtime } = await this.client.put(
                            remotePath,
                            content,
                            c.file.stat.size,
                        );
                        // Hash AFTER PUT — not needed for the transfer itself,
                        // only stored in the manifest.
                        const hash = c.localHash ?? await sha256(content);
                        session.uploaded.push(c.file.path);
                        this.settings.manifest[c.file.path] = {
                            hash,
                            localMtime: c.file.stat.mtime,
                            size: c.file.stat.size,
                            remoteMtime: remoteMtime || Date.now(),
                        };
                        // Update progress to show the file as "done" — clears the
                        // pulsing animation and removes the size label.
                        cb.onProgress?.({
                            phase: 'uploading',
                            current: uploadCounter,
                            total: uploadTotal.v,
                            file: c.file.path,
                            sizeBytes: 0,
                        });
                        void isBinary;
                    } catch (err: any) {
                        const msg = err?.message ?? String(err);
                        session.uploadFailed.push({ path: c.file.path, reason: msg });
                        new Notice(t('errorSpecific', c.file.name, msg));
                    }
                });
            }

            // 7. Build download tasks (two-way sync)
            const toDownload: Array<{ path: string; entry?: DavEntry }> = [];
            // a) remote-only NEW files
            for (const p of remoteNewToDownload) {
                if (!p.startsWith(`${trashSub}/`)) {
                    toDownload.push({ path: p, entry: remote.get(p) });
                }
            }
            // b) remote-newer (existing locally, server has newer)
            if (this.settings.twoWaySync) {
                for (const c of classified) {
                    if (c.kind === 'remote-newer') {
                        toDownload.push({ path: c.file.path, entry: remote.get(c.file.path) });
                    }
                }
            }

            const downloadTasks: Array<() => Promise<void>> = [];
            let dlCounter = 0;
            const dlTotal = toDownload.length;
            for (const { path: p, entry } of toDownload) {
                downloadTasks.push(async () => {
                    if (cancelled()) return;
                    cb.onProgress?.({
                        phase: 'downloading',
                        current: ++dlCounter,
                        total: dlTotal,
                        file: p,
                    });
                    if (dryRun) {
                        session.downloaded.push(p);
                        return;
                    }
                    try {
                        await this.downloadOne(p, entry, syncFolder);
                        session.downloaded.push(p);
                    } catch (err: any) {
                        const msg = err?.message ?? String(err);
                        session.downloadFailed.push({ path: p, reason: msg });
                    }
                });
            }

            // 8. Execute uploads + downloads with concurrency
            await runWithConcurrency(uploadTasks, this.settings.maxConcurrency, cancelled);
            if (cancelled()) {
                session.cancelled = true;
                return session;
            }
            // Clear the last-file label so the bar doesn't appear frozen
            // while folder sync and deletions run below.
            if (uploadTasks.length > 0) {
                cb.onProgress?.({ phase: 'finishing', current: 1, total: 1 });
            }
            await runWithConcurrency(downloadTasks, this.settings.maxConcurrency, cancelled);
            if (cancelled()) {
                session.cancelled = true;
                return session;
            }
            if (downloadTasks.length > 0) {
                cb.onProgress?.({ phase: 'finishing', current: 1, total: 1 });
            }

            // 8b. Folder sync (preserve empty folders in both directions).
            //     Files that were just uploaded/downloaded already implicitly created
            //     their parent folders; this step exists for folders that contain no
            //     tracked files at all.
            try {
                await this.syncEmptyFolders({
                    syncFolder,
                    trashSub,
                    logFolderPrefix,
                    remoteFolders,
                    isExcluded,
                    downloadOnly,
                    dryRun,
                    cancelled,
                });
            } catch (e: any) {
                console.warn('Empty-folder sync failed:', e);
            }
            if (cancelled()) {
                session.cancelled = true;
                return session;
            }

            // 9. Deletion phase
            if (this.settings.enableDelete && !downloadOnly) {
                // Remote deletions = files in manifest but no longer local AND
                //                    files on remote (reconcile) that are not local
                const fromManifest = Object.keys(this.settings.manifest).filter(
                    (p) => !localPaths.has(p),
                );
                const fromReconcile = this.settings.enablePropfindReconcile
                    ? [...remote.keys()].filter((p) => !localPaths.has(p))
                    : [];
                // If two-way sync is enabled, files-deleted-on-remote are LOCAL deletions, not remote.
                let candidateRemoteDelete = unique([...fromManifest, ...fromReconcile])
                    .filter((p) => !p.startsWith(logFolderPrefix))
                    .filter((p) => !p.startsWith(`${trashSub}/`));

                // Always remove anything we just queued for download — those are
                // not deletions, they are downloads. (Previously this was inside
                // the twoWaySync branch only, leaving a hole when reconcile was
                // on but twoWaySync was off.)
                {
                    const dlSet = new Set(toDownload.map((d) => d.path));
                    candidateRemoteDelete = candidateRemoteDelete.filter((p) => !dlSet.has(p));
                }

                let candidateLocalDelete: string[] = [];
                if (this.settings.twoWaySync) {
                    // remote-deleted: in manifest, exists locally (from classifier), not in remote
                    const rawCandidates = classified
                        .filter((c) => c.kind === 'remote-deleted')
                        .map((c) => c.file.path);
                    // Verify each one with a per-file PROPFIND concurrently.
                    // Yandex WebDAV listings can omit recently-PUT files (eventual
                    // consistency); without this check we would offer to delete files
                    // that actually exist.
                    const verifyTasks = rawCandidates.map(
                        (p) => async (): Promise<{ p: string; stillThere: boolean }> => {
                            try {
                                return { p, stillThere: await this.client.exists(`${syncFolder}/${p}`) };
                            } catch {
                                // Network error: be conservative, treat as still present.
                                return { p, stillThere: true };
                            }
                        },
                    );
                    const verifyResults = await runWithConcurrency(
                        verifyTasks,
                        this.settings.maxConcurrency,
                        cancelled,
                    );
                    for (const r of verifyResults) {
                        if (r.status === 'fulfilled') {
                            if (r.value.stillThere) session.skipped.push(r.value.p);
                            else candidateLocalDelete.push(r.value.p);
                        }
                        // rejected = conservative skip (tasks catch internally so this won't happen)
                    }
                }

                // Confirm remote deletions
                if (candidateRemoteDelete.length > 0) {
                    let approved: string[] | null = candidateRemoteDelete;
                    if (this.settings.confirmBeforeDelete && cb.confirmRemoteDelete) {
                        approved = await cb.confirmRemoteDelete(candidateRemoteDelete);
                    }
                    if (approved === null || approved.length === 0) {
                        session.deleteSkippedRemote = candidateRemoteDelete;
                        if (approved === null) new Notice(t('noticeDeleteCancelled'));
                    } else {
                        const skipped = candidateRemoteDelete.filter((p) => !approved!.includes(p));
                        session.deleteSkippedRemote = skipped;
                        let delCounter = 0;
                        const delTotal = approved.length;
                        for (const path of approved) {
                            if (cancelled()) {
                                session.cancelled = true;
                                break;
                            }
                            cb.onProgress?.({
                                phase: 'deleting',
                                current: ++delCounter,
                                total: delTotal,
                                file: path,
                            });
                            if (dryRun) {
                                session.deletedRemote.push(path);
                                continue;
                            }
                            try {
                                await this.deleteRemote(path, syncFolder, trashSub);
                                session.deletedRemote.push(path);
                                delete this.settings.manifest[path];
                            } catch (err: any) {
                                session.deleteFailed.push({
                                    path,
                                    reason: err?.message ?? String(err),
                                });
                            }
                        }
                    }
                }

                // Confirm local deletions
                if (candidateLocalDelete.length > 0) {
                    let approved: string[] | null = candidateLocalDelete;
                    if (this.settings.confirmBeforeDelete && cb.confirmLocalDelete) {
                        approved = await cb.confirmLocalDelete(candidateLocalDelete);
                    }
                    if (approved === null || approved.length === 0) {
                        session.deleteSkippedLocal = candidateLocalDelete;
                        if (approved === null) new Notice(t('noticeLocalDeleteCancelled'));
                    } else {
                        const skipped = candidateLocalDelete.filter((p) => !approved!.includes(p));
                        session.deleteSkippedLocal = skipped;
                        for (const path of approved) {
                            if (cancelled()) {
                                session.cancelled = true;
                                break;
                            }
                            if (dryRun) {
                                session.deletedLocal.push(path);
                                continue;
                            }
                            try {
                                await this.deleteLocal(path);
                                session.deletedLocal.push(path);
                                delete this.settings.manifest[path];
                            } catch (err: any) {
                                session.deleteFailed.push({
                                    path,
                                    reason: err?.message ?? String(err),
                                });
                            }
                        }
                    }
                }
            }

            cb.onProgress?.({ phase: 'finishing', current: 1, total: 1 });
            if (!dryRun) {
                // saveSettings() is debounced — await it directly so the
                // progress modal doesn't close before the manifest is written.
                await this.saveSettings();
            }
        } catch (e: any) {
            console.error('Sync engine fatal:', e);
            session.aborted = true;
            session.otherErrors.push({ reason: e?.message ?? String(e) });
            new Notice(t('errorSync'));
        } finally {
            session.finishedAt = Date.now();
        }

        return session;
    }

    // ---------- Classification ----------

    private async classifyOne(file: TFile, remote: Map<string, DavEntry>): Promise<ClassifiedLocal> {
        const manifestEntry = this.settings.manifest[file.path];
        const remoteEntry = remote.get(file.path);

        // No manifest entry: kind is determined purely by remote presence — reading
        // or hashing the file is completely unnecessary here. The upload task will
        // call readWithHash() when it actually needs the content.
        if (!manifestEntry) {
            return { file, kind: remoteEntry ? 'conflict' : 'new' };
        }

        // Fast path: size + mtime match the last-known values → treat as unchanged
        // without touching the file at all.
        const sizeMatch = manifestEntry.size === file.stat.size;
        const mtimeMatch = Math.abs(manifestEntry.localMtime - file.stat.mtime) < MTIME_TOLERANCE_MS;

        let localHash: string = manifestEntry.hash;
        let content: string | ArrayBuffer | undefined;
        let isBinary = false;

        if (!sizeMatch || !mtimeMatch) {
            // File metadata changed — read and hash to confirm.
            const r = await this.readContent(file);
            isBinary = r.isBinary;
            localHash = await sha256(r.content);
            // Cache content only for small files; large files stay out of memory
            // until the upload task runs.
            if (file.stat.size <= LARGE_FILE_CACHE_THRESHOLD) {
                content = r.content;
            }
        }

        const localChanged = manifestEntry.hash !== localHash;

        if (!remoteEntry) {
            // Remote was deleted on another device.
            if (!localChanged) return { file, kind: 'remote-deleted', localHash };
            // Local changed too — safer to re-upload.
            return { file, kind: 'local-newer', localHash, content, isBinary };
        }

        const remoteChanged =
            remoteEntry.mtime > 0 &&
            remoteEntry.mtime > manifestEntry.remoteMtime + MTIME_TOLERANCE_MS;

        if (!localChanged && !remoteChanged) return { file, kind: 'unchanged', localHash };
        if (localChanged && !remoteChanged) return { file, kind: 'local-newer', localHash, content, isBinary };
        if (!localChanged && remoteChanged) return { file, kind: 'remote-newer', localHash };
        return { file, kind: 'conflict', localHash, content, isBinary };
    }

    private applyAutoStrategy(paths: string[]): Map<string, ConflictAction> {
        const map = new Map<string, ConflictAction>();
        const s = this.settings.conflictStrategy;
        const action: ConflictAction =
            s === 'ask' ? 'skip' : (s as ConflictAction); // fallback if no callback provided
        for (const p of paths) map.set(p, action);
        return map;
    }

    // ---------- IO helpers ----------

    private async readContent(file: TFile): Promise<{ content: string | ArrayBuffer; isBinary: boolean }> {
        const ext = file.extension.toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
            const buf = await this.app.vault.readBinary(file);
            return { content: buf, isBinary: true };
        }
        const text = await this.app.vault.cachedRead(file);
        return { content: text, isBinary: false };
    }

    private async readWithHash(c: ClassifiedLocal): Promise<{
        content: string | ArrayBuffer;
        hash: string;
        isBinary: boolean;
    }> {
        if (c.content !== undefined && c.localHash) {
            return { content: c.content, hash: c.localHash, isBinary: !!c.isBinary };
        }
        const r = await this.readContent(c.file);
        const h = c.localHash ?? (await sha256(r.content));
        return { content: r.content, hash: h, isBinary: r.isBinary };
    }

    private async downloadOne(
        vaultPath: string,
        entry: DavEntry | undefined,
        syncFolder: string,
    ): Promise<void> {
        const dispose = this.cb.onSelfWriteLocal?.(vaultPath);
        try {
            await this.downloadOneInner(vaultPath, entry, syncFolder);
        } finally {
            dispose?.();
        }
    }

    private async downloadOneInner(
        vaultPath: string,
        entry: DavEntry | undefined,
        syncFolder: string,
    ): Promise<void> {
        const remotePath = `${syncFolder}/${vaultPath}`;
        const ext = vaultPath.split('.').pop()?.toLowerCase() ?? '';
        const isBinary = BINARY_EXTENSIONS.has(ext);

        // Ensure local parent folder exists in vault
        const lastSlash = vaultPath.lastIndexOf('/');
        if (lastSlash > 0) {
            const parent = vaultPath.substring(0, lastSlash);
            await this.ensureLocalFolder(parent);
        }

        const existing = this.app.vault.getAbstractFileByPath(vaultPath);

        if (isBinary) {
            const buf = await this.client.getBinary(remotePath);
            const hash = await sha256(buf);
            if (existing instanceof TFile) {
                await this.app.vault.modifyBinary(existing, buf);
            } else {
                await this.app.vault.createBinary(vaultPath, buf);
            }
            const tFile = this.app.vault.getAbstractFileByPath(vaultPath) as TFile | null;
            this.settings.manifest[vaultPath] = {
                hash,
                localMtime: tFile?.stat.mtime ?? Date.now(),
                size: buf.byteLength,
                remoteMtime: entry?.mtime ?? Date.now(),
            };
        } else {
            const text = await this.client.getText(remotePath);
            const hash = await sha256(text);
            if (existing instanceof TFile) {
                await this.app.vault.modify(existing, text);
            } else {
                await this.app.vault.create(vaultPath, text);
            }
            const tFile = this.app.vault.getAbstractFileByPath(vaultPath) as TFile | null;
            this.settings.manifest[vaultPath] = {
                hash,
                localMtime: tFile?.stat.mtime ?? Date.now(),
                size: text.length,
                remoteMtime: entry?.mtime ?? Date.now(),
            };
        }
    }

    private async deleteRemote(
        vaultPath: string,
        syncFolder: string,
        trashSub: string,
    ): Promise<void> {
        const src = `${syncFolder}/${vaultPath}`;
        if (this.settings.useTrash) {
            const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            const dst = `${syncFolder}/${trashSub}/${dateStr}/${vaultPath}`;
            // Ensure trash subfolders exist
            const lastSlash = dst.lastIndexOf('/');
            if (lastSlash > 0) {
                await this.client.ensureFolder(dst.substring(0, lastSlash));
            }
            try {
                await this.client.move(src, dst, true);
                return;
            } catch (e: any) {
                // If MOVE fails, fall back to DELETE so user isn't stuck
                if (e instanceof WebDavError && e.status === 404) return;
                console.warn('MOVE to trash failed, falling back to DELETE:', e);
            }
        }
        await this.client.delete(src);
    }

    private async deleteLocal(vaultPath: string): Promise<void> {
        const dispose = this.cb.onSelfWriteLocal?.(vaultPath);
        try {
            const af = this.app.vault.getAbstractFileByPath(vaultPath);
            if (!af) return;
            // Use Obsidian trash (configurable in vault settings)
            await this.app.vault.trash(af, true);
        } finally {
            dispose?.();
        }
    }

    private async saveRemoteAsConflictCopy(file: TFile, syncFolder: string): Promise<void> {
        const remotePath = `${syncFolder}/${file.path}`;
        const ext = file.extension.toLowerCase();
        const isBinary = BINARY_EXTENSIONS.has(ext);

        const dot = file.path.lastIndexOf('.');
        const base = dot === -1 ? file.path : file.path.substring(0, dot);
        const tail = dot === -1 ? '' : file.path.substring(dot);
        const ts = formatTs(new Date());
        const conflictPath = `${base}.conflict-${ts}${tail}`;

        const parent = file.parent?.path;
        if (parent && parent !== '/' && parent !== '') {
            await this.ensureLocalFolder(parent);
        }

        const existing = this.app.vault.getAbstractFileByPath(conflictPath);
        if (isBinary) {
            const buf = await this.client.getBinary(remotePath);
            if (existing instanceof TFile) {
                await this.app.vault.modifyBinary(existing, buf);
            } else {
                await this.app.vault.createBinary(conflictPath, buf);
            }
        } else {
            const text = await this.client.getText(remotePath);
            if (existing instanceof TFile) {
                await this.app.vault.modify(existing, text);
            } else {
                await this.app.vault.create(conflictPath, text);
            }
        }
    }

    private async cleanTrash(
        syncFolder: string,
        trashSub: string,
        session: SessionReport,
    ): Promise<void> {
        const trashRoot = `${syncFolder}/${trashSub}`;
        // List date subfolders by listing files (Depth: infinity captures everything)
        // Easier: list with empty extension set -> we get nothing. Instead use a dedicated PROPFIND Depth:1 call.
        // Reuse listFiles with all-known-extensions cheat? Simpler: skip granular discovery and try MOVE/DELETE per known date.
        // We compute cutoff and look at top-level folder names by Depth:1.
        const exts = new Set(this.settings.includedExtensions.map((e) => e.toLowerCase()));
        let trashFiles: Map<string, DavEntry>;
        try {
            trashFiles = await this.client.listFiles(trashRoot, exts, []);
        } catch (e: any) {
            if (e instanceof WebDavError && e.status === 404) return;
            throw e;
        }

        const cutoff = Date.now() - this.settings.trashRetentionDays * 24 * 3600 * 1000;
        const toRemove: string[] = [];
        for (const [rel, entry] of trashFiles) {
            // rel starts with "<YYYY-MM-DD>/<vault path>"
            const slash = rel.indexOf('/');
            if (slash === -1) continue;
            const datePart = rel.substring(0, slash);
            const parsedDate = Date.parse(datePart + 'T00:00:00Z');
            if (isNaN(parsedDate)) continue;
            if (parsedDate < cutoff) toRemove.push(rel);
            // mtime fallback (defensive)
            else if (entry.mtime > 0 && entry.mtime < cutoff) toRemove.push(rel);
        }
        for (const rel of toRemove) {
            try {
                await this.client.delete(`${trashRoot}/${rel}`);
                session.trashCleaned.push(`${trashSub}/${rel}`);
            } catch (e: any) {
                console.warn('Trash cleanup failed for', rel, e);
            }
        }
    }

    private async ensureLocalFolder(path: string): Promise<void> {
        const norm = normalizePath(path);
        const parts = norm.split('/').filter((p) => p.length > 0);
        let cur = '';
        for (const p of parts) {
            cur = cur ? `${cur}/${p}` : p;
            const af = this.app.vault.getAbstractFileByPath(cur);
            if (af instanceof TFolder) continue;
            if (af) continue; // exists as file (weird), don't try to create
            try {
                await this.app.vault.createFolder(cur);
            } catch (e: any) {
                if (!/already exists/i.test(String(e?.message ?? e))) throw e;
            }
        }
    }

    /**
     * Mirror non-trivial folders (including empty ones) in both directions.
     * - Local-only folders \u2192 created remotely (skipped in downloadOnly).
     * - Remote-only folders \u2192 created locally.
     * Excluded paths, the trash subfolder and the local log folder are skipped.
     * Folder *deletions* are intentionally not handled here \u2014 file-deletion
     * cleans up on its own and folder-deletion is risky (could nuke a folder
     * the user just created on the other device).
     */
    private async syncEmptyFolders(opts: {
        syncFolder: string;
        trashSub: string;
        logFolderPrefix: string;
        remoteFolders: Set<string>;
        isExcluded: (p: string) => boolean;
        downloadOnly: boolean;
        dryRun: boolean;
        cancelled: () => boolean;
    }): Promise<void> {
        const { syncFolder, trashSub, logFolderPrefix, remoteFolders, isExcluded,
            downloadOnly, dryRun, cancelled } = opts;

        // Collect all local folders (relative vault paths, no leading slash).
        const localFolders = new Set<string>();
        const walk = (folder: TFolder) => {
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    localFolders.add(child.path);
                    walk(child);
                }
            }
        };
        const root = this.app.vault.getRoot();
        if (root) walk(root);

        const skip = (rel: string): boolean => {
            if (!rel) return true;
            if (rel.startsWith(logFolderPrefix)) return true;
            // logFolderPrefix has trailing '/'; also handle exact match
            const logFolder = logFolderPrefix.replace(/\/+$/, '');
            if (logFolder && rel === logFolder) return true;
            if (rel === trashSub || rel.startsWith(`${trashSub}/`)) return true;
            // isExcluded operates on file globs; folder paths usually won't
            // match, but respect it when they do (e.g. trailing /** patterns).
            if (isExcluded(rel) || isExcluded(`${rel}/`)) return true;
            return false;
        };

        // 1. Push local-only folders to remote.
        if (!downloadOnly) {
            for (const rel of localFolders) {
                if (cancelled()) return;
                if (skip(rel)) continue;
                if (remoteFolders.has(rel)) continue;
                if (dryRun) continue;
                try {
                    await this.client.ensureFolder(`${syncFolder}/${rel}`);
                } catch (e: any) {
                    console.warn('ensureFolder (remote) failed for', rel, e);
                }
            }
        }

        // 2. Pull remote-only folders to local.
        for (const rel of remoteFolders) {
            if (cancelled()) return;
            if (skip(rel)) continue;
            if (localFolders.has(rel)) continue;
            if (dryRun) continue;
            try {
                await this.ensureLocalFolder(rel);
            } catch (e: any) {
                console.warn('ensureLocalFolder failed for', rel, e);
            }
        }
    }

    private normalizeRemote(p: string): string {
        let s = p.replace(/\\+/g, '/').replace(/\/+/g, '/');
        if (!s.startsWith('/')) s = '/' + s;
        if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
        return s;
    }

    private normalizeLocal(p: string): string {
        return (p || '').replace(/\\+/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
    }
}

function unique<T>(arr: T[]): T[] {
    return Array.from(new Set(arr));
}

function pad(n: number): string {
    return n < 10 ? '0' + n : '' + n;
}

export function formatTs(d: Date): string {
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
}
