const archiver = require('archiver');
const path = require('path');
const Application = require('../models/Application');
const University = require('../models/University');
const Scholarship = require('../models/Scholarship');
const User = require('../models/User');
const {
    deleteUploadedFile,
    downloadStoredFile,
    normalizeDownloadName,
    prepareStoredFileBufferForDownload,
    uploadToCloudinary,
} = require('../utils/uploadFileUtils');
const { enqueueJob } = require('../utils/jobQueue');
const { invalidateCacheByTags } = require('../middleware/responseCache');
const { generateApplicationSummaryPdf } = require('../utils/pdfGenerator');
const { evaluateOpportunityForUser } = require('../utils/eligibilityUtils');

const APPLICATION_STATUSES = ['Applied', 'Admit Card', 'Test', 'Interview', 'Selected', 'Rejected'];
const APPLICATION_UPDATE_FIELDS = new Set([
    'status',
    'selectedPrograms',
    'testDate',
    'interviewDate',
    'admitCard',
    'offerLetter',
    'offeredUniversities',
]);

const parsePossibleJSON = (value, fallback = null) => {
    if (value == null) return fallback;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};

const toObjectIdString = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value._id) return String(value._id);
    return String(value);
};

const toPositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
};

const escapeRegex = (value) =>
    String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseStartDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    date.setHours(0, 0, 0, 0);
    return date;
};

const parseEndDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    date.setHours(23, 59, 59, 999);
    return date;
};

const toPagination = (query = {}, options = {}) => {
    const defaultPage = toPositiveInt(options.defaultPage, 1);
    const defaultLimit = toPositiveInt(options.defaultLimit, 50);
    const maxLimit = toPositiveInt(options.maxLimit, 200);

    const page = toPositiveInt(query.page, defaultPage);
    const requestedLimit = toPositiveInt(query.limit, defaultLimit);
    const limit = Math.min(requestedLimit, maxLimit);

    return {
        page,
        limit,
        skip: (page - 1) * limit,
    };
};

const normalizeApplicationTypeFilter = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return '';
    if (normalized === 'university') return 'University';
    if (normalized === 'scholarship') return 'Scholarship';
    return '';
};

const buildApplicationListQuery = async (baseQuery = {}, requestQuery = {}) => {
    const query = { ...baseQuery };
    const includeEligibleParam = requestQuery.includeEligible;
    const includeEligible =
        includeEligibleParam == null || includeEligibleParam === ''
            ? true
            : toBooleanFlag(includeEligibleParam, true);
    const status = String(requestQuery.status || '').trim();
    const typeFilter = normalizeApplicationTypeFilter(
        requestQuery.applicationType || requestQuery.type
    );
    const programFilter = String(
        requestQuery.program || requestQuery.level || ''
    ).trim();
    const stateFilter = String(requestQuery.state || '').trim();
    const cityFilter = String(requestQuery.city || '').trim();
    const search = String(requestQuery.search || '').trim();
    const userId = String(requestQuery.userId || requestQuery.user || '').trim();
    const startDate = parseStartDate(requestQuery.startDate);
    const endDate = parseEndDate(requestQuery.endDate);

    if (userId) {
        query.user = userId;
    }

    if (status && APPLICATION_STATUSES.includes(status)) {
        query.status = status;
    }
    if (typeFilter) {
        query.type = typeFilter;
    }
    if (programFilter) {
        query['selectedPrograms.programName'] = new RegExp(
            escapeRegex(programFilter),
            'i'
        );
    }
    if (startDate || endDate) {
        query.appliedAt = {};
        if (startDate) query.appliedAt.$gte = startDate;
        if (endDate) query.appliedAt.$lte = endDate;
    }
    if (!includeEligible) {
        query.isReapplyEligible = { $ne: true };
    }

    if (search || stateFilter || cityFilter) {
        const userQuery = { role: 'user' };
        if (search) {
            const pattern = new RegExp(escapeRegex(search), 'i');
            userQuery.$or = [
                { name: pattern },
                { email: pattern },
                { phone: pattern },
            ];
        }
        if (stateFilter) userQuery.state = stateFilter;
        if (cityFilter) userQuery.city = cityFilter;

        const maxSearchUsers = Math.min(
            toPositiveInt(requestQuery.maxSearchUsers, 10000),
            50000
        );
        const userIds = await User.find(userQuery)
            .sort({ _id: -1 })
            .limit(maxSearchUsers)
            .distinct('_id');
        if (userIds.length === 0) {
            query.user = { $in: [] };
            return query;
        }
        query.user = { $in: userIds };
    }

    return query;
};

const buildInstitutionAdminQuery = (user) => {
    const userId = toObjectIdString(user?._id);
    const email = String(user?.email || '')
        .trim()
        .toLowerCase();
    const or = [];
    if (userId) {
        or.push({ 'adminAccount.userId': userId });
    }
    if (email) {
        or.push({
            'adminAccount.email': {
                $regex: new RegExp(`^${escapeRegex(email)}$`, 'i'),
            },
        });
    }
    if (or.length === 0) return null;
    return or.length === 1 ? or[0] : { $or: or };
};

const findUniversityForAdmin = async (user) => {
    const query = buildInstitutionAdminQuery(user);
    if (!query) return null;
    return University.findOne(query).select('_id name thumbnail logo').lean();
};

const findScholarshipForAdmin = async (user) => {
    const query = buildInstitutionAdminQuery(user);
    if (!query) return null;
    return Scholarship.findOne(query).select('_id title thumbnail image').lean();
};

const hasOpportunityResetAccess = async ({
    type,
    opportunityId,
    user,
}) => {
    if (!user) return false;
    if (user.role === 'admin') return true;

    const normalizedType = normalizeOpportunityType(type);
    const normalizedOpportunityId = toObjectIdString(opportunityId);
    if (!normalizedType || !normalizedOpportunityId) return false;

    if (user.role === 'university') {
        if (normalizedType !== 'University') return false;
        const university = await findUniversityForAdmin(user);
        return (
            Boolean(university?._id) &&
            toObjectIdString(university._id) === normalizedOpportunityId
        );
    }

    if (user.role === 'scholarship') {
        if (normalizedType !== 'Scholarship') return false;
        const scholarship = await findScholarshipForAdmin(user);
        return (
            Boolean(scholarship?._id) &&
            toObjectIdString(scholarship._id) === normalizedOpportunityId
        );
    }

    return false;
};

const assertInstitutionAccess = async (application, user) => {
    if (user.role === 'admin') return true;

    if (user.role === 'university') {
        const uni = await findUniversityForAdmin(user);
        if (!uni) return false;
        
        const appUniId = toObjectIdString(application.university);
        const adminUniId = toObjectIdString(uni._id);
        
        if (appUniId && appUniId === adminUniId) return true;
        
        // Check if university is in offeredUniversities (for scholarship apps)
        const isOffered = (application.offeredUniversities || []).some(
            (entry) => toObjectIdString(entry.university) === adminUniId
        );
        if (isOffered) return true;
        return false;
    }

    if (user.role === 'scholarship') {
        const scholarship = await findScholarshipForAdmin(user);
        if (!scholarship) return false;
        
        const appScholId = toObjectIdString(application.scholarship);
        const adminScholId = toObjectIdString(scholarship._id);
        
        return appScholId === adminScholId;
    }

    if (user.role === 'user') {
        return toObjectIdString(application.user) === toObjectIdString(user._id);
    }

    return false;
};

