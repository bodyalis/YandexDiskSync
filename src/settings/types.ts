import { DEFAULT_CONCURRENCY, DEFAULT_INCLUDED_EXTENSIONS, DEFAULT_REMOTE_TRASH } from '../constants';

export type ConflictStrategy = 'ask' | 'skip' | 'overwrite' | 'keep-both' | 'prefer-remote';

/** Manifest entry: what we know about a file from the previous sync. */
export interface ManifestEntry {
    /** SHA-256 hex of file content at last successful upload. */
    hash: string;
    /** Local mtime (ms) at the moment we read+uploaded the file. */
    localMtime: number;
    /** File size in bytes. */
    size: number;
    /** Server-reported lastModified (ms) right after PUT, or 0 if unknown. */
    remoteMtime: number;
}

export interface YandexSyncSettings {
    // Account
    yandexLogin: string;
    yandexToken: string;
    syncFolder: string;

    // Sync behaviour
    twoWaySync: boolean;
    includedExtensions: string[];
    /** Glob patterns of vault paths to skip (both upload and download). */
    excludeGlobs: string[];

    // Manifest (per-file state)
    manifest: Record<string, ManifestEntry>;

    // Obsidian config sync (.obsidian/) — opt-in
    syncObsidianConfig: boolean;
    /** Skip plugin data.json files (often contain API keys / passwords). */
    excludeObsidianPluginData: boolean;
    /** Skip plugin compiled artifacts (main.js, styles.css, manifest.json) — installed from catalog. */
    excludeObsidianPluginBinaries: boolean;
    /** Skip hotkeys.json (often differs between OS — Cmd vs Ctrl). */
    excludeObsidianHotkeys: boolean;
    /** Manifest for config files; separate to avoid colliding with note manifest. */
    configManifest: Record<string, ManifestEntry>;

    // Deletion
    enableDelete: boolean;
    confirmBeforeDelete: boolean;
    enablePropfindReconcile: boolean;
    useTrash: boolean;
    trashFolder: string;
    trashRetentionDays: number;

    // Conflicts
    conflictStrategy: ConflictStrategy;

    // Auto sync
    syncIntervalMinutes: number;
    syncOnStartup: boolean;
    syncOnFileModify: boolean;
    syncOnFileModifyDelaySec: number;

    // Performance
    maxConcurrency: number;
    maxRetries: number;

    // Logs
    enableLogs: boolean;
    localLogFolder: string;
    logRetentionDays: number;
    maxLogFiles: number;
}

export const DEFAULT_SETTINGS: YandexSyncSettings = {
    yandexLogin: '',
    yandexToken: '',
    syncFolder: '/ObsidianBackup',

    twoWaySync: true,
    includedExtensions: [...DEFAULT_INCLUDED_EXTENSIONS],
    excludeGlobs: [],

    manifest: {},

    syncObsidianConfig: false,
    excludeObsidianPluginData: true,
    excludeObsidianPluginBinaries: true,
    excludeObsidianHotkeys: false,
    configManifest: {},

    enableDelete: true,
    confirmBeforeDelete: true,
    enablePropfindReconcile: true,
    useTrash: true,
    trashFolder: DEFAULT_REMOTE_TRASH,
    trashRetentionDays: 30,

    conflictStrategy: 'ask',

    syncIntervalMinutes: 0,
    syncOnStartup: false,
    syncOnFileModify: false,
    syncOnFileModifyDelaySec: 30,

    maxConcurrency: DEFAULT_CONCURRENCY,
    maxRetries: 3,

    enableLogs: true,
    localLogFolder: 'Sync/YandexDiskSync/Logs',
    logRetentionDays: 30,
    maxLogFiles: 100,
};

/** Migrate raw data (loadData) to current shape. Mutates and returns it. */
export function migrateSettings(raw: any): any {
    if (!raw || typeof raw !== 'object') return {};

    // v1 -> v2: lastSyncedFiles: string[] | Record<string, number> -> manifest: {}
    if ('lastSyncedFiles' in raw) {
        // We can't recover hashes from old data; reset manifest. Next sync will conflict-detect.
        raw.manifest = {};
        delete raw.lastSyncedFiles;
    }
    // v2 (intermediate) had only mtime; replace with empty manifest if entries lack hash.
    if (raw.manifest && typeof raw.manifest === 'object') {
        for (const k of Object.keys(raw.manifest)) {
            const entry = raw.manifest[k];
            if (!entry || typeof entry !== 'object' || typeof entry.hash !== 'string') {
                delete raw.manifest[k];
            }
        }
    } else {
        raw.manifest = {};
    }
    if (!raw.configManifest || typeof raw.configManifest !== 'object') {
        raw.configManifest = {};
    }
    return raw;
}
