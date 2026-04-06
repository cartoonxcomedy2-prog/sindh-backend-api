const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Application = require('../models/Application');
const University = require('../models/University');
const Scholarship = require('../models/Scholarship');
const {
    deleteUploadedFile,
    uploadToCloudinary,
} = require('../utils/uploadFileUtils');

const DEFAULT_COUNTRY = 'Pakistan';

const PROFILE_FIELDS = [
    'name',
    'email',
    'role',
    'phone',
    'countryCode',
    'country',
    'age',
    'fatherName',
    'address',
    'state',
    'city',
    'dateOfBirth',
    'avatar',
    'education',
    'notifications',
    'isActive',
    'createdAt',
    'updatedAt',
];

const EDUCATION_FILE_FIELD_MAP = {
    idFile: ['nationalId', 'file'],
    matricTranscript: ['matric', 'transcript'],
    matricCertificate: ['matric', 'certificate'],
    interTranscript: ['intermediate', 'transcript'],
    interCertificate: ['intermediate', 'certificate'],
    bachTranscript: ['bachelor', 'transcript'],
    bachCertificate: ['bachelor', 'certificate'],
    masterTranscript: ['masters', 'transcript'],
    masterCertificate: ['masters', 'certificate'],
    passportPdf: ['international', 'passportPdf'],
    testTranscript: ['international', 'testTranscript'],
    cv: ['international', 'cv'],
    recommendationLetter: ['international', 'recommendationLetter'],
    fatherCnicFile: ['personalInfo', 'fatherCnicFile'],
};

const EDUCATION_FILE_LABEL_MAP = {
    idFile: 'national-id',
    matricTranscript: 'matric-transcript',
    matricCertificate: 'matric-certificate',
    interTranscript: 'intermediate-transcript',
    interCertificate: 'intermediate-certificate',
    bachTranscript: 'bachelor-transcript',
    bachCertificate: 'bachelor-certificate',
    masterTranscript: 'masters-transcript',
    masterCertificate: 'masters-certificate',
    passportPdf: 'passport',
    testTranscript: 'english-test-transcript',
    cv: 'curriculum-vitae',
    recommendationLetter: 'recommendation-letter',
    fatherCnicFile: 'father-cnic',
};

const EDUCATION_DOWNLOAD_FIELD_MAP = {
    nationalId: new Set(['file']),
    matric: new Set(['transcript', 'certificate']),
    intermediate: new Set(['transcript', 'certificate']),
    bachelor: new Set(['transcript', 'certificate']),
    masters: new Set(['transcript', 'certificate']),
    phd: new Set(['transcript', 'certificate']),
    international: new Set([
        'passportPdf',
        'testTranscript',
        'cv',
        'recommendationLetter',
    ]),
};

const EDUCATION_FILE_PATHS = Object.values(EDUCATION_FILE_FIELD_MAP).map((parts) =>
    parts.join('.')
);

const REMINDER_CHECK_COOLDOWN_MS = 10 * 60 * 1000;
const reminderLastCheckedAt = new Map();
const NOTIFICATION_RETENTION_DAYS = 21;
const NOTIFICATION_RETENTION_MS = NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const parseDeadlineDate = (rawDate) => {
    if (!rawDate) return null;
    const parsed = new Date(rawDate);
    if (Number.isNaN(parsed.getTime())) return null;
    parsed.setHours(23, 59, 59, 999);
    return parsed;
};

const formatReminderDeadline = (date) =>
    date.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
    });

const buildReminderTitle = (daysRemaining) => {
    if (daysRemaining <= 0) return 'Deadline Today';
    if (daysRemaining === 1) return 'Deadline Tomorrow';
    return 'Deadline in 2 Days';
};

const buildReminderBody = (entityName, dateLabel) =>
    `Apply now for ${entityName}. Deadline is ${dateLabel}. Don't miss this opportunity.`;

const filterNotificationsByRetention = (notifications = []) => {
    const cutoff = Date.now() - NOTIFICATION_RETENTION_MS;
    return (notifications || []).filter((item) => {
        const created = new Date(item?.createdAt || 0).getTime();
        if (!Number.isFinite(created) || created <= 0) return true;
        return created >= cutoff;
    });
};

