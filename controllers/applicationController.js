const archiver = require('archiver');
const Application = require('../models/Application');
const University = require('../models/University');
const Scholarship = require('../models/Scholarship');
const User = require('../models/User');
const {
    deleteUploadedFile,
    downloadStoredFile,
    normalizeDownloadName,
    readStoredFileBuffer,
    uploadToCloudinary,
} = require('../utils/uploadFileUtils');

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

    await pushNotificationToUser(application.user, {
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
    });
};

const emitApplicationSubmitNotification = async (application) => {
    const info = await getEntityInfoForApplication(application);
    const context = await getApplicationContextInfo(application);

    await pushNotificationToUser(application.user, {
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
    });
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

    await pushNotificationToUser(application.user, {
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
    });
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
            const uni = await findUniversityForAdmin(req.user._id);
            if (!uni || (type === 'university' && String(uni._id) !== id)) {
                return res.status(403).json({ message: 'Unauthorized access to applicants' });
            }
        } else if (req.user.role === 'scholarship') {
            const scholarship = await findScholarshipForAdmin(req.user._id);
            if (!scholarship || (type === 'scholarship' && String(scholarship._id) !== id)) {
                return res.status(403).json({ message: 'Unauthorized access to applicants' });
            }
        }

        const query = type === 'university' ? { university: id } : { scholarship: id };
        const applicants = await populateApplicationQuery(Application.find(query).sort('-appliedAt')).lean();

        return res.json({ data: applicants });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// @desc    Get all applications for admin applications page
// @route   GET /api/applications/admin/list
// @access  Private
const getAdminApplicationsList = async (req, res) => {
    try {
        let query = {};

        if (req.user.role === 'university') {
            const uni = await findUniversityForAdmin(req.user._id);
            if (!uni) return res.json({ data: [] });
            query = { university: uni._id };
        } else if (req.user.role === 'scholarship') {
            const scholarship = await findScholarshipForAdmin(req.user._id);
            if (!scholarship) return res.json({ data: [] });
            query = { scholarship: scholarship._id };
        }

        const page = toPositiveInt(req.query.page, 1);
        const limit = Math.min(toPositiveInt(req.query.limit, 20), 100);
        const shouldPaginate = Boolean(req.query.page) || Boolean(req.query.limit);

        if (!shouldPaginate) {
            const apps = await populateAdminApplicationListQuery(
                Application.find(query)
                    .select(ADMIN_APPLICATION_LIST_SELECT)
                    .sort('-appliedAt')
            ).lean();
            return res.json({ data: apps });
        }

        const skip = (page - 1) * limit;
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
        const apps = await populateApplicationQuery(
            Application.find({ user: req.user._id }).sort('-appliedAt')
        ).lean();

        return res.json({ data: apps });
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
            await pushNotificationToUser(application.user, {
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
            });
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
        return offered?.[field] || '';
    }

    return application[field] || '';
};

// @desc    Download document from application
// @route   GET /api/applications/:id/download-doc/:field
// @access  Private
const downloadApplicationDocument = async (req, res) => {
    try {
        const { id, field } = req.params;
        const { uniId, downloadName } = req.query;

        if (!['admitCard', 'offerLetter'].includes(field)) {
            return res.status(400).json({ message: 'Invalid document field' });
        }

        const application = await Application.findById(id);
        if (!application) return res.status(404).json({ message: 'Application not found' });

        const allowed = await assertInstitutionAccess(application, req.user);
        if (!allowed) return res.status(403).json({ message: 'Unauthorized' });

        const filename = resolveDocFile(application, field, uniId);
        if (!filename) return res.status(404).json({ message: 'Document not found' });

        const safeDownloadName = normalizeDownloadName(downloadName);
        const sent = await downloadStoredFile(
            res,
            filename,
            safeDownloadName || ''
        );
        if (!sent) {
            return res.status(404).json({ message: 'File does not exist on server' });
        }
        return null;
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

// @desc    Download zip bundle of all available application docs
// @route   GET /api/applications/:id/download-bundle
// @access  Private
const downloadApplicationBundle = async (req, res) => {
    try {
        const application = await Application.findById(req.params.id).populate('offeredUniversities.university');
        if (!application) return res.status(404).json({ message: 'Application not found' });

        const allowed = await assertInstitutionAccess(application, req.user);
        if (!allowed) return res.status(403).json({ message: 'Unauthorized' });

        const docs = [];
        const seenFiles = new Set();
        const addDoc = (namePrefix, file) => {
            if (!file || seenFiles.has(file)) return;
            seenFiles.add(file);
            docs.push({ name: `${namePrefix}-${file}`, file });
        };

        addDoc('main-admit', application.admitCard);
        addDoc('main-offer', application.offerLetter);

        (application.offeredUniversities || []).forEach((entry) => {
            const uniName = (entry.university?.name || toObjectIdString(entry.university) || 'university')
                .replace(/[^a-zA-Z0-9_-]/g, '-')
                .slice(0, 40);

            addDoc(`${uniName}-admit`, entry.admitCard);
            addDoc(`${uniName}-offer`, entry.offerLetter);
        });

        const user = await User.findById(application.user)
            .select('education')
            .lean();
        const education = user?.education || {};
        addDoc('applicant-cnic', education?.nationalId?.file);
        addDoc('applicant-matric-transcript', education?.matric?.transcript);
        addDoc('applicant-matric-certificate', education?.matric?.certificate);
        addDoc('applicant-intermediate-transcript', education?.intermediate?.transcript);
        addDoc('applicant-intermediate-certificate', education?.intermediate?.certificate);
        addDoc('applicant-bachelor-transcript', education?.bachelor?.transcript);
        addDoc('applicant-bachelor-certificate', education?.bachelor?.certificate);
        addDoc('applicant-masters-transcript', education?.masters?.transcript);
        addDoc('applicant-masters-certificate', education?.masters?.certificate);
        addDoc('applicant-passport', education?.international?.passportPdf);
        addDoc('applicant-test-transcript', education?.international?.testTranscript);
        addDoc('applicant-cv', education?.international?.cv);
        addDoc('applicant-recommendation', education?.international?.recommendationLetter);

        const existingDocs = [];
        for (const doc of docs) {
            const fileData = await readStoredFileBuffer(doc.file);
            if (!fileData) continue;
            existingDocs.push({
                ...doc,
                buffer: fileData.buffer,
                fileName: normalizeDownloadName(fileData.fileName) || 'document',
            });
        }

        if (existingDocs.length === 0) {
            return res.status(404).json({ message: 'No documents available for bundle' });
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="application-${application._id}-docs.zip"`
        );

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', (err) => {
            throw err;
        });

        archive.pipe(res);
        existingDocs.forEach((doc) =>
            archive.append(doc.buffer, {
                name: `${doc.name}-${doc.fileName}`,
            })
        );
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
