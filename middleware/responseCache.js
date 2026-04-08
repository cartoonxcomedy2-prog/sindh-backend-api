const toBoundedInt = (raw, fallback, min, max) => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
};

const CACHE_ENABLED =
    String(process.env.RESPONSE_CACHE_ENABLED || 'true').toLowerCase() !== 'false';

const MAX_CACHE_ENTRIES = toBoundedInt(
    process.env.RESPONSE_CACHE_MAX_ENTRIES,
    150,
    20,
    5000
);

const MAX_CACHE_ENTRY_BYTES = toBoundedInt(
    process.env.RESPONSE_CACHE_MAX_ENTRY_BYTES,
    256 * 1024,
    1024,
    10 * 1024 * 1024
);

const MAX_CACHE_TOTAL_BYTES = toBoundedInt(
    process.env.RESPONSE_CACHE_MAX_TOTAL_BYTES,
    8 * 1024 * 1024,
    64 * 1024,
    100 * 1024 * 1024
);

const CACHE_PRUNE_INTERVAL_MS = toBoundedInt(
    process.env.RESPONSE_CACHE_PRUNE_INTERVAL_MS,
    10000,
    1000,
    10 * 60 * 1000
);

const cacheStore = new Map();
const tagIndex = new Map();

let cacheHits = 0;
let cacheMisses = 0;
let cacheBytes = 0;
let cacheSkippedLarge = 0;
let cacheSkippedDisabled = 0;
let lastPrunedAt = 0;

