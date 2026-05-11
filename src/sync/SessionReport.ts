export type ConflictAction = 'skip' | 'overwrite' | 'keep-both' | 'prefer-remote';

export interface SessionReport {
    startedAt: number;
    finishedAt: number;
    dryRun: boolean;
    aborted: boolean;
    cancelled: boolean;

    uploaded: string[];
    downloaded: string[];
    skipped: string[];
    deletedRemote: string[];
    deletedLocal: string[];
    deleteSkippedRemote: string[];
    deleteSkippedLocal: string[];
    conflicts: { path: string; action: ConflictAction | 'unresolved' }[];
    trashCleaned: string[];

    uploadFailed: { path: string; reason: string }[];
    downloadFailed: { path: string; reason: string }[];
    deleteFailed: { path: string; reason: string }[];
    otherErrors: { reason: string }[];
}

export function newSession(dryRun = false): SessionReport {
    return {
        startedAt: Date.now(),
        finishedAt: 0,
        dryRun,
        aborted: false,
        cancelled: false,
        uploaded: [],
        downloaded: [],
        skipped: [],
        deletedRemote: [],
        deletedLocal: [],
        deleteSkippedRemote: [],
        deleteSkippedLocal: [],
        conflicts: [],
        trashCleaned: [],
        uploadFailed: [],
        downloadFailed: [],
        deleteFailed: [],
        otherErrors: [],
    };
}
