const archiver = require('archiver');
const path = require('path');
const PDFDocument = require('pdfkit');
const Application = require('../models/Application');
const University = require('../models/University');
const Scholarship = require('../models/Scholarship');
const User = require('../models/User');
const {
    deleteUploadedFile,
    downloadStoredFile,
    normalizeDownloadName,
    openStoredFileStream,
    uploadToCloudinary,
} = require('../utils/uploadFileUtils');
const { enqueueJob } = require('../utils/jobQueue');
const { invalidateCacheByTags } = require('../middleware/responseCache');

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
    const startDate = parseStartDate(requestQuery.startDate);
    const endDate = parseEndDate(requestQuery.endDate);

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

        const userDocs = await User.find(userQuery)
            .select('_id')
            .limit(5000)
            .lean();
        const userIds = userDocs.map((item) => item._id);
        if (userIds.length === 0) {
            query.user = { $in: [] };
            return query;
        }
        query.user = { $in: userIds };
    }

    return query;
};

const findUniversityForAdmin = async (userId) =>
    University.findOne({ 'adminAccount.userId': userId }).select('_id name thumbnail logo').lean();

const findScholarshipForAdmin = async (userId) =>
    Scholarship.findOne({ 'adminAccount.userId': userId }).select('_id title thumbnail image').lean();

const assertInstitutionAccess = async (application, user) => {
    if (user.role === 'admin') return true;

    if (user.role === 'university') {
        const uni = await findUniversityForAdmin(user._id);
        if (!uni || String(application.university) !== String(uni._id)) return false;
        return true;
    }

    if (user.role === 'scholarship') {
        const scholarship = await findScholarshipForAdmin(user._id);
        if (!scholarship || String(application.scholarship) !== String(scholarship._id)) return false;
        return true;
    }

    if (user.role === 'user') {
        return String(application.user) === String(user._id);
    }

    return false;
};

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
                $slice: 200,
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

    if (!result.enqueued) {
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
    }
) => {
    const context = await getApplicationContextInfo(application);
    const mergedContext = { ...context, ...contextOverride };

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
            status: docLabel,
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
                admitCard: entry.admitCard || undefined,
                offerLetter: entry.offerLetter || undefined,
            };
        })
        .filter(Boolean);
};

const APPLICATION_DOC_LABEL_MAP = {
    admitCard: 'admit-card',
    offerLetter: 'offer-letter',
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
        } catch (_error) {
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

const toDateLabel = (value) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toISOString().slice(0, 10);
};

const toLineValue = (value) => {
    if (value == null) return '-';
    const str = String(value).trim();
    return str || '-';
};

const addSummaryHeading = (doc, title) => {
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text(title);
    doc.moveDown(0.2);
};

const addSummaryLine = (doc, label, value) => {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text(`${label}: `, {
        continued: true,
    });
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(toLineValue(value));
};

const addSummaryProgramLines = (doc, selectedPrograms = []) => {
    if (!Array.isArray(selectedPrograms) || selectedPrograms.length === 0) {
        addSummaryLine(doc, 'Selected Programs', '-');
        return;
    }

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Selected Programs:');
    selectedPrograms.forEach((program, index) => {
        const name = toLineValue(program?.programName || program?.name);
        const type = toLineValue(program?.programType || program?.type);
        const duration = toLineValue(program?.duration);
        doc.font('Helvetica').fontSize(10).text(
            `${index + 1}. ${name} | Level: ${type} | Duration: ${duration}`
        );
    });
};

