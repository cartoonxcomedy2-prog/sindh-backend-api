const fs = require('fs');
const path = require('path');
const Scholarship = require('../models/Scholarship');
const User = require('../models/User');
const DEFAULT_COUNTRY = 'Pakistan';
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

const publicScholarshipQuery = {};

const tryParseJSON = (value, fallback) => {
    if (typeof value !== 'string') return value ?? fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};

const toBoolean = (value, fallback) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    if (typeof value === 'number') return value === 1;
    return fallback;
};

const normalizeContactInfo = (value) => {
    const parsed = tryParseJSON(value, []);
    if (!Array.isArray(parsed)) return [];

    return parsed
        .map((entry) => {
            const item = entry && typeof entry === 'object' ? entry : {};
            return {
                email: (item.email ?? '').toString().trim(),
                phone: (item.phone ?? '').toString().trim(),
            };
        })
        .filter((item) => item.email || item.phone);
};

const normalizeScholarshipPayload = (payload = {}) => {
    const normalized = { ...payload };

    const coverage = tryParseJSON(payload.coverage, []);
    normalized.coverage = Array.isArray(coverage) ? coverage : [];

    const programs = tryParseJSON(payload.programs, []);
    normalized.programs = Array.isArray(programs) ? programs : [];

    const linkedUniversities = tryParseJSON(payload.linkedUniversities, []);
    normalized.linkedUniversities = Array.isArray(linkedUniversities) ? linkedUniversities : [];

    const applicationSteps = tryParseJSON(payload.applicationSteps, []);
    normalized.applicationSteps = Array.isArray(applicationSteps) ? applicationSteps : [];

    const eligibility = tryParseJSON(payload.eligibility, {});
    normalized.eligibility = eligibility && typeof eligibility === 'object' ? eligibility : {};
    normalized.contactInfo = normalizeContactInfo(payload.contactInfo);

    if (typeof payload.isActive !== 'undefined') {
        normalized.isActive = toBoolean(payload.isActive, true);
    }

    if (typeof payload.contact !== 'undefined') {
        normalized.contact = (payload.contact ?? '').toString().trim();
    }

    normalized.country = DEFAULT_COUNTRY;

    return normalized;
};

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

const removeOldUploadIfUnused = async (model, field, oldValue, currentId) => {
    const filename = extractUploadFilename(oldValue);
    if (!filename) return;

    const escapedFilename = escapeRegex(filename);
    const stillUsed = await model.exists({
        _id: { $ne: currentId },
        [field]: {
            $regex: new RegExp(`(?:^|/uploads/)${escapedFilename}(?:\\?.*)?$`),
        },
    });

    if (stillUsed) return;

    const absolutePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
    }
};

const withHasAdmin = (records = []) =>
    records.map((record) => ({
        ...record.toObject(),
        hasAdmin: Boolean(record.adminAccount?.email),
    }));

