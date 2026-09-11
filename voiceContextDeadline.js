// The tool and its HTTP request share one budget; the outer tool must not
// discard a still-valid request and cause the model to start a duplicate.
export const VOICE_CONTEXT_TIMEOUT_MS = 8000;

export async function withToolDeadline(run, timeoutMs, label) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`${label} timed out after ${timeoutMs}ms`);
            controller.abort(error);
            reject(error);
        }, timeoutMs);
    });
    try {
        return await Promise.race([Promise.resolve().then(() => run(controller.signal)), timeout]);
    } finally {
        clearTimeout(timer);
    }
}