const normalizeOpportunityType = (value) => {
    const normalized = String(value || '')
        .trim()
        .toLowerCase();
    if (normalized === 'university') return 'University';
    if (normalized === 'scholarship') return 'Scholarship';
    return '';
};

const buildOpportunityQuery = (type, opportunityId) => {
    const normalizedType = normalizeOpportunityType(type);
    const normalizedId = toObjectIdString(opportunityId);
    if (!normalizedType || !normalizedId) return null;
    if (normalizedType === 'University') {
        return {
            university: normalizedId,
        };
    }
    return {
        scholarship: normalizedId,
    };
};

const toBooleanFlag = (value, fallback = false) => {
    if (value == null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value)
        .trim()
        .toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return fallback;
};

const NULLISH_TEXT_VALUES = new Set([
    'null',
    'undefined',
    'n/a',
    'na',
    'none',
    '-',
]);

const isEmptyLikeValue = (value) => {
    if (value == null) return true;
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '' || NULLISH_TEXT_VALUES.has(normalized);
};

const normalizeDocumentFileValue = (value) => {
    if (isEmptyLikeValue(value)) return undefined;
    return String(value).trim();
};

const collectApplicationDocumentFiles = (application) => {
    const files = new Set();
    const addFile = (file) => {
        const normalized = normalizeDocumentFileValue(file);
        if (normalized) files.add(normalized);
    };

    addFile(application?.admitCard);
    addFile(application?.offerLetter);

    (application?.offeredUniversities || []).forEach((entry) => {
        addFile(entry?.admitCard);
        addFile(entry?.offerLetter);
    });

    return [...files];
};

const removeApplicationNotifications = async (userId, applicationId) => {
    const normalizedUserId = toObjectIdString(userId);
    const normalizedApplicationId = toObjectIdString(applicationId);
    if (!normalizedUserId || !normalizedApplicationId) return;

    await User.updateOne(
        { _id: normalizedUserId },
        {
            $pull: {
                notifications: {
                    'data.applicationId': normalizedApplicationId,
                },
            },
        }
    );
};

const MAX_STORED_NOTIFICATIONS = 1000;

const pushNotificationToUser = async (userId, payload) => {
    if (!userId) return;

    const notification = {
        ...payload,
        isRead: false,
        createdAt: new Date(),
    };

    await User.findByIdAndUpdate(userId, {
        $push: {
            notifications: {
                $each: [notification],
                $position: 0,
                $slice: MAX_STORED_NOTIFICATIONS,
            },
        },
    });
};

const enqueueUserNotification = (userId, payload, dedupeHint = '') => {
    if (!userId) return;

    const normalizedUserId = toObjectIdString(userId);
    const notificationType = String(payload?.type || 'generic');
    const applicationId = toObjectIdString(payload?.data?.applicationId);
    const status = String(payload?.data?.status || '');
    const dedupeKey = [
        'user-notify',
        normalizedUserId,
        notificationType,
        applicationId,
        status,
        dedupeHint,
    ].join(':');

    const result = enqueueJob({
        name: 'user-notification',
        dedupeKey,
        timeoutMs: 12000,
        handler: async () => {
            await pushNotificationToUser(normalizedUserId, payload);
        },
    });

    if (!result.enqueued && result.reason !== 'deduped') {
        pushNotificationToUser(normalizedUserId, payload).catch((error) => {
            console.error('Notification fallback warning:', error?.message || error);
        });
    }
};

const getEntityInfoForApplication = async (application) => {
    if (application.type === 'University') {
        const university =
            typeof application.university === 'object' && application.university !== null && application.university.name
                ? application.university
                : await University.findById(application.university).select('name thumbnail logo').lean();

        return {
            entityType: 'university',
            entityId: toObjectIdString(university?._id || application.university),
            entityName: university?.name || 'University',
            entityThumbnail: university?.thumbnail || university?.logo || '',
        };
    }

    const scholarship =
        typeof application.scholarship === 'object' && application.scholarship !== null && application.scholarship.title
            ? application.scholarship
            : await Scholarship.findById(application.scholarship).select('title thumbnail image').lean();

    return {
        entityType: 'scholarship',
        entityId: toObjectIdString(scholarship?._id || application.scholarship),
        entityName: scholarship?.title || 'Scholarship',
        entityThumbnail: scholarship?.thumbnail || scholarship?.image || '',
    };
};

const getApplicationContextInfo = async (application) => {
    const university =
        application?.university && typeof application.university === 'object' && application.university.name
            ? application.university
            : application?.university
              ? await University.findById(application.university).select('_id name thumbnail logo').lean()
              : null;

    const scholarship =
        application?.scholarship && typeof application.scholarship === 'object' && application.scholarship.title
            ? application.scholarship
            : application?.scholarship
              ? await Scholarship.findById(application.scholarship).select('_id title thumbnail image').lean()
              : null;

    return {
        universityId: toObjectIdString(university?._id || application?.university),
        universityName: university?.name || '',
        universityThumbnail: university?.thumbnail || university?.logo || '',
        scholarshipId: toObjectIdString(scholarship?._id || application?.scholarship),
        scholarshipName: scholarship?.title || '',
        scholarshipThumbnail: scholarship?.thumbnail || scholarship?.image || '',
    };
};

const emitApplicationStatusNotification = async (application, status) => {
    const info = await getEntityInfoForApplication(application);
    const context = await getApplicationContextInfo(application);
    const safeStatus = status || application.status || 'Updated';

    enqueueUserNotification(
        application.user,
        {
        type: 'application-status',
        title: `${info.entityName} - Status Updated`,
        body: `Admission status for ${info.entityName} is now ${safeStatus}.`,
        entityType: info.entityType,
        entityId: info.entityId,
        entityName: info.entityName,
        entityThumbnail: info.entityThumbnail,
        data: {
            type: 'application',
            applicationId: toObjectIdString(application._id),
            applicationType: application.type,
            entityId: info.entityId,
            entityType: info.entityType,
            entityName: info.entityName,
            status: safeStatus,
            universityId: context.universityId,
            universityName: context.universityName,
            universityThumbnail: context.universityThumbnail,
            scholarshipId: context.scholarshipId,
            scholarshipName: context.scholarshipName,
            scholarshipThumbnail: context.scholarshipThumbnail,
        },
        },
        `status:${safeStatus}`
    );
};

const emitApplicationSubmitNotification = async (application) => {
    const info = await getEntityInfoForApplication(application);
    const context = await getApplicationContextInfo(application);

    enqueueUserNotification(application.user, {
        type: 'application-submit',
        title: `${info.entityName} - Application Submitted`,
        body: `Your application for ${info.entityName} was submitted successfully.`,
        entityType: info.entityType,
        entityId: info.entityId,
        entityName: info.entityName,
        entityThumbnail: info.entityThumbnail,
        data: {
            type: 'application',
            applicationId: toObjectIdString(application._id),
            applicationType: application.type,
            entityId: info.entityId,
            entityType: info.entityType,
            entityName: info.entityName,
            status: application.status || 'Applied',
            universityId: context.universityId,
            universityName: context.universityName,
            universityThumbnail: context.universityThumbnail,
            scholarshipId: context.scholarshipId,
            scholarshipName: context.scholarshipName,
            scholarshipThumbnail: context.scholarshipThumbnail,
        },
    }, 'submit');
};

