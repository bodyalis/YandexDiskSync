import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import {
    REMOTE_LOGS_SUBFOLDER,
    RETRY_BASE_DELAY_MS,
    RETRY_MAX_DELAY_MS,
    RETRYABLE_STATUSES,
    WEBDAV_BASE,
} from '../constants';
import { t } from '../i18n';

export class WebDavError extends Error {
    constructor(public status: number, message: string, public cause?: any) {
        super(message);
        this.name = 'WebDavError';
    }
}

function mapHttpError(e: any): { status: number; message: string } {
    const status = typeof e?.status === 'number' ? e.status : 0;
    let message: string;
    if (status === 507) message = t('errDiskFull');
    else if (status === 401 || status === 403) message = t('errAuth');
    else if (status === 423) message = t('errLocked');
    else if (status === 429) message = t('errRateLimit');
    else if (status > 0) message = `HTTP error ${status}`;
    else message = e?.message ?? t('errNetwork');
    return { status, message };
}

export interface DavEntry {
    /** Path relative to the listing root (no leading slash). */
    path: string;
    isCollection: boolean;
    /** Server-reported last-modified in ms (0 if missing). */
    mtime: number;
    /** Size in bytes (0 if missing or for collections). */
    size: number;
}

export interface ClientOptions {
    maxRetries?: number;
    onRetry?: (attempt: number, status: number, delayMs: number) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class YandexWebDavClient {
    private auth: string;
    private maxRetries: number;
    private onRetry?: ClientOptions['onRetry'];

    constructor(login: string, password: string, opts: ClientOptions = {}) {
        this.auth = 'Basic ' + btoa(`${login}:${password}`);
        this.maxRetries = opts.maxRetries ?? 3;
        this.onRetry = opts.onRetry;
    }

    private url(remotePath: string): string {
        // remotePath always begins with '/'
        return WEBDAV_BASE + encodeURI(remotePath);
    }

    private async send(params: RequestUrlParam, retryable = true): Promise<RequestUrlResponse> {
        let attempt = 0;
        const merged: RequestUrlParam = {
            ...params,
            headers: {
                Authorization: this.auth,
                Accept: '*/*',
                ...(params.headers ?? {}),
            },
            throw: false,
        };

        while (true) {
            attempt++;
            try {
                const res: RequestUrlResponse = await requestUrl(merged);
                const status = res.status;
                if (status >= 200 && status < 300) return res;
                if (status === 404 || status === 405 || status === 409 || status === 412) {
                    // Not retryable but also not "real" errors at this layer; bubble up.
                    throw new WebDavError(status, mapHttpError({ status }).message);
                }
                if (retryable && RETRYABLE_STATUSES.has(status) && attempt <= this.maxRetries) {
                    const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
                    this.onRetry?.(attempt, status, delay);
                    await sleep(delay);
                    continue;
                }
                throw new WebDavError(status, mapHttpError({ status }).message);
            } catch (e: unknown) {
                if (e instanceof WebDavError) throw e;
                // Network error -> retry
                if (retryable && attempt <= this.maxRetries) {
                    const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
                    this.onRetry?.(attempt, 0, delay);
                    await sleep(delay);
                    continue;
                }
                const mapped = mapHttpError(e);
                throw new WebDavError(mapped.status, mapped.message, e);
            }
        }
    }

    /** Recursive MKCOL. Caches successfully created paths. */
    private createdFolders = new Set<string>();
    clearFolderCache(): void {
        this.createdFolders.clear();
    }

    async ensureFolder(fullPath: string): Promise<void> {
        const clean = fullPath.replace(/\/+/g, '/').replace(/\/$/, '');
        if (!clean || clean === '/') return;
        if (this.createdFolders.has(clean)) return;

        const parts = clean.split('/').filter((p) => p.length > 0);
        let current = '';
        for (const part of parts) {
            current += '/' + part;
            if (this.createdFolders.has(current)) continue;
            try {
                await this.send({ url: this.url(current), method: 'MKCOL' }, false);
                this.createdFolders.add(current);
            } catch (e: any) {
                // 405 Method Not Allowed = already exists
                if (e instanceof WebDavError && (e.status === 405 || e.status === 409)) {
                    this.createdFolders.add(current);
                    continue;
                }
                throw e;
            }
        }
    }

    async put(remotePath: string, body: string | ArrayBuffer): Promise<{ remoteMtime: number }> {
        const res = await this.send({
            url: this.url(remotePath),
            method: 'PUT',
            body,
        });
        // Some servers include Last-Modified in PUT response
        const lm = res?.headers?.['last-modified'] || res?.headers?.['Last-Modified'];
        const remoteMtime = lm ? Date.parse(lm) : 0;
        return { remoteMtime: isNaN(remoteMtime) ? 0 : remoteMtime };
    }

    async getText(remotePath: string): Promise<string> {
        const res = await this.send({ url: this.url(remotePath), method: 'GET' });
        return res.text;
    }

    async getBinary(remotePath: string): Promise<ArrayBuffer> {
        const res = await this.send({ url: this.url(remotePath), method: 'GET' });
        return res.arrayBuffer;
    }

    async delete(remotePath: string): Promise<void> {
        try {
            await this.send({ url: this.url(remotePath), method: 'DELETE' });
        } catch (e: any) {
            if (e instanceof WebDavError && e.status === 404) return; // already gone
            throw e;
        }
    }

    async move(srcPath: string, dstPath: string, overwrite = true): Promise<void> {
        await this.send({
            url: this.url(srcPath),
            method: 'MOVE',
            headers: {
                Destination: WEBDAV_BASE + encodeURI(dstPath),
                Overwrite: overwrite ? 'T' : 'F',
            },
        });
    }

    async exists(remotePath: string): Promise<boolean> {
        try {
            await this.send(
                {
                    url: this.url(remotePath),
                    method: 'PROPFIND',
                    headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
                    body:
                        '<?xml version="1.0" encoding="utf-8"?>' +
                        '<propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
                },
                false,
            );
            return true;
        } catch (e: any) {
            if (e instanceof WebDavError && e.status === 404) return false;
            throw e;
        }
    }

    /**
     * PROPFIND with Depth: infinity. Returns entries relative to `rootFolder`,
     * filtered to files matching `extensions`, excluding the Logs/ subfolder
     * and the trash folder. Pass `null` for `extensions` to accept all files
     * regardless of extension (used by the config-sync engine).
     *
     * If `outFolders` is provided, every collection (folder) found, relative to
     * `rootFolder`, is added to it. Useful for syncing empty folders.
     */
    async listFiles(
        rootFolder: string,
        extensions: Set<string> | null,
        excludeSubfolders: string[] = [REMOTE_LOGS_SUBFOLDER],
        outFolders?: Set<string>,
    ): Promise<Map<string, DavEntry>> {
        const result = new Map<string, DavEntry>();
        const cleanRoot = rootFolder.replace(/\/+$/, '') || '/';
        const excludePrefixes = excludeSubfolders.map((s) => s.replace(/^\/+|\/+$/g, '') + '/');

        // Yandex.Disk's WebDAV does not honor `Depth: infinity` \u2014 it only ever
        // returns one level. We must recurse with `Depth: 1` per folder.
        const queue: string[] = ['']; // relative paths under cleanRoot ('' == root)
        const visited = new Set<string>();

        while (queue.length > 0) {
            const relFolder = queue.shift()!;
            if (visited.has(relFolder)) continue;
            visited.add(relFolder);

            const absFolder = relFolder ? `${cleanRoot}/${relFolder}` : cleanRoot;
            const url = this.url(absFolder.endsWith('/') ? absFolder : absFolder + '/');

            let res: RequestUrlResponse;
            try {
                res = await this.send({
                    url,
                    method: 'PROPFIND',
                    headers: {
                        Depth: '1',
                        'Content-Type': 'application/xml; charset=utf-8',
                    },
                    body:
                        '<?xml version="1.0" encoding="utf-8"?>' +
                        '<propfind xmlns="DAV:"><prop>' +
                        '<resourcetype/><getlastmodified/><getcontentlength/>' +
                        '</prop></propfind>',
                });
            } catch (e: any) {
                if (e instanceof WebDavError && e.status === 404) {
                    // Root missing => empty result; nested missing => just skip.
                    if (relFolder === '') return result;
                    continue;
                }
                throw e;
            }

            const xml = res.text as string;
            const parser = new DOMParser();
            const doc = parser.parseFromString(xml, 'application/xml');
            const responses = doc.getElementsByTagNameNS('DAV:', 'response');

            const folderPrefix = absFolder.endsWith('/') ? absFolder : absFolder + '/';
            const rootPrefix = cleanRoot.endsWith('/') ? cleanRoot : cleanRoot + '/';

            for (let i = 0; i < responses.length; i++) {
                const node = responses[i];
                const hrefNode = node.getElementsByTagNameNS('DAV:', 'href')[0];
                if (!hrefNode || !hrefNode.textContent) continue;

                let href = hrefNode.textContent.trim();
                try {
                    href = decodeURI(href);
                } catch {
                    /* keep */
                }

                // Strip optional scheme://host
                const schemeIdx = href.indexOf('://');
                if (schemeIdx !== -1) {
                    const slashAfterHost = href.indexOf('/', schemeIdx + 3);
                    href = slashAfterHost === -1 ? '/' : href.substring(slashAfterHost);
                }

                const isCollection =
                    node.getElementsByTagNameNS('DAV:', 'collection').length > 0;

                // Compute path relative to the listing root we asked for.
                if (!href.startsWith(rootPrefix)) {
                    // PROPFIND on non-root folder includes the folder itself; skip it.
                    continue;
                }
                const rel = href.substring(rootPrefix.length).replace(/\/+$/, '');
                if (!rel) continue; // the queried folder itself

                // Also skip the queried folder when it appears as a child entry
                // (some servers report it differently); covered by !rel above.

                if (excludePrefixes.some((p) => rel.startsWith(p))) continue;

                if (isCollection) {
                    if (outFolders) outFolders.add(rel);
                    // Enqueue for recursive listing.
                    if (!visited.has(rel)) queue.push(rel);
                    continue;
                }

                const ext = rel.split('.').pop()?.toLowerCase() ?? '';
                if (extensions !== null && !extensions.has(ext)) continue;

                const lmNode = node.getElementsByTagNameNS('DAV:', 'getlastmodified')[0];
                let mtime = 0;
                if (lmNode?.textContent) {
                    const parsed = Date.parse(lmNode.textContent.trim());
                    if (!isNaN(parsed)) mtime = parsed;
                }
                const sizeNode = node.getElementsByTagNameNS('DAV:', 'getcontentlength')[0];
                const size = sizeNode?.textContent
                    ? parseInt(sizeNode.textContent, 10) || 0
                    : 0;

                result.set(rel, { path: rel, isCollection: false, mtime, size });
            }
        }

        return result;
    }

    /** Lightweight HEAD-like check returning success + folder content count. */
    async testConnection(
        remoteFolder: string,
    ): Promise<
        | { ok: true; count: number }
        | { ok: false; notFound: true; folder: string; message: string }
        | { ok: false; notFound?: false; message: string }
    > {
        try {
            const res: RequestUrlResponse = await this.send(
                {
                    url: this.url(remoteFolder.replace(/\/+$/, '') + '/'),
                    method: 'PROPFIND',
                    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
                    body:
                        '<?xml version="1.0" encoding="utf-8"?>' +
                        '<propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
                },
                false,
            );
            const doc = new DOMParser().parseFromString(res.text, 'application/xml');
            const count = doc.getElementsByTagNameNS('DAV:', 'response').length;
            return { ok: true, count: Math.max(0, count - 1) };
        } catch (e: any) {
            if (e instanceof WebDavError && e.status === 404) {
                return {
                    ok: false,
                    notFound: true,
                    folder: remoteFolder,
                    message: `Folder not found: ${remoteFolder}`,
                };
            }
            return { ok: false, message: e?.message ?? String(e) };
        }
    }
}
