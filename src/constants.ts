// Common constants
/**
 * Yandex Disk REST API base URL. The plugin used to also speak WebDAV via
 * webdav.yandex.ru, but that gateway stalls on PUTs over ~10 MB and forces
 * XML parsing, so the entire transport was migrated to REST in 1.3.0.
 *
 * Requires an OAuth token with `cloud_api:disk.read` and
 * `cloud_api:disk.write` scopes.
 */
export const YANDEX_REST_API_BASE = 'https://cloud-api.yandex.net/v1';
export const REMOTE_LOGS_SUBFOLDER = 'Logs';
export const DEFAULT_REMOTE_TRASH = '.trash';

// mtime tolerance (ms) for fuzzy comparisons of HTTP-date precision
export const MTIME_TOLERANCE_MS = 2000;

// Retry policy defaults
export const RETRY_BASE_DELAY_MS = 600;
export const RETRY_MAX_DELAY_MS = 8000;
export const RETRYABLE_STATUSES = new Set<number>([408, 423, 425, 429, 500, 502, 503, 504]);

// Timeout for control operations (list/exists/move/delete/mkdir).
// Data operations (PUT, GET) are excluded — large files need unlimited transfer time.
export const REQUEST_TIMEOUT_MS = 30_000;

// Files larger than this are not cached in memory during the classification phase.
// They are read for hashing and immediately released; re-read when the upload task runs.
// This keeps planning-phase memory flat even when the vault contains large PDFs/binaries.
export const LARGE_FILE_CACHE_THRESHOLD = 4 * 1024 * 1024; // 4 MB

// Default concurrency for upload/download phases.
// REST API tolerates 3–4 parallel requests well; we use 2 as a conservative
// default that still gives ~2x throughput over sequential without tripping
// the 429 rate limiter on bursts.
export const DEFAULT_CONCURRENCY = 2;

// Subfolder on Yandex Disk that mirrors the local .obsidian/ config directory.
// Stored separately from notes so it never appears in the user's normal vault listing
// and so a regular note named "config" can't collide.
export const OBSIDIAN_CONFIG_REMOTE_SUBFOLDER = '.obsidian-config';

// Plugin id of THIS plugin — its own settings folder is always excluded from
// config-sync to avoid clobbering settings/manifest across machines.
export const SELF_PLUGIN_ID = 'yandex-disk-sync';

// Files inside .obsidian/ that are NEVER synced (they are session/cache state
// and would create constant churn / cross-platform conflicts).
export const OBSIDIAN_CONFIG_FORCED_EXCLUDES = [
    'workspace',
    'workspace.json',
    'workspace-mobile.json',
    'cache',
    '.DS_Store',
    'Thumbs.db',
];

// Default included extensions
export const DEFAULT_INCLUDED_EXTENSIONS = [
    'md',
    'canvas',
    'pdf',
    'png',
    'jpg',
    'jpeg',
    'webp',
    'gif',
    'svg',
];

// Binary-treated extensions (anything not in this set is treated as text)
export const BINARY_EXTENSIONS = new Set<string>([
    'pdf',
    'png',
    'jpg',
    'jpeg',
    'webp',
    'gif',
    'svg',
    'bmp',
    'ico',
    'mp3',
    'mp4',
    'mov',
    'avi',
    'wav',
    'flac',
    'ogg',
    'zip',
    'rar',
    '7z',
    'tar',
    'gz',
    'docx',
    'xlsx',
    'pptx',
    'odt',
    'ods',
    'odp',
]);
