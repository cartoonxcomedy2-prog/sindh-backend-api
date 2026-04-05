const fs = require('fs');
const path = require('path');
const University = require('../models/University');
const User = require('../models/User');
const DEFAULT_COUNTRY = 'Pakistan';
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

const publicUniversityQuery = {
    $or: [
        { isActive: true },
        { active: true },
        { isActive: { $exists: false }, active: { $exists: false } },
    ],
};

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

const normalizeUniversityPayload = (payload = {}) => {
    const normalized = { ...payload };

    const programs = tryParseJSON(payload.programs, []);
    normalized.programs = Array.isArray(programs) ? programs : [];

    const applicationSteps = tryParseJSON(payload.applicationSteps, []);
    normalized.applicationSteps = Array.isArray(applicationSteps) ? applicationSteps : [];
    normalized.contactInfo = normalizeContactInfo(payload.contactInfo);

    if (typeof payload.contact !== 'undefined') {
        normalized.contact = (payload.contact ?? '').toString().trim();
    }

    if (typeof payload.internationalStudents !== 'undefined') {
        normalized.internationalStudents = toBoolean(payload.internationalStudents, false);
    }

    if (typeof payload.isActive !== 'undefined') {
        normalized.isActive = toBoolean(payload.isActive, true);
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

// @desc    Fetch all universities (public)
// @route   GET /api/universities
// @access  Public
const getUniversities = async (req, res) => {
    try {
        const universities = await University.find(publicUniversityQuery).sort({ createdAt: -1 });
        res.json(universities);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Fetch all universities for admin panel
// @route   GET /api/universities/admin/list
// @access  Private
const getUniversitiesAdminList = async (req, res) => {
    try {
        let query = {};
        if (req.user.role === 'university') {
            query = { 'adminAccount.userId': req.user._id };
        }
        const universities = await University.find(query).sort({ createdAt: -1 });
        res.json({ data: withHasAdmin(universities) });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Fetch university by id
// @route   GET /api/universities/:id
// @access  Public
const getUniversityById = async (req, res) => {
    try {
        const university = await University.findById(req.params.id);

        if (!university) {
            return res.status(404).json({ message: 'University not found' });
        }

        res.json({
            data: {
                ...university.toObject(),
                hasAdmin: Boolean(university.adminAccount?.email),
            },
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const createUniversity = async (req, res) => {
    try {
        const payload = normalizeUniversityPayload(req.body);

        // If high-level institutional admin is creating, link it automatically
        if (req.user.role === 'university') {
            payload.adminAccount = {
                email: req.user.email,
                userId: req.user._id,
            };
        }

        const university = new University(payload);
        const createdUniversity = await university.save();
        res.status(201).json({ data: createdUniversity });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// @desc    Update university (Admin only)
// @route   PUT /api/universities/:id
// @access  Private/Admin
const updateUniversity = async (req, res) => {
    try {
        const university = await University.findById(req.params.id);
        if (!university) {
            return res.status(404).json({ message: 'University not found' });
        }

        // Authorization Check: Super Admin can update any, University Admin can update their own
        if (req.user.role !== 'admin' && String(university.adminAccount?.userId) !== String(req.user._id)) {
            return res.status(403).json({ message: 'Not authorized to update this university' });
        }

        const payload = normalizeUniversityPayload(req.body);
        const previousThumbnail = university.thumbnail || '';
        const previousLogo = university.logo || '';
        const updatedUniversity = await University.findByIdAndUpdate(req.params.id, payload, {
            new: true,
            runValidators: true,
        });

        const nextThumbnail = Object.prototype.hasOwnProperty.call(payload, 'thumbnail')
            ? payload.thumbnail || ''
            : previousThumbnail;
        const nextLogo = Object.prototype.hasOwnProperty.call(payload, 'logo')
            ? payload.logo || ''
            : previousLogo;

        if (previousThumbnail && nextThumbnail !== previousThumbnail) {
            await removeOldUploadIfUnused(University, 'thumbnail', previousThumbnail, university._id);
        }
        if (previousLogo && nextLogo !== previousLogo) {
            await removeOldUploadIfUnused(University, 'logo', previousLogo, university._id);
        }

        res.json({ data: updatedUniversity });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// @desc    Delete university (Admin only)
// @route   DELETE /api/universities/:id
// @access  Private/Admin
const deleteUniversity = async (req, res) => {
    try {
        const deletedUniversity = await University.findByIdAndDelete(req.params.id);

        if (!deletedUniversity) {
            return res.status(404).json({ message: 'University not found' });
        }

        await removeOldUploadIfUnused(University, 'thumbnail', deletedUniversity.thumbnail, deletedUniversity._id);
        await removeOldUploadIfUnused(University, 'logo', deletedUniversity.logo, deletedUniversity._id);

        res.json({ message: 'University deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get university account info
// @route   GET /api/universities/:id/account
// @access  Private/Admin
const getUniversityAccount = async (req, res) => {
    try {
        const university = await University.findById(req.params.id).select('adminAccount name');

        if (!university) {
            return res.status(404).json({ message: 'University not found' });
        }

        if (!university.adminAccount?.email) {
            return res.json({ data: null });
        }

        res.json({
            data: {
                email: university.adminAccount.email,
                role: 'university',
                name: university.name,
            },
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Create or update university account
// @route   PUT /api/universities/:id/account
// @access  Private/Admin
const upsertUniversityAccount = async (req, res) => {
    try {
        const { email, password, name } = req.body;

        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const university = await University.findById(req.params.id);
        if (!university) {
            return res.status(404).json({ message: 'University not found' });
        }

        let user = await User.findOne({ email }).select('+password');

        if (!user) {
            if (!password) {
                return res.status(400).json({ message: 'Password is required for new account' });
            }

            user = await User.create({
                name: name || university.name || 'University Admin',
                email,
                password,
                role: 'university',
            });
        } else {
            user.name = name || university.name || user.name;
            user.role = 'university';

            if (password) {
                user.password = password;
            }

            await user.save();
        }

        university.adminAccount = {
            email: user.email,
            userId: user._id,
        };
        await university.save();

        res.json({
            message: 'University credentials saved successfully',
            data: { email: user.email },
        });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

module.exports = {
    getUniversities,
    getUniversitiesAdminList,
    getUniversityById,
    createUniversity,
    updateUniversity,
    deleteUniversity,
    getUniversityAccount,
    upsertUniversityAccount,
};
