/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Avoids the `(e: any)` anti-pattern in `catch` clauses while still being
 * permissive about non-Error throws (which the requestUrl APIs sometimes do).
 */
export function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object' && 'message' in e) {
        const msg = (e as { message?: unknown }).message;
        if (typeof msg === 'string') return msg;
    }
    return String(e);
}