const pruneOldNotificationsInDoc = (userDoc) => {
    const current = Array.isArray(userDoc?.notifications) ? userDoc.notifications : [];
    const trimmed = filterNotificationsByRetention(current);
    const changed = trimmed.length !== current.length;
    if (changed) {
        userDoc.notifications = trimmed;
    }
    return changed;
};

const ensureDeadlineRemindersForUser = async (userInput, options = {}) => {
    if (!userInput?._id) return userInput;

    const { force = false } = options;
    const userId = String(userInput._id);
    const now = Date.now();
    const lastCheckedAt = reminderLastCheckedAt.get(userId) || 0;

    if (!force && now - lastCheckedAt < REMINDER_CHECK_COOLDOWN_MS) {
        return userInput;
    }

    reminderLastCheckedAt.set(userId, now);

    const user =
        typeof userInput.save === 'function'
            ? userInput
            : await User.findById(userId).select('notifications');

    if (!user) return userInput;

    let notifications = Array.isArray(user.notifications) ? [...user.notifications] : [];
    const notificationsBeforeTrim = notifications.length;
    notifications = filterNotificationsByRetention(notifications);
    const notificationsTrimmed = notifications.length !== notificationsBeforeTrim;
    if (notificationsTrimmed) {
        user.notifications = notifications;
    }
    const existingReminderKeys = new Set(
        notifications
            .map((item) => item?.data?.reminderKey)
            .filter((key) => typeof key === 'string' && key.trim())
    );

    const apps = await Application.find({ user: user._id })
        .select('university scholarship')
        .lean();

    const appliedUniversityIds = new Set(
        apps
            .map((app) => app?.university)
            .filter(Boolean)
            .map((id) => String(id))
    );
    const appliedScholarshipIds = new Set(
        apps
            .map((app) => app?.scholarship)
            .filter(Boolean)
            .map((id) => String(id))
    );

    const [universities, scholarships] = await Promise.all([
        University.find({
            isActive: true,
            deadline: { $exists: true, $nin: ['', null] },
        })
            .select('_id name deadline thumbnail logo')
            .lean(),
        Scholarship.find({
            isActive: true,
            deadline: { $exists: true, $nin: ['', null] },
        })
            .select('_id title deadline thumbnail image')
            .lean(),
    ]);

    const nowDate = new Date();
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const generated = [];

    for (const uni of universities) {
        const uniId = String(uni._id);
        if (appliedUniversityIds.has(uniId)) continue;

        const deadlineDate = parseDeadlineDate(uni.deadline);
        if (!deadlineDate) continue;

        const daysRemaining = Math.ceil(
            (deadlineDate.getTime() - nowDate.getTime()) / MS_PER_DAY
        );
        if (daysRemaining < 0 || daysRemaining > 2) continue;

        const deadlineKey = deadlineDate.toISOString().slice(0, 10);
        const reminderKey = `deadline-university-${uniId}-${deadlineKey}`;
        if (existingReminderKeys.has(reminderKey)) continue;

        const formattedDate = formatReminderDeadline(deadlineDate);
        generated.push({
            title: buildReminderTitle(daysRemaining),
            body: buildReminderBody(uni.name || 'this university', formattedDate),
            type: 'deadline-reminder',
            entityType: 'university',
            entityId: uniId,
            entityName: uni.name || 'University',
            entityThumbnail: uni.thumbnail || uni.logo || '',
            isRead: false,
            createdAt: new Date(),
            data: {
                type: 'deadline-reminder',
                entityType: 'university',
                entityId: uniId,
                entityName: uni.name || 'University',
                status: 'Closing Soon',
                deadline: uni.deadline,
                reminderKey,
            },
        });
        existingReminderKeys.add(reminderKey);
    }

    for (const scholarship of scholarships) {
        const scholarshipId = String(scholarship._id);
        if (appliedScholarshipIds.has(scholarshipId)) continue;

        const deadlineDate = parseDeadlineDate(scholarship.deadline);
        if (!deadlineDate) continue;

        const daysRemaining = Math.ceil(
            (deadlineDate.getTime() - nowDate.getTime()) / MS_PER_DAY
        );
        if (daysRemaining < 0 || daysRemaining > 2) continue;

        const deadlineKey = deadlineDate.toISOString().slice(0, 10);
        const reminderKey = `deadline-scholarship-${scholarshipId}-${deadlineKey}`;
        if (existingReminderKeys.has(reminderKey)) continue;

        const formattedDate = formatReminderDeadline(deadlineDate);
        generated.push({
            title: buildReminderTitle(daysRemaining),
            body: buildReminderBody(scholarship.title || 'this scholarship', formattedDate),
            type: 'deadline-reminder',
            entityType: 'scholarship',
            entityId: scholarshipId,
            entityName: scholarship.title || 'Scholarship',
            entityThumbnail: scholarship.thumbnail || scholarship.image || '',
            isRead: false,
            createdAt: new Date(),
            data: {
                type: 'deadline-reminder',
                entityType: 'scholarship',
                entityId: scholarshipId,
                entityName: scholarship.title || 'Scholarship',
                status: 'Closing Soon',
                deadline: scholarship.deadline,
                reminderKey,
            },
        });
        existingReminderKeys.add(reminderKey);
    }

    if (generated.length === 0) {
        if (notificationsTrimmed) {
            await user.save();
        }
        return userInput;
    }

    const mergedNotifications = [...generated, ...notifications]
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, 200);

    user.notifications = mergedNotifications;
    await user.save();

    if (typeof userInput === 'object' && userInput !== null) {
        userInput.notifications = mergedNotifications;
    }

    return userInput;
};

