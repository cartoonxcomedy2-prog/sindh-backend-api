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
// Set root uploads folder to 755
try { fs.chmodSync(uploadsDir, 0o755); } catch (e) {}

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
    // Always use local storage - Cloudinary removed
    if (!fileSource) return '';

    const nameParts = (Array.isArray(parts) ? parts : [parts])
        .map((part) => sanitizePart(part))
        .filter(Boolean);

    const baseName = nameParts.join('-') || 'document';
    const forcePdf = options?.forcePdf === true;
    const originalName = options?.originalName || '';

    // Determine subfolder based on options or parts
    let subFolder = options?.subFolder || '';
    const partsLower = nameParts.map(p => p.toLowerCase());
    
    if (!subFolder) {
        if (partsLower.some(p => p.includes('banner'))) {
            subFolder = 'banners';
        } else if (partsLower.some(p => p.includes('scholarship'))) {
            subFolder = 'scholarships';
        } else if (partsLower.some(p => p.includes('university')) || partsLower.some(p => p.includes('thumbnail')) || partsLower.some(p => p.includes('logo'))) {
            subFolder = 'universities';
        } else if (partsLower.some(p => p.includes('education')) || partsLower.some(p => p.includes('transcript')) || partsLower.some(p => p.includes('certificate')) || partsLower.some(p => p.includes('cnic')) || partsLower.some(p => p.includes('passport'))) {
            subFolder = 'education';
        } else if (partsLower.some(p => p.includes('admit-card')) || partsLower.some(p => p.includes('offer-letter'))) {
            subFolder = 'applications';
        } else if (partsLower.some(p => p.includes('avatar')) || partsLower.some(p => p.includes('profile'))) {
            subFolder = 'avatars';
        } else if (partsLower.some(p => p.includes('image'))) {
            subFolder = 'scholarships'; // Fallback for general images to scholarships if not caught above
        }
    }
    
    const targetDir = subFolder ? path.join(uploadsDir, subFolder) : uploadsDir;
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }
    // Automatically set permissions to 755 for the directory
    try { fs.chmodSync(targetDir, 0o755); } catch (e) {}

    let uploadSource = fileSource;
    const cleanupPaths = new Set();

    // Helper to persist to local storage
    const persistLocalUpload = async (source, isBase64 = false, base64Mime = '') => {
        let ext = (path.extname(source) || path.extname(originalName) || '').toLowerCase();
        let finalSource = source;

        if (isBase64) {
            const buffer = Buffer.from(source, 'base64');
            if (!ext) {
                if (base64Mime.includes('pdf')) ext = '.pdf';
                else if (base64Mime.includes('jpeg')) ext = '.jpg';
                else if (base64Mime.includes('png')) ext = '.png';
                else if (base64Mime.includes('webp')) ext = '.webp';
                else ext = '.bin';
            }

            // PDF Conversion for Base64 if forced
            if (forcePdf && imageExtSet.has(ext)) {
                try {
                    const pdfBuffer = await convertImageBufferToPdf(buffer, baseName);
                    const finalLocalName = `${baseName}-${Date.now()}.pdf`;
                    const finalLocalPath = path.join(targetDir, finalLocalName);
                    fs.writeFileSync(finalLocalPath, pdfBuffer);
                    // Force 644 permission for files so they are readable by the web server
                    try { fs.chmodSync(finalLocalPath, 0o644); } catch (e) {}
                    return (subFolder ? `/uploads/${subFolder}/` : '/uploads/') + finalLocalName;
                } catch (err) {
                    console.error('Base64 PDF conversion failed:', err);
                }
            }

            const finalLocalName = `${baseName}-${Date.now()}${ext}`;
            const finalLocalPath = path.join(targetDir, finalLocalName);
            fs.writeFileSync(finalLocalPath, buffer);
            // Force 644 permission for files so they are readable by the web server
            try { fs.chmodSync(finalLocalPath, 0o644); } catch (e) {}
            return (subFolder ? `/uploads/${subFolder}/` : '/uploads/') + finalLocalName;
        }

        // For local files
        const finalLocalName = `${baseName}-${Date.now()}${ext}`;
        const finalLocalPath = path.join(targetDir, finalLocalName);

        try {
            if (typeof finalSource === 'string' && fs.existsSync(finalSource)) {
                if (path.resolve(finalSource) !== path.resolve(finalLocalPath)) {
                    fs.renameSync(finalSource, finalLocalPath);
                    finalSource = finalLocalPath;
                }
                return (subFolder ? `/uploads/${subFolder}/` : '/uploads/') + path.basename(finalSource);
            }
        } catch (e) {
            console.error('Local file persistence failed:', e);
        }
        return '';
    };

    const isLocalUploadPath = (sourceValue) =>
        typeof sourceValue === 'string' &&
        !sourceValue.startsWith('data:') &&
        fs.existsSync(sourceValue);

    // Handle Data URLs (Base64)
    if (typeof uploadSource === 'string' && uploadSource.startsWith('data:')) {
        const matches = uploadSource.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
            return await persistLocalUpload(matches[2], true, matches[1]);
        }
        return '';
    }

    // Handle Local Files (Multer)
    if (isLocalUploadPath(uploadSource)) {
        cleanupPaths.add(uploadSource);
        let sourceExt = (path.extname(uploadSource) || path.extname(originalName) || '').toLowerCase();

        if (forcePdf && imageExtSet.has(sourceExt)) {
            try {
                const convertedPdfPath = await convertImageFileToPdf(uploadSource, baseName);
                uploadSource = convertedPdfPath;
                cleanupPaths.add(convertedPdfPath);
            } catch (error) {
                console.error('File-to-PDF conversion failed:', error);
            }
        }
    }

    return await persistLocalUpload(uploadSource);
};

const removeFromCloudinary = async (fileUrl) => {
    // Now handles local file deletion instead of Cloudinary
    if (!fileUrl) return;
    
    const localPath = resolveLocalUploadPath(fileUrl);
    if (localPath && fs.existsSync(localPath)) {
        try {
            fs.unlinkSync(localPath);
        } catch (error) {
            console.error('Local file delete error:', error);
        }
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

    // Handle subfolder paths like /uploads/banners/filename.jpg
    const uploadsPathMatch = raw.match(/^\/?uploads\/([^/]+)\/(.+)$/);
    if (uploadsPathMatch) {
        const subFolder = uploadsPathMatch[1];
        const fileName = uploadsPathMatch[2];
        const target = path.resolve(uploadsDir, subFolder, fileName);
        if (target.startsWith(uploadsDir)) {
            return target;
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
    const mimeMap = {
        '.pdf': 'application/pdf',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.zip': 'application/zip',
        '.rar': 'application/x-rar-compressed'
    };
    res.setHeader('Content-Type', mimeMap[fileExtension] || 'application/octet-stream');
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
