import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import {
    REMOTE_LOGS_SUBFOLDER,
    REQUEST_TIMEOUT_MS,
    RETRY_BASE_DELAY_MS,
    RETRY_MAX_DELAY_MS,
    RETRYABLE_STATUSES,
    YANDEX_REST_API_BASE,
} from '../constants';
import { t } from '../i18n';

/**
 * Yandex Disk REST API client.
 *
 * The previous implementation used the legacy WebDAV gateway (webdav.yandex.ru),
 * which stalls on PUTs over ~10 MB and forces us to parse XML. This client
 * speaks JSON to cloud-api.yandex.net exclusively and requires an OAuth token
 * with the `cloud_api:disk.read` and `cloud_api:disk.write` scopes.
 *
 * All `path` arguments use vault-style paths beginning with `/`. They are
 * translated to the API's `disk:` scheme internally.
 */

export class YandexApiError extends Error {
    constructor(public status: number, message: string, public cause?: unknown) {
        super(message);
        this.name = 'YandexApiError';
    }
}

export interface RemoteEntry {
    /** Path relative to the listing root (no leading slash). */
    path: string;
    isFolder: boolean;
    /** Server-reported modified time in ms (0 if missing). */
    mtime: number;
    /** Size in bytes (0 for folders). */
    size: number;
    /** MD5 from the server, when available. */
    md5?: string;
}

export interface ClientOptions {
    maxRetries?: number;
    onRetry?: (attempt: number, status: number, delayMs: number) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function diskPath(p: string): string {
    return 'disk:' + (p.startsWith('/') ? p : '/' + p);
}

function normalizeFolder(p: string): string {
    let s = p.replace(/\\+/g, '/').replace(/\/+/g, '/');
    if (!s.startsWith('/')) s = '/' + s;
    if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    return s;
}

function mapStatus(status: number): string {
    if (status === 507) return t('errDiskFull');
    if (status === 401 || status === 403) return t('errAuth');
    if (status === 423) return t('errLocked');
    if (status === 429) return t('errRateLimit');
    if (status === 404) return t('errNotFound');
    if (status > 0) return `HTTP error ${status}`;
    return t('errNetwork');
}

export class YandexClient {
    private auth: string;
    private maxRetries: number;
    private onRetry?: ClientOptions['onRetry'];
    private createdFolders = new Set<string>();

    constructor(oauthToken: string, opts: ClientOptions = {}) {
        this.auth = 'OAuth ' + oauthToken;
        this.maxRetries = opts.maxRetries ?? 3;
        this.onRetry = opts.onRetry;
    }

    clearFolderCache(): void {
        this.createdFolders.clear();
    }

    // ---------- Core HTTP ----------

    /**
     * Authenticated request to cloud-api.yandex.net with retry on 429/5xx and
     * an optional timeout race. Returns the raw response — callers inspect
     * status and parse JSON themselves so we can handle both 2xx and expected
     * 404/409 cases without exceptions.
     */
    private async send(
        params: RequestUrlParam,
        opts: { retry?: boolean; timeoutMs?: number } = {},
    ): Promise<RequestUrlResponse> {
        const retry = opts.retry !== false;
        const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
        const merged: RequestUrlParam = {
            ...params,
            headers: {
                Authorization: this.auth,
                Accept: 'application/json',
                ...(params.headers ?? {}),
            },
            throw: false,
        };

        let attempt = 0;
        while (true) {
            attempt++;
            try {
                const res = await this.race(merged, timeoutMs);
                const status = res.status;
                if (retry && RETRYABLE_STATUSES.has(status) && attempt <= this.maxRetries) {
                    const delay = this.backoff(attempt);
                    this.onRetry?.(attempt, status, delay);
                    await sleep(delay);
                    continue;
                }
                return res;
            } catch (e) {
                if (retry && attempt <= this.maxRetries) {
                    const delay = this.backoff(attempt);
                    this.onRetry?.(attempt, 0, delay);
                    await sleep(delay);
                    continue;
                }
                throw new YandexApiError(0, mapStatus(0), e);
            }
        }
    }

    /** Unauthenticated request (used for pre-signed upload/download URLs). */
    private async sendRaw(params: RequestUrlParam, timeoutMs: number): Promise<RequestUrlResponse> {
        const merged: RequestUrlParam = { ...params, throw: false };
        try {
            return await this.race(merged, timeoutMs);
        } catch (e) {
            throw new YandexApiError(0, mapStatus(0), e);
        }
    }

    private async race(params: RequestUrlParam, timeoutMs: number): Promise<RequestUrlResponse> {
        const req = requestUrl(params);
        if (timeoutMs <= 0) return req;
        return Promise.race<RequestUrlResponse>([
            req,
            new Promise<never>((_, reject) =>
                window.setTimeout(
                    () => reject(new YandexApiError(0, `Yandex API request timed out (${timeoutMs}ms)`)),
                    timeoutMs,
                ),
            ),
        ]);
    }

