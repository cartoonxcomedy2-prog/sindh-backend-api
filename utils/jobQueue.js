const toBoundedInt = (raw, fallback, min, max) => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
};

const QUEUE_CONCURRENCY = toBoundedInt(
    process.env.JOB_QUEUE_CONCURRENCY,
    2,
    1,
    16
);
const MAX_BACKLOG = toBoundedInt(
    process.env.JOB_QUEUE_MAX_BACKLOG,
    2000,
    100,
    50000
);
const DEFAULT_TIMEOUT_MS = toBoundedInt(
    process.env.JOB_QUEUE_TIMEOUT_MS,
    10000,
    1000,
    60000
);
const DEDUPE_WINDOW_MS = toBoundedInt(
    process.env.JOB_QUEUE_DEDUPE_WINDOW_MS,
    15000,
    1000,
    300000
);

const pendingJobs = [];
const dedupeClock = new Map();
let activeJobs = 0;
let acceptedJobs = 0;
let completedJobs = 0;
let failedJobs = 0;
let droppedJobs = 0;

const cleanupDedupeKeys = (now) => {
    for (const [key, value] of dedupeClock.entries()) {
        if (now - value > DEDUPE_WINDOW_MS) {
            dedupeClock.delete(key);
        }
    }
};

const withTimeout = async (promiseFactory, timeoutMs, label) => {
    let timeoutId;
    try {
        return await Promise.race([
            Promise.resolve().then(() => promiseFactory()),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`${label} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
};

const runNextJob = () => {
    if (activeJobs >= QUEUE_CONCURRENCY) return;
    const nextJob = pendingJobs.shift();
    if (!nextJob) return;

    activeJobs += 1;

    Promise.resolve()
        .then(() =>
            withTimeout(
                nextJob.handler,
                nextJob.timeoutMs,
                `Queue job "${nextJob.name}"`
            )
        )
        .then(() => {
            completedJobs += 1;
        })
        .catch((error) => {
            failedJobs += 1;
            console.error(
                `[jobQueue] ${nextJob.name} failed:`,
                error?.message || error
            );
        })
        .finally(() => {
            activeJobs = Math.max(0, activeJobs - 1);
            runNextJob();
        });
};

const drainQueue = () => {
    while (activeJobs < QUEUE_CONCURRENCY && pendingJobs.length > 0) {
        runNextJob();
    }
};

const enqueueJob = ({
    name = 'job',
    handler,
    dedupeKey = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
    if (typeof handler !== 'function') {
        throw new Error('enqueueJob requires a function handler');
    }

    const now = Date.now();
    cleanupDedupeKeys(now);

    if (dedupeKey) {
        const lastSeen = dedupeClock.get(dedupeKey) || 0;
        if (now - lastSeen < DEDUPE_WINDOW_MS) {
            droppedJobs += 1;
            return { enqueued: false, reason: 'deduped' };
        }
        dedupeClock.set(dedupeKey, now);
    }

    if (pendingJobs.length >= MAX_BACKLOG) {
        droppedJobs += 1;
        return { enqueued: false, reason: 'queue_full' };
    }

    pendingJobs.push({
        name: String(name || 'job'),
        handler,
        timeoutMs: toBoundedInt(timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60000),
    });
    acceptedJobs += 1;
    drainQueue();
    return { enqueued: true, reason: 'queued' };
};

const getQueueStats = () => ({
    concurrency: QUEUE_CONCURRENCY,
    maxBacklog: MAX_BACKLOG,
    pending: pendingJobs.length,
    active: activeJobs,
    accepted: acceptedJobs,
    completed: completedJobs,
    failed: failedJobs,
    dropped: droppedJobs,
});

module.exports = {
    enqueueJob,
    getQueueStats,
};
