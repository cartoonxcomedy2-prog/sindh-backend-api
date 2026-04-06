const cloudinary = require('../config/cloudinary');
const fs = require('fs');
const path = require('path');

const uploadsDir = path.join(__dirname, '..', 'uploads');

const sanitizePart = (value) =>
    String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);

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
        
        // Clean up local temp file if it's a path
        if (typeof fileSource === 'string' && !fileSource.startsWith('data:') && fs.existsSync(fileSource)) {
            fs.unlinkSync(fileSource);
        }
        
        return result.secure_url;
    } catch (error) {
        console.error('Cloudinary Upload Error:', error);
        return '';
    }
};

const removeFromCloudinary = async (fileUrl) => {
    if (!fileUrl || !fileUrl.includes('cloudinary')) return;

    try {
        // Extract publicId from URL
        const parts = fileUrl.split('/');
        const lastPart = parts[parts.length - 1];
        const publicId = `sindh_uploads/${lastPart.split('.')[0]}`;
        
        await cloudinary.uploader.destroy(publicId);
    } catch (error) {
        console.error('Cloudinary Delete Error:', error);
    }
};

const deleteUploadedFile = async (filenameOrUrl) => {
    if (!filenameOrUrl) return;

    if (filenameOrUrl.startsWith('http')) {
        await removeFromCloudinary(filenameOrUrl);
    } else {
        const target = path.join(uploadsDir, filenameOrUrl);
        try {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        } catch (_error) {}
    }
};

module.exports = {
    deleteUploadedFile,
    uploadToCloudinary,
    removeFromCloudinary,
};

