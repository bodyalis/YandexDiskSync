import { App, Notice, TFile, TFolder } from 'obsidian';
import { REMOTE_LOGS_SUBFOLDER, WEBDAV_BASE } from '../constants';
import { t } from '../i18n';
import { YandexSyncSettings } from '../settings/types';
import { SessionReport } from '../sync/SessionReport';
import { formatTs } from '../sync/SyncEngine';
import { YandexWebDavClient } from '../webdav/client';

export function renderLog(s: SessionReport): string {
    const list = (items: string[]) =>
        items.length === 0 ? t('logNone') : items.map((p) => `- \`${p}\``).join('\n');

    const conflictsList =
        s.conflicts.length === 0
            ? t('logNone')
            : s.conflicts.map((c) => `- \`${c.path}\` — **${c.action}**`).join('\n');

    const errors = [
        ...s.uploadFailed.map((e) => `- upload: \`${e.path}\` — ${e.reason}`),
        ...s.downloadFailed.map((e) => `- download: \`${e.path}\` — ${e.reason}`),
        ...s.deleteFailed.map((e) => `- delete: \`${e.path}\` — ${e.reason}`),
        ...s.otherErrors.map((e) => `- other: ${e.reason}`),
    ];
    const errorsList = errors.length === 0 ? t('logNone') : errors.join('\n');

    const startedIso = new Date(s.startedAt).toISOString();
    const finishedIso = new Date(s.finishedAt).toISOString();
    const durationSec = ((s.finishedAt - s.startedAt) / 1000).toFixed(1);

    const head = [
        '---',
        `started: ${startedIso}`,
        `finished: ${finishedIso}`,
        `duration_sec: ${durationSec}`,
        `dry_run: ${s.dryRun}`,
        `aborted: ${s.aborted}`,
        `cancelled: ${s.cancelled}`,
        `uploaded: ${s.uploaded.length}`,
        `downloaded: ${s.downloaded.length}`,
        `deleted_remote: ${s.deletedRemote.length}`,
        `deleted_local: ${s.deletedLocal.length}`,
        `conflicts: ${s.conflicts.length}`,
        `errors: ${errors.length}`,
        '---',
    ];

    const body = [
        '',
        `# ${t('logHeader')}`,
        s.dryRun ? `\n> **${t('logDryRun')}**\n` : '',
        '',
        `## ${t('logUploaded')} (${s.uploaded.length})`,
        list(s.uploaded),
        '',
        `## ${t('logDownloaded')} (${s.downloaded.length})`,
        list(s.downloaded),
        '',
        `## ${t('logDeletedRemote')} (${s.deletedRemote.length})`,
        list(s.deletedRemote),
        '',
        `## ${t('logDeletedLocal')} (${s.deletedLocal.length})`,
        list(s.deletedLocal),
        '',
        `## ${t('logConflicts')} (${s.conflicts.length})`,
        conflictsList,
        '',
        `## ${t('logSkipped')} (${s.skipped.length})`,
        list(s.skipped),
        '',
        `## ${t('logDeleteSkipped')} (${s.deleteSkippedRemote.length + s.deleteSkippedLocal.length})`,
        list([...s.deleteSkippedRemote, ...s.deleteSkippedLocal]),
        '',
        `## ${t('logTrashCleaned')} (${s.trashCleaned.length})`,
        list(s.trashCleaned),
        '',
        `## ${t('logErrors')} (${errors.length})`,
        errorsList,
        '',
    ];

    return head.concat(body).join('\n');
}

export class LogWriter {
    constructor(
        private app: App,
        private settings: YandexSyncSettings,
        private client: YandexWebDavClient,
    ) { }

    private localFolder(): string {
        return (this.settings.localLogFolder || 'Sync/YandexDiskSync/Logs')
            .replace(/^\/+|\/+$/g, '')
            .replace(/\/+/g, '/');
    }

