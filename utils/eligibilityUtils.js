const NULLISH_TEXT_VALUES = new Set([
    '',
    'null',
    'undefined',
    'n/a',
    'na',
    'none',
    'nil',
    '-',
    '""',
    "''",
]);

const asObject = (value) =>
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const cleanText = (value) => String(value ?? '').trim();

const hasValue = (value) => {
    if (value == null) return false;
    const normalized = cleanText(value).toLowerCase();
    return !NULLISH_TEXT_VALUES.has(normalized);
};

const parseDate = (value) => {
    if (!hasValue(value)) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
};

const parsePercentage = (value) => {
    if (!hasValue(value)) return null;

    const raw = cleanText(value);
    const numberMatch = raw.match(/-?\d+(\.\d+)?/);
    if (!numberMatch) return null;

    const parsed = Number.parseFloat(numberMatch[0]);
    if (!Number.isFinite(parsed) || parsed < 0) return null;

    const lowered = raw.toLowerCase();
    const hasPercentSign = lowered.includes('%');
    const hasGpaHint = lowered.includes('gpa') || lowered.includes('cgpa');

    if (hasPercentSign) {
        return Math.min(parsed, 100);
    }

    if (hasGpaHint && parsed <= 4.2) {
        return Math.min((parsed / 4) * 100, 100);
    }
    if (hasGpaHint && parsed <= 5.1) {
        return Math.min((parsed / 5) * 100, 100);
    }

    if (parsed <= 1) {
        return parsed * 100;
    }
    if (parsed <= 5) {
        return Math.min(parsed * 20, 100);
    }
    return Math.min(parsed, 100);
};

const parseRequiredPercentage = (value) => {
    if (value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.min(value, 100));
    }
    return parsePercentage(value);
};

const levelKeywords = {
    phd: ['phd', 'doctor', 'doctoral', 'doctorate'],
    master: ['master', 'ms', 'msc', 'mphil', 'postgraduate', 'pg'],
    bachelor: [
        'bachelor',
        'bs',
        'ba',
        'bsc',
        'undergraduate',
        'ug',
        'llb',
    ],
};

const normalizeProgramLevel = (rawType, fallbackName = '') => {
    const text = `${cleanText(rawType).toLowerCase()} ${cleanText(
        fallbackName
    ).toLowerCase()}`;

    if (levelKeywords.phd.some((keyword) => text.includes(keyword))) {
        return 'phd';
    }
    if (levelKeywords.master.some((keyword) => text.includes(keyword))) {
        return 'master';
    }
    return 'bachelor';
};

const resolveProgramLevel = ({ selectedPrograms = [], opportunity = {} }) => {
    const firstProgram =
        Array.isArray(selectedPrograms) && selectedPrograms.length > 0
            ? asObject(selectedPrograms[0])
            : null;

    const selectedType =
        firstProgram?.programType || firstProgram?.type || firstProgram?.level;
    const selectedName = firstProgram?.programName || firstProgram?.name || '';
    if (hasValue(selectedType) || hasValue(selectedName)) {
        return normalizeProgramLevel(selectedType, selectedName);
    }

    const opportunityPrograms = Array.isArray(opportunity.programs)
        ? opportunity.programs
        : [];
    const firstOpportunityProgram = asObject(opportunityPrograms[0]);
    const opportunityType =
        firstOpportunityProgram.type || firstOpportunityProgram.programType || '';
    const opportunityName =
        firstOpportunityProgram.name || firstOpportunityProgram.programName || '';

    return normalizeProgramLevel(opportunityType, opportunityName);
};

const hasAcademicData = (education = {}, sectionKey = '', requireDegree = false) => {
    const section = asObject(education[sectionKey]);
    const hasDoc = hasValue(section.transcript) || hasValue(section.certificate);
    const hasInstitute =
        hasValue(section.schoolName) ||
        hasValue(section.collegeName) ||
        hasValue(section.instituteName);
    const hasYear = hasValue(section.passingYear);
    const hasGrade = hasValue(section.grade);
    const hasDegree = !requireDegree || hasValue(section.degreeName);
    return hasDoc && hasInstitute && hasYear && hasGrade && hasDegree;
};