    private backoff(attempt: number): number {
        return Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
    }

    private resourceUrl(path: string, params: Record<string, string | number | boolean> = {}): string {
        const qp = new URLSearchParams();
        qp.set('path', diskPath(path));
        for (const [k, v] of Object.entries(params)) qp.set(k, String(v));
        return `${YANDEX_REST_API_BASE}/disk/resources?${qp.toString()}`;
    }

    private fail(res: RequestUrlResponse): YandexApiError {
        return new YandexApiError(res.status, mapStatus(res.status));
    }

    // ---------- Public API ----------

    async ensureFolder(fullPath: string): Promise<void> {
        const clean = normalizeFolder(fullPath);
        if (!clean || clean === '/') return;
        if (this.createdFolders.has(clean)) return;

        const parts = clean.split('/').filter((p) => p.length > 0);
        let current = '';
        for (const part of parts) {
            current += '/' + part;
            if (this.createdFolders.has(current)) continue;
            const res = await this.send(
                { url: this.resourceUrl(current), method: 'PUT' },
                { retry: false },
            );
            // 201 Created OR 409 (already exists) — both fine.
            if (res.status === 201 || res.status === 409) {
                this.createdFolders.add(current);
                continue;
            }
            throw this.fail(res);
        }
    }

    async exists(path: string): Promise<boolean> {
        const url = this.resourceUrl(path, { fields: 'name' });
        const res = await this.send({ url, method: 'GET' });
        if (res.status === 200) return true;
        if (res.status === 404) return false;
        throw this.fail(res);
    }

    async getText(path: string): Promise<string> {
        const buf = await this.download(path);
        return new TextDecoder('utf-8').decode(buf);
    }

    async getBinary(path: string): Promise<ArrayBuffer> {
        return this.download(path);
    }

    private async download(path: string): Promise<ArrayBuffer> {
        const metaUrl = `${YANDEX_REST_API_BASE}/disk/resources/download?path=${encodeURIComponent(diskPath(path))}`;
        const meta = await this.send({ url: metaUrl, method: 'GET' });
        if (meta.status !== 200) throw this.fail(meta);
        const href = this.parseHref(meta);
        const res = await this.sendRaw({ url: href, method: 'GET' }, 0);
        if (res.status < 200 || res.status >= 300) throw this.fail(res);
        return res.arrayBuffer;
    }

    /**
     * Two-step upload via cloud-api.yandex.net.
     *
     * Step 1: GET /disk/resources/upload → pre-signed `href` and method.
     * Step 2: PUT body to that href with NO Authorization header — the URL
     * itself carries the signature; an extra header makes Yandex reject it.
     */
    async put(
        path: string,
        body: string | ArrayBuffer,
        sizeBytes?: number,
    ): Promise<{ remoteMtime: number }> {
        const bytes = sizeBytes ?? (body instanceof ArrayBuffer ? body.byteLength : body.length);
        // 1 second per 50 KB, minimum 2 minutes. No upper cap.
        const timeoutMs = Math.max(120_000, Math.ceil(bytes / 50_000) * 1000);

        const metaUrl =
            `${YANDEX_REST_API_BASE}/disk/resources/upload`
            + `?path=${encodeURIComponent(diskPath(path))}&overwrite=true`;
        const meta = await this.send({ url: metaUrl, method: 'GET' });
        if (meta.status !== 200) throw this.fail(meta);
        const href = this.parseHref(meta);

        const upload = await this.sendRaw({ url: href, method: 'PUT', body }, timeoutMs);
        if (upload.status < 200 || upload.status >= 300) throw this.fail(upload);

        // The upload endpoint doesn't return Last-Modified.
        return { remoteMtime: Date.now() };
    }

    async delete(path: string): Promise<void> {
        const url = this.resourceUrl(path, { permanently: 'false' });
        const res = await this.send({ url, method: 'DELETE' });
        // 204 sync delete, 202 async delete (we don't poll — for our single-file
        // use case it always finishes by the time the next operation runs).
        if (res.status === 204 || res.status === 202 || res.status === 404) return;
        throw this.fail(res);
    }

    async move(src: string, dst: string, overwrite = true): Promise<void> {
        const url =
            `${YANDEX_REST_API_BASE}/disk/resources/move`
            + `?from=${encodeURIComponent(diskPath(src))}`
            + `&path=${encodeURIComponent(diskPath(dst))}`
            + `&overwrite=${overwrite}`;
        const res = await this.send({ url, method: 'POST' });
        if (res.status === 201 || res.status === 202) return;
        throw this.fail(res);
    }

