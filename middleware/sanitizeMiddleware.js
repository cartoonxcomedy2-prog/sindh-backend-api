const PROTOTYPE_POLLUTION_KEYS = new Set([
    '__proto__',
    'prototype',
    'constructor',
]);

const isPlainObject = (value) =>
    Object.prototype.toString.call(value) === '[object Object]';

const sanitizeKeyName = (key) => {
    const raw = String(key || '');
    const cleaned = raw.replace(/^\$+/, '').replace(/\./g, '_');
    return cleaned.trim();
};

const sanitizeInPlace = (target) => {
    if (Array.isArray(target)) {
        target.forEach((item) => sanitizeInPlace(item));
        return;
    }

    if (!isPlainObject(target)) {
        return;
    }

    const keys = Object.keys(target);
    for (const key of keys) {
        const value = target[key];
        const sanitizedKey = sanitizeKeyName(key);
        const shouldRename =
            key !== sanitizedKey &&
            sanitizedKey &&
            !PROTOTYPE_POLLUTION_KEYS.has(sanitizedKey);
        const shouldDelete =
            !sanitizedKey || PROTOTYPE_POLLUTION_KEYS.has(sanitizedKey);

        if (shouldRename) {
            if (typeof target[sanitizedKey] === 'undefined') {
                target[sanitizedKey] = value;
            }
            delete target[key];
            sanitizeInPlace(target[sanitizedKey]);
            continue;
        }

        if (shouldDelete) {
            delete target[key];
            continue;
        }

        sanitizeInPlace(value);
    }
};

const sanitizeMiddleware = (req, _res, next) => {
    // Express 5 exposes req.query as a getter-only property.
    // Sanitizing request body in-place avoids setter collisions while still
    // protecting write payloads against operator/prototype injection.
    const target = req.body;
    if (target && (Array.isArray(target) || isPlainObject(target))) {
        sanitizeInPlace(target);
    }
    next();
};

module.exports = sanitizeMiddleware;
