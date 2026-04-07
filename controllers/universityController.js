const fs = require('fs');
const path = require('path');
const University = require('../models/University');
const User = require('../models/User');
const { uploadToCloudinary, deleteUploadedFile } = require('../utils/uploadFileUtils');
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
    const normalized = {};

    // Basic Fields
    if (payload.name) normalized.name = payload.name.toString().trim();
    if (payload.description) normalized.description = payload.description.toString().trim();
    if (payload.country) normalized.country = payload.country.toString().trim();
    if (payload.state) normalized.state = payload.state.toString().trim();
    if (payload.city) normalized.city = payload.city.toString().trim();
    if (payload.address) normalized.address = payload.address.toString().trim();
    if (payload.currency) normalized.currency = payload.currency.toString().trim();
    if (payload.type) normalized.type = payload.type.toString().trim();
    if (payload.universityType) normalized.universityType = payload.universityType.toString().trim();
    if (payload.website) normalized.website = payload.website.toString().trim();
    if (payload.ranking) normalized.ranking = payload.ranking.toString().trim();
    if (payload.testDate) normalized.testDate = payload.testDate.toString().trim();
    if (payload.interviewDate) normalized.interviewDate = payload.interviewDate.toString().trim();
    if (payload.deadline) normalized.deadline = payload.deadline.toString().trim();
    if (payload.applicationFee) normalized.applicationFee = payload.applicationFee.toString().trim();
    if (payload.applicationFees) normalized.applicationFees = payload.applicationFees.toString().trim();
    if (payload.contact) normalized.contact = payload.contact.toString().trim();
    if (payload.eligibility) normalized.eligibility = payload.eligibility.toString().trim();
    if (payload.scholarshipDetails) normalized.scholarshipDetails = payload.scholarshipDetails.toString().trim();
    if (payload.thumbnail) normalized.thumbnail = payload.thumbnail;
    if (payload.logo) normalized.logo = payload.logo;

    if (typeof payload.internationalStudents !== 'undefined') {
        normalized.internationalStudents = toBoolean(payload.internationalStudents, false);
    }
    if (typeof payload.isActive !== 'undefined') {
        normalized.isActive = toBoolean(payload.isActive, true);
    }

    // Complex Fields (JSON or Arrays)
    let rawPrograms = payload.programs;
    if (typeof rawPrograms === 'string') {
        rawPrograms = tryParseJSON(rawPrograms, []);
    }
    
    const programs = Array.isArray(rawPrograms) ? rawPrograms : [];
    normalized.programs = programs.map((p) => {
        let item = p;
        if (typeof p === 'string') {
            const fixedStr = p.replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":').replace(/'/g, '"');
            item = tryParseJSON(fixedStr, tryParseJSON(p, {}));
        }
        
        if (Array.isArray(item)) item = item[0] || {};
        
        const obj = item && typeof item === 'object' ? item : {};
        return {
            name: (obj.name || obj.programName || '').toString().trim(),
            type: (obj.type || obj.programType || '').toString().trim(),
            duration: (obj.duration || '').toString().trim(),
            feeAmount: (obj.feeAmount || '').toString().trim(),
            feeStructure: (obj.feeStructure || '').toString().trim(),
        };
    }).filter(p => p.name);

    const applicationSteps = tryParseJSON(payload.applicationSteps, []);
    normalized.applicationSteps = Array.isArray(applicationSteps) ? applicationSteps : [];

    normalized.contactInfo = normalizeContactInfo(payload.contactInfo);

    normalized.country = normalized.country || DEFAULT_COUNTRY;

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

const normalizeEmail = (rawEmail) =>
    String(rawEmail || '')
        .trim()
        .toLowerCase();

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

        if (payload.thumbnail && payload.thumbnail.startsWith('data:')) {
            payload.thumbnail = await uploadToCloudinary(payload.thumbnail, [payload.name, 'thumbnail']);
            if (!payload.thumbnail) {
                throw new Error('Failed to upload university thumbnail');
            }
        }
        if (payload.logo && payload.logo.startsWith('data:')) {
            payload.logo = await uploadToCloudinary(payload.logo, [payload.name, 'logo']);
            if (!payload.logo) {
                throw new Error('Failed to upload university logo');
            }
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
        if (payload.thumbnail && payload.thumbnail.startsWith('data:')) {
            payload.thumbnail = await uploadToCloudinary(payload.thumbnail, [payload.name || university.name, 'thumbnail']);
            if (!payload.thumbnail) {
                throw new Error('Failed to upload university thumbnail');
            }
        }
        if (payload.logo && payload.logo.startsWith('data:')) {
            payload.logo = await uploadToCloudinary(payload.logo, [payload.name || university.name, 'logo']);
            if (!payload.logo) {
                throw new Error('Failed to upload university logo');
            }
        }

        const previousThumbnail = university.thumbnail || '';
        const previousLogo = university.logo || '';
        const updatedUniversity = await University.findByIdAndUpdate(req.params.id, payload, {
            new: true,
            runValidators: true,
        });

        if (previousThumbnail && payload.thumbnail && previousThumbnail !== payload.thumbnail) {
            await deleteUploadedFile(previousThumbnail);
        }
        if (previousLogo && payload.logo && previousLogo !== payload.logo) {
            await deleteUploadedFile(previousLogo);
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
        const { password, name } = req.body;
        const email = normalizeEmail(req.body.email);

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