const emitApplicationDocumentNotification = async (
    application,
    {
        docLabel,
        entityType,
        entityId,
        entityName,
        entityThumbnail = '',
        contextOverride = {},
        status = '',
    }
) => {
    const context = await getApplicationContextInfo(application);
    const mergedContext = { ...context, ...contextOverride };
    const safeStatus = String(status || application.status || 'Applied').trim() || 'Applied';

    enqueueUserNotification(application.user, {
        type: 'application-document',
        title: `${entityName} - ${docLabel} Uploaded`,
        body: `${docLabel} for ${entityName} has been uploaded.`,
        entityType,
        entityId,
        entityName,
        entityThumbnail,
        data: {
            type: 'application',
            applicationId: toObjectIdString(application._id),
            applicationType: application.type,
            entityId,
            entityType,
            entityName,
            status: safeStatus,
            documentLabel: docLabel,
            universityId: mergedContext.universityId || '',
            universityName: mergedContext.universityName || '',
            universityThumbnail: mergedContext.universityThumbnail || '',
            scholarshipId: mergedContext.scholarshipId || '',
            scholarshipName: mergedContext.scholarshipName || '',
            scholarshipThumbnail: mergedContext.scholarshipThumbnail || '',
        },
    }, `document:${normalizeDocTag(docLabel)}`);
};

const populateApplicationQuery = (query) =>
    query
        .populate('user', 'name email phone avatar fatherName country state city address education')
        .populate('university')
        .populate('scholarship')
        .populate('offeredUniversities.university');

const populateAdminApplicationListQuery = (query) =>
    query
        .populate(
            'user',
            'name email phone avatar fatherName country state city address'
        )
        .populate(
            'university',
            'name city state country address thumbnail logo'
        )
        .populate(
            'scholarship',
            'title city state country address thumbnail image university_name'
        );

const populateApplicantsListQuery = (query) =>
    query
        .populate(
            'user',
            'name email phone avatar fatherName country state city address education'
        )
        .populate(
            'university',
            'name city state country address thumbnail logo'
        )
        .populate(
            'scholarship',
            'title city state country address thumbnail image university_name'
        )
        .populate(
            'offeredUniversities.university',
            'name city state country address thumbnail logo'
        );

const normalizeDocTag = (label) =>
    String(label || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

const normalizeSelectedPrograms = (selectedPrograms = []) => {
    if (!Array.isArray(selectedPrograms)) return [];
    return selectedPrograms
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
            programName: item.programName || item.name || '',
            programType: item.programType || item.type || '',
            duration: item.duration || '',
        }))
        .filter((item) => item.programName);
};

const normalizeOfferedUniversities = (offeredUniversities = []) => {
    if (!Array.isArray(offeredUniversities)) return [];
    return offeredUniversities
        .map((entry) => {
            const universityId = toObjectIdString(entry?.university);
            if (!universityId) return null;
            return {
                university: universityId,
                status: entry.status || 'Applied',
                admitCard: normalizeDocumentFileValue(entry?.admitCard),
                offerLetter: normalizeDocumentFileValue(entry?.offerLetter),
            };
        })
        .filter(Boolean);
};

const APPLICATION_CACHE_TAGS = [
    'applications-summary',
    'applications-admin-list',
    'applications-user-list',
];

const invalidateApplicationCaches = () => invalidateCacheByTags(APPLICATION_CACHE_TAGS);

const EDUCATION_DOC_SPEC = [
    { key: 'national-id', path: ['nationalId', 'file'] },
    { key: 'matric-transcript', path: ['matric', 'transcript'] },
    { key: 'matric-certificate', path: ['matric', 'certificate'] },
    { key: 'intermediate-transcript', path: ['intermediate', 'transcript'] },
    { key: 'intermediate-certificate', path: ['intermediate', 'certificate'] },
    { key: 'bachelor-transcript', path: ['bachelor', 'transcript'] },
    { key: 'bachelor-certificate', path: ['bachelor', 'certificate'] },
    { key: 'masters-transcript', path: ['masters', 'transcript'] },
    { key: 'masters-certificate', path: ['masters', 'certificate'] },
    { key: 'phd-transcript', path: ['phd', 'transcript'] },
    { key: 'phd-certificate', path: ['phd', 'certificate'] },
    { key: 'passport', path: ['international', 'passportPdf'] },
    { key: 'english-test-transcript', path: ['international', 'testTranscript'] },
    { key: 'cv', path: ['international', 'cv'] },
    { key: 'recommendation-letter', path: ['international', 'recommendationLetter'] },
    { key: 'father-cnic', path: ['personalInfo', 'fatherCnicFile'] },
];

const sanitizeFilePart = (value, fallback = 'document') => {
    const cleaned = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return cleaned || fallback;
};

const extractFileExtension = (value, fallback = '.pdf') => {
    const raw = String(value || '').trim();
    if (!raw) return fallback;

    let pathname = raw;
    if (/^https?:\/\//i.test(raw)) {
        try {
            pathname = new URL(raw).pathname || raw;
        } catch {
            pathname = raw;
        }
    }

    const ext = path.extname(pathname.split('?')[0]).toLowerCase();
    if (!ext || ext.length > 10) return fallback;
    return ext;
};

const composeDownloadFileName = (parts = [], extension = '.pdf') => {
    const fileBase = (parts || [])
        .map((part) => sanitizeFilePart(part, ''))
        .filter(Boolean)
        .join('-');
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    return `${fileBase || 'document'}${ext}`;
};

const getNestedValue = (source, pathParts = []) =>
    (pathParts || []).reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), source);

const ADMIN_APPLICATION_LIST_SELECT = [
    'user',
    'university',
    'scholarship',
    'type',
    'status',
    'selectedPrograms',
    'appliedAt',
    'admitCard',
    'offerLetter',
    'testDate',
    'interviewDate',
    'offeredUniversities',
    'updatedAt',
].join(' ');