const generateToken = (id) =>
    jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: '30d',
    });

const parsePossibleJSON = (value, fallback = null) => {
    if (value == null) return fallback;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};

const normalizePhone = (value) =>
    String(value || '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/-/g, '');

const setNested = (obj, path, value) => {
    let current = obj;
    for (let i = 0; i < path.length - 1; i += 1) {
        if (!current[path[i]] || typeof current[path[i]] !== 'object') {
            current[path[i]] = {};
        }
        current = current[path[i]];
    }
    current[path[path.length - 1]] = value;
};

const getNested = (obj, path = []) => {
    let current = obj;
    for (const key of path) {
        if (!current || typeof current !== 'object') return undefined;
        current = current[key];
    }
    return current;
};

const removeReplacedEducationFiles = async (previous = {}, next = {}) => {
    const currentFiles = new Set(
        EDUCATION_FILE_PATHS.map((dotPath) =>
            dotPath.split('.').reduce((acc, part) => acc?.[part], next)
        ).filter((value) => typeof value === 'string' && value.trim())
    );

    for (const dotPath of EDUCATION_FILE_PATHS) {
        const parts = dotPath.split('.');
        const oldFile = parts.reduce((acc, part) => acc?.[part], previous);
        const nextFile = parts.reduce((acc, part) => acc?.[part], next);
        if (
            typeof oldFile === 'string' &&
            oldFile.trim() &&
            oldFile !== nextFile &&
            !currentFiles.has(oldFile)
        ) {
            await deleteUploadedFile(oldFile);
        }
    }
};

const toResponseUser = async (userDoc, withApplications = false) => {
    const user = userDoc.toObject ? userDoc.toObject() : { ...userDoc };
    delete user.password;

    const filteredUser = { _id: user._id };
    PROFILE_FIELDS.forEach((field) => {
        if (typeof user[field] !== 'undefined') {
            filteredUser[field] = user[field];
        }
    });

    if (!Array.isArray(filteredUser.notifications)) {
        filteredUser.notifications = [];
    }

    filteredUser.country = filteredUser.country || DEFAULT_COUNTRY;
    const personalInfo = filteredUser.education?.personalInfo || {};
    if (!filteredUser.fatherName && personalInfo.fatherName) {
        filteredUser.fatherName = personalInfo.fatherName;
    }
    if (!filteredUser.phone && personalInfo.contactNumber) {
        filteredUser.phone = personalInfo.contactNumber;
    }
    if (!filteredUser.dateOfBirth && personalInfo.dateOfBirth) {
        filteredUser.dateOfBirth = personalInfo.dateOfBirth;
    }

    filteredUser.notifications = filterNotificationsByRetention(
        filteredUser.notifications
    ).sort(
        (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );

    if (withApplications) {
        filteredUser.applications = await Application.find({ user: user._id })
            .populate('university')
            .populate('scholarship')
            .populate('offeredUniversities.university')
            .sort('-appliedAt')
            .lean();
    }

    return filteredUser;
};

const upsertEducationFromPayload = (user, educationPayload) => {
    if (!educationPayload || typeof educationPayload !== 'object') return;
    const base = user.education && typeof user.education === 'object' ? user.education : {};

    user.education = {
        ...base,
        ...educationPayload,
        personalInfo: {
            ...(base.personalInfo || {}),
            ...(educationPayload.personalInfo || {}),
        },
        nationalId: {
            ...(base.nationalId || {}),
            ...(educationPayload.nationalId || {}),
        },
        matric: {
            ...(base.matric || {}),
            ...(educationPayload.matric || {}),
        },
        intermediate: {
            ...(base.intermediate || {}),
            ...(educationPayload.intermediate || {}),
        },
        bachelor: {
            ...(base.bachelor || {}),
            ...(educationPayload.bachelor || {}),
        },
        masters: {
            ...(base.masters || {}),
            ...(educationPayload.masters || {}),
        },
        international: {
            ...(base.international || {}),
            ...(educationPayload.international || {}),
        },
    };

    if (!user.education.nationalId) user.education.nationalId = {};
    user.education.nationalId.country = DEFAULT_COUNTRY;
};

const assignEducationFiles = async (user, files = []) => {
    if (!files || !files.length) return;
    const education = user.education && typeof user.education === 'object' ? { ...user.education } : {};

    for (const file of files) {
        const pathParts = EDUCATION_FILE_FIELD_MAP[file.fieldname];
        if (!pathParts) continue;
        const previousFile = getNested(education, pathParts);
        const fileLabel = EDUCATION_FILE_LABEL_MAP[file.fieldname] || file.fieldname;
        
        const renamed = await uploadToCloudinary(file.path, [
            user?.name || 'applicant',
            'education',
            fileLabel,
        ]);
        
        setNested(education, pathParts, renamed);
        if (previousFile && previousFile !== renamed) {
            await deleteUploadedFile(previousFile);
        }
    }

    user.education = education;
};

// @desc    Auth user & get token
// @route   POST /api/users/login
const authUser = async (req, res) => {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select('+password');

    if (user && (await user.matchPassword(password))) {
        await ensureDeadlineRemindersForUser(user);
        const userResponse = await toResponseUser(user, true);
        return res.json({
            ...userResponse,
            token: generateToken(user._id),
        });
    }

    return res.status(401).json({ message: 'Invalid email or password' });
};

// @desc    Register a new user
// @route   POST /api/users
const registerUser = async (req, res) => {
    const userExists = await User.findOne({ email: req.body.email });

    if (userExists) {
        return res.status(400).json({ message: 'User already exists' });
    }

    const normalizedPhone = normalizePhone(req.body.phone);
    if (normalizedPhone) {
        const phoneExists = await User.findOne({ phone: normalizedPhone });
        if (phoneExists) {
            return res.status(400).json({ message: 'Mobile number already exists' });
        }
    }

    const payload = {
        name: req.body.name,
        email: req.body.email,
        password: req.body.password,
        phone: normalizedPhone || undefined,
        country: DEFAULT_COUNTRY,
        role: 'user',
    };

    const user = await User.create(payload);

    if (!user) {
        return res.status(400).json({ message: 'Invalid user data' });
    }

    const userResponse = await toResponseUser(user, true);
    return res.status(201).json({
        ...userResponse,
        token: generateToken(user._id),
    });
};

// @desc    Get user profile with applications
// @route   GET /api/users/profile
const getUserProfile = async (req, res) => {
    const user = await User.findById(req.user._id);
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    await ensureDeadlineRemindersForUser(user);
    const userResponse = await toResponseUser(user, true);
    return res.json(userResponse);
};

// @desc    Update own profile
// @route   PUT /api/users/profile
const updateUserProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('+password');

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        const previousEducation =
            user.education && typeof user.education === 'object'
                ? JSON.parse(JSON.stringify(user.education))
                : {};

        const {
            name,
            email,
            password,
            fatherName,
            dateOfBirth,
            phone,
            age,
            city,
            state,
            address,
            avatar,
        } = req.body;

        if (email && email !== user.email) {
            const emailTaken = await User.findOne({ email, _id: { $ne: user._id } });
            if (emailTaken) {
                return res.status(400).json({ message: 'Email already in use' });
            }
            user.email = email;
        }

        const normalizedPhone = typeof phone === 'string' ? normalizePhone(phone) : null;
        if (normalizedPhone !== null) {
            if (normalizedPhone) {
                const phoneTaken = await User.findOne({
                    _id: { $ne: user._id },
                    phone: normalizedPhone,
                });
                if (phoneTaken) {
                    return res.status(400).json({ message: 'Mobile number already exists' });
                }
            }
            user.phone = normalizedPhone;
        }

        if (typeof name === 'string') user.name = name;
        if (typeof city === 'string') user.city = city;
        if (typeof state === 'string') user.state = state;
        if (typeof address === 'string') user.address = address;
        if (typeof avatar === 'string' && avatar.trim()) {
            if (avatar.startsWith('data:')) {
                const oldAvatar = user.avatar;
                user.avatar = await uploadToCloudinary(avatar, [user.name, 'avatar']);
                if (oldAvatar && user.avatar !== oldAvatar) {
                    await deleteUploadedFile(oldAvatar);
                }
            } else {
                user.avatar = avatar;
            }
        }
        if (typeof age !== 'undefined') user.age = age;
        user.country = DEFAULT_COUNTRY;

        if (typeof password === 'string' && password.trim()) {
            user.password = password.trim();
        }

        const educationPayload = parsePossibleJSON(req.body.education, req.body.education);
        upsertEducationFromPayload(user, educationPayload);

        if (!user.education || typeof user.education !== 'object') user.education = {};
        if (!user.education.personalInfo || typeof user.education.personalInfo !== 'object') {
            user.education.personalInfo = {};
        }

        if (typeof fatherName === 'string') {
            user.fatherName = fatherName;
            user.education.personalInfo.fatherName = fatherName;
        }
        if (typeof dateOfBirth === 'string') {
            user.dateOfBirth = dateOfBirth;
            user.education.personalInfo.dateOfBirth = dateOfBirth;
        }
        if (typeof phone === 'string') {
            user.education.personalInfo.contactNumber = normalizePhone(phone);
        }
        if (typeof user.education.nationalId?.idNumber === 'string' && user.education.nationalId.idNumber.trim()) {
            user.education.personalInfo.cnicNumber = user.education.nationalId.idNumber;
        }
        if (!user.education.nationalId || typeof user.education.nationalId !== 'object') {
            user.education.nationalId = {};
        }
        user.education.nationalId.country = DEFAULT_COUNTRY;

        await assignEducationFiles(user, req.files || []);
        await removeReplacedEducationFiles(previousEducation, user.education || {});

        await user.save();

        const userResponse = await toResponseUser(user, false);
        return res.json(userResponse);
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
};

// @desc    Get all users (admin panel)
// @route   GET /api/users
// @access  Private/Admin
const getUsers = async (_req, res) => {
    try {
        const users = await User.find({ role: 'user' }).sort({ createdAt: -1 });
        const payload = users.map((u) => {
            const plain = u.toObject();
            delete plain.password;
            return plain;
        });
        res.json({ data: payload });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get single user by id (admin)
// @route   GET /api/users/:id
const getUserById = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const userResponse = await toResponseUser(user, false);
        return res.json({ data: userResponse });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// @desc    Update user profile by admin
// @route   PUT /api/users/:id/profile
// @access  Private/Admin
const updateUserByAdmin = async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('+password');

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const {
            name,
            email,
            password,
            fatherName,
            dateOfBirth,
            phone,
            age,
            city,
            state,
            address,
            isActive,
            avatar,
        } = req.body;

        if (email && email !== user.email) {
            const emailTaken = await User.findOne({ email, _id: { $ne: user._id } });
            if (emailTaken) {
                return res.status(400).json({ message: 'Email already in use' });
            }
            user.email = email;
        }

        const normalizedPhone = typeof phone === 'string' ? normalizePhone(phone) : null;
        if (normalizedPhone !== null) {
            if (normalizedPhone) {
                const phoneTaken = await User.findOne({
                    _id: { $ne: user._id },
                    phone: normalizedPhone,
                });
                if (phoneTaken) {
                    return res.status(400).json({ message: 'Mobile number already exists' });
                }
            }
            user.phone = normalizedPhone;
        }

        if (typeof name === 'string') user.name = name;
        if (typeof city === 'string') user.city = city;
        if (typeof state === 'string') user.state = state;
        if (typeof address === 'string') user.address = address;
        if (typeof avatar === 'string' && avatar.trim()) {
            if (avatar.startsWith('data:')) {
                const oldAvatar = user.avatar;
                user.avatar = await uploadToCloudinary(avatar, [user.name, 'avatar']);
                if (oldAvatar && user.avatar !== oldAvatar) {
                    await deleteUploadedFile(oldAvatar);
                }
            } else {
                user.avatar = avatar;
            }
        }

        if (typeof age !== 'undefined') user.age = age;
        if (typeof isActive === 'boolean') user.isActive = isActive;
        user.country = DEFAULT_COUNTRY;

        if (typeof password === 'string' && password.trim()) {
            user.password = password.trim();
        }

        if (!user.education || typeof user.education !== 'object') user.education = {};
        if (!user.education.personalInfo || typeof user.education.personalInfo !== 'object') {
            user.education.personalInfo = {};
        }
        if (!user.education.nationalId || typeof user.education.nationalId !== 'object') {
            user.education.nationalId = {};
        }
        user.education.nationalId.country = DEFAULT_COUNTRY;

        if (typeof fatherName === 'string') {
            user.fatherName = fatherName;
            user.education.personalInfo.fatherName = fatherName;
        }
        if (typeof dateOfBirth === 'string') {
            user.dateOfBirth = dateOfBirth;
            user.education.personalInfo.dateOfBirth = dateOfBirth;
        }
        if (typeof phone === 'string') {
            user.education.personalInfo.contactNumber = normalizePhone(phone);
        }

        await user.save();

        const userResponse = await toResponseUser(user, false);
        return res.json({ data: userResponse });
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
};

// @desc    Update user education by admin (or owner)
// @route   PUT /api/users/:id/education
const updateUserEducation = async (req, res) => {
    try {
        if (req.user.role !== 'admin' && String(req.user._id) !== String(req.params.id)) {
            return res.status(403).json({ message: 'Unauthorized' });
        }

        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const section = req.body.section;
        const field = req.body.field;
        const file = Array.isArray(req.files) && req.files.length > 0 ? req.files[0] : null;

        if (!section || !field || !file) {
            return res.status(400).json({ message: 'section, field and file are required' });
        }

        const education = user.education && typeof user.education === 'object' ? { ...user.education } : {};
        if (!education[section] || typeof education[section] !== 'object') {
            education[section] = {};
        }
        const previousFile = education[section][field];
        const renameLabel = EDUCATION_FILE_LABEL_MAP[file.fieldname] || field;
        const renamed = await uploadToCloudinary(file.path, [
            user?.name || 'applicant',
            section,
            renameLabel,
        ]);
        education[section][field] = renamed;
        user.education = education;

        if (previousFile && previousFile !== renamed) {
            await deleteUploadedFile(previousFile);
        }
        await user.save();

        const userResponse = await toResponseUser(user, false);
        return res.json({ data: userResponse });
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
};

// @desc    Download user education file
// @route   GET /api/users/:id/education/:section/:field/download
const downloadUserEducationFile = async (req, res) => {
    try {
        if (req.user.role !== 'admin' && String(req.user._id) !== String(req.params.id)) {
            return res.status(403).json({ message: 'Unauthorized' });
        }

        const section = String(req.params.section || '').trim();
        const field = String(req.params.field || '').trim();
        const allowedFields = EDUCATION_DOWNLOAD_FIELD_MAP[section];
        if (!allowedFields || !allowedFields.has(field)) {
            return res.status(400).json({ message: 'Invalid education file path' });
        }

        const user = await User.findById(req.params.id).select('name education').lean();
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const filename = user?.education?.[section]?.[field];
        if (typeof filename !== 'string' || !filename.trim()) {
            return res.status(404).json({ message: 'Document not found' });
        }

        const safeName = path.basename(filename.trim());
        const filePath = path.join(__dirname, '..', 'uploads', safeName);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ message: 'File does not exist on server' });
        }

        const requestedName = path.basename(
            String(req.query.downloadName || '').trim()
        );
        const ext = path.extname(safeName) || '.pdf';
        const fallbackName = `${String(user.name || 'applicant')
            .trim()
            .replace(/\s+/g, '-')
            .toLowerCase()}-${section}-${field}${ext}`;

        return res.download(filePath, requestedName || fallbackName);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// @desc    Delete user education field by admin (or owner)
// @route   DELETE /api/users/:id/education/:section/:field
const deleteUserEducationField = async (req, res) => {
    try {
        if (req.user.role !== 'admin' && String(req.user._id) !== String(req.params.id)) {
            return res.status(403).json({ message: 'Unauthorized' });
        }

        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const { section, field } = req.params;
        const education = user.education && typeof user.education === 'object' ? { ...user.education } : {};

        if (education[section] && typeof education[section] === 'object') {
            const previousFile = education[section][field];
            delete education[section][field];
            if (previousFile) {
                deleteUploadedFile(previousFile);
            }
        }

        user.education = education;
        await user.save();

        const userResponse = await toResponseUser(user, false);
        return res.json({ data: userResponse });
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
};

// @desc    Get current user notifications
// @route   GET /api/users/notifications
const getUserNotifications = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('notifications');
        if (!user) return res.status(404).json({ message: 'User not found' });

        const pruned = pruneOldNotificationsInDoc(user);
        if (pruned) {
            await user.save();
        }

        await ensureDeadlineRemindersForUser(user);
        const notifications = (user.notifications || []).sort(
            (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        );

        return res.json({ data: notifications });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// @desc    Mark all notifications as read
// @route   PUT /api/users/notifications/read
const markAllNotificationsAsRead = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        pruneOldNotificationsInDoc(user);
        user.notifications = (user.notifications || []).map((item) => {
            const plain = item && typeof item.toObject === 'function' ? item.toObject() : { ...item };
            return {
                ...plain,
                isRead: true,
            };
        });
        await user.save();

        return res.json({ message: 'Notifications marked as read' });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// @desc    Delete user by admin
// @route   DELETE /api/users/:id
// @access  Private/Admin
const deleteUserByAdmin = async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('education').lean();
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const educationFiles = EDUCATION_FILE_PATHS.map((dotPath) =>
            dotPath.split('.').reduce((acc, part) => acc?.[part], user.education)
        ).filter((value) => typeof value === 'string' && value.trim());

        const applications = await Application.find({ user: req.params.id })
            .select('admitCard offerLetter offeredUniversities')
            .lean();

        const applicationFiles = applications.flatMap((app) => [
            app?.admitCard,
            app?.offerLetter,
            ...(app?.offeredUniversities || []).flatMap((entry) => [
                entry?.admitCard,
                entry?.offerLetter,
            ]),
        ]).filter((value) => typeof value === 'string' && value.trim());

        await Application.deleteMany({ user: req.params.id });
        await User.findByIdAndDelete(req.params.id);

        const filesToDelete = [...new Set([...educationFiles, ...applicationFiles])];
        for (const file of filesToDelete) {
            await deleteUploadedFile(file);
        }

        return res.json({ message: 'User deleted successfully' });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

module.exports = {
    authUser,
    registerUser,
    getUserProfile,
    updateUserProfile,
    getUsers,
    getUserById,
    updateUserByAdmin,
    updateUserEducation,
    deleteUserEducationField,
    downloadUserEducationFile,
    getUserNotifications,
    markAllNotificationsAsRead,
    deleteUserByAdmin,
};