    /**
     * Recursive listing of a remote folder. Returns files keyed by their path
     * relative to `rootFolder`, filtered by extension; folder names are
     * collected into `outFolders` if provided. The trash subfolder, the logs
     * subfolder and any path under `excludeSubfolders` are skipped.
     */
    async list(
        rootFolder: string,
        extensions: Set<string> | null,
        excludeSubfolders: string[] = [REMOTE_LOGS_SUBFOLDER],
        outFolders?: Set<string>,
    ): Promise<Map<string, RemoteEntry>> {
        const result = new Map<string, RemoteEntry>();
        const cleanRoot = normalizeFolder(rootFolder);
        const excludePrefixes = excludeSubfolders.map((s) => s.replace(/^\/+|\/+$/g, '') + '/');
        const queue: string[] = ['']; // relative folder paths
        const visited = new Set<string>();

        while (queue.length > 0) {
            const relFolder = queue.shift()!;
            if (visited.has(relFolder)) continue;
            visited.add(relFolder);

            const absFolder = relFolder ? `${cleanRoot}/${relFolder}` : cleanRoot;
            const ok = await this.listFolderInto(
                absFolder,
                cleanRoot,
                extensions,
                excludePrefixes,
                queue,
                outFolders,
                result,
            );
            // Root missing => empty result; nested missing => just skip.
            if (!ok && relFolder === '') return result;
        }

        return result;
    }

    private async listFolderInto(
        absFolder: string,
        cleanRoot: string,
        extensions: Set<string> | null,
        excludePrefixes: string[],
        queue: string[],
        outFolders: Set<string> | undefined,
        result: Map<string, RemoteEntry>,
    ): Promise<boolean> {
        const limit = 1000;
        let offset = 0;
        const fields =
            '_embedded.total,_embedded.items.path,_embedded.items.type,'
            + '_embedded.items.modified,_embedded.items.size,_embedded.items.md5';
        // Strip leading '/' for the prefix comparison done in the loop.
        const rootPrefix = cleanRoot === '/' ? '' : cleanRoot.replace(/^\/+/, '');

        while (true) {
            const url = this.resourceUrl(absFolder, { limit, offset, fields });
            const res = await this.send({ url, method: 'GET' });
            if (res.status === 404) return false;
            if (res.status !== 200) throw this.fail(res);

            const json = this.parseJson(res) as { _embedded?: { items?: unknown[]; total?: number } };
            const items = (json._embedded?.items ?? []) as Array<Record<string, unknown>>;
            const total = json._embedded?.total ?? items.length;

            for (const item of items) {
                const fullPathRaw = String(item.path ?? '').replace(/^disk:/, '');
                const full = fullPathRaw.replace(/^\/+/, '');
                let rel: string;
                if (rootPrefix === '') {
                    rel = full;
                } else if (full === rootPrefix) {
                    continue;
                } else if (full.startsWith(rootPrefix + '/')) {
                    rel = full.substring(rootPrefix.length + 1);
                } else {
                    continue;
                }
                if (!rel) continue;
                if (excludePrefixes.some((p) => rel.startsWith(p))) continue;

                const isFolder = item.type === 'dir';
                if (isFolder) {
                    if (outFolders) outFolders.add(rel);
                    queue.push(rel);
                    continue;
                }
                if (extensions !== null) {
                    const ext = rel.split('.').pop()?.toLowerCase() ?? '';
                    if (!extensions.has(ext)) continue;
                }
                const modified = typeof item.modified === 'string' ? Date.parse(item.modified) : NaN;
                const mtime = isNaN(modified) ? 0 : modified;
                const size = typeof item.size === 'number' ? item.size : 0;
                const md5 = typeof item.md5 === 'string' ? item.md5 : undefined;
                result.set(rel, { path: rel, isFolder: false, mtime, size, md5 });
            }

            offset += items.length;
            if (offset >= total || items.length === 0) break;
        }
        return true;
    }

    /** Lightweight check returning success + folder content count. */
    async testConnection(
        remoteFolder: string,
    ): Promise<
        | { ok: true; count: number }
        | { ok: false; notFound: true; folder: string; message: string }
        | { ok: false; notFound?: false; message: string }
    > {
        const url = this.resourceUrl(remoteFolder, { limit: 0, fields: '_embedded.total' });
        const res = await this.send({ url, method: 'GET' }, { retry: false });
        if (res.status === 200) {
            const json = this.parseJson(res) as { _embedded?: { total?: number } };
            return { ok: true, count: json._embedded?.total ?? 0 };
        }
        if (res.status === 404) {
            return {
                ok: false,
                notFound: true,
                folder: remoteFolder,
                message: `Folder not found: ${remoteFolder}`,
            };
        }
        return { ok: false, message: mapStatus(res.status) };
    }

    // ---------- Parsing helpers ----------

    private parseHref(res: RequestUrlResponse): string {
        const json = this.parseJson(res) as { href?: unknown };
        if (typeof json.href !== 'string' || !json.href) {
            throw new YandexApiError(0, 'Yandex API: missing href in response');
        }
        return json.href;
    }

    private parseJson(res: RequestUrlResponse): unknown {
        try {
            return JSON.parse(res.text);
        } catch {
            throw new YandexApiError(res.status, 'Yandex API: invalid JSON response');
        }
    }
}