// @desc    Get applicants for a specific record
// @route   GET /api/applications/:type/:id
// @access  Private
const getApplicants = async (req, res) => {
    try {
        const { type, id } = req.params;

        if (!['university', 'scholarship'].includes(type)) {
            return res.status(400).json({ message: 'Invalid type. Use university or scholarship.' });
        }

        if (req.user.role === 'university') {
            if (type !== 'university') {
                return res.status(403).json({ message: 'Unauthorized access to applicants' });
            }
            const uni = await findUniversityForAdmin(req.user);
            if (!uni || (type === 'university' && String(uni._id) !== id)) {
                return res.status(403).json({ message: 'Unauthorized access to applicants' });
            }
        } else if (req.user.role === 'scholarship') {
            if (type !== 'scholarship') {
                return res.status(403).json({ message: 'Unauthorized access to applicants' });
            }
            const scholarship = await findScholarshipForAdmin(req.user);
            if (!scholarship || (type === 'scholarship' && String(scholarship._id) !== id)) {
                return res.status(403).json({ message: 'Unauthorized access to applicants' });
            }
        }

        const baseQuery = type === 'university' ? { university: id } : { scholarship: id };
        const query = await buildApplicationListQuery(baseQuery, req.query);
        const { page, limit, skip } = toPagination(req.query, {
            defaultLimit: 50,
            maxLimit: 200,
        });

        const [applicants, total] = await Promise.all([
            populateApplicantsListQuery(
                Application.find(query)
                    .sort('-appliedAt')
                    .skip(skip)
                    .limit(limit)
            ).lean(),
            Application.countDocuments(query),
        ]);

        return res.json({
            data: applicants,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// @desc    Get all applications for admin applications page
// @route   GET /api/applications/admin/list
// @access  Private
const getAdminApplicationsList = async (req, res) => {
    try {
        let baseQuery = {};

        if (req.user.role === 'university') {
            const uni = await findUniversityForAdmin(req.user);
            if (!uni) return res.json({ data: [] });
            baseQuery = { university: uni._id };
        } else if (req.user.role === 'scholarship') {
            const scholarship = await findScholarshipForAdmin(req.user);
            if (!scholarship) return res.json({ data: [] });
            baseQuery = { scholarship: scholarship._id };
        }

        const query = await buildApplicationListQuery(baseQuery, req.query);
        const { page, limit, skip } = toPagination(req.query, {
            defaultLimit: 20,
            maxLimit: 100,
        });
        const [apps, total] = await Promise.all([
            populateAdminApplicationListQuery(
                Application.find(query)
                    .select(ADMIN_APPLICATION_LIST_SELECT)
                    .sort('-appliedAt')
                    .skip(skip)
                    .limit(limit)
            ).lean(),
            Application.countDocuments(query),
        ]);

        return res.json({
            data: apps,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// @desc    Get all applications (Admin dashboard summary)
// @route   GET /api/applications/total
// @access  Private/Admin
const getAllApplicationsTotal = async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Unauthorized access' });
        }
        const total = await Application.countDocuments({});
        return res.json({ data: { total } });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// @desc    Get current user applications
// @route   GET /api/applications/me
// @access  Private/User
const getMyApplications = async (req, res) => {
    try {
        const baseQuery = { user: req.user._id };
        const query = await buildApplicationListQuery(baseQuery, req.query);
        const { page, limit, skip } = toPagination(req.query, {
            defaultLimit: 50,
            maxLimit: 100,
        });

        const [apps, total] = await Promise.all([
            populateApplicationQuery(
                Application.find(query)
                    .sort('-appliedAt')
                    .skip(skip)
                    .limit(limit)
            ).lean(),
            Application.countDocuments(query),
        ]);

        return res.json({
            data: apps,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// @desc    Apply to scholarship/university
// @route   POST /api/applications/apply
// @access  Private/User
const applyToOpportunity = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

        const universityId = req.body.universityId || req.body.university;
        const scholarshipId = req.body.scholarshipId || req.body.scholarship;
        const requestedType = (req.body.type || '').toString().toLowerCase();

        let type = requestedType === 'scholarship' ? 'Scholarship' : 'University';
        if (scholarshipId && !universityId) type = 'Scholarship';
        if (universityId && !scholarshipId) type = 'University';

        if (universityId && scholarshipId) {
            return res.status(400).json({ message: 'Send either universityId or scholarshipId, not both.' });
        }

        const targetId = type === 'University' ? universityId : scholarshipId;
        if (!targetId) {
            return res.status(400).json({ message: `${type} id is required` });
        }

        let targetOpportunity;
        if (type === 'University') {
            targetOpportunity = await University.findById(targetId).select(
                '_id name isActive deadline eligibility programs'
            );
            if (!targetOpportunity) {
                return res.status(404).json({ message: 'University not found' });
            }
        } else {
            targetOpportunity = await Scholarship.findById(targetId).select(
                '_id title isActive deadline eligibility programs'
            );
            if (!targetOpportunity) {
                return res.status(404).json({ message: 'Scholarship not found' });
            }
        }

        const selectedPrograms = normalizeSelectedPrograms(
            parsePossibleJSON(req.body.selectedPrograms, req.body.selectedPrograms)
        );

        const duplicateQuery =
            type === 'University'
                ? { user: req.user._id, university: targetId }
                : { user: req.user._id, scholarship: targetId };

        const existing = await Application.findOne(duplicateQuery);
        if (existing) {
            if (!existing.isReapplyEligible) {
                return res.status(400).json({
                    message: `You have already applied for this ${type.toLowerCase()}.`,
                });
            }

            const filesToDelete = collectApplicationDocumentFiles(existing);
            const userForSnapshot_re = await User.findById(req.user._id)
                .select('name email phone address city state fatherName dateOfBirth education')
                .lean();

            if (!userForSnapshot_re) {
                return res.status(404).json({ message: 'User not found' });
            }

            const eligibilityCheck = evaluateOpportunityForUser({
                type: type.toLowerCase(),
                opportunity: targetOpportunity.toObject(),
                education: userForSnapshot_re.education || {},
                selectedPrograms,
            });
            if (!eligibilityCheck.canApply) {
                return res.status(400).json({
                    message:
                        eligibilityCheck.reasons[0] ||
                        'Application blocked by document or eligibility validation.',
                    code: 'APPLICATION_BLOCKED',
                    details: {
                        status: eligibilityCheck.status,
                        reasons: eligibilityCheck.reasons,
                        missingDocuments:
                            eligibilityCheck.documentValidation?.missing || [],
                        requiredPercentage: eligibilityCheck.requiredPercentage,
                        userPercentage: eligibilityCheck.userPercentage,
                        programLevel: eligibilityCheck.programLevel,
                    },
                });
            }
                
            const snapshot = {
                ...(userForSnapshot_re?.education || {}),
                personalInfoSnapshot: {
                    name: userForSnapshot_re?.name,
                    email: userForSnapshot_re?.email,
                    phone: userForSnapshot_re?.phone,
                    address: userForSnapshot_re?.address,
                    city: userForSnapshot_re?.city,
                    state: userForSnapshot_re?.state,
                    fatherName: userForSnapshot_re?.fatherName,
                    dateOfBirth: userForSnapshot_re?.dateOfBirth,
                }
            };

            existing.status = 'Applied';
            existing.selectedPrograms = selectedPrograms;
            existing.appliedAt = new Date();
            existing.testDate = undefined;
            existing.interviewDate = undefined;
            existing.admitCard = undefined;
            existing.offerLetter = undefined;
            existing.offeredUniversities = [];
            existing.isReapplyEligible = false;
            existing.educationSnapshot = snapshot;
            await existing.save();

            for (const file of filesToDelete) {
                await deleteUploadedFile(file);
            }

            await removeApplicationNotifications(existing.user, existing._id);
            await emitApplicationSubmitNotification(existing);

            const resetPayload = await populateApplicationQuery(
                Application.findById(existing._id)
            ).lean();

            invalidateApplicationCaches();
            return res.status(201).json({
                data: resetPayload,
                meta: { reapplied: true },
            });
        }

        let application;
        try {
            const userForSnapshot = await User.findById(req.user._id)
                .select('name email phone address city state fatherName dateOfBirth education')
                .lean();

            if (!userForSnapshot) {
                return res.status(404).json({ message: 'User not found' });
            }

            const eligibilityCheck = evaluateOpportunityForUser({
                type: type.toLowerCase(),
                opportunity: targetOpportunity.toObject(),
                education: userForSnapshot.education || {},
                selectedPrograms,
            });
            if (!eligibilityCheck.canApply) {
                return res.status(400).json({
                    message:
                        eligibilityCheck.reasons[0] ||
                        'Application blocked by document or eligibility validation.',
                    code: 'APPLICATION_BLOCKED',
                    details: {
                        status: eligibilityCheck.status,
                        reasons: eligibilityCheck.reasons,
                        missingDocuments:
                            eligibilityCheck.documentValidation?.missing || [],
                        requiredPercentage: eligibilityCheck.requiredPercentage,
                        userPercentage: eligibilityCheck.userPercentage,
                        programLevel: eligibilityCheck.programLevel,
                    },
                });
            }
                
            const snapshot = {
                ...(userForSnapshot?.education || {}),
                personalInfoSnapshot: {
                    name: userForSnapshot?.name,
                    email: userForSnapshot?.email,
                    phone: userForSnapshot?.phone,
                    address: userForSnapshot?.address,
                    city: userForSnapshot?.city,
                    state: userForSnapshot?.state,
                    fatherName: userForSnapshot?.fatherName,
                    dateOfBirth: userForSnapshot?.dateOfBirth,
                }
            };

            application = await Application.create({
                user: req.user._id,
                university: type === 'University' ? targetId : undefined,
                scholarship: type === 'Scholarship' ? targetId : undefined,
                type,
                status: 'Applied',
                selectedPrograms,
                educationSnapshot: snapshot,
            });
        } catch (error) {
            if (error?.code === 11000) {
                return res.status(400).json({
                    message: `You have already applied for this ${type.toLowerCase()}.`,
                });
            }
            throw error;
        }

        await emitApplicationSubmitNotification(application);

        const populated = await populateApplicationQuery(
            Application.findById(application._id)
        ).lean();

        invalidateApplicationCaches();
        return res.status(201).json({ data: populated });
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
};

// @desc    Update application status / docs
// @route   PUT /api/applications/:id
// @access  Private
const updateApplicationStatus = async (req, res) => {
    try {
        const application = await Application.findById(req.params.id);
        if (!application) return res.status(404).json({ message: 'Application not found' });

        const allowed = await assertInstitutionAccess(application, req.user);
        if (!allowed) return res.status(403).json({ message: 'Unauthorized' });

        const previousStatus = application.status;
        const previousAdmitCard = application.admitCard || '';
        const previousOfferLetter = application.offerLetter || '';
        const previousOfferedFiles = (application.offeredUniversities || []).flatMap(
            (entry) => [entry?.admitCard, entry?.offerLetter].filter(Boolean)
        );
        const updateData = {};
        Object.entries(req.body || {}).forEach(([key, value]) => {
            if (APPLICATION_UPDATE_FIELDS.has(key)) {
                updateData[key] = value;
            }
        });

        const offeredUniversities = parsePossibleJSON(updateData.offeredUniversities, updateData.offeredUniversities);
        if (Array.isArray(offeredUniversities)) {
            updateData.offeredUniversities = normalizeOfferedUniversities(offeredUniversities);
        }

        if (updateData.selectedPrograms) {
            const selectedPrograms = parsePossibleJSON(updateData.selectedPrograms, updateData.selectedPrograms);
            updateData.selectedPrograms = normalizeSelectedPrograms(selectedPrograms);
        }

        if (updateData.status && !APPLICATION_STATUSES.includes(updateData.status)) {
            return res.status(400).json({ message: 'Invalid status value' });
        }

        if (req.files && typeof req.files === 'object' && !Array.isArray(req.files)) {
            const applicant = await User.findById(application.user).select('name').lean();
            const contextInfo = await getApplicationContextInfo(application);
            const entityName =
                contextInfo.universityName || contextInfo.scholarshipName || 'application';
            const userName = applicant?.name || 'applicant';

            if (req.files.admitCard?.[0]) {
                updateData.admitCard = await uploadToCloudinary(req.files.admitCard[0].path, [userName,
                    entityName,
                    normalizeDocTag('admit-card'),
                ], { forcePdf: true, originalName: req.files.admitCard[0].originalname });
                if (!updateData.admitCard) {
                    throw new Error('Failed to upload admit card');
                }
            }
            if (req.files.offerLetter?.[0]) {
                updateData.offerLetter = await uploadToCloudinary(req.files.offerLetter[0].path, [userName,
                    entityName,
                    normalizeDocTag('offer-letter'),
                ], { forcePdf: true, originalName: req.files.offerLetter[0].originalname });
                if (!updateData.offerLetter) {
                    throw new Error('Failed to upload offer letter');
                }
            }
        }

        Object.entries(updateData).forEach(([key, value]) => {
            if (typeof value === 'undefined') return;
            const shouldClearField =
                ['testDate', 'interviewDate', 'admitCard', 'offerLetter'].includes(key) &&
                isEmptyLikeValue(value);
            if (shouldClearField) {
                application[key] = undefined;
                return;
            }
            if (key === 'admitCard' || key === 'offerLetter') {
                application[key] = normalizeDocumentFileValue(value);
                return;
            }
            application[key] = value;
        });

        await application.save();

        if (previousAdmitCard && previousAdmitCard !== application.admitCard) {
            await deleteUploadedFile(previousAdmitCard);
        }
        if (previousOfferLetter && previousOfferLetter !== application.offerLetter) {
            await deleteUploadedFile(previousOfferLetter);
        }

        const currentOfferedFiles = (application.offeredUniversities || []).flatMap(
            (entry) => [entry?.admitCard, entry?.offerLetter].filter(Boolean)
        );
        for (const oldFile of previousOfferedFiles) {
            if (!currentOfferedFiles.includes(oldFile)) {
                await deleteUploadedFile(oldFile);
            }
        }

        if (application.status !== previousStatus) {
            await emitApplicationStatusNotification(application, application.status);
        }

        const info = await getEntityInfoForApplication(application);
        if (application.admitCard && application.admitCard !== previousAdmitCard) {
            await emitApplicationDocumentNotification(application, {
                docLabel: 'Admit Card',
                entityType: info.entityType,
                entityId: info.entityId,
                entityName: info.entityName,
                entityThumbnail: info.entityThumbnail,
                status: application.status,
            });
        }
        if (application.offerLetter && application.offerLetter !== previousOfferLetter) {
            await emitApplicationDocumentNotification(application, {
                docLabel: 'Offer Letter',
                entityType: info.entityType,
                entityId: info.entityId,
                entityName: info.entityName,
                entityThumbnail: info.entityThumbnail,
                status: application.status,
            });
        }

        const updated = await populateApplicationQuery(
            Application.findById(application._id)
        ).lean();
        invalidateApplicationCaches();
        return res.json({ data: updated });
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
};

// @desc    Update offered university status/docs inside scholarship application
// @route   PUT /api/applications/:id/university-status
// @access  Private
const updateUniversityStatus = async (req, res) => {
    try {
        const application = await Application.findById(req.params.id).populate('offeredUniversities.university');
        if (!application) return res.status(404).json({ message: 'Application not found' });

        const allowed = await assertInstitutionAccess(application, req.user);
        if (!allowed) return res.status(403).json({ message: 'Unauthorized' });

        const universityId = req.body.universityId || req.body.university;
        if (!universityId) {
            return res.status(400).json({ message: 'universityId is required' });
        }

        const uniId = toObjectIdString(universityId);
        let offered = application.offeredUniversities.find(
            (entry) => toObjectIdString(entry.university) === uniId
        );

        if (!offered) {
            application.offeredUniversities.push({
                university: uniId,
                status: 'Applied',
            });
            offered = application.offeredUniversities[application.offeredUniversities.length - 1];
        }

        const previousStatus = offered.status;
        const previousAdmitCard = offered.admitCard || '';
        const previousOfferLetter = offered.offerLetter || '';
        const applicant = await User.findById(application.user).select('name').lean();
        const applicantName = applicant?.name || 'applicant';

        if (req.body.status) {
            if (!APPLICATION_STATUSES.includes(req.body.status)) {
                return res.status(400).json({ message: 'Invalid status value' });
            }
            offered.status = req.body.status;
        }

        const shouldClearAdmitCard =
            Object.prototype.hasOwnProperty.call(req.body || {}, 'admitCard') &&
            isEmptyLikeValue(req.body.admitCard);
        const shouldClearOfferLetter =
            Object.prototype.hasOwnProperty.call(req.body || {}, 'offerLetter') &&
            isEmptyLikeValue(req.body.offerLetter);

        if (shouldClearAdmitCard) {
            offered.admitCard = undefined;
        }
        if (shouldClearOfferLetter) {
            offered.offerLetter = undefined;
        }

        if (req.files && typeof req.files === 'object' && !Array.isArray(req.files)) {
            const uniForName =
                typeof offered.university === 'object' && offered.university !== null
                    ? offered.university
                    : await University.findById(uniId).select('name').lean();
            const uniName = uniForName?.name || 'university';

            if (req.files.admitCard?.[0]) {
                offered.admitCard = await uploadToCloudinary(req.files.admitCard[0].path, [applicantName,
                    uniName,
                    normalizeDocTag('admit-card'),
                ], { forcePdf: true, originalName: req.files.admitCard[0].originalname });
                if (!offered.admitCard) {
                    throw new Error('Failed to upload admit card');
                }
            }
            if (req.files.offerLetter?.[0]) {
                offered.offerLetter = await uploadToCloudinary(req.files.offerLetter[0].path, [applicantName,
                    uniName,
                    normalizeDocTag('offer-letter'),
                ], { forcePdf: true, originalName: req.files.offerLetter[0].originalname });
                if (!offered.offerLetter) {
                    throw new Error('Failed to upload offer letter');
                }
            }
        }

        await application.save();

        if (previousAdmitCard && previousAdmitCard !== offered.admitCard) {
            await deleteUploadedFile(previousAdmitCard);
        }
        if (previousOfferLetter && previousOfferLetter !== offered.offerLetter) {
            await deleteUploadedFile(previousOfferLetter);
        }

        const uni =
            typeof offered.university === 'object' && offered.university !== null
                ? offered.university
                : await University.findById(uniId).select('name thumbnail logo').lean();
        const context = await getApplicationContextInfo(application);

        if (offered.status !== previousStatus) {
            enqueueUserNotification(application.user, {
                type: 'application-university-status',
                title: `${uni?.name || 'University'} - Status Updated`,
                body: `Admission status for ${uni?.name || 'University'} is now ${offered.status}.`,
                entityType: 'university',
                entityId: toObjectIdString(uni?._id || uniId),
                entityName: uni?.name || 'University',
                entityThumbnail: uni?.thumbnail || uni?.logo || '',
                data: {
                    type: 'application',
                    applicationId: toObjectIdString(application._id),
                    applicationType: application.type,
                    universityId: toObjectIdString(uni?._id || uniId),
                    entityName: uni?.name || 'University',
                    status: offered.status,
                    universityName: uni?.name || context.universityName,
                    universityThumbnail:
                        uni?.thumbnail || uni?.logo || context.universityThumbnail || '',
                    scholarshipId: context.scholarshipId,
                    scholarshipName: context.scholarshipName,
                    scholarshipThumbnail: context.scholarshipThumbnail,
                },
            }, `university-status:${toObjectIdString(uni?._id || uniId)}:${offered.status}`);
        }

        if (offered.admitCard && offered.admitCard !== previousAdmitCard) {
            await emitApplicationDocumentNotification(application, {
                docLabel: 'Admit Card',
                entityType: 'university',
                entityId: toObjectIdString(uni?._id || uniId),
                entityName: uni?.name || context.universityName || 'University',
                entityThumbnail:
                    uni?.thumbnail || uni?.logo || context.universityThumbnail || '',
                status: offered.status,
                contextOverride: {
                    universityId: toObjectIdString(uni?._id || uniId),
                    universityName: uni?.name || context.universityName || '',
                    universityThumbnail:
                        uni?.thumbnail || uni?.logo || context.universityThumbnail || '',
                    scholarshipId: context.scholarshipId,
                    scholarshipName: context.scholarshipName,
                    scholarshipThumbnail: context.scholarshipThumbnail,
                },
            });
        }

        if (offered.offerLetter && offered.offerLetter !== previousOfferLetter) {
            await emitApplicationDocumentNotification(application, {
                docLabel: 'Offer Letter',
                entityType: 'university',
                entityId: toObjectIdString(uni?._id || uniId),
                entityName: uni?.name || context.universityName || 'University',
                entityThumbnail:
                    uni?.thumbnail || uni?.logo || context.universityThumbnail || '',
                status: offered.status,
                contextOverride: {
                    universityId: toObjectIdString(uni?._id || uniId),
                    universityName: uni?.name || context.universityName || '',
                    universityThumbnail:
                        uni?.thumbnail || uni?.logo || context.universityThumbnail || '',
                    scholarshipId: context.scholarshipId,
                    scholarshipName: context.scholarshipName,
                    scholarshipThumbnail: context.scholarshipThumbnail,
                },
            });
        }

        const updated = await populateApplicationQuery(
            Application.findById(application._id)
        ).lean();

        invalidateApplicationCaches();
        return res.json({ data: updated });
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
};

// @desc    Bulk update statuses
// @route   PUT /api/applications/bulk-status
// @access  Private
const bulkUpdateStatus = async (req, res) => {
    try {
        const { ids, status } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'ids array is required' });
        }
        if (!APPLICATION_STATUSES.includes(status)) {
            return res.status(400).json({ message: 'Invalid status value' });
        }

        const apps = await Application.find({ _id: { $in: ids } });
        const updatedIds = [];

        for (const app of apps) {
            const allowed = await assertInstitutionAccess(app, req.user);
            if (!allowed) continue;
            const old = app.status;
            app.status = status;
            await app.save();
            if (old !== status) {
                await emitApplicationStatusNotification(app, status);
            }
            updatedIds.push(String(app._id));
        }

        invalidateApplicationCaches();
        return res.json({ message: 'Bulk status update completed', data: { updatedIds } });
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
};

// @desc    Reset opportunity applications for next admission cycle
// @route   POST /api/applications/reset-opportunity
// @access  Private/Admin|University|Scholarship
const resetOpportunityApplications = async (req, res) => {
    try {
        const requestedType =
            req.body.type ||
            req.body.applicationType ||
            (req.body.universityId ? 'university' : req.body.scholarshipId ? 'scholarship' : '');
        const requestedOpportunityId =
            req.body.opportunityId ||
            req.body.id ||
            req.body.universityId ||
            req.body.scholarshipId;

        const opportunityType = normalizeOpportunityType(requestedType);
        const opportunityId = toObjectIdString(requestedOpportunityId);

        if (!opportunityType || !opportunityId) {
            return res.status(400).json({
                message: 'type and opportunityId (or universityId/scholarshipId) are required',
            });
        }

        const hasAccess = await hasOpportunityResetAccess({
            type: opportunityType,
            opportunityId,
            user: req.user,
        });
        if (!hasAccess) {
            return res.status(403).json({ message: 'Unauthorized' });
        }

        const clearTracking = toBooleanFlag(req.body.clearTracking, false);
        const clearDocuments = toBooleanFlag(req.body.clearDocuments, false);
        const clearNotifications = toBooleanFlag(req.body.clearNotifications, false);
        const purgeApplications =
            toBooleanFlag(req.body.purgeApplications, false) ||
            toBooleanFlag(req.body.hardDelete, false);
        const shouldClearNotifications = clearNotifications || purgeApplications;
        const clearStoredDocuments = purgeApplications || clearDocuments || clearTracking;

        const opportunityQuery = buildOpportunityQuery(opportunityType, opportunityId);
        if (!opportunityQuery) {
            return res.status(400).json({ message: 'Invalid type or opportunity id' });
        }

        const applications = await Application.find(opportunityQuery);
        if (applications.length === 0) {
            return res.json({
                message: 'No applications found for this opportunity',
                data: {
                    matched: 0,
                    updated: 0,
                    deletedApplications: 0,
                    markedReapplyEligible: 0,
                    deletedFiles: 0,
                    notificationsCleared: 0,
                    clearTracking,
                    clearDocuments: clearStoredDocuments,
                    clearNotifications: shouldClearNotifications,
                    purgeApplications,
                },
            });
        }

        const filesToDelete = new Set();
        const applicationIdsForNotifications = [];
        const userIdsForNotifications = new Set();
        const notificationEntityId = toObjectIdString(opportunityId);
        const notificationTypeTokens = Array.from(
            new Set([
                opportunityType,
                String(opportunityType || '').toLowerCase(),
                String(opportunityType || '').toUpperCase(),
                `${String(opportunityType || '').charAt(0).toUpperCase()}${String(opportunityType || '').slice(1)}`,
            ].filter(Boolean))
        );
        let updatedCount = 0;
        let markedReapplyEligible = 0;

        const buildNotificationPullFilter = () => {
            const orConditions = [];
            if (applicationIdsForNotifications.length > 0) {
                orConditions.push({
                    'data.applicationId': {
                        $in: applicationIdsForNotifications,
                    },
                });
            }
            if (notificationEntityId) {
                orConditions.push({
                    'data.entityId': notificationEntityId,
                    'data.entityType': { $in: notificationTypeTokens },
                });
                orConditions.push({
                    entityId: notificationEntityId,
                    entityType: { $in: notificationTypeTokens },
                });
            }
            if (orConditions.length === 0) return null;
            return { $or: orConditions };
        };

        for (const application of applications) {
            if (clearStoredDocuments) {
                collectApplicationDocumentFiles(application).forEach((file) => {
                    filesToDelete.add(file);
                });
            }

            if (shouldClearNotifications) {
                applicationIdsForNotifications.push(toObjectIdString(application._id));
                userIdsForNotifications.add(toObjectIdString(application.user));
            }

            if (purgeApplications) {
                continue;
            }

            let shouldSave = false;

            if (!application.isReapplyEligible) {
                application.isReapplyEligible = true;
                shouldSave = true;
                markedReapplyEligible += 1;
            }

            if (clearStoredDocuments) {
                if (application.admitCard) {
                    application.admitCard = undefined;
                    shouldSave = true;
                }
                if (application.offerLetter) {
                    application.offerLetter = undefined;
                    shouldSave = true;
                }

                if (Array.isArray(application.offeredUniversities)) {
                    let changedOfferedDocs = false;
                    application.offeredUniversities.forEach((entry) => {
                        if (entry?.admitCard) {
                            entry.admitCard = undefined;
                            changedOfferedDocs = true;
                        }
                        if (entry?.offerLetter) {
                            entry.offerLetter = undefined;
                            changedOfferedDocs = true;
                        }
                    });
                    if (changedOfferedDocs) {
                        shouldSave = true;
                    }
                }
            }

            if (clearTracking) {
                if (application.status !== 'Rejected') {
                    application.status = 'Rejected';
                    shouldSave = true;
                }
                if (application.testDate) {
                    application.testDate = undefined;
                    shouldSave = true;
                }
                if (application.interviewDate) {
                    application.interviewDate = undefined;
                    shouldSave = true;
                }
                if (
                    Array.isArray(application.offeredUniversities) &&
                    application.offeredUniversities.length > 0
                ) {
                    application.offeredUniversities = [];
                    shouldSave = true;
                }
            }

            if (shouldSave) {
                await application.save();
                updatedCount += 1;
            }
        }

        if (purgeApplications && applications.length > 0) {
            const applicationIds = applications.map((application) => application._id);
            await Application.deleteMany({ _id: { $in: applicationIds } });
            updatedCount = applications.length;
        }

        for (const file of filesToDelete) {
            await deleteUploadedFile(file);
        }

        if (
            shouldClearNotifications &&
            userIdsForNotifications.size > 0
        ) {
            const pullFilter = buildNotificationPullFilter();
            if (pullFilter) {
                await User.updateMany(
                    { _id: { $in: [...userIdsForNotifications] } },
                    {
                        $pull: {
                            notifications: pullFilter,
                        },
                    }
                );
            }
        }

        invalidateApplicationCaches();
        return res.json({
            message: 'Application cycle reset completed',
            data: {
                matched: applications.length,
                updated: updatedCount,
                deletedApplications: purgeApplications ? applications.length : 0,
                markedReapplyEligible,
                deletedFiles: filesToDelete.size,
                notificationsCleared: shouldClearNotifications
                    ? applicationIdsForNotifications.length
                    : 0,
                clearTracking,
                clearDocuments: clearStoredDocuments,
                clearNotifications: shouldClearNotifications,
                purgeApplications,
            },
        });
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
};

const resolveRequestedApplicationDoc = (application, field, requestedUniId) => {
    const normalizedUniId = toObjectIdString(requestedUniId);

    // Strict behavior: for university-specific requests, return only that
    // university's document. For general requests, return only top-level docs.
    if (normalizedUniId) {
        const offered = (application.offeredUniversities || []).find(
            (entry) => toObjectIdString(entry.university) === normalizedUniId
        );
        const file = normalizeDocumentFileValue(offered?.[field]);
        if (!file) return null;
        return {
            file,
            uniId: normalizedUniId,
            offeredEntry: offered || null,
        };
    }

    const topLevelFile = normalizeDocumentFileValue(application?.[field]);
    if (!topLevelFile) return null;
    return {
        file: topLevelFile,
        uniId: '',
        offeredEntry: null,
    };
};

const buildApplicationDocFallbackName = async ({
    application,
    field,
    offeredEntry,
    sourceFile,
}) => {
    const user = await User.findById(application.user).select('name').lean();
    const docLabel = (field === 'admitCard' ? 'AdmitCard' : 'OfferLetter');
    const userLabel = sanitizeFilePart(user?.name || 'applicant', 'applicant');
    const extension = extractFileExtension(sourceFile, '.pdf');
    const offeredUniversity = offeredEntry?.university;
    const universityLabel = sanitizeFilePart(
        offeredUniversity && typeof offeredUniversity === 'object'
            ? offeredUniversity?.name || ''
            : '',
        ''
    );

    return composeDownloadFileName(
        [userLabel, universityLabel, docLabel].filter(Boolean),
        extension
    );
};

// @desc    Download document from application
// @route   GET /api/applications/:id/download-doc/:field
// @access  Private
const downloadApplicationDocument = async (req, res) => {
    try {
        const { id, field } = req.params;
        const { downloadName } = req.query;
        const requestedUniId =
            req.query.uniId || req.query.universityId || '';

        if (!['admitCard', 'offerLetter'].includes(field)) {
            return res.status(400).json({ message: 'Invalid document field' });
        }

        const application = await Application.findById(id)
            .populate('offeredUniversities.university', 'name')
            .populate('university', 'name')
            .populate('scholarship', 'title');
        if (!application) return res.status(404).json({ message: 'Application not found' });

        const allowed = await assertInstitutionAccess(application, req.user);
        if (!allowed) return res.status(403).json({ message: 'Unauthorized' });

        const candidate = resolveRequestedApplicationDoc(
            application,
            field,
            requestedUniId
        );
        if (!candidate) {
            return res.status(404).json({ message: 'Document not found' });
        }

        const safeDownloadName = normalizeDownloadName(downloadName);
        const fallbackName = await buildApplicationDocFallbackName({
            application,
            field,
            offeredEntry: candidate.offeredEntry,
            sourceFile: candidate.file,
        });
        const sent = await downloadStoredFile(
            res,
            candidate.file,
            safeDownloadName || fallbackName,
            { forcePdf: true }
        );
        if (sent) return null;
        return res.status(404).json({ message: 'File does not exist on server' });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const downloadApplicationBundle = async (req, res) => {
    try {
        console.log(`[ZIP BUNDLE] Request for application: ${req.params.id} by user: ${req.user._id}`);
        const application = await Application.findById(req.params.id)
            .populate('offeredUniversities.university')
            .populate('university', 'name')
            .populate('scholarship', 'title')
            .lean();

        if (!application) return res.status(404).json({ message: 'Application not found' });
        console.log('[ZIP BUNDLE] Application found');

        const allowed = await assertInstitutionAccess(application, req.user);
        if (!allowed) return res.status(403).json({ message: 'Unauthorized' });
        console.log('[ZIP BUNDLE] Access allowed');

        const docs = [];
        const seenFiles = new Set();
        const addDoc = (file, nameParts = []) => {
            const normalizedFile = normalizeDocumentFileValue(file);
            if (!normalizedFile || seenFiles.has(normalizedFile)) return;
            seenFiles.add(normalizedFile);
            docs.push({ file: normalizedFile, nameParts });
        };

        const user = await User.findById(application.user)
            .select('name email phone country state city address fatherName dateOfBirth education')
            .lean();

        if (!user) return res.status(404).json({ message: 'User not found' });
        console.log(`[ZIP BUNDLE] User found: ${user.name}`);

        const userLabel = sanitizeFilePart(user?.name || 'applicant', 'applicant');
        
        const education = { 
            ...(application.educationSnapshot || {}), 
            ...(user?.education || {}) 
        };
        console.log('[ZIP BUNDLE] Education structure keys:', Object.keys(education));
        
        EDUCATION_DOC_SPEC.forEach((spec) => {
            const file = getNestedValue(education, spec.path);
            if (file) {
                console.log(`[ZIP BUNDLE] Found doc for ${spec.key}: ${file}`);
                addDoc(file, [userLabel, spec.key]);
            }
        });

        // Removed Application Specific Documents and Offered Universities Documents as requested.
        console.log(`[ZIP BUNDLE] Total unique docs collected: ${docs.length}`);

        if (docs.length === 0) {
            console.log('[ZIP BUNDLE] No documents found to zip');
            return res.status(404).json({ message: 'No documents found for this applicant' });
        }

        const usedArchiveNames = new Set();
        const ensureUniqueArchiveName = (rawName) => {
            const ext = path.extname(rawName);
            const baseName = ext ? rawName.slice(0, -ext.length) : rawName;
            let candidate = rawName;
            let index = 2;
            while (usedArchiveNames.has(candidate)) {
                candidate = `${baseName}(${index})${ext}`;
                index++;
            }
            usedArchiveNames.add(candidate);
            return candidate;
        };

        const archive = archiver('zip', { zlib: { level: 9 } });
        const downloadName = req.query.downloadName || `${userLabel}-bundle.zip`;
        res.attachment(downloadName);

        archive.on('error', (err) => {
            console.error('[ARCHIVE ERROR]', err);
            throw err;
        });
        archive.pipe(res);

        // --- Add Application Summary PDF ---
        try {
            console.log('[ZIP BUNDLE] Generating summary PDF...');
            const summaryPdfBuffer = await generateApplicationSummaryPdf(application, user);
            const summaryName = ensureUniqueArchiveName(`${userLabel}-application-summary.pdf`);
            archive.append(summaryPdfBuffer, { name: summaryName });
            console.log(`[ZIP BUNDLE] Summary PDF added: ${summaryName}`);
        } catch (pdfErr) {
            console.error('[ZIP BUNDLE] Failed to generate summary PDF:', pdfErr);
        }

        for (const doc of docs) {
            try {
                // Use prepareStoredFileBufferForDownload to handle local/remote files and PDF conversion
                const fileData = await prepareStoredFileBufferForDownload(doc.file, { forcePdf: true });
                
                if (!fileData || !fileData.buffer) {
                    console.log(`[ZIP BUNDLE] Could not retrieve file data for: ${doc.file}`);
                    continue;
                }

                const archiveName = ensureUniqueArchiveName(
                    composeDownloadFileName(doc.nameParts, fileData.extension || '.pdf')
                );

                console.log(`[ZIP BUNDLE] Adding file: ${archiveName} (Source: ${doc.file})`);
                archive.append(fileData.buffer, { name: archiveName });
            } catch (fileErr) {
                console.error(`[ZIP BUNDLE] Failed to add file ${doc.file}:`, fileErr);
            }
        }

        console.log('[ZIP BUNDLE] Finalizing archive...');
        await archive.finalize();
        console.log('[ZIP BUNDLE] Archive finalized successfully');
    } catch (error) {
        console.error('[ZIP BUNDLE ERROR]', error);
        console.error('[ZIP BUNDLE ERROR STACK]', error.stack);
        if (!res.headersSent) {
            res.status(500).json({ message: error.message });
        }
    }
};

const deleteApplication = async (req, res) => {
    try {
        const deleted = await Application.findById(req.params.id);
        if (!deleted) return res.status(404).json({ message: 'Application not found' });

        const filesToDelete = [
            deleted.admitCard,
            deleted.offerLetter,
            ...(deleted.offeredUniversities || []).flatMap((entry) => [
                entry?.admitCard,
                entry?.offerLetter,
            ]),
        ].filter(Boolean);

        await Application.findByIdAndDelete(req.params.id);
        for (const file of filesToDelete) {
            await deleteUploadedFile(file);
        }

        invalidateApplicationCaches();
        return res.json({ message: 'Application deleted successfully' });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getApplicants,
    getAdminApplicationsList,
    getAllApplicationsTotal,
    getMyApplications,
    applyToOpportunity,
    updateApplicationStatus,
    updateUniversityStatus,
    bulkUpdateStatus,
    resetOpportunityApplications,
    downloadApplicationDocument,
    downloadApplicationBundle,
    deleteApplication,
};