// @desc    Fetch all scholarships (public)
// @route   GET /api/scholarships
// @access  Public
const getScholarships = async (req, res) => {
    try {
        const scholarships = await Scholarship.find(publicScholarshipQuery)
            .sort({ createdAt: -1 })
            .populate('linkedUniversities', 'name thumbnail city country')
            .populate('university', 'name logo');
        res.json(scholarships);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Fetch all scholarships for admin panel
// @route   GET /api/scholarships/admin/list
// @access  Private
const getScholarshipsAdminList = async (req, res) => {
    try {
        let query = {};
        if (req.user.role === 'scholarship') {
            query = { 'adminAccount.userId': req.user._id };
        }
        const scholarships = await Scholarship.find(query)
            .sort({ createdAt: -1 })
            .populate('linkedUniversities', 'name thumbnail city country')
            .populate('university', 'name logo');
        res.json({ data: withHasAdmin(scholarships) });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Fetch scholarship by id
// @route   GET /api/scholarships/:id
// @access  Public
const getScholarshipById = async (req, res) => {
    try {
        const scholarship = await Scholarship.findById(req.params.id)
            .populate('linkedUniversities', 'name thumbnail city country')
            .populate('university', 'name logo');

        if (!scholarship) {
            return res.status(404).json({ message: 'Scholarship not found' });
        }

        res.json({
            data: {
                ...scholarship.toObject(),
                hasAdmin: Boolean(scholarship.adminAccount?.email),
            },
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Create scholarship (Admin only)
// @route   POST /api/scholarships
// @access  Private/Admin
const createScholarship = async (req, res) => {
    try {
        const payload = normalizeScholarshipPayload(req.body);

        // Link only if institutional admin is creating
        if (req.user.role === 'scholarship') {
            payload.adminAccount = {
                email: req.user.email,
                userId: req.user._id,
            };
        }

        const scholarship = new Scholarship(payload);
        const createdScholarship = await scholarship.save();
        res.status(201).json({ data: createdScholarship });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// @desc    Update scholarship (Admin only)
// @route   PUT /api/scholarships/:id
// @access  Private/Admin
const updateScholarship = async (req, res) => {
    try {
        const scholarship = await Scholarship.findById(req.params.id);
        if (!scholarship) {
            return res.status(404).json({ message: 'Scholarship not found' });
        }

        // Authorization Check
        if (req.user.role !== 'admin' && String(scholarship.adminAccount?.userId) !== String(req.user._id)) {
            return res.status(403).json({ message: 'Not authorized to update this scholarship' });
        }

        const payload = normalizeScholarshipPayload(req.body);
        const previousThumbnail = scholarship.thumbnail || '';
        const previousImage = scholarship.image || '';
        const updatedScholarship = await Scholarship.findByIdAndUpdate(req.params.id, payload, {
            new: true,
            runValidators: true,
        });

        const nextThumbnail = Object.prototype.hasOwnProperty.call(payload, 'thumbnail')
            ? payload.thumbnail || ''
            : previousThumbnail;
        const nextImage = Object.prototype.hasOwnProperty.call(payload, 'image')
            ? payload.image || ''
            : previousImage;

        if (previousThumbnail && nextThumbnail !== previousThumbnail) {
            await removeOldUploadIfUnused(Scholarship, 'thumbnail', previousThumbnail, scholarship._id);
        }
        if (previousImage && nextImage !== previousImage) {
            await removeOldUploadIfUnused(Scholarship, 'image', previousImage, scholarship._id);
        }

        res.json({ data: updatedScholarship });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// @desc    Delete scholarship (Admin only)
// @route   DELETE /api/scholarships/:id
// @access  Private/Admin
const deleteScholarship = async (req, res) => {
    try {
        const deletedScholarship = await Scholarship.findByIdAndDelete(req.params.id);

        if (!deletedScholarship) {
            return res.status(404).json({ message: 'Scholarship not found' });
        }

        await removeOldUploadIfUnused(Scholarship, 'thumbnail', deletedScholarship.thumbnail, deletedScholarship._id);
        await removeOldUploadIfUnused(Scholarship, 'image', deletedScholarship.image, deletedScholarship._id);

        res.json({ message: 'Scholarship deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get scholarship account info
// @route   GET /api/scholarships/:id/account
// @access  Private/Admin
const getScholarshipAccount = async (req, res) => {
    try {
        const scholarship = await Scholarship.findById(req.params.id).select('adminAccount title');

        if (!scholarship) {
            return res.status(404).json({ message: 'Scholarship not found' });
        }

        if (!scholarship.adminAccount?.email) {
            return res.json({ data: null });
        }

        res.json({
            data: {
                email: scholarship.adminAccount.email,
                role: 'scholarship',
                name: scholarship.title,
            },
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Create or update scholarship account
// @route   PUT /api/scholarships/:id/account
// @access  Private/Admin
const upsertScholarshipAccount = async (req, res) => {
    try {
        const { email, password, name } = req.body;

        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const scholarship = await Scholarship.findById(req.params.id);
        if (!scholarship) {
            return res.status(404).json({ message: 'Scholarship not found' });
        }

        let user = await User.findOne({ email }).select('+password');

        if (!user) {
            if (!password) {
                return res.status(400).json({ message: 'Password is required for new account' });
            }

            user = await User.create({
                name: name || scholarship.title || 'Scholarship Admin',
                email,
                password,
                role: 'scholarship',
            });
        } else {
            user.name = name || scholarship.title || user.name;
            user.role = 'scholarship';

            if (password) {
                user.password = password;
            }

            await user.save();
        }

        scholarship.adminAccount = {
            email: user.email,
            userId: user._id,
        };
        await scholarship.save();

        res.json({
            message: 'Scholarship credentials saved successfully',
            data: { email: user.email },
        });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

module.exports = {
    getScholarships,
    getScholarshipsAdminList,
    getScholarshipById,
    createScholarship,
    updateScholarship,
    deleteScholarship,
    getScholarshipAccount,
    upsertScholarshipAccount,
};
