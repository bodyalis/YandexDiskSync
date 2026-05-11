/**
 * Convert a list of glob patterns into a single matcher.
 * Supported syntax:
 *   *       — any chars except `/`
 *   **      — any chars including `/`
 *   ?       — single char except `/`
 *   [abc]   — character class
 *   trailing `/` is ignored
 *
 * Patterns are matched against the full vault-relative path (POSIX, no leading slash).
 */
export function compileGlobs(patterns: string[]): (path: string) => boolean {
    const cleaned = patterns
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && !p.startsWith('#'));
    if (cleaned.length === 0) return () => false;

    const regexes = cleaned.map((p) => new RegExp('^' + globToRegex(p) + '$'));
    return (path: string) => {
        const norm = path.replace(/^\/+/, '').replace(/\/+$/, '');
        return regexes.some((r) => r.test(norm));
    };
}

function globToRegex(glob: string): string {
    const g = glob.replace(/^\/+/, '').replace(/\/+$/, '');
    let out = '';
    let i = 0;
    while (i < g.length) {
        const c = g[i];
        if (c === '*') {
            if (g[i + 1] === '*') {
                // ** — match any chars including '/'
                out += '.*';
                i += 2;
                if (g[i] === '/') i++; // collapse `**/`
                continue;
            }
            // single * — anything except '/'
            out += '[^/]*';
            i++;
            continue;
        }
        if (c === '?') {
            out += '[^/]';
            i++;
            continue;
        }
        if (c === '[') {
            const end = g.indexOf(']', i);
            if (end === -1) {
                out += '\\[';
                i++;
                continue;
            }
            out += g.substring(i, end + 1);
            i = end + 1;
            continue;
        }
        if ('\\^$.|+(){}'.includes(c)) {
            out += '\\' + c;
            i++;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}