const createApplicationSummaryPdfBuffer = async ({ application, user }) =>
    new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            margin: 40,
            info: {
                Title: 'Application Summary',
                Author: 'Sindh Backend',
            },
        });

        const chunks = [];
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const userName = user?.name || 'Applicant';
        const education = user?.education || {};
        const personalInfo = education?.personalInfo || {};
        const nationalId = education?.nationalId || {};
        const matric = education?.matric || {};
        const intermediate = education?.intermediate || {};
        const bachelor = education?.bachelor || {};
        const masters = education?.masters || {};
        const international = education?.international || {};
        const targetName =
            application?.type === 'University'
                ? application?.university?.name || '-'
                : application?.scholarship?.title || '-';

        doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text('Application Summary');
        doc
            .font('Helvetica')
            .fontSize(10)
            .fillColor('#374151')
            .text(`Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);

        addSummaryHeading(doc, 'Applicant');
        addSummaryLine(doc, 'Name', userName);
        addSummaryLine(doc, 'Email', user?.email);
        addSummaryLine(doc, 'Phone', user?.phone);
        addSummaryLine(doc, 'Country', user?.country || 'Pakistan');
        addSummaryLine(doc, 'State', user?.state);
        addSummaryLine(doc, 'City', user?.city);
        addSummaryLine(doc, 'Address', user?.address);

        addSummaryHeading(doc, 'Application');
        addSummaryLine(doc, 'Application ID', application?._id);
        addSummaryLine(doc, 'Type', application?.type);
        addSummaryLine(doc, 'Target', targetName);
        addSummaryLine(doc, 'Status', application?.status || 'Applied');
        addSummaryLine(doc, 'Applied At', toDateLabel(application?.appliedAt));
        addSummaryLine(doc, 'Test Date', toDateLabel(application?.testDate));
        addSummaryLine(doc, 'Interview Date', toDateLabel(application?.interviewDate));
        addSummaryProgramLines(doc, application?.selectedPrograms || []);

        addSummaryHeading(doc, 'Personal Documents');
        addSummaryLine(doc, 'Father Name', personalInfo?.fatherName || user?.fatherName);
        addSummaryLine(doc, 'Date of Birth', personalInfo?.dateOfBirth || user?.dateOfBirth);
        addSummaryLine(doc, 'National ID Number', nationalId?.idNumber || personalInfo?.cnicNumber);
        addSummaryLine(doc, 'Father CNIC Number', personalInfo?.fatherCnicNumber);
        addSummaryLine(doc, 'Father Contact Number', personalInfo?.fatherContactNumber);

        addSummaryHeading(doc, 'Matric');
        addSummaryLine(doc, 'School Name', matric?.schoolName);
        addSummaryLine(doc, 'Passing Year', matric?.passingYear);
        addSummaryLine(doc, 'Grade / CGPA', matric?.grade);

        addSummaryHeading(doc, 'Intermediate');
        addSummaryLine(doc, 'College Name', intermediate?.collegeName);
        addSummaryLine(doc, 'Passing Year', intermediate?.passingYear);
        addSummaryLine(doc, 'Grade / CGPA', intermediate?.grade);

        addSummaryHeading(doc, 'Bachelor');
        addSummaryLine(doc, 'Degree Name', bachelor?.degreeName);
        addSummaryLine(doc, 'Institute Name', bachelor?.collegeName || bachelor?.schoolName);
        addSummaryLine(doc, 'Passing Year', bachelor?.passingYear);
        addSummaryLine(doc, 'Grade / CGPA', bachelor?.grade);

        addSummaryHeading(doc, 'Masters');
        addSummaryLine(doc, 'Degree Name', masters?.degreeName);
        addSummaryLine(doc, 'Institute Name', masters?.collegeName || masters?.schoolName);
        addSummaryLine(doc, 'Passing Year', masters?.passingYear);
        addSummaryLine(doc, 'Grade / CGPA', masters?.grade);

        addSummaryHeading(doc, 'International');
        addSummaryLine(doc, 'Passport Number', international?.passportNumber);
        addSummaryLine(doc, 'English Test Type', international?.englishTestType);
        addSummaryLine(doc, 'English Test Score', international?.testScore);

        doc.end();
    });

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
            const uni = await findUniversityForAdmin(req.user._id);
            if (!uni || (type === 'university' && String(uni._id) !== id)) {
                return res.status(403).json({ message: 'Unauthorized access to applicants' });
            }
        } else if (req.user.role === 'scholarship') {
            if (type !== 'scholarship') {
                return res.status(403).json({ message: 'Unauthorized access to applicants' });
            }
            const scholarship = await findScholarshipForAdmin(req.user._id);
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
            populateApplicationQuery(
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
            const uni = await findUniversityForAdmin(req.user._id);
            if (!uni) return res.json({ data: [] });
            baseQuery = { university: uni._id };
        } else if (req.user.role === 'scholarship') {
            const scholarship = await findScholarshipForAdmin(req.user._id);
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

        if (type === 'University') {
            const university = await University.findById(targetId).select('_id name');
            if (!university) return res.status(404).json({ message: 'University not found' });
        } else {
            const scholarship = await Scholarship.findById(targetId).select('_id title');
            if (!scholarship) return res.status(404).json({ message: 'Scholarship not found' });
        }

        const duplicateQuery =
            type === 'University'
                ? { user: req.user._id, university: targetId }
                : { user: req.user._id, scholarship: targetId };

        const already = await Application.findOne(duplicateQuery).lean();
        if (already) {
            return res.status(400).json({ message: `You have already applied for this ${type.toLowerCase()}.` });
        }

        const selectedPrograms = normalizeSelectedPrograms(
            parsePossibleJSON(req.body.selectedPrograms, req.body.selectedPrograms)
        );

        let application;
        try {
            application = await Application.create({
                user: req.user._id,
                university: type === 'University' ? targetId : undefined,
                scholarship: type === 'Scholarship' ? targetId : undefined,
                type,
                status: 'Applied',
                selectedPrograms,
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
                updateData.admitCard = await uploadToCloudinary(req.files.admitCard[0].path, [
                    userName,
                    entityName,
                    normalizeDocTag('admit-card'),
                ]);
                if (!updateData.admitCard) {
                    throw new Error('Failed to upload admit card');
                }
            }
            if (req.files.offerLetter?.[0]) {
                updateData.offerLetter = await uploadToCloudinary(req.files.offerLetter[0].path, [
                    userName,
                    entityName,
                    normalizeDocTag('offer-letter'),
                ]);
                if (!updateData.offerLetter) {
                    throw new Error('Failed to upload offer letter');
                }
            }
        }

        Object.entries(updateData).forEach(([key, value]) => {
            if (typeof value === 'undefined') return;
            if (value === '' && ['testDate', 'interviewDate', 'admitCard', 'offerLetter'].includes(key)) {
                application[key] = undefined;
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
            });
        }
        if (application.offerLetter && application.offerLetter !== previousOfferLetter) {
            await emitApplicationDocumentNotification(application, {
                docLabel: 'Offer Letter',
                entityType: info.entityType,
                entityId: info.entityId,
                entityName: info.entityName,
                entityThumbnail: info.entityThumbnail,
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
            (req.body.admitCard === null ||
                req.body.admitCard === '' ||
                String(req.body.admitCard).toLowerCase() === 'null');
        const shouldClearOfferLetter =
            Object.prototype.hasOwnProperty.call(req.body || {}, 'offerLetter') &&
            (req.body.offerLetter === null ||
                req.body.offerLetter === '' ||
                String(req.body.offerLetter).toLowerCase() === 'null');

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
                offered.admitCard = await uploadToCloudinary(req.files.admitCard[0].path, [
                    applicantName,
                    uniName,
                    normalizeDocTag('admit-card'),
                ]);
                if (!offered.admitCard) {
                    throw new Error('Failed to upload admit card');
                }
            }
            if (req.files.offerLetter?.[0]) {
                offered.offerLetter = await uploadToCloudinary(req.files.offerLetter[0].path, [
                    applicantName,
                    uniName,
                    normalizeDocTag('offer-letter'),
                ]);
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

const resolveDocFile = (application, field, uniId) => {
    if (uniId) {
        const offered = (application.offeredUniversities || []).find(
            (entry) => toObjectIdString(entry.university) === toObjectIdString(uniId)
        );
        return {
            file: offered?.[field] || '',
            offered,
        };
    }

    return {
        file: application[field] || '',
        offered: null,
    };
};

const buildDownloadDocCandidates = (application, field, requestedUniId) => {
    const normalizedUniId = toObjectIdString(requestedUniId);
    const candidates = [];
    const seen = new Set();

    const addCandidate = ({ file, uniId = '', offeredEntry = null }) => {
        const normalizedFile = String(file || '').trim();
        if (!normalizedFile || seen.has(normalizedFile)) return;
        seen.add(normalizedFile);
        candidates.push({
            file: normalizedFile,
            uniId: toObjectIdString(uniId),
            offeredEntry,
        });
    };

    if (normalizedUniId) {
        const { file, offered } = resolveDocFile(application, field, normalizedUniId);
        addCandidate({
            file,
            uniId: normalizedUniId,
            offeredEntry: offered || null,
        });
    }

    addCandidate({
        file: application?.[field] || '',
        uniId: '',
        offeredEntry: null,
    });

    return candidates;
};

const buildApplicationDocFallbackName = async ({
    application,
    field,
    uniId,
    offeredEntry,
    sourceFile,
}) => {
    const user = await User.findById(application.user).select('name').lean();
    const docLabel = APPLICATION_DOC_LABEL_MAP[field] || sanitizeFilePart(field, 'document');
    const userLabel = sanitizeFilePart(user?.name || 'applicant', 'applicant');
    const applicationLabel = sanitizeFilePart(
        toObjectIdString(application?._id),
        'application'
    );

    let universityLabel = '';
    if (uniId) {
        if (offeredEntry?.university && typeof offeredEntry.university === 'object') {
            universityLabel = sanitizeFilePart(offeredEntry.university.name || 'university', '');
        } else {
            const university = await University.findById(uniId).select('name').lean();
            universityLabel = sanitizeFilePart(university?.name || 'university', '');
        }
    }

    const extension = extractFileExtension(sourceFile, '.pdf');
    return composeDownloadFileName(
        [userLabel, applicationLabel, universityLabel, docLabel].filter(Boolean),
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

        const application = await Application.findById(id);
        if (!application) return res.status(404).json({ message: 'Application not found' });

        const allowed = await assertInstitutionAccess(application, req.user);
        if (!allowed) return res.status(403).json({ message: 'Unauthorized' });

        const candidates = buildDownloadDocCandidates(
            application,
            field,
            requestedUniId
        );
        if (!candidates.length) {
            return res.status(404).json({ message: 'Document not found' });
        }

        const safeDownloadName = normalizeDownloadName(downloadName);
        for (const candidate of candidates) {
            const fallbackName = await buildApplicationDocFallbackName({
                application,
                field,
                uniId: candidate.uniId,
                offeredEntry: candidate.offeredEntry,
                sourceFile: candidate.file,
            });
            const sent = await downloadStoredFile(
                res,
                candidate.file,
                safeDownloadName || fallbackName
            );
            if (sent) return null;
        }
        return res.status(404).json({ message: 'File does not exist on server' });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// @desc    Download zip bundle of all available application docs
// @route   GET /api/applications/:id/download-bundle
// @access  Private
const downloadApplicationBundle = async (req, res) => {
    try {
        const application = await Application.findById(req.params.id)
            .populate('offeredUniversities.university')
            .populate('university', 'name')
            .populate('scholarship', 'title');
        if (!application) return res.status(404).json({ message: 'Application not found' });

        const allowed = await assertInstitutionAccess(application, req.user);
        if (!allowed) return res.status(403).json({ message: 'Unauthorized' });

        const docs = [];
        const seenFiles = new Set();
        const addDoc = (file, nameParts = []) => {
            const normalizedFile = String(file || '').trim();
            if (!normalizedFile || seenFiles.has(normalizedFile)) return;
            seenFiles.add(normalizedFile);
            docs.push({ file: normalizedFile, nameParts });
        };

        const user = await User.findById(application.user)
            .select(
                [
                    'name',
                    'email',
                    'phone',
                    'country',
                    'state',
                    'city',
                    'address',
                    'fatherName',
                    'dateOfBirth',
                    'education',
                ].join(' ')
            )
            .lean();

        const userLabel = sanitizeFilePart(user?.name || 'applicant', 'applicant');
        addDoc(application.admitCard, [userLabel, 'application', 'admit-card']);
        addDoc(application.offerLetter, [userLabel, 'application', 'offer-letter']);

        (application.offeredUniversities || []).forEach((entry) => {
            const uniName = sanitizeFilePart(
                entry.university?.name || toObjectIdString(entry.university) || 'university',
                'university'
            );
            addDoc(entry.admitCard, [userLabel, uniName, 'admit-card']);
            addDoc(entry.offerLetter, [userLabel, uniName, 'offer-letter']);
        });

        const education = user?.education || {};
        EDUCATION_DOC_SPEC.forEach((spec) => {
            const file = getNestedValue(education, spec.path);
            addDoc(file, [userLabel, spec.key]);
        });

        const usedArchiveNames = new Set();
        const ensureUniqueArchiveName = (rawName) => {
            const ext = path.extname(rawName);
            const baseName = ext ? rawName.slice(0, -ext.length) : rawName;
            let candidate = rawName;
            let index = 2;
            while (usedArchiveNames.has(candidate)) {
                candidate = `${baseName}-${index}${ext}`;
                index += 1;
            }
            usedArchiveNames.add(candidate);
            return candidate;
        };

        const summaryBuffer = await createApplicationSummaryPdfBuffer({
            application,
            user,
        });
        const hasSummary = Boolean(summaryBuffer?.length);
        if (!hasSummary && docs.length === 0) {
            return res.status(404).json({ message: 'No documents available for bundle' });
        }

        const requestedBundleName = normalizeDownloadName(req.query.downloadName);
        const fallbackBundleName = composeDownloadFileName(
            [userLabel, 'application', toObjectIdString(application._id), 'bundle'],
            '.zip'
        );
        const bundleName = requestedBundleName
            ? requestedBundleName.toLowerCase().endsWith('.zip')
                ? requestedBundleName
                : `${requestedBundleName}.zip`
            : fallbackBundleName;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${bundleName}"`
        );

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('warning', () => {});
        archive.on('error', (err) => {
            if (!res.headersSent) {
                res.status(500).json({ message: 'Failed to create ZIP bundle' });
                return;
            }
            res.destroy(err);
        });

        archive.pipe(res);

        if (hasSummary) {
            const summaryName = ensureUniqueArchiveName(
                composeDownloadFileName([userLabel, 'application-summary'], '.pdf')
            );
            archive.append(summaryBuffer, { name: summaryName });
        }

        for (const doc of docs) {
            const fileData = await openStoredFileStream(doc.file);
            if (!fileData?.stream) continue;
            const ext = extractFileExtension(fileData.fileName || doc.file, '.pdf');
            const archiveName = ensureUniqueArchiveName(
                composeDownloadFileName(doc.nameParts, ext)
            );
            archive.append(fileData.stream, { name: archiveName });
        }

        await archive.finalize();
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// @desc    Delete application
// @route   DELETE /api/applications/:id
// @access  Private/Admin
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
    downloadApplicationDocument,
    downloadApplicationBundle,
    deleteApplication,
};
