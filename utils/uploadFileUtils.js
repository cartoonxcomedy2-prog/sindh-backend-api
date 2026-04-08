const cloudinary = require('../config/cloudinary');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const uploadsDir = path.resolve(path.join(__dirname, '..', 'uploads'));
const documentExtRegex = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv)$/i;
const remoteUrlRegex = /https?:\/\/[^\s"'<>]+/i;
const redirectStatusCodes = new Set([301, 302, 303, 307, 308]);
const maxRemoteRedirects = 5;
const MAX_DOWNLOAD_BUFFER_BYTES = 20 * 1024 * 1024;
const REMOTE_FETCH_TIMEOUT_MS = 45000;

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

const extractFileNameFromUrl = (urlLike = '') => {
    try {
        const parsed = new URL(String(urlLike || '').trim());
        return normalizeDownloadName(path.basename(parsed.pathname || '')) || 'document';
    } catch (_error) {
        return 'document';
    }
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

const buildRemoteDownloadCandidates = (embeddedUrl) => {
    const candidates = [embeddedUrl];
    const rawCandidate = toCloudinaryRawDeliveryUrl(embeddedUrl);
    if (rawCandidate && rawCandidate !== embeddedUrl) {
        candidates.push(rawCandidate);
    }
    for (const candidate of buildCloudinaryPrivateDownloadCandidates(embeddedUrl)) {
        if (!candidates.includes(candidate)) {
            candidates.push(candidate);
        }
    }
    for (const candidate of buildCloudinarySignedDeliveryCandidates(embeddedUrl)) {
        if (!candidates.includes(candidate)) {
            candidates.push(candidate);
        }
    }
    return candidates;
};

const collectStreamToBuffer = async (stream, maxBytes = MAX_DOWNLOAD_BUFFER_BYTES) =>
    await new Promise((resolve, reject) => {
        let settled = false;
        let totalBytes = 0;
        const chunks = [];

        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const fail = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        stream.on('data', (chunk) => {
            totalBytes += Number(chunk?.length || 0);
            if (totalBytes > maxBytes) {
                stream.destroy();
                return finish(null);
            }
            chunks.push(chunk);
        });
        stream.on('end', () => finish(Buffer.concat(chunks)));
        stream.on('error', fail);
    });

const fetchRemoteBuffer = async (
    remoteUrl,
    maxBytes = MAX_DOWNLOAD_BUFFER_BYTES,
    redirectCount = 0
) => {
    if (!remoteUrl) return null;
    if (redirectCount > maxRemoteRedirects) return null;

    if (typeof fetch === 'function') {
        try {
            const controller =
                typeof AbortController === 'function' ? new AbortController() : null;
            const timeoutId = setTimeout(() => {
                if (controller) controller.abort();
            }, REMOTE_FETCH_TIMEOUT_MS);
            try {
                const response = await fetch(remoteUrl, {
                    redirect: 'follow',
                    signal: controller?.signal,
                });
                if (!response.ok || !response.body) return null;

                const contentLength = Number.parseInt(
                    response.headers.get('content-length') || '',
                    10
                );
                if (Number.isFinite(contentLength) && contentLength > maxBytes) {
                    return null;
                }

                const bodyStream =
                    typeof Readable.fromWeb === 'function'
                        ? Readable.fromWeb(response.body)
                        : Readable.from(response.body);
                const buffer = await collectStreamToBuffer(bodyStream, maxBytes);
                if (!buffer) return null;

                return {
                    buffer,
                    finalUrl: response.url || remoteUrl,
                };
            } finally {
                clearTimeout(timeoutId);
            }
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

                const contentLength = Number.parseInt(
                    response.headers['content-length'] || '',
                    10
                );
                if (Number.isFinite(contentLength) && contentLength > maxBytes) {
                    response.resume();
                    return resolve(null);
                }

                let settled = false;
                let totalBytes = 0;
                const chunks = [];
                const finish = (value) => {
                    if (settled) return;
                    settled = true;
                    resolve(value);
                };
                const fail = (error) => {
                    if (settled) return;
                    settled = true;
                    reject(error);
                };

                response.on('data', (chunk) => {
                    totalBytes += Number(chunk?.length || 0);
                    if (totalBytes > maxBytes) {
                        response.destroy();
                        return finish(null);
                    }
                    chunks.push(chunk);
                });
                response.on('end', () =>
                    finish({
                        buffer: Buffer.concat(chunks),
                        finalUrl: remoteUrl,
                    })
                );
                response.on('error', fail);
            })
            .on('error', reject);
    });
};

const openRemoteStream = async (remoteUrl, redirectCount = 0) => {
    if (!remoteUrl) return null;
    if (redirectCount > maxRemoteRedirects) return null;

    if (typeof fetch === 'function') {
        try {
            const controller =
                typeof AbortController === 'function' ? new AbortController() : null;
            const timeoutId = setTimeout(() => {
                if (controller) controller.abort();
            }, REMOTE_FETCH_TIMEOUT_MS);
            try {
                const response = await fetch(remoteUrl, {
                    redirect: 'follow',
                    signal: controller?.signal,
                });
                if (!response.ok || !response.body) return null;

                const stream =
                    typeof Readable.fromWeb === 'function'
                        ? Readable.fromWeb(response.body)
                        : Readable.from(response.body);
                const contentLength = Number.parseInt(
                    response.headers.get('content-length') || '',
                    10
                );

                return {
                    stream,
                    fileName: extractFileNameFromUrl(response.url || remoteUrl),
                    contentLength: Number.isFinite(contentLength) ? contentLength : 0,
                };
            } finally {
                clearTimeout(timeoutId);
            }
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
                        return resolve(openRemoteStream(nextUrl, redirectCount + 1));
                    } catch (_error) {
                        return resolve(null);
                    }
                }
                if (statusCode < 200 || statusCode >= 300) {
                    response.resume();
                    return resolve(null);
                }

                const contentLength = Number.parseInt(
                    response.headers['content-length'] || '',
                    10
                );

                return resolve({
                    stream: response,
                    fileName: extractFileNameFromUrl(remoteUrl),
                    contentLength: Number.isFinite(contentLength) ? contentLength : 0,
                });
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
            const candidates = buildRemoteDownloadCandidates(embeddedUrl);

            for (const candidateUrl of candidates) {
                const remoteFile = await fetchRemoteBuffer(candidateUrl);
                if (!remoteFile?.buffer) continue;

                return {
                    buffer: remoteFile.buffer,
                    fileName: extractFileNameFromUrl(remoteFile.finalUrl || candidateUrl),
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
        const stat = await fs.promises.stat(localPath);
        if (Number(stat?.size || 0) > MAX_DOWNLOAD_BUFFER_BYTES) {
            return null;
        }
        return {
            buffer: await fs.promises.readFile(localPath),
            fileName: path.basename(localPath),
        };
    } catch (_error) {
        return null;
    }
};

const openStoredFileStream = async (filenameOrUrl) => {
    if (!filenameOrUrl) return null;

    const embeddedUrl = extractEmbeddedRemoteUrl(filenameOrUrl);
    if (embeddedUrl && isRemoteUrl(embeddedUrl)) {
        try {
            const candidates = buildRemoteDownloadCandidates(embeddedUrl);
            for (const candidateUrl of candidates) {
                const remoteFile = await openRemoteStream(candidateUrl);
                if (remoteFile?.stream) {
                    return remoteFile;
                }
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
            stream: fs.createReadStream(localPath),
            fileName: path.basename(localPath),
            contentLength: Number((await fs.promises.stat(localPath))?.size || 0),
        };
    } catch (_error) {
        return null;
    }
};

const downloadStoredFile = async (res, filenameOrUrl, preferredName = '') => {
    const file = await openStoredFileStream(filenameOrUrl);
    if (!file?.stream) return false;

    const fallbackName = normalizeDownloadName(file.fileName) || 'document';
    const requestedName = normalizeDownloadName(preferredName);
    const downloadName = requestedName || fallbackName;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    if (Number(file.contentLength || 0) > 0) {
        res.setHeader('Content-Length', String(file.contentLength));
    }

    try {
        await pipeline(file.stream, res);
    } catch (error) {
        if (!res.headersSent) {
            throw error;
        }
        res.destroy(error);
    }

    return true;
};

module.exports = {
    deleteUploadedFile,
    downloadStoredFile,
    isRemoteUrl,
    normalizeDownloadName,
    openStoredFileStream,
    readStoredFileBuffer,
    removeFromCloudinary,
    resolveLocalUploadPath,
    uploadToCloudinary,
};
