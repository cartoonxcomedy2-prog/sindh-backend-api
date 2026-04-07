const toBoundedInt = (raw, fallback, min, max) => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
};

const MAX_CACHE_ENTRIES = toBoundedInt(
    process.env.RESPONSE_CACHE_MAX_ENTRIES,
    500,
    50,
    5000
);

const cacheStore = new Map();
const tagIndex = new Map();
let cacheHits = 0;
let cacheMisses = 0;

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

const deleteCacheEntry = (cacheKey) => {
    if (!cacheStore.has(cacheKey)) return;
    cacheStore.delete(cacheKey);
    removeKeyFromTags(cacheKey);
};

const setCacheEntry = (cacheKey, entry) => {
    if (cacheStore.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = cacheStore.keys().next().value;
        if (oldestKey) {
            deleteCacheEntry(oldestKey);
        }
    }
    cacheStore.set(cacheKey, entry);
    (entry.tags || []).forEach((tag) => {
        if (!tag) return;
        if (!tagIndex.has(tag)) {
            tagIndex.set(tag, new Set());
        }
        tagIndex.get(tag).add(cacheKey);
    });
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

        const cacheKey = cacheKeyForRequest(req, options);
        const now = Date.now();
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

            const tags = normalizeTags(options.tags, req, res);
            const headers = {};
            if (contentType) {
                headers['Content-Type'] = contentType;
            }
            const cacheControl = res.getHeader('Cache-Control');
            if (cacheControl) {
                headers['Cache-Control'] = cacheControl;
            }

            setCacheEntry(cacheKey, {
                body,
                statusCode,
                headers,
                tags,
                expiresAt: Date.now() + ttlSeconds * 1000,
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
};

const getResponseCacheStats = () => ({
    entries: cacheStore.size,
    maxEntries: MAX_CACHE_ENTRIES,
    tags: tagIndex.size,
    hits: cacheHits,
    misses: cacheMisses,
});

module.exports = {
    createResponseCache,
    invalidateCacheByTag,
    invalidateCacheByTags,
    clearResponseCache,
    getResponseCacheStats,
};
