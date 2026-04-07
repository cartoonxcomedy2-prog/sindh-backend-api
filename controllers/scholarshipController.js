const fs = require('fs');
const path = require('path');
const Scholarship = require('../models/Scholarship');
const User = require('../models/User');
const { uploadToCloudinary, deleteUploadedFile } = require('../utils/uploadFileUtils');
const DEFAULT_COUNTRY = 'Pakistan';
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

const publicScholarshipQuery = {
    $or: [
        { isActive: true },
        { isActive: { $exists: false } },
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

const cleanLooseString = (value) => {
    if (typeof value !== 'string') return value;
    return value.replace(/'\s*\+\s*'/g, '').replace(/\\n/g, '\n').trim();
};

const tryParseLooseJSON = (value) => {
    if (typeof value !== 'string') return null;
    const cleaned = cleanLooseString(value);
    if (!cleaned || (!cleaned.includes('{') && !cleaned.includes('[')) || !cleaned.includes(':')) {
        return null;
    }
    const fixed = cleaned
        .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":')
        .replace(/'/g, '"');
    try {
        return JSON.parse(fixed);
    } catch {
        return null;
    }
};

const extractProgramFromString = (value) => {
    if (typeof value !== 'string') return null;
    const nameMatch = /name\s*[:=]\s*['"]([^'"]+)['"]/i.exec(value);
    const typeMatch = /type\s*[:=]\s*['"]([^'"]+)['"]/i.exec(value);
    const durationMatch = /duration\s*[:=]\s*['"]([^'"]+)['"]/i.exec(value);
    if (!nameMatch && !typeMatch && !durationMatch) return null;
    return {
        name: nameMatch?.[1] || '',
        type: typeMatch?.[1] || '',
        duration: durationMatch?.[1] || '',
    };
};

// The Scholarship schema uses structured program objects: { name, type, duration }
// Always store full program objects, never name-only strings.

const normalizeScholarshipPayload = (payload = {}) => {
    const normalized = {};

    // Basic Fields
    if (payload.title) normalized.title = payload.title.toString().trim();
    if (payload.description) normalized.description = payload.description.toString().trim();
    if (payload.country) normalized.country = payload.country.toString().trim();
    if (payload.state) normalized.state = payload.state.toString().trim();
    if (payload.city) normalized.city = payload.city.toString().trim();
    if (payload.address) normalized.address = payload.address.toString().trim();
    if (payload.currency) normalized.currency = payload.currency.toString().trim();
    if (payload.type) normalized.type = payload.type.toString().trim();
    if (payload.duration) normalized.duration = payload.duration.toString().trim();
    if (payload.amount) normalized.amount = payload.amount.toString().trim();
    if (payload.provider) normalized.provider = payload.provider.toString().trim();
    if (payload.website) normalized.website = payload.website.toString().trim();
    if (payload.testDate) normalized.testDate = payload.testDate.toString().trim();
    if (payload.interviewDate) normalized.interviewDate = payload.interviewDate.toString().trim();
    if (payload.deadline) normalized.deadline = payload.deadline.toString().trim();
    if (payload.contact) normalized.contact = payload.contact.toString().trim();
    if (payload.thumbnail) normalized.thumbnail = payload.thumbnail;
    if (payload.image) normalized.image = payload.image;

    // Complex Fields (JSON or Arrays)
    const coverage = tryParseJSON(payload.coverage, []);
    normalized.coverage = Array.isArray(coverage) ? coverage : [];

    // --- Programs normalization (simplified & battle-tested) ---
    let rawPrograms = payload.programs;

    // If sent as a JSON string, parse it first
    if (typeof rawPrograms === 'string') {
        rawPrograms = tryParseJSON(rawPrograms, []);
    }

    // Ensure we have an array
    const programs = Array.isArray(rawPrograms)
        ? rawPrograms
        : (rawPrograms && typeof rawPrograms === 'object' ? [rawPrograms] : []);

    normalized.programs = programs.map((p) => {
        // Already a clean object from the admin panel
        if (p && typeof p === 'object' && !Array.isArray(p)) {
            const name = (p.name || p.programName || '').toString().trim();
            return {
                name,
                type: (p.type || p.programType || p.level || '').toString().trim(),
                duration: (p.duration || '').toString().trim(),
            };
        }

        // Handle string entries (legacy or edge cases)
        if (typeof p === 'string') {
            const parsed = tryParseLooseJSON(p);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return {
                    name: (parsed.name || parsed.programName || '').toString().trim(),
                    type: (parsed.type || parsed.programType || parsed.level || '').toString().trim(),
                    duration: (parsed.duration || '').toString().trim(),
                };
            }
            const extracted = extractProgramFromString(p);
            if (extracted) {
                return {
                    name: (extracted.name || '').toString().trim(),
                    type: (extracted.type || '').toString().trim(),
                    duration: (extracted.duration || '').toString().trim(),
                };
            }
            // Plain string name
            const name = p.trim();
            if (name) {
                return { name, type: '', duration: '' };
            }
        }

        return null;
    }).filter((p) => p && p.name);

    const linkedUniversities = tryParseJSON(payload.linkedUniversities, []);
    normalized.linkedUniversities = Array.isArray(linkedUniversities) ? linkedUniversities : [];

    const applicationSteps = tryParseJSON(payload.applicationSteps, []);
    normalized.applicationSteps = Array.isArray(applicationSteps) ? applicationSteps : [];

    const eligibility = tryParseJSON(payload.eligibility, {});
    normalized.eligibility = {
        minPercentage: eligibility?.minPercentage ? Number(eligibility.minPercentage) : undefined,
        minGrade: eligibility?.minGrade?.toString() || '',
        description: eligibility?.description?.toString() || '',
    };

    normalized.contactInfo = normalizeContactInfo(payload.contactInfo);

    if (typeof payload.isActive !== 'undefined') {
        normalized.isActive = toBoolean(payload.isActive, true);
    }

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

        if (payload.thumbnail && payload.thumbnail.startsWith('data:')) {
            payload.thumbnail = await uploadToCloudinary(payload.thumbnail, [payload.title, 'thumbnail']);
            if (!payload.thumbnail) {
                throw new Error('Failed to upload scholarship thumbnail');
            }
        }
        if (payload.image && payload.image.startsWith('data:')) {
            payload.image = await uploadToCloudinary(payload.image, [payload.title, 'image']);
            if (!payload.image) {
                throw new Error('Failed to upload scholarship image');
            }
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

        if (payload.thumbnail && payload.thumbnail.startsWith('data:')) {
            payload.thumbnail = await uploadToCloudinary(payload.thumbnail, [payload.title || scholarship.title, 'thumbnail']);
            if (!payload.thumbnail) {
                throw new Error('Failed to upload scholarship thumbnail');
            }
        }
        if (payload.image && payload.image.startsWith('data:')) {
            payload.image = await uploadToCloudinary(payload.image, [payload.title || scholarship.title, 'image']);
            if (!payload.image) {
                throw new Error('Failed to upload scholarship image');
            }
        }

        const previousThumbnail = scholarship.thumbnail || '';
        const previousImage = scholarship.image || '';
        const updatedScholarship = await Scholarship.findByIdAndUpdate(req.params.id, payload, {
            new: true,
            runValidators: true,
        });

        if (previousThumbnail && payload.thumbnail && previousThumbnail !== payload.thumbnail) {
            await deleteUploadedFile(previousThumbnail);
        }
        if (previousImage && payload.image && previousImage !== payload.image) {
            await deleteUploadedFile(previousImage);
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
        const { password, name } = req.body;
        const email = normalizeEmail(req.body.email);

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