const serializeQuery = (query = {}) => {
    const keys = Object.keys(query).sort();
    if (keys.length === 0) return '';
    return keys
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(query[key]))}`)
        .join('&');
};

const cacheKeyForRequest = (req, { scopeByUser = false, keyBuilder } = {}) => {
    if (typeof keyBuilder === 'function') {
        return keyBuilder(req);
    }

    const basePath = req.originalUrl?.split('?')[0] || req.path || '';
    const queryPart = serializeQuery(req.query || {});
    const scope = scopeByUser
        ? `${req.user?._id || 'anon'}:${req.user?.role || 'guest'}`
        : 'public';
    return `${req.method}:${scope}:${basePath}?${queryPart}`;
};

const removeKeyFromTags = (cacheKey) => {
    for (const [tag, keys] of tagIndex.entries()) {
        if (!keys.has(cacheKey)) continue;
        keys.delete(cacheKey);
        if (keys.size === 0) tagIndex.delete(tag);
    }
};

const getBodyByteSize = (body) => {
    if (Buffer.isBuffer(body)) return body.length;
    if (typeof body === 'string') return Buffer.byteLength(body);
    if (body == null) return 0;
    try {
        return Buffer.byteLength(JSON.stringify(body));
    } catch (_error) {
        return 0;
    }
};

const deleteCacheEntry = (cacheKey) => {
    const entry = cacheStore.get(cacheKey);
    if (!entry) return;

    cacheStore.delete(cacheKey);
    removeKeyFromTags(cacheKey);
    cacheBytes = Math.max(0, cacheBytes - Number(entry.sizeBytes || 0));
};

const pruneExpiredEntries = (now = Date.now()) => {
    for (const [key, entry] of cacheStore.entries()) {
        if (Number(entry?.expiresAt || 0) <= now) {
            deleteCacheEntry(key);
        }
    }
};

const pruneCache = (now = Date.now()) => {
    pruneExpiredEntries(now);
    while (
        cacheStore.size > MAX_CACHE_ENTRIES ||
        cacheBytes > MAX_CACHE_TOTAL_BYTES
    ) {
        const oldestKey = cacheStore.keys().next().value;
        if (!oldestKey) break;
        deleteCacheEntry(oldestKey);
    }
};

const maybePruneCache = (now = Date.now()) => {
    if (now - lastPrunedAt < CACHE_PRUNE_INTERVAL_MS) return;
    lastPrunedAt = now;
    pruneCache(now);
};

const setCacheEntry = (cacheKey, entry) => {
    if (!CACHE_ENABLED) {
        cacheSkippedDisabled += 1;
        return false;
    }

    const sizeBytes = Number(entry?.sizeBytes || 0);
    if (sizeBytes <= 0 || sizeBytes > MAX_CACHE_ENTRY_BYTES) {
        cacheSkippedLarge += 1;
        return false;
    }

    if (cacheStore.has(cacheKey)) {
        deleteCacheEntry(cacheKey);
    }

    const now = Date.now();
    maybePruneCache(now);

    // Skip impossible-to-store entries early.
    if (sizeBytes > MAX_CACHE_TOTAL_BYTES) {
        cacheSkippedLarge += 1;
        return false;
    }

    // Make room for this entry.
    while (
        cacheStore.size >= MAX_CACHE_ENTRIES ||
        cacheBytes + sizeBytes > MAX_CACHE_TOTAL_BYTES
    ) {
        const oldestKey = cacheStore.keys().next().value;
        if (!oldestKey) break;
        deleteCacheEntry(oldestKey);
    }

    if (cacheBytes + sizeBytes > MAX_CACHE_TOTAL_BYTES) {
        cacheSkippedLarge += 1;
        return false;
    }

    cacheStore.set(cacheKey, entry);
    cacheBytes += sizeBytes;

    (entry.tags || []).forEach((tag) => {
        if (!tag) return;
        if (!tagIndex.has(tag)) {
            tagIndex.set(tag, new Set());
        }
        tagIndex.get(tag).add(cacheKey);
    });

    return true;
};

const normalizeTags = (tagsInput, req, res) => {
    if (typeof tagsInput === 'function') {
        const resolved = tagsInput(req, res);
        return Array.isArray(resolved) ? resolved.filter(Boolean) : [];
    }
    if (Array.isArray(tagsInput)) return tagsInput.filter(Boolean);
    if (typeof tagsInput === 'string' && tagsInput.trim()) return [tagsInput.trim()];
    return [];
};

const shouldBypassCache = (req, options = {}) => {
    if (!CACHE_ENABLED) return true;
    if (req.method !== 'GET') return true;
    if (String(req.query?.noCache || '').toLowerCase() === 'true') return true;
    if (typeof options.skip === 'function' && options.skip(req)) return true;
    return false;
};

const createResponseCache = (options = {}) => {
    const ttlSeconds = toBoundedInt(options.ttlSeconds, 30, 1, 3600);

    return (req, res, next) => {
        if (shouldBypassCache(req, options)) {
            return next();
        }

        const now = Date.now();
        maybePruneCache(now);

        const cacheKey = cacheKeyForRequest(req, options);
        const cached = cacheStore.get(cacheKey);

        if (cached && cached.expiresAt > now) {
            cacheHits += 1;
            res.setHeader('X-Response-Cache', 'HIT');
            for (const [headerName, headerValue] of Object.entries(
                cached.headers || {}
            )) {
                if (!headerName) continue;
                res.setHeader(headerName, headerValue);
            }
            res.status(cached.statusCode || 200);
            return res.send(cached.body);
        }

        cacheMisses += 1;
        if (cached) {
            deleteCacheEntry(cacheKey);
        }
        res.setHeader('X-Response-Cache', 'MISS');

        const originalJson = res.json.bind(res);
        const originalSend = res.send.bind(res);
        let captured = false;

        const persistIfCacheable = (body, contentType) => {
            if (captured) return;
            captured = true;

            const statusCode = res.statusCode || 200;
            if (statusCode >= 400) return;

            const cacheControlHeader = String(
                res.getHeader('Cache-Control') || ''
            ).trim();
            if (cacheControlHeader.toLowerCase().includes('no-store')) {
                return;
            }

            const tags = normalizeTags(options.tags, req, res);
            const headers = {};
            if (contentType) {
                headers['Content-Type'] = contentType;
            }
            if (cacheControlHeader) {
                headers['Cache-Control'] = cacheControlHeader;
            }

            const sizeBytes = getBodyByteSize(body);
            if (sizeBytes <= 0) return;

            setCacheEntry(cacheKey, {
                body,
                statusCode,
                headers,
                tags,
                expiresAt: Date.now() + ttlSeconds * 1000,
                sizeBytes,
            });
        };

        res.json = (body) => {
            let payload = body;
            try {
                payload = JSON.stringify(body);
                persistIfCacheable(payload, 'application/json; charset=utf-8');
                return res
                    .type('application/json; charset=utf-8')
                    .send(payload);
            } catch (_error) {
                return originalJson(body);
            }
        };

        res.send = (body) => {
            const type = String(res.getHeader('Content-Type') || '');
            if (typeof body === 'string' || Buffer.isBuffer(body)) {
                persistIfCacheable(body, type || undefined);
            }
            return originalSend(body);
        };

        return next();
    };
};

const invalidateCacheByTag = (tag) => {
    const safeTag = String(tag || '').trim();
    if (!safeTag) return 0;
    const keys = tagIndex.get(safeTag);
    if (!keys || keys.size === 0) return 0;
    let removed = 0;
    for (const key of [...keys]) {
        if (cacheStore.has(key)) {
            deleteCacheEntry(key);
            removed += 1;
        }
    }
    tagIndex.delete(safeTag);
    return removed;
};

const invalidateCacheByTags = (tags = []) =>
    (Array.isArray(tags) ? tags : [tags]).reduce(
        (count, tag) => count + invalidateCacheByTag(tag),
        0
    );

const clearResponseCache = () => {
    cacheStore.clear();
    tagIndex.clear();
    cacheHits = 0;
    cacheMisses = 0;
    cacheBytes = 0;
    cacheSkippedLarge = 0;
    cacheSkippedDisabled = 0;
    lastPrunedAt = 0;
};

const getResponseCacheStats = () => ({
    enabled: CACHE_ENABLED,
    entries: cacheStore.size,
    maxEntries: MAX_CACHE_ENTRIES,
    bytes: cacheBytes,
    maxBytes: MAX_CACHE_TOTAL_BYTES,
    maxEntryBytes: MAX_CACHE_ENTRY_BYTES,
    tags: tagIndex.size,
    hits: cacheHits,
    misses: cacheMisses,
    skippedLarge: cacheSkippedLarge,
    skippedDisabled: cacheSkippedDisabled,
});

module.exports = {
    createResponseCache,
    invalidateCacheByTag,
    invalidateCacheByTags,
    clearResponseCache,
    getResponseCacheStats,
};
