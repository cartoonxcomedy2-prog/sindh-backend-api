const fs = require('fs');
const path = require('path');
const multer = require('multer');

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '');
        const safeBase = path
            .basename(file.originalname || 'file', ext)
            .replace(/[^a-zA-Z0-9_-]/g, '-')
            .slice(0, 50);
        cb(null, `${Date.now()}-${safeBase}${ext}`);
    },
});

const allowedMime = new Set([
    'application/pdf',
    'application/x-pdf',
    'application/octet-stream',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
]);
const allowedExt = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp']);

const EDUCATION_UPLOAD_FIELDS = [
    'idFile',
    'matricTranscript',
    'matricCertificate',
    'interTranscript',
    'interCertificate',
    'bachTranscript',
    'bachCertificate',
    'masterTranscript',
    'masterCertificate',
    'passportPdf',
    'testTranscript',
    'cv',
    'recommendationLetter',
    'fatherCnicFile',
    // Admin legacy dynamic field uploads:
    'file',
    'transcript',
    'certificate',
];

const upload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024,
        files: 20,
    },
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const isMimeAllowed = allowedMime.has(file.mimetype);
        const isExtAllowed = allowedExt.has(ext);

        // Some mobile pickers send generic MIME types for valid PDF/image files.
        if (!isMimeAllowed && !isExtAllowed) {
            return cb(new Error('Only PDF and image files are allowed'));
        }
        cb(null, true);
    },
});

const appDocUpload = upload.fields([
    { name: 'admitCard', maxCount: 1 },
    { name: 'offerLetter', maxCount: 1 },
]);

const mixedUpload = upload.fields(
    EDUCATION_UPLOAD_FIELDS.map((name) => ({ name, maxCount: 1 }))
);

module.exports = {
    upload,
    appDocUpload,
    mixedUpload,
};
