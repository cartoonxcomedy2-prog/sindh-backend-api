const fs = require('fs');
const path = require('path');

const uploadsDir = path.join(__dirname, '..', 'uploads');

const sanitizePart = (value) =>
    String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);

const safeBasename = (filename) => path.basename(String(filename || '').trim());

const deleteUploadedFile = (filename) => {
    const safeName = safeBasename(filename);
    if (!safeName) return;
    const target = path.join(uploadsDir, safeName);
    try {
        if (fs.existsSync(target)) {
            fs.unlinkSync(target);
        }
    } catch (_error) {
        // Silent cleanup fail to avoid breaking API responses.
    }
};

const renameUploadedFile = (filename, parts = []) => {
    const safeName = safeBasename(filename);
    if (!safeName) return '';

    const source = path.join(uploadsDir, safeName);
    if (!fs.existsSync(source)) return safeName;

    const ext = path.extname(safeName);
    const nameParts = (Array.isArray(parts) ? parts : [parts])
        .map((part) => sanitizePart(part))
        .filter(Boolean);

    if (!nameParts.length) return safeName;

    const renamed = `${Date.now()}-${nameParts.join('-')}${ext}`;
    const target = path.join(uploadsDir, renamed);

    try {
        fs.renameSync(source, target);
        return renamed;
    } catch (_error) {
        return safeName;
    }
};

module.exports = {
    deleteUploadedFile,
    renameUploadedFile,
};
