/**
 * Run async tasks with bounded concurrency. Stops scheduling when shouldStop()
 * returns true (already-started tasks finish naturally).
 */
export async function runWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    concurrency: number,
    shouldStop?: () => boolean,
): Promise<PromiseSettledResult<T>[]> {
    const c = Math.max(1, Math.floor(concurrency));
    const results: PromiseSettledResult<T>[] = new Array(tasks.length);
    let nextIdx = 0;

    const workers = new Array(Math.min(c, tasks.length)).fill(0).map(async () => {
        while (true) {
            if (shouldStop?.()) return;
            const idx = nextIdx++;
            if (idx >= tasks.length) return;
            try {
                const value = await tasks[idx]();
                results[idx] = { status: 'fulfilled', value };
            } catch (reason) {
                results[idx] = { status: 'rejected', reason };
            }
        }
    });

    await Promise.all(workers);
    // Fill any holes (when stopped early) with rejected sentinel
    for (let i = 0; i < tasks.length; i++) {
        if (!results[i]) {
            results[i] = { status: 'rejected', reason: new Error('skipped') };
        }
    }
    return results;
}
