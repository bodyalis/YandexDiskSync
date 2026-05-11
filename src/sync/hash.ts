/** Compute SHA-256 hex of a string (UTF-8) or ArrayBuffer using SubtleCrypto. */
export async function sha256(data: string | ArrayBuffer): Promise<string> {
    let buffer: ArrayBuffer;
    if (typeof data === 'string') {
        buffer = new TextEncoder().encode(data).buffer as ArrayBuffer;
    } else {
        buffer = data;
    }
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
        const h = bytes[i].toString(16);
        s += h.length === 1 ? '0' + h : h;
    }
    return s;
}
