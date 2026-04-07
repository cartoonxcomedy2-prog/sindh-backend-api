const cloudinary = require('../config/cloudinary');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const uploadsDir = path.resolve(path.join(__dirname, '..', 'uploads'));

const sanitizePart = (value) =>
    String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);

const isRemoteUrl = (value) =>
    typeof value === 'string' && /^https?:\/\//i.test(value.trim());

const normalizeDownloadName = (value) => {
    const safe = path.basename(String(value || '').trim());
    return safe || '';
};

const resolveLocalUploadPath = (storedValue) => {
    if (!storedValue || isRemoteUrl(storedValue)) return null;

    const raw = String(storedValue).trim();
    if (!raw) return null;

    // Always force files to remain inside uploads directory.
    const fileName = path.basename(raw);
    if (!fileName) return null;

    const target = path.resolve(uploadsDir, fileName);
    const uploadsPrefix = `${uploadsDir}${path.sep}`;
    if (target !== uploadsDir && !target.startsWith(uploadsPrefix)) {
        return null;
    }

    return target;
};

const uploadToCloudinary = async (fileSource, parts = []) => {
    if (!fileSource) return '';

    const nameParts = (Array.isArray(parts) ? parts : [parts])
        .map((part) => sanitizePart(part))
        .filter(Boolean);

    const publicId = `${Date.now()}-${nameParts.join('-')}`;

    try {
        const result = await cloudinary.uploader.upload(fileSource, {
            folder: 'sindh_uploads',
            public_id: publicId,
            resource_type: 'auto',
        });

        // Clean up local temp file if it's a path.
        if (
            typeof fileSource === 'string' &&
            !fileSource.startsWith('data:') &&
            fs.existsSync(fileSource)
        ) {
            fs.unlinkSync(fileSource);
        }

        return result.secure_url;
    } catch (error) {
        if (
            typeof fileSource === 'string' &&
            !fileSource.startsWith('data:') &&
            fs.existsSync(fileSource)
        ) {
            fs.unlinkSync(fileSource);
        }
        console.error('Cloudinary Upload Error:', error);
        return '';
    }
};

const removeFromCloudinary = async (fileUrl) => {
    if (!fileUrl || !fileUrl.includes('cloudinary')) return;

    try {
        const decoded = decodeURIComponent(String(fileUrl));
        const matched = decoded.match(
            /\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+(?:\?.*)?$/i
        );
        const publicId = matched?.[1] || '';
        if (!publicId) return;

        await cloudinary.uploader.destroy(publicId, {
            resource_type: 'image',
            invalidate: true,
        });
        await cloudinary.uploader.destroy(publicId, {
            resource_type: 'raw',
            invalidate: true,
        });
    } catch (error) {
        console.error('Cloudinary Delete Error:', error);
    }
};

const deleteUploadedFile = async (filenameOrUrl) => {
    if (!filenameOrUrl) return;

    if (isRemoteUrl(filenameOrUrl)) {
        await removeFromCloudinary(filenameOrUrl);
        return;
    }

    const target = resolveLocalUploadPath(filenameOrUrl);
    if (!target) return;

    try {
        if (fs.existsSync(target)) {
            fs.unlinkSync(target);
        }
    } catch (_error) {}
};

const readStoredFileBuffer = async (filenameOrUrl) => {
    if (!filenameOrUrl) return null;

    if (isRemoteUrl(filenameOrUrl)) {
        try {
            let buffer = null;
            if (typeof fetch === 'function') {
                const response = await fetch(filenameOrUrl);
                if (!response.ok) return null;
                const data = await response.arrayBuffer();
                buffer = Buffer.from(data);
            } else {
                buffer = await new Promise((resolve, reject) => {
                    const client = filenameOrUrl.startsWith('https://')
                        ? https
                        : http;
                    client
                        .get(filenameOrUrl, (response) => {
                            if (response.statusCode < 200 || response.statusCode >= 300) {
                                response.resume();
                                return reject(new Error('Remote file request failed'));
                            }
                            const chunks = [];
                            response.on('data', (chunk) => chunks.push(chunk));
                            response.on('end', () => resolve(Buffer.concat(chunks)));
                            response.on('error', reject);
                        })
                        .on('error', reject);
                });
            }

            const url = new URL(filenameOrUrl);
            const rawName = path.basename(url.pathname || '') || 'document';

            return {
                buffer,
                fileName: normalizeDownloadName(rawName) || 'document',
            };
        } catch (_error) {
            return null;
        }
    }

    const localPath = resolveLocalUploadPath(filenameOrUrl);
    if (!localPath || !fs.existsSync(localPath)) return null;

    try {
        return {
            buffer: await fs.promises.readFile(localPath),
            fileName: path.basename(localPath),
        };
    } catch (_error) {
        return null;
    }
};

const downloadStoredFile = async (res, filenameOrUrl, preferredName = '') => {
    const file = await readStoredFileBuffer(filenameOrUrl);
    if (!file) return false;

    const fallbackName = normalizeDownloadName(file.fileName) || 'document';
    const requestedName = normalizeDownloadName(preferredName);
    const downloadName = requestedName || fallbackName;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.send(file.buffer);
    return true;
};

module.exports = {
    deleteUploadedFile,
    downloadStoredFile,
    isRemoteUrl,
    normalizeDownloadName,
    readStoredFileBuffer,
    removeFromCloudinary,
    resolveLocalUploadPath,
    uploadToCloudinary,
};