    /** Returns the local file path of the written log, or null on failure. */
    async write(session: SessionReport): Promise<string | null> {
        const content = renderLog(session);
        const fileName = `Sync-${formatTs(new Date(session.startedAt))}.md`;
        const localFolder = this.localFolder();
        const localPath = `${localFolder}/${fileName}`;

        // Local
        try {
            await this.ensureLocalFolder(localFolder);
            const existing = this.app.vault.getAbstractFileByPath(localPath);
            if (existing instanceof TFile) {
                await this.app.vault.modify(existing, content);
            } else {
                await this.app.vault.create(localPath, content);
            }
        } catch (e: any) {
            console.error('Local log write failed:', e);
            new Notice(t('errorLogWrite', e?.message ?? String(e)));
            return null;
        }

        // Remote (best-effort)
        try {
            const syncFolder = this.normalizeRemote(this.settings.syncFolder);
            await this.client.ensureFolder(`${syncFolder}/${REMOTE_LOGS_SUBFOLDER}`);
            await this.client.put(`${syncFolder}/${REMOTE_LOGS_SUBFOLDER}/${fileName}`, content);
        } catch (e: any) {
            console.error('Remote log write failed:', e);
        }

        // Rotate (best-effort)
        try {
            await this.rotate();
        } catch (e: any) {
            console.warn('Log rotation failed:', e);
        }

        return localPath;
    }

    /** Latest log file path or null. */
    findLatestLog(): string | null {
        const folder = this.app.vault.getAbstractFileByPath(this.localFolder());
        if (!(folder instanceof TFolder)) return null;
        let latest: TFile | null = null;
        for (const child of folder.children) {
            if (child instanceof TFile && child.extension === 'md' && child.name.startsWith('Sync-')) {
                if (!latest || child.stat.mtime > latest.stat.mtime) latest = child;
            }
        }
        return latest?.path ?? null;
    }

    private async rotate(): Promise<void> {
        const folder = this.app.vault.getAbstractFileByPath(this.localFolder());
        if (!(folder instanceof TFolder)) return;
        const logs = folder.children.filter(
            (c): c is TFile =>
                c instanceof TFile && c.extension === 'md' && c.name.startsWith('Sync-'),
        );
        // Sort newest first
        logs.sort((a, b) => b.stat.mtime - a.stat.mtime);

        const cutoff = this.settings.logRetentionDays > 0
            ? Date.now() - this.settings.logRetentionDays * 24 * 3600 * 1000
            : -Infinity;
        const maxFiles = this.settings.maxLogFiles > 0 ? this.settings.maxLogFiles : Infinity;

        for (let i = 0; i < logs.length; i++) {
            const f = logs[i];
            const tooOld = f.stat.mtime < cutoff;
            const overLimit = i >= maxFiles;
            if (tooOld || overLimit) {
                try {
                    // Use vault.trash so users can recover accidentally rotated logs
                    // (system trash if available, otherwise the vault's .trash folder).
                    await this.app.vault.trash(f, true);
                } catch {
                    /* ignore */
                }
            }
        }
    }

    private async ensureLocalFolder(folderPath: string): Promise<void> {
        const parts = folderPath.split('/').filter((p) => p.length > 0);
        let cur = '';
        for (const p of parts) {
            cur = cur ? `${cur}/${p}` : p;
            const af = this.app.vault.getAbstractFileByPath(cur);
            if (af instanceof TFolder) continue;
            if (af) continue;
            try {
                await this.app.vault.createFolder(cur);
            } catch (e: any) {
                if (!/already exists/i.test(String(e?.message ?? e))) throw e;
            }
        }
    }

    private normalizeRemote(p: string): string {
        let s = (p || '').replace(/\\+/g, '/').replace(/\/+/g, '/');
        if (!s.startsWith('/')) s = '/' + s;
        if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
        return s;
    }
}

// Reference WEBDAV_BASE so esbuild keeps the import (also useful if extended later).
void WEBDAV_BASE;