const missingDocumentsForLevel = (education = {}, level = 'bachelor') => {
    const normalizedEducation = asObject(education);
    const personalInfo = asObject(normalizedEducation.personalInfo);
    const nationalId = asObject(normalizedEducation.nationalId);
    const missing = [];

    const hasPersonalInfo =
        hasValue(personalInfo.fatherName) &&
        hasValue(personalInfo.fatherContactNumber) &&
        hasValue(personalInfo.dateOfBirth);
    if (!hasPersonalInfo) {
        missing.push('Personal Information');
    }

    if (!hasValue(nationalId.file)) {
        missing.push('National ID PDF');
    }

    if (!hasAcademicData(normalizedEducation, 'matric', false)) {
        missing.push('Matric Documents & Details');
    }
    if (!hasAcademicData(normalizedEducation, 'intermediate', false)) {
        missing.push('Intermediate Documents & Details');
    }

    if (level === 'master' || level === 'phd') {
        if (!hasAcademicData(normalizedEducation, 'bachelor', true)) {
            missing.push('Bachelor Documents & Details');
        }
    }

    if (level === 'phd') {
        if (!hasAcademicData(normalizedEducation, 'masters', true)) {
            missing.push('Master Documents & Details');
        }
    }

    return missing;
};

const extractUserPercentageByLevel = (education = {}, level = 'bachelor') => {
    const normalizedEducation = asObject(education);
    const lookupOrder =
        level === 'phd'
            ? ['masters', 'bachelor', 'intermediate', 'matric']
            : level === 'master'
            ? ['bachelor', 'intermediate', 'matric']
            : ['intermediate', 'matric'];

    for (const sectionKey of lookupOrder) {
        const section = asObject(normalizedEducation[sectionKey]);
        const percentage = parsePercentage(section.grade);
        if (percentage != null) {
            return { percentage, source: `${sectionKey}.grade` };
        }
    }
    return { percentage: null, source: '' };
};

const getGradeFromSource = (education = {}, source = '') => {
    if (!source) return '';
    const parts = String(source).split('.');
    if (parts.length !== 2) return '';
    const section = asObject(education[parts[0]]);
    return cleanText(section[parts[1]]);
};

const extractRequiredPercentage = (type = '', opportunity = {}) => {
    const normalizedType = cleanText(type).toLowerCase();
    if (normalizedType === 'scholarship') {
        const eligibility = asObject(opportunity.eligibility);
        return (
            parseRequiredPercentage(eligibility.minPercentage) ??
            parseRequiredPercentage(eligibility.description)
        );
    }
    return parseRequiredPercentage(opportunity.eligibility);
};

const isOpportunityClosed = (opportunity = {}) => {
    const isActive = opportunity.isActive !== false;
    const deadlineDate = parseDate(opportunity.deadline);
    const deadlinePassed =
        deadlineDate != null && deadlineDate.getTime() < Date.now();
    return {
        isActive,
        deadlineDate,
        deadlinePassed,
        isClosed: !isActive || deadlinePassed,
    };
};

const evaluateOpportunityForUser = ({
    type = '',
    opportunity = {},
    education = {},
    selectedPrograms = [],
}) => {
    const level = resolveProgramLevel({
        selectedPrograms,
        opportunity,
    });
    const documentMissing = missingDocumentsForLevel(education, level);
    const { percentage: userPercentage, source: userPercentageSource } =
        extractUserPercentageByLevel(education, level);
    const requiredPercentage = extractRequiredPercentage(type, opportunity);
    const closedInfo = isOpportunityClosed(opportunity);

    const reasons = [];
    let status = 'eligible';

    if (closedInfo.isClosed) {
        status = 'closed';
        if (!closedInfo.isActive) {
            reasons.push('Admissions are currently inactive for this opportunity.');
        }
        if (closedInfo.deadlinePassed) {
            reasons.push('Application deadline has already passed.');
        }
    }

    if (status !== 'closed' && documentMissing.length > 0) {
        status = 'needs_documents';
        reasons.push(`Missing documents: ${documentMissing.join(', ')}`);
    }

    if (status !== 'closed') {
        if (requiredPercentage != null && userPercentage == null) {
            status = 'needs_marks';
            reasons.push(
                `Required merit is ${requiredPercentage.toFixed(
                    1
                )}% but your academic percentage is missing.`
            );
        } else if (
            requiredPercentage != null &&
            userPercentage != null &&
            userPercentage < requiredPercentage
        ) {
            status = 'not_eligible';
            reasons.push(
                `Required merit ${requiredPercentage.toFixed(
                    1
                )}% is higher than your ${userPercentage.toFixed(1)}%.`
            );
        }
    }

    if (reasons.length === 0) {
        reasons.push('Profile matches core requirements.');
    }

    const canApply = status === 'eligible';

    return {
        canApply,
        status,
        reasons,
        programLevel: level,
        requiredPercentage,
        userPercentage,
        userPercentageSource,
        documentValidation: {
            complete: documentMissing.length === 0,
            missing: documentMissing,
        },
        closed: closedInfo,
    };
};

