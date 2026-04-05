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
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
]);

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (!allowedMime.has(file.mimetype)) {
            return cb(new Error('Only PDF and image files are allowed'));
        }
        cb(null, true);
    },
});

const appDocUpload = upload.fields([
    { name: 'admitCard', maxCount: 1 },
    { name: 'offerLetter', maxCount: 1 },
]);

const mixedUpload = upload.any();

module.exports = {
    upload,
    appDocUpload,
    mixedUpload,
};

