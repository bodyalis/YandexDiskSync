// Common constants
export const WEBDAV_BASE = 'https://webdav.yandex.ru';
export const REMOTE_LOGS_SUBFOLDER = 'Logs';
export const DEFAULT_REMOTE_TRASH = '.trash';

// mtime tolerance (ms) for fuzzy comparisons of HTTP-date precision
export const MTIME_TOLERANCE_MS = 2000;

// Retry policy defaults
export const RETRY_BASE_DELAY_MS = 600;
export const RETRY_MAX_DELAY_MS = 8000;
export const RETRYABLE_STATUSES = new Set<number>([408, 423, 425, 429, 500, 502, 503, 504]);

// Default concurrency for upload/download phases
export const DEFAULT_CONCURRENCY = 4;

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