const safeEntityName = (type, opportunity = {}) => {
    const normalizedType = cleanText(type).toLowerCase();
    if (normalizedType === 'scholarship') {
        return cleanText(opportunity.title) || 'Scholarship';
    }
    return cleanText(opportunity.name) || 'University';
};

const normalizeLocation = (entity = {}) => {
    const city = cleanText(entity.city);
    const state = cleanText(entity.state);
    const country = cleanText(entity.country);
    const parts = [city, state, country].filter(Boolean);
    return parts.join(', ');
};

const toProgramHighlights = (entity = {}) => {
    const programs = Array.isArray(entity.programs) ? entity.programs : [];
    return programs
        .map((raw) => asObject(raw))
        .map((program) => {
            const name = cleanText(program.name || program.programName);
            const type = cleanText(program.type || program.programType);
            if (!name) return '';
            return type ? `${name} (${type})` : name;
        })
        .filter(Boolean)
        .slice(0, 3);
};

const toContactSummary = (entity = {}) => {
    const contact = cleanText(entity.contact);
    if (contact) return contact;

    const info = Array.isArray(entity.contactInfo) ? entity.contactInfo : [];
    for (const raw of info) {
        const entry = asObject(raw);
        if (hasValue(entry.email)) return cleanText(entry.email);
        if (hasValue(entry.phone)) return cleanText(entry.phone);
    }
    return '';
};

const scoreEvaluation = (evaluation) => {
    let score = 50;

    switch (evaluation.status) {
        case 'eligible':
            score += 45;
            break;
        case 'needs_documents':
            score += 22;
            break;
        case 'needs_marks':
            score += 18;
            break;
        case 'not_eligible':
            score += 12;
            break;
        case 'closed':
            score -= 20;
            break;
        default:
            break;
    }

    if (evaluation.requiredPercentage != null && evaluation.userPercentage != null) {
        const delta = evaluation.userPercentage - evaluation.requiredPercentage;
        score += Math.max(-15, Math.min(20, delta / 2));
    }

    score -= evaluation.documentValidation.missing.length * 4;
    return Math.max(0, Math.min(100, Math.round(score)));
};

const toSuggestionCard = ({ type, entity = {}, evaluation }) => {
    const normalizedType = cleanText(type).toLowerCase();
    const title = safeEntityName(type, entity);
    const deadline = cleanText(entity.deadline);
    const subtitle =
        normalizeLocation(entity) ||
        cleanText(entity.provider) ||
        cleanText(entity.university_name);
    const applicationFee =
        cleanText(entity.applicationFee) ||
        cleanText(entity.applicationFees) ||
        cleanText(entity.amount);
    const contactSummary = toContactSummary(entity);
    const programHighlights = toProgramHighlights(entity);

    return {
        entityType: normalizedType,
        entityId: cleanText(entity._id),
        title,
        subtitle,
        deadline,
        applicationFee,
        contactSummary,
        programHighlights,
        matchScore: scoreEvaluation(evaluation),
        status: evaluation.status,
        reasons: evaluation.reasons.slice(0, 3),
        route: {
            screen:
                normalizedType === 'scholarship'
                    ? 'scholarship_detail_screen'
                    : 'university_detail_screen',
        },
    };
};

const normalizeApplicationType = (value = '') => {
    const normalized = cleanText(value).toLowerCase();
    return normalized === 'scholarship' ? 'scholarship' : 'university';
};

const normalizeProgramEntry = (program = {}) => {
    const normalized = asObject(program);
    const programName = cleanText(
        normalized.programName || normalized.name || 'General'
    );
    const programType = cleanText(
        normalized.programType || normalized.type || normalized.level
    );
    return {
        programName: programName || 'General',
        programType,
    };
};

const resolveApplicationPrograms = (application = {}, opportunity = {}) => {
    const selectedPrograms = Array.isArray(application.selectedPrograms)
        ? application.selectedPrograms
        : [];
    if (selectedPrograms.length > 0) {
        return selectedPrograms.map(normalizeProgramEntry);
    }

    const opportunityPrograms = Array.isArray(opportunity.programs)
        ? opportunity.programs
        : [];
    if (opportunityPrograms.length > 0) {
        const first = normalizeProgramEntry(opportunityPrograms[0]);
        return [first];
    }
    return [{ programName: 'General', programType: '' }];
};

const buildMeritInsights = ({
    applications = [],
    includeStudent = false,
} = {}) => {
    const selectedApplications = (Array.isArray(applications) ? applications : []).filter(
        (application) => cleanText(application?.status).toLowerCase() === 'selected'
    );

    const groups = new Map();

    for (const rawApplication of selectedApplications) {
        const application = asObject(rawApplication);
        const type = normalizeApplicationType(application.type);
        const opportunity =
            type === 'scholarship'
                ? asObject(application.scholarship)
                : asObject(application.university);

        const institutionId = cleanText(opportunity._id);
        const institutionName = safeEntityName(type, opportunity);
        if (!institutionId || !institutionName) {
            continue;
        }

        const education = asObject(
            application.educationSnapshot || application.user?.education || {}
        );

        const selectedAtRaw =
            application.updatedAt || application.appliedAt || new Date();
        const selectedAt = parseDate(selectedAtRaw) || new Date();

        const student = asObject(application.user);
        const studentName = cleanText(student.name);
        const studentEmail = cleanText(student.email);

        const programs = resolveApplicationPrograms(application, opportunity);
        for (const program of programs) {
            const programName = cleanText(program.programName) || 'General';
            const programType = cleanText(program.programType);
            const level = normalizeProgramLevel(programType, programName);
            const percentageInfo = extractUserPercentageByLevel(education, level);
            const userPercentage = percentageInfo.percentage;
            const userGrade = getGradeFromSource(education, percentageInfo.source);

            const key = [
                type,
                institutionId,
                programName.toLowerCase(),
                programType.toLowerCase(),
            ].join('|');

            const existing =
                groups.get(key) ||
                {
                    entityType: type,
                    institutionId,
                    institutionName,
                    programName,
                    programType,
                    totalSelected: 0,
                    closingMeritPercentage: null,
                    latestSelectedAt: '',
                    lastSelectedPercentage: null,
                    lastSelectedGrade: '',
                    lastSelectedStudentName: '',
                    lastSelectedStudentEmail: '',
                };

            existing.totalSelected += 1;

            if (userPercentage != null) {
                if (
                    existing.closingMeritPercentage == null ||
                    userPercentage < existing.closingMeritPercentage
                ) {
                    existing.closingMeritPercentage = userPercentage;
                }
            }

            const existingLatest = parseDate(existing.latestSelectedAt);
            if (!existingLatest || selectedAt.getTime() >= existingLatest.getTime()) {
                existing.latestSelectedAt = selectedAt.toISOString();
                existing.lastSelectedPercentage = userPercentage;
                existing.lastSelectedGrade = userGrade;
                if (includeStudent) {
                    existing.lastSelectedStudentName = studentName;
                    existing.lastSelectedStudentEmail = studentEmail;
                }
            }

            groups.set(key, existing);
        }
    }

    return [...groups.values()]
        .sort((a, b) => {
            const dateA = parseDate(a.latestSelectedAt)?.getTime() || 0;
            const dateB = parseDate(b.latestSelectedAt)?.getTime() || 0;
            return dateB - dateA;
        })
        .map((item) => ({
            ...item,
            closingMeritPercentage:
                item.closingMeritPercentage == null
                    ? null
                    : Number(item.closingMeritPercentage.toFixed(2)),
            lastSelectedPercentage:
                item.lastSelectedPercentage == null
                    ? null
                    : Number(item.lastSelectedPercentage.toFixed(2)),
            lastSelectedStudentName: includeStudent
                ? item.lastSelectedStudentName
                : '',
            lastSelectedStudentEmail: includeStudent
                ? item.lastSelectedStudentEmail
                : '',
        }));
};

const buildSuggestionsForUser = ({
    universities = [],
    scholarships = [],
    education = {},
    maxUniversities = 6,
    maxScholarships = 6,
}) => {
    const uniSuggestions = (Array.isArray(universities) ? universities : [])
        .map((uni) => {
            const evaluation = evaluateOpportunityForUser({
                type: 'university',
                opportunity: asObject(uni),
                education,
                selectedPrograms: [],
            });
            return toSuggestionCard({
                type: 'university',
                entity: asObject(uni),
                evaluation,
            });
        })
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, maxUniversities);

    const scholarshipSuggestions = (
        Array.isArray(scholarships) ? scholarships : []
    )
        .map((scholarship) => {
            const evaluation = evaluateOpportunityForUser({
                type: 'scholarship',
                opportunity: asObject(scholarship),
                education,
                selectedPrograms: [],
            });
            return toSuggestionCard({
                type: 'scholarship',
                entity: asObject(scholarship),
                evaluation,
            });
        })
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, maxScholarships);

    return {
        universities: uniSuggestions,
        scholarships: scholarshipSuggestions,
        all: [...uniSuggestions, ...scholarshipSuggestions].sort(
            (a, b) => b.matchScore - a.matchScore
        ),
    };
};

const buildDecisionReasons = ({ status, evaluation, targetName }) => {
    const normalizedStatus = cleanText(status).toLowerCase() || 'applied';

    if (normalizedStatus === 'selected') {
        return [
            `Congratulations! You are selected for ${targetName}.`,
            'Your application cleared all review stages.',
        ];
    }

    if (normalizedStatus === 'rejected') {
        const reasons = [];
        if (evaluation.documentValidation.missing.length > 0) {
            reasons.push(
                `Missing documents were found: ${evaluation.documentValidation.missing.join(
                    ', '
                )}.`
            );
        }
        if (
            evaluation.requiredPercentage != null &&
            evaluation.userPercentage != null &&
            evaluation.userPercentage < evaluation.requiredPercentage
        ) {
            reasons.push(
                `Merit requirement was ${evaluation.requiredPercentage.toFixed(
                    1
                )}% while profile showed ${evaluation.userPercentage.toFixed(1)}%.`
            );
        } else if (
            evaluation.requiredPercentage != null &&
            evaluation.userPercentage == null
        ) {
            reasons.push(
                `Required merit is ${evaluation.requiredPercentage.toFixed(
                    1
                )}% but grade percentage was unavailable.`
            );
        }
        if (reasons.length === 0) {
            reasons.push(
                'Application was reviewed but selection did not happen due seat competition or policy criteria.'
            );
        }
        return reasons;
    }

    if (normalizedStatus === 'interview') {
        return [
            `Application is in interview stage for ${targetName}.`,
            'Final selection is pending after interview review.',
        ];
    }
    if (normalizedStatus === 'test') {
        return [
            `Application is in test stage for ${targetName}.`,
            'Selection will be decided after test results are finalized.',
        ];
    }
    if (normalizedStatus === 'admit card') {
        return [
            `Admit card stage is active for ${targetName}.`,
            'Complete test/interview steps for final decision.',
        ];
    }

    return [
        `Application is currently in ${status || 'Applied'} stage for ${targetName}.`,
        'Selection decision has not been finalized yet.',
    ];
};

const buildApplicationDiagnostics = ({
    applications = [],
    fallbackEducation = {},
}) => {
    const normalizedApplications = Array.isArray(applications) ? applications : [];
    return normalizedApplications.map((raw) => {
        const application = asObject(raw);
        const type =
            cleanText(application.type).toLowerCase() === 'scholarship'
                ? 'scholarship'
                : 'university';
        const opportunity =
            type === 'scholarship'
                ? asObject(application.scholarship)
                : asObject(application.university);
        const education = asObject(application.educationSnapshot);
        const evaluation = evaluateOpportunityForUser({
            type,
            opportunity,
            education: Object.keys(education).length ? education : fallbackEducation,
            selectedPrograms: application.selectedPrograms,
        });
        const targetName = safeEntityName(type, opportunity);
        const status = cleanText(application.status) || 'Applied';

        return {
            applicationId: cleanText(application._id),
            type,
            targetId: cleanText(opportunity._id),
            targetName,
            appliedAt: application.appliedAt || '',
            status,
            programLevel: evaluation.programLevel,
            decisionReasons: buildDecisionReasons({
                status,
                evaluation,
                targetName,
            }),
            blockerReasons: evaluation.reasons,
            documentValidation: evaluation.documentValidation,
            eligibility: {
                canApplyNow: evaluation.canApply,
                requiredPercentage: evaluation.requiredPercentage,
                userPercentage: evaluation.userPercentage,
                userPercentageSource: evaluation.userPercentageSource,
            },
        };
    });
};

module.exports = {
    cleanText,
    hasValue,
    parsePercentage,
    normalizeProgramLevel,
    extractUserPercentageByLevel,
    missingDocumentsForLevel,
    evaluateOpportunityForUser,
    buildSuggestionsForUser,
    buildApplicationDiagnostics,
    buildMeritInsights,
};
