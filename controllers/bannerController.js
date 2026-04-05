const fs = require('fs');
const path = require('path');
const Banner = require('../models/Banner');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

const extractUploadFilename = (value) => {
    if (typeof value !== 'string') return '';
    const raw = value.trim();
    if (!raw || raw.startsWith('data:')) return '';

    if (raw.startsWith('/uploads/')) return raw.replace(/^\/uploads\//, '');
    if (raw.startsWith('uploads/')) return raw.replace(/^uploads\//, '');

    const uploadsIndex = raw.indexOf('/uploads/');
    if (uploadsIndex >= 0) {
        return raw.slice(uploadsIndex + '/uploads/'.length).split('?')[0];
    }

    return '';
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const removeOldBannerUploadIfUnused = async (oldValue, currentId) => {
    const filename = extractUploadFilename(oldValue);
    if (!filename) return;

    const escapedFilename = escapeRegex(filename);
    const stillUsed = await Banner.exists({
        _id: { $ne: currentId },
        imageUrl: {
            $regex: new RegExp(`(?:^|/uploads/)${escapedFilename}(?:\\?.*)?$`),
        },
    });

    if (stillUsed) return;

    const absolutePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
    }
};

// @desc    Fetch all banners
// @route   GET /api/banners
// @access  Public
const getBanners = async (req, res) => {
    try {
        const banners = await Banner.find({ active: true });
        res.json(banners);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Create banner
// @route   POST /api/banners
// @access  Private/Admin
const createBanner = async (req, res) => {
    try {
        const { title, imageUrl } = req.body;
        const banner = new Banner({ title, imageUrl });
        const createdBanner = await banner.save();
        res.status(201).json(createdBanner);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// @desc    Update banner
// @route   PATCH /api/banners/:id
// @access  Private/Admin
const updateBanner = async (req, res) => {
    try {
        const { title, imageUrl } = req.body;
        const banner = await Banner.findById(req.params.id);

        if (!banner) {
            return res.status(404).json({ message: 'Banner not found' });
        }

        const updatedBanner = await Banner.findByIdAndUpdate(
            req.params.id,
            { title, imageUrl },
            { new: true, runValidators: true },
        );

        const nextImage = typeof imageUrl === 'string' ? imageUrl : banner.imageUrl;
        if (banner.imageUrl && nextImage !== banner.imageUrl) {
            await removeOldBannerUploadIfUnused(banner.imageUrl, banner._id);
        }

        res.json(updatedBanner);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// @desc    Delete banner
// @route   DELETE /api/banners/:id
// @access  Private/Admin
const deleteBanner = async (req, res) => {
    try {
        const deletedBanner = await Banner.findByIdAndDelete(req.params.id);

        if (!deletedBanner) {
            return res.status(404).json({ message: 'Banner not found' });
        }

        await removeOldBannerUploadIfUnused(deletedBanner.imageUrl, deletedBanner._id);

        res.json({ message: 'Banner deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getBanners,
    createBanner,
    updateBanner,
    deleteBanner,
};
