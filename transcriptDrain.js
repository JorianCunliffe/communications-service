export const DEFAULT_TRANSCRIPT_DRAIN_MS = 2000;

export function createTranscriptDrain({
    hasPending,
    shouldWait = hasPending,
    finalize,
    timeoutMs = DEFAULT_TRANSCRIPT_DRAIN_MS,
    schedule = setTimeout,
    cancel = clearTimeout,
}) {
    let mediaClosed = false;
    let providerClosed = false;
    let finalized = false;
    let timer = null;

    const finish = () => {
        if (finalized) return;
        finalized = true;
        if (timer) cancel(timer);
        timer = null;
        finalize();
    };

    const settle = () => {
        if (mediaClosed && (!hasPending() || providerClosed)) finish();
    };

    return {
        mediaClosed() {
            if (mediaClosed) return;
            mediaClosed = true;
            if (!shouldWait() || providerClosed) return finish();
            timer = schedule(finish, timeoutMs);
        },
        pendingSettled: settle,
        providerClosed() {
            providerClosed = true;
            settle();
        },
    };
}