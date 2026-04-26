const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const PDFDocument = require('pdfkit');
const cloudinary = require('../config/cloudinary');

const uploadsDir = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const imageExtSet = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const pdfExtSet = new Set(['.pdf']);

const sanitizePart = (val) => {
    return String(val || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-');
};

const convertImageFileToPdf = async (inputPath, baseName) => {
    return new Promise((resolve, reject) => {
        try {
            const outputPath = path.join(uploadsDir, `${baseName}-${Date.now()}.pdf`);
            const doc = new PDFDocument({ autoFirstPage: false });
            const stream = fs.createWriteStream(outputPath);
            doc.pipe(stream);

            const img = doc.openImage(inputPath);
            doc.addPage({ size: [img.width, img.height] });
            doc.image(img, 0, 0);
            doc.end();

            stream.on('finish', () => resolve(outputPath));
            stream.on('error', reject);
        } catch (err) {
            reject(err);
        }
    });
};

const convertImageBufferToPdf = async (buffer, baseName) => {
    return new Promise((resolve, reject) => {
        try {
            const chunks = [];
            const doc = new PDFDocument({ autoFirstPage: false });
            doc.on('data', (chunk) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));

            const img = doc.openImage(buffer);
            doc.addPage({ size: [img.width, img.height] });
            doc.image(img, 0, 0);
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
};

const fetchRemoteBuffer = async (remoteUrl, redirectCount = 0) => {
    if (redirectCount > 5) return null;
    const redirectStatusCodes = new Set([301, 302, 303, 307, 308]);

    return new Promise((resolve, reject) => {
        try {
            const client = remoteUrl.startsWith('https://') ? https : http;
            client.get(remoteUrl, (response) => {
                const statusCode = Number(response.statusCode || 0);
                if (redirectStatusCodes.has(statusCode)) {
                    const location = String(response.headers.location || '').trim();
                    response.resume();
                    if (!location) return resolve(null);
                    try {
                        const nextUrl = new URL(location, remoteUrl).toString();
                        return resolve(fetchRemoteBuffer(nextUrl, redirectCount + 1));
                    } catch {
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
            }).on('error', reject);
        } catch {
            resolve(null);
        }
    });
};

const uploadToCloudinary = async (fileSource, parts = [], options = {}) => {
    if (!fileSource) return '';

    const nameParts = (Array.isArray(parts) ? parts : [parts])
        .map((part) => sanitizePart(part))
        .filter(Boolean);

    const baseName = nameParts.join('-') || 'document';
    const publicId = `${baseName}-${Date.now()}`;
    const forcePdf = options?.forcePdf === true;
    const originalName = options?.originalName || '';

    let uploadSource = fileSource;
    const cleanupPaths = new Set();
    const persistLocalUpload = () => {
        const ext = (path.extname(uploadSource) || path.extname(originalName) || '').toLowerCase();
        
        // If it's a data URL, we need to decode and write it to a file
        if (typeof uploadSource === 'string' && uploadSource.startsWith('data:')) {
            try {
                const matches = uploadSource.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
                if (!matches || matches.length !== 3) return '';

                const mimeType = matches[1];
                const base64Data = matches[2];
                const buffer = Buffer.from(base64Data, 'base64');
                
                // Infer extension from mimeType if possible
                let detectedExt = ext;
                if (!detectedExt) {
                    if (mimeType.includes('pdf')) detectedExt = '.pdf';
                    else if (mimeType.includes('jpeg')) detectedExt = '.jpg';
                    else if (mimeType.includes('png')) detectedExt = '.png';
                    else if (mimeType.includes('webp')) detectedExt = '.webp';
                    else detectedExt = '.bin';
                }

                const finalLocalName = `${baseName}-${Date.now()}${detectedExt}`;
                const finalLocalPath = path.join(uploadsDir, finalLocalName);
                fs.writeFileSync(finalLocalPath, buffer);
                return '/uploads/' + finalLocalName;
            } catch (e) {
                console.error('Base64 local upload failed:', e);
                return '';
            }
        }

        const finalLocalName = `${baseName}-${Date.now()}${ext}`;
        const finalLocalPath = path.join(uploadsDir, finalLocalName);

        try {
            if (typeof uploadSource === 'string' && fs.existsSync(uploadSource)) {
                if (path.resolve(uploadSource) !== path.resolve(finalLocalPath)) {
                    fs.renameSync(uploadSource, finalLocalPath);
                    uploadSource = finalLocalPath;
                }
                return '/uploads/' + path.basename(uploadSource);
            }
        } catch (e) {
            console.error('Local upload fallback failed:', e);
        }
        return '';
    };
    const inferSourceExtension = (sourceValue, fallbackName = '') => {
        const primaryExt = path.extname(String(sourceValue || '')).toLowerCase();
        if (primaryExt) return primaryExt;
        return path.extname(String(fallbackName || '')).toLowerCase();
    };
    const isLocalUploadPath = (sourceValue) =>
        typeof sourceValue === 'string' &&
        !sourceValue.startsWith('data:') &&
        fs.existsSync(sourceValue);
    let shouldUploadAsRaw = false;
    let sourceExt = inferSourceExtension(uploadSource, originalName);

    if (isLocalUploadPath(fileSource)) {
        cleanupPaths.add(fileSource);
    }

    if (forcePdf) {
        if (isLocalUploadPath(uploadSource) && pdfExtSet.has(sourceExt)) {
            shouldUploadAsRaw = true;
        } else if (isLocalUploadPath(uploadSource) && imageExtSet.has(sourceExt)) {
            try {
                const convertedPdfPath = await convertImageFileToPdf(uploadSource, baseName);
                uploadSource = convertedPdfPath;
                cleanupPaths.add(convertedPdfPath);
                sourceExt = '.pdf';
                shouldUploadAsRaw = true;
            } catch (error) {
                shouldUploadAsRaw = false;
                console.error('PDF conversion failed, uploading original file instead:', error);
            }
        } else if (pdfExtSet.has(sourceExt)) {
            shouldUploadAsRaw = true;
        }
    }

    const resourceType = shouldUploadAsRaw ? 'raw' : 'auto';

    if (!process.env.CLOUDINARY_API_KEY) {
        const localFallback = persistLocalUpload();
        if (localFallback) return localFallback;
        return '';
    }

    try {
        const result = await cloudinary.uploader.upload(uploadSource, {
            folder: 'sindh_uploads',
            public_id: publicId,
            resource_type: resourceType,
        });

        for (const tempPath of cleanupPaths) {
            try {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } catch {}
        }

        return result.secure_url;
    } catch (error) {
        const localFallback = persistLocalUpload();

        for (const tempPath of cleanupPaths) {
            try {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } catch {}
        }

        if (localFallback) {
            console.error('Cloudinary Upload Error, stored locally:', error);
            return localFallback;
        }

        console.error('Cloudinary Upload Error:', error);
        return '';
    }
};

const removeFromCloudinary = async (fileUrl) => {
    if (!fileUrl || !fileUrl.includes('cloudinary')) return;
    try {
        const decoded = decodeURIComponent(String(fileUrl));
        const matched = decoded.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+(?:\?.*)?$/i);
        const publicId = matched?.[1] || '';
        if (!publicId) return;
        await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
        await cloudinary.uploader.destroy(publicId, { resource_type: 'raw', invalidate: true });
    } catch (error) {
        console.error('Cloudinary Delete Error:', error);
    }
};

const isRemoteUrl = (val) => String(val || '').startsWith('http');

const extractEmbeddedRemoteUrl = (val) => {
    const raw = String(val || '').trim();
    if (isRemoteUrl(raw)) return raw;
    if (raw.includes('|')) return raw.split('|').find(isRemoteUrl) || null;
    return null;
};

const resolveLocalUploadPath = (storedValue) => {
    if (!storedValue || isRemoteUrl(storedValue)) return null;
    const raw = String(storedValue).trim();
    if (!raw) return null;

    // Accept direct absolute paths that already point inside uploads.
    if (path.isAbsolute(raw)) {
        const normalizedAbsolute = path.resolve(raw);
        if (normalizedAbsolute.startsWith(uploadsDir)) {
            return normalizedAbsolute;
        }
    }

    const fileName = path.basename(raw);
    if (!fileName) return null;
    const target = path.resolve(uploadsDir, fileName);
    if (!target.startsWith(uploadsDir)) return null;
    return target;
};

const inferFileExtensionFromBuffer = (buffer, fallback = '.pdf') => {
    if (!buffer || buffer.length < 4) return fallback;
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return '.pdf';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png';
    // RAR 4.x/5.x
    if (buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72 && buffer[3] === 0x21) return '.rar';
    // ZIP
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) return '.zip';
    return fallback;
};

const normalizeDownloadName = (val) => {
    return String(val || '').trim().replace(/[^a-zA-Z0-9.\-_]/g, '-');
};

const readStoredFileBuffer = async (filenameOrUrl) => {
    if (!filenameOrUrl) return null;
    const embeddedUrl = extractEmbeddedRemoteUrl(filenameOrUrl);
    if (embeddedUrl && isRemoteUrl(embeddedUrl)) {
        const buffer = await fetchRemoteBuffer(embeddedUrl);
        if (buffer) return { buffer, fileName: path.basename(new URL(embeddedUrl).pathname) || 'document' };
        return null;
    }
    const localPath = resolveLocalUploadPath(filenameOrUrl);
    if (!localPath || !fs.existsSync(localPath)) return null;
    return { buffer: await fs.promises.readFile(localPath), fileName: path.basename(localPath) };
};

const prepareStoredFileBufferForDownload = async (filenameOrUrl, { forcePdf = false } = {}) => {
    const file = await readStoredFileBuffer(filenameOrUrl);
    if (!file) return null;
    const sourceExtension = inferFileExtensionFromBuffer(file.buffer);
    if (forcePdf && imageExtSet.has(sourceExtension)) {
        try {
            const pdfBuffer = await convertImageBufferToPdf(file.buffer, 'document');
            return { buffer: pdfBuffer, fileName: file.fileName, extension: '.pdf' };
        } catch (error) {
            console.error('PDF conversion failed:', error);
        }
    }
    return { buffer: file.buffer, fileName: file.fileName, extension: sourceExtension };
};

const downloadStoredFile = async (res, filenameOrUrl, preferredName = '', options = {}) => {
    const file = await prepareStoredFileBufferForDownload(filenameOrUrl, options);
    if (!file) return false;
    const normalizedPreferred = normalizeDownloadName(preferredName);
    const fileExtension = (file.extension || '.pdf').toLowerCase();
    let downloadName = normalizedPreferred || 'document';
    const providedExt = path.extname(downloadName).toLowerCase();
    if (!providedExt) {
        downloadName = `${downloadName}${fileExtension}`;
    } else if (providedExt !== fileExtension) {
        downloadName = `${downloadName.slice(0, -providedExt.length)}${fileExtension}`;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.send(file.buffer);
    return true;
};

const deleteUploadedFile = async (storedValue) => {
    const raw = String(storedValue || '').trim();
    if (!raw) return false;

    const embeddedRemote = extractEmbeddedRemoteUrl(raw);
    if (embeddedRemote && isRemoteUrl(embeddedRemote)) {
        await removeFromCloudinary(embeddedRemote);
    }

    const localPath = resolveLocalUploadPath(raw);
    if (!localPath || !fs.existsSync(localPath)) {
        return Boolean(embeddedRemote);
    }

    try {
        await fs.promises.unlink(localPath);
        return true;
    } catch {
        return false;
    }
};

module.exports = {
    deleteUploadedFile,
    downloadStoredFile,
    inferFileExtensionFromBuffer,
    isRemoteUrl,
    normalizeDownloadName,
    prepareStoredFileBufferForDownload,
    readStoredFileBuffer,
    removeFromCloudinary,
    resolveLocalUploadPath,
    uploadToCloudinary,
};
