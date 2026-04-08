const cloudinary = require('../config/cloudinary');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const uploadsDir = path.resolve(path.join(__dirname, '..', 'uploads'));
const documentExtRegex = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv)$/i;
const remoteUrlRegex = /https?:\/\/[^\s"'<>]+/i;
const redirectStatusCodes = new Set([301, 302, 303, 307, 308]);
const maxRemoteRedirects = 5;

const extractEmbeddedRemoteUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const matched = raw.match(remoteUrlRegex);
    if (!matched?.[0]) return '';
    return matched[0].replace(/[\],);.]+$/g, '');
};

const sanitizePart = (value) =>
    String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);

const isRemoteUrl = (value) =>
    /^https?:\/\//i.test(extractEmbeddedRemoteUrl(value));

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

const inferCloudinaryResourceType = (fileSource) => {
    const raw = String(fileSource || '').trim().toLowerCase();
    if (!raw) return 'auto';
    if (raw.startsWith('data:application/pdf')) return 'raw';
    if (raw.startsWith('data:image/')) return 'image';

    const ext = path.extname(raw.split('?')[0] || '');
    if (ext === '.pdf') return 'raw';
    return 'auto';
};

const toCloudinaryRawDeliveryUrl = (value) => {
    const source = extractEmbeddedRemoteUrl(value);
    if (!source) return '';
    try {
        const parsed = new URL(source);
        if (!/cloudinary\.com$/i.test(parsed.hostname)) return '';
        if (!documentExtRegex.test(parsed.pathname || '')) return '';
        if (!parsed.pathname.includes('/image/upload/')) return '';
        return source.replace('/image/upload/', '/raw/upload/');
    } catch (_error) {
        return '';
    }
};

const extractCloudinaryPublicIdAndFormat = (value) => {
    const source = extractEmbeddedRemoteUrl(value);
    if (!source) return null;
    try {
        const decoded = decodeURIComponent(source);
        const match = decoded.match(
            /\/upload\/(?:v\d+\/)?(.+)\.([a-z0-9]+)(?:\?.*)?$/i
        );
        if (!match) return null;
        return {
            publicId: match[1],
            format: String(match[2] || '').toLowerCase(),
        };
    } catch (_error) {
        return null;
    }
};

const buildCloudinaryPrivateDownloadCandidates = (value) => {
    const extracted = extractCloudinaryPublicIdAndFormat(value);
    if (!extracted || !extracted.publicId || !extracted.format) return [];

    const candidates = [];
    const resourceTypes = ['image', 'raw'];
    for (const resourceType of resourceTypes) {
        try {
            const signed = cloudinary.utils.private_download_url(
                extracted.publicId,
                extracted.format,
                {
                    resource_type: resourceType,
                    type: 'upload',
                    attachment: false,
                }
            );
            if (signed) candidates.push(signed);
        } catch (_error) {}
    }
    return candidates;
};

const buildCloudinarySignedDeliveryCandidates = (value) => {
    const extracted = extractCloudinaryPublicIdAndFormat(value);
    if (!extracted || !extracted.publicId || !extracted.format) return [];

    const candidates = [];
    const resourceTypes = ['image', 'raw'];
    const deliveryTypes = ['upload', 'private', 'authenticated'];

    for (const resourceType of resourceTypes) {
        for (const type of deliveryTypes) {
            try {
                const signed = cloudinary.url(extracted.publicId, {
                    secure: true,
                    sign_url: true,
                    resource_type: resourceType,
                    type,
                    format: extracted.format,
                });
                if (signed) candidates.push(signed);
            } catch (_error) {}
        }
    }
    return candidates;
};

const fetchRemoteBuffer = async (remoteUrl, redirectCount = 0) => {
    if (!remoteUrl) return null;
    if (redirectCount > maxRemoteRedirects) return null;
    if (typeof fetch === 'function') {
        try {
            const response = await fetch(remoteUrl, { redirect: 'follow' });
            if (!response.ok) return null;
            const data = await response.arrayBuffer();
            return Buffer.from(data);
        } catch (_error) {
            return null;
        }
    }

    return await new Promise((resolve, reject) => {
        const client = remoteUrl.startsWith('https://') ? https : http;
        client
            .get(remoteUrl, (response) => {
                const statusCode = Number(response.statusCode || 0);
                if (redirectStatusCodes.has(statusCode)) {
                    const location = String(response.headers.location || '').trim();
                    response.resume();
                    if (!location) {
                        return resolve(null);
                    }
                    try {
                        const nextUrl = new URL(location, remoteUrl).toString();
                        return resolve(
                            fetchRemoteBuffer(nextUrl, redirectCount + 1)
                        );
                    } catch (_error) {
                        return resolve(null);
                    }
                }
                if (statusCode < 200 || statusCode >= 300) {
                    response.resume();
                    return resolve(null);
                }
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => resolve(Buffer.concat(chunks)));
                response.on('error', reject);
            })
            .on('error', reject);
    });
};

const uploadToCloudinary = async (fileSource, parts = []) => {
    if (!fileSource) return '';

    const nameParts = (Array.isArray(parts) ? parts : [parts])
        .map((part) => sanitizePart(part))
        .filter(Boolean);

    const publicId = `${Date.now()}-${nameParts.join('-')}`;
    const resourceType = inferCloudinaryResourceType(fileSource);

    try {
        const result = await cloudinary.uploader.upload(fileSource, {
            folder: 'sindh_uploads',
            public_id: publicId,
            resource_type: resourceType,
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

    const embeddedUrl = extractEmbeddedRemoteUrl(filenameOrUrl);
    if (embeddedUrl && isRemoteUrl(embeddedUrl)) {
        try {
            const candidates = [embeddedUrl];
            const rawCandidate = toCloudinaryRawDeliveryUrl(embeddedUrl);
            if (rawCandidate && rawCandidate !== embeddedUrl) {
                candidates.push(rawCandidate);
            }
            for (const candidate of buildCloudinaryPrivateDownloadCandidates(
                embeddedUrl
            )) {
                if (!candidates.includes(candidate)) {
                    candidates.push(candidate);
                }
            }
            for (const candidate of buildCloudinarySignedDeliveryCandidates(
                embeddedUrl
            )) {
                if (!candidates.includes(candidate)) {
                    candidates.push(candidate);
                }
            }

            for (const candidateUrl of candidates) {
                const buffer = await fetchRemoteBuffer(candidateUrl);
                if (!buffer) continue;

                const parsed = new URL(candidateUrl);
                const rawName = path.basename(parsed.pathname || '') || 'document';
                return {
                    buffer,
                    fileName: normalizeDownloadName(rawName) || 'document',
                };
            }
            return null;
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
