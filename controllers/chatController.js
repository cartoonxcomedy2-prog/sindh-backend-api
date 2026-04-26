const { GoogleGenerativeAI } = require('@google/generative-ai');
const User = require('../models/User');
const University = require('../models/University');
const Scholarship = require('../models/Scholarship');
const Application = require('../models/Application');
const {
    buildSuggestionsForUser,
    buildApplicationDiagnostics,
    buildMeritInsights,
    missingDocumentsForLevel,
    cleanText,
} = require('../utils/eligibilityUtils');
const { extractTextFromPdf } = require('../utils/pdfReader');

const CHAT_HISTORY_LIMIT = 25;
const PROMPT_APPLICATION_LIMIT = 200;
const PROMPT_SUGGESTION_LIMIT = 12;
const MAX_ADMIN_CATALOG_ITEMS = 200;

const escapeRegex = (value) =>
    String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getAI = () => {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is missing in backend .env file');
    }
    return new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
};

const toObjectIdString = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value._id) return String(value._id);
    return String(value);
};

const buildOwnershipQuery = (user) => {
    const userId = toObjectIdString(user?._id);
    const email = cleanText(user?.email).toLowerCase();
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

const detectIntent = (message = '') => {
    const text = cleanText(message).toLowerCase();

    const wantsSuggestions =
        /suggest|recommend|eligible|best|which|list|uni|university|scholarship|kon|kaun|kaunsi|kis/i.test(
            text
        );

    const wantsDiagnostics =
        /why|reason|kyu|kyun|reject|rejected|apply|cannot|can't|nahi|ni|issue|problem|validation|document/i.test(
            text
        );

    const wantsMerit = /merit|cut\s?off|closing|selected|select|lowest|highest|rank|position|chance|kitne|kitni|percentage/i.test(
        text
    );

    const wantsDocContent = /marks|grade|percentage|marksheet|transcript|result|points|cgpa|document\s?text|likha\s?hai|kya\s?hai/i.test(
        text
    );

    let type = 'general';
    if (wantsSuggestions && wantsDiagnostics) {
        type = 'diagnostics_and_suggestions';
    } else if (wantsDiagnostics) {
        type = 'diagnostics';
    } else if (wantsSuggestions) {
        type = 'suggestions';
    }

    return {
        type,
        wantsSuggestions,
        wantsDiagnostics,
        wantsMerit,
        wantsDocContent
    };
};

const TRACKING_KEYWORDS =
    /track|tracking|status check|application status|where.*application|mera status|mera application/i;

const HOW_TO_KEYWORDS =
    /how|kaise|kia kr|kya kar|steps|guide|process|procedure|start|kahan se|where to|kis tarah/i;

const isTrackingQuery = (message = '') => TRACKING_KEYWORDS.test(cleanText(message));

const wantsHowToGuide = (message = '') => HOW_TO_KEYWORDS.test(cleanText(message));

const buildOutOfScopeReply = (role = 'user') => {
    if (role === 'admin') {
        return 'Main sirf UnvSindh portal ke data aur workflows par answer deta hoon. Is se bahar queries ka jawab nahi deta.';
    }
    if (role === 'university' || role === 'scholarship') {
        return 'Main sirf aapke UnvSindh admin scope ke data par madad karta hoon. Irrelevant queries ka jawab nahi de sakta.';
    }
    return 'Main sirf UnvSindh app (universities, scholarships, documents, applications) se related sawalon ka jawab deta hoon.';
};

const buildTrackingRedirectReply = () =>
    'Tracking ke live details dekhne ke liye app mein `Track Application` screen open karein. AI yahan sirf guidance deta hai.';

const buildHowToReply = (message = '') => {
    const text = cleanText(message).toLowerCase();

    if (/upload|document|pdf|cnic|education/i.test(text)) {
        return [
            'Documents upload karne ke liye:',
            '1) Menu > Education Document open karein.',
            '2) Har section (Matric/Inter/Bachelor/Master) me required PDF upload karein.',
            '3) Save/Update karein, phir university ya scholarship detail page se apply karein.',
        ].join('\n');
    }

    if (/apply|admission|university|scholarship/i.test(text)) {
        return [
            'Apply karne ka short flow:',
            '1) Universities ya Scholarships list screen open karein.',
            '2) Kisi item ka detail page kholen.',
            '3) Program select karke wahan se apply karein.',
            '4) Agar doc missing hua to pehle Education Document me upload karein.',
        ].join('\n');
    }

    if (/track|tracking|status/i.test(text)) {
        return buildTrackingRedirectReply();
    }

    return [
        'App use karne ka flow:',
        '1) Education documents complete karein.',
        '2) University/Scholarship list se detail page open karein.',
        '3) Detail page se apply karein.',
        '4) Status dekhne ke liye Track Application page use karein.',
    ].join('\n');
};

const summarizeDocumentHealth = (education = {}) => {
    const bachelorMissing = missingDocumentsForLevel(education, 'bachelor');
    const masterMissing = missingDocumentsForLevel(education, 'master');

    return {
        bachelor: {
            complete: bachelorMissing.length === 0,
            missing: bachelorMissing,
        },
        master: {
            complete: masterMissing.length === 0,
            missing: masterMissing,
        },
    };
};

const compactSuggestion = (suggestion) => ({
    entityType: suggestion.entityType,
    entityId: suggestion.entityId,
    title: suggestion.title,
    subtitle: suggestion.subtitle,
    description: cleanText(suggestion.description),
    type: cleanText(suggestion.type),
    deadline: suggestion.deadline,
    applicationFee: suggestion.applicationFee || '',
    contactSummary: suggestion.contactSummary || '',
    programHighlights: Array.isArray(suggestion.programHighlights)
        ? suggestion.programHighlights
        : [],
    matchScore: suggestion.matchScore,
    status: suggestion.status,
    reasons: Array.isArray(suggestion.reasons) ? suggestion.reasons.slice(0, 2) : [],
    route: suggestion.route,
});

const compactDiagnostic = (diagnostic) => ({
    applicationId: diagnostic.applicationId,
    type: diagnostic.type,
    targetId: diagnostic.targetId,
    targetName: diagnostic.targetName,
    appliedAt: diagnostic.appliedAt || '',
    status: diagnostic.status,
    programLevel: diagnostic.programLevel,
    decisionReasons: Array.isArray(diagnostic.decisionReasons)
        ? diagnostic.decisionReasons.slice(0, 2)
        : [],
    blockerReasons: Array.isArray(diagnostic.blockerReasons)
        ? diagnostic.blockerReasons.slice(0, 2)
        : [],
    documentValidation: diagnostic.documentValidation,
    eligibility: diagnostic.eligibility,
    studentName: diagnostic.studentName || '',
    studentEmail: diagnostic.studentEmail || '',
});

const compactMeritInsight = (insight) => ({
    entityType: insight.entityType,
    institutionId: insight.institutionId,
    institutionName: insight.institutionName,
    programName: insight.programName,
    programType: insight.programType || '',
    totalSelected: insight.totalSelected || 0,
    closingMeritPercentage:
        typeof insight.closingMeritPercentage === 'number'
            ? insight.closingMeritPercentage
            : null,
    latestSelectedAt: insight.latestSelectedAt || '',
    lastSelectedPercentage:
        typeof insight.lastSelectedPercentage === 'number'
            ? insight.lastSelectedPercentage
            : null,
    lastSelectedGrade: insight.lastSelectedGrade || '',
    lastSelectedStudentName: insight.lastSelectedStudentName || '',
    lastSelectedStudentEmail: insight.lastSelectedStudentEmail || '',
});

const buildFallbackReply = ({ intent, scope, suggestions, diagnostics }) => {
    const roleLabel =
        scope.role === 'admin'
            ? 'Super Admin'
            : scope.role === 'university'
            ? 'University Admin'
            : scope.role === 'scholarship'
            ? 'Scholarship Admin'
            : 'Student';

    if (intent.wantsDiagnostics && diagnostics.length > 0) {
        const first = diagnostics[0];
        const reason = (first.decisionReasons || first.blockerReasons || [])[0] ||
            'Application review is still in progress.';
        return `${roleLabel} view ready. ${first.targetName}: ${reason}`;
    }

    if (intent.wantsSuggestions && suggestions.length > 0) {
        const top = suggestions.slice(0, 3).map((item) => item.title).join(', ');
        return `Top matches prepared for you: ${top}. Open any card to view full details.`;
    }

    return 'UnvSindh AI is ready. Ask about eligibility, missing documents, or why an application was not selected.';
};

const buildUserScope = async (user, message = '') => {
    const userRecord = await User.findById(user._id)
        .select('name email education aiChatHistory')
        .lean();

    if (!userRecord) {
        throw new Error('User profile not found');
    }

    const [applications, universities, scholarships, selectedApplications] =
        await Promise.all([
        Application.find({
            user: user._id,
            isReapplyEligible: { $ne: true },
        })
            .sort({ appliedAt: -1 })
            .limit(PROMPT_APPLICATION_LIMIT)
            .populate(
                'university',
                'name city state country deadline isActive eligibility programs thumbnail logo applicationFee applicationFees contactInfo contact description type'
            )
            .populate(
                'scholarship',
                'title provider city state country deadline isActive eligibility programs thumbnail image amount contactInfo contact university_name'
            )
            .lean(),
        University.find({
            $or: [
                { isActive: true },
                { isActive: { $exists: false } },
                { active: true },
            ],
        })
            .select(
                'name city state country deadline isActive eligibility programs thumbnail logo applicationFee applicationFees contactInfo contact description type'
            )
            .sort({ createdAt: -1 })
            .lean(),
        Scholarship.find({
            $or: [{ isActive: true }, { isActive: { $exists: false } }],
        })
            .select(
                'title provider city state country deadline isActive eligibility programs thumbnail image university_name amount contactInfo contact'
            )
            .sort({ createdAt: -1 })
            .lean(),
        Application.find({
            status: 'Selected',
            isReapplyEligible: { $ne: true },
        })
            .sort({ updatedAt: -1 })
            .limit(1200)
            .populate(
                'university',
                'name city state country deadline isActive eligibility programs applicationFee applicationFees contactInfo contact'
            )
            .populate(
                'scholarship',
                'title provider city state country deadline isActive eligibility programs amount contactInfo contact university_name'
            )
            .lean(),
    ]);

    const suggestions = buildSuggestionsForUser({
        universities,
        scholarships,
        education: userRecord.education || {},
        maxUniversities: 7,
        maxScholarships: 7,
    }).all;

    const diagnostics = buildApplicationDiagnostics({
        applications,
        fallbackEducation: userRecord.education || {},
    });
    const meritInsights = buildMeritInsights({
        applications: selectedApplications,
        includeStudent: false,
    });

    const documentHealth = summarizeDocumentHealth(userRecord.education || {});

    // Optional: Extract text from PDFs if user is asking about marks/content
    const docContexts = {};
    const intent = detectIntent(message);
    if (intent.wantsDocContent) {
        const edu = userRecord.education || {};
        const transcripts = [
            { key: 'matric', url: edu.matric?.transcript },
            { key: 'intermediate', url: edu.intermediate?.transcript },
            { key: 'bachelor', url: edu.bachelor?.transcript },
        ].filter(t => t.url && t.url.toLowerCase().endsWith('.pdf'));

        for (const t of transcripts) {
            try {
                const text = await extractTextFromPdf(t.url);
                if (text) docContexts[t.key] = text;
            } catch (pdfErr) {
                console.error(`PDF read error for ${t.key}:`, pdfErr.message);
            }
        }
    }

    return {
        role: 'user',
        profile: userRecord,
        applications,
        suggestions,
        diagnostics,
        meritInsights,
        docContent: docContexts,
        stats: {
            universities: universities.length,
            scholarships: scholarships.length,
            applications: applications.length,
        },
        documentHealth,
        recentHistory: Array.isArray(userRecord.aiChatHistory)
            ? userRecord.aiChatHistory.slice(-5)
            : [],
    };
};

const buildUniversityScope = async (user) => {
    const ownershipQuery = buildOwnershipQuery(user);
    const university = ownershipQuery
        ? await University.findOne(ownershipQuery)
              .select(
                  'name city state country deadline isActive eligibility programs applicationFee applicationFees contactInfo contact description type'
              )
              .lean()
        : null;

    if (!university) {
        throw new Error('No university linked to your account.');
    }

    const applications = await Application.find({
        $or: [
            { university: university._id },
            { 'offeredUniversities.university': university._id },
        ],
    })
        .sort({ appliedAt: -1 })
        .limit(PROMPT_APPLICATION_LIMIT)
        .populate('user', 'name email education')
        .populate(
            'university',
            'name city state country deadline isActive eligibility programs applicationFee applicationFees contactInfo contact'
        )
        .populate(
            'scholarship',
            'title provider deadline isActive eligibility programs amount contactInfo contact university_name'
        )
        .lean();

    const diagnostics = buildApplicationDiagnostics({
        applications: applications.map((application) => ({
            ...application,
            educationSnapshot:
                application.educationSnapshot || application.user?.education || {},
        })),
        fallbackEducation: {},
    }).map((item, index) => ({
        ...item,
        studentName: cleanText(applications[index]?.user?.name) || 'Student',
        studentEmail: cleanText(applications[index]?.user?.email) || '',
    }));
    const meritInsights = buildMeritInsights({
        applications,
        includeStudent: true,
    });

    return {
        role: 'university',
        university,
        applications,
        diagnostics,
        meritInsights,
        stats: {
            applications: applications.length,
            pending: applications.filter(
                (app) => cleanText(app.status).toLowerCase() !== 'selected'
            ).length,
        },
    };
};

const buildScholarshipScope = async (user) => {
    const ownershipQuery = buildOwnershipQuery(user);
    const scholarship = ownershipQuery
        ? await Scholarship.findOne(ownershipQuery)
              .select(
                  'title provider city state country deadline isActive eligibility programs amount contactInfo contact university_name'
              )
              .lean()
        : null;

    if (!scholarship) {
        throw new Error('No scholarship linked to your account.');
    }

    const applications = await Application.find({ scholarship: scholarship._id })
        .sort({ appliedAt: -1 })
        .limit(PROMPT_APPLICATION_LIMIT)
        .populate('user', 'name email education')
        .populate(
            'university',
            'name city state country deadline isActive eligibility programs applicationFee applicationFees contactInfo contact'
        )
        .populate(
            'scholarship',
            'title provider deadline isActive eligibility programs amount contactInfo contact university_name'
        )
        .lean();

    const diagnostics = buildApplicationDiagnostics({
        applications: applications.map((application) => ({
            ...application,
            educationSnapshot:
                application.educationSnapshot || application.user?.education || {},
        })),
        fallbackEducation: {},
    }).map((item, index) => ({
        ...item,
        studentName: cleanText(applications[index]?.user?.name) || 'Student',
        studentEmail: cleanText(applications[index]?.user?.email) || '',
    }));
    const meritInsights = buildMeritInsights({
        applications,
        includeStudent: true,
    });

    return {
        role: 'scholarship',
        scholarship,
        applications,
        diagnostics,
        meritInsights,
        stats: {
            applications: applications.length,
            pending: applications.filter(
                (app) => cleanText(app.status).toLowerCase() !== 'selected'
            ).length,
        },
    };
};

const buildAdminScope = async () => {
    const [users, universities, scholarships, applications] = await Promise.all([
        User.find({ role: 'user' })
            .select('name email education createdAt')
            .sort({ createdAt: -1 })
            .limit(MAX_ADMIN_CATALOG_ITEMS)
            .lean(),
        University.find({})
            .select(
                'name city state country deadline isActive eligibility programs applicationFee applicationFees contactInfo contact description type'
            )
            .sort({ createdAt: -1 })
            .limit(MAX_ADMIN_CATALOG_ITEMS)
            .lean(),
        Scholarship.find({})
            .select(
                'title provider city state country deadline isActive eligibility programs amount contactInfo contact university_name'
            )
            .sort({ createdAt: -1 })
            .limit(MAX_ADMIN_CATALOG_ITEMS)
            .lean(),
        Application.find({})
            .sort({ appliedAt: -1 })
            .limit(MAX_ADMIN_CATALOG_ITEMS)
            .populate('user', 'name email education')
            .populate(
                'university',
                'name city state country deadline isActive eligibility programs applicationFee applicationFees contactInfo contact'
            )
            .populate(
                'scholarship',
                'title provider deadline isActive eligibility programs amount contactInfo contact university_name'
            )
            .lean(),
    ]);

    const diagnostics = buildApplicationDiagnostics({
        applications: applications.map((application) => ({
            ...application,
            educationSnapshot:
                application.educationSnapshot || application.user?.education || {},
        })),
        fallbackEducation: {},
    }).map((item, index) => ({
        ...item,
        studentName: cleanText(applications[index]?.user?.name) || 'Student',
        studentEmail: cleanText(applications[index]?.user?.email) || '',
    }));
    const meritInsights = buildMeritInsights({
        applications,
        includeStudent: true,
    });

    const usersWithMissingDocs = users.filter((candidate) => {
        const missing = missingDocumentsForLevel(candidate.education || {}, 'bachelor');
        return missing.length > 0;
    }).length;

    return {
        role: 'admin',
        stats: {
            users: users.length,
            universities: universities.length,
            scholarships: scholarships.length,
            applications: applications.length,
            usersWithMissingDocs,
        },
        catalog: {
            universities: universities.map((uni) => ({
                id: toObjectIdString(uni._id),
                name: cleanText(uni.name),
                location: [cleanText(uni.city), cleanText(uni.state), cleanText(uni.country)]
                    .filter(Boolean)
                    .join(', '),
                deadline: cleanText(uni.deadline),
                type: cleanText(uni.type),
                description: cleanText(uni.description),
                applicationFee:
                    cleanText(uni.applicationFee) || cleanText(uni.applicationFees),
                programs: Array.isArray(uni.programs)
                    ? uni.programs
                          .slice(0, 8)
                          .map((program) => ({
                              name: cleanText(program?.name || program?.programName),
                              type: cleanText(program?.type || program?.programType),
                          }))
                          .filter((program) => program.name)
                    : [],
                contact:
                    cleanText(uni.contact) ||
                    (Array.isArray(uni.contactInfo) && uni.contactInfo.length > 0
                        ? cleanText(uni.contactInfo[0]?.email || uni.contactInfo[0]?.phone)
                        : ''),
            })),
            scholarships: scholarships.map((scholarship) => ({
                id: toObjectIdString(scholarship._id),
                title: cleanText(scholarship.title),
                provider: cleanText(scholarship.provider),
                location: [
                    cleanText(scholarship.city),
                    cleanText(scholarship.state),
                    cleanText(scholarship.country),
                ]
                    .filter(Boolean)
                    .join(', '),
                deadline: cleanText(scholarship.deadline),
                amount: cleanText(scholarship.amount),
                programs: Array.isArray(scholarship.programs)
                    ? scholarship.programs
                          .slice(0, 8)
                          .map((program) => ({
                              name: cleanText(program?.name || program?.programName),
                              type: cleanText(program?.type || program?.programType),
                          }))
                          .filter((program) => program.name)
                    : [],
                contact:
                    cleanText(scholarship.contact) ||
                    (Array.isArray(scholarship.contactInfo) &&
                    scholarship.contactInfo.length > 0
                        ? cleanText(
                              scholarship.contactInfo[0]?.email ||
                                  scholarship.contactInfo[0]?.phone
                          )
                        : ''),
            })),
        },
        meritInsights,
        diagnostics,
    };
};

const buildScope = async (user, message = '') => {
    if (user.role === 'admin') return buildAdminScope();
    if (user.role === 'university') return buildUniversityScope(user);
    if (user.role === 'scholarship') return buildScholarshipScope(user);
    return buildUserScope(user, message);
};

const buildPromptSnapshot = ({ scope, intent, message }) => {
    if (scope.role === 'user') {
        return {
            role: scope.role,
            intent,
            profile: {
                name: scope.profile?.name || '',
                email: scope.profile?.email || '',
                documentHealth: scope.documentHealth,
            },
            stats: scope.stats,
            suggestions: scope.suggestions
                .slice(0, PROMPT_SUGGESTION_LIMIT)
                .map(compactSuggestion),
            diagnostics: scope.diagnostics.slice(0, 10).map(compactDiagnostic),
            meritInsights: (scope.meritInsights || [])
                .slice(0, 20)
                .map(compactMeritInsight),
            docContent: scope.docContent || {},
            recentHistory: (scope.recentHistory || []).slice(-5),
            userMessage: message,
        };
    }

    if (scope.role === 'admin') {
        return {
            role: scope.role,
            intent,
            stats: scope.stats,
            catalog: scope.catalog || { universities: [], scholarships: [] },
            diagnostics: scope.diagnostics.slice(0, 25).map(compactDiagnostic),
            meritInsights: (scope.meritInsights || [])
                .slice(0, 35)
                .map(compactMeritInsight),
            userMessage: message,
        };
    }

    return {
        role: scope.role,
        intent,
        organization:
            scope.role === 'university' ? scope.university : scope.scholarship,
        stats: scope.stats,
        diagnostics: scope.diagnostics.slice(0, 20).map(compactDiagnostic),
        meritInsights: (scope.meritInsights || [])
            .slice(0, 30)
            .map(compactMeritInsight),
        userMessage: message,
    };
};

const buildSystemPrompt = (scopeRole) => {
    const roleLine =
        scopeRole === 'admin'
            ? 'You are UnvSindh Super Admin AI analyst.'
            : scopeRole === 'university'
            ? 'You are UnvSindh University Sub-Admin AI assistant.'
            : scopeRole === 'scholarship'
            ? 'You are UnvSindh Scholarship Sub-Admin AI assistant.'
            : 'You are UnvSindh student counselor AI assistant.';

    const privacyLine =
        scopeRole === 'user'
            ? '- Never reveal any other student name/email/identity. Anonymize merit queries (e.g. "Last year lowest selected percentage was X%").'
            : '- Reveal student identity only if it is within current admin scope.';

    return `${roleLine}
Rules:
- You must ONLY answer questions related to UnivSindh, universities, scholarships, education, applications, merit, and greetings.
- If a user asks a general knowledge question (e.g., about the world, weather, politics), politely decline and state you only help with UnvSindh.
- Use only provided JSON data.
- Answer in Roman Urdu or English based on user language.
- If the user asks for a list of universities, scholarships, or applications, provide a clear, formatted, and detailed list based on the provided JSON data. Do not skip or ignore list requests.
- If structured merit insights are missing for a specific university, check its "description" or "eligibility" text in the JSON data for any mentioned merit criteria or closing percentages.
- If "docContent" is provided, it contains text extracted from the student's uploaded PDF transcripts (matric, intermediate, bachelor). Use this to answer specific questions about their marks, subjects, or grades.
- Only discuss application "Diagnostics" (reasons for rejection/selection) when the user specifically asks about their own application status or issues. Do not show them for general info queries.
- If user asks "why not selected" or "why apply failed", explain exact reasons from diagnostics and document validation.
- Keep answer concise and practical, but detailed enough for lists.
- Never expose data outside current user role scope.
- ${privacyLine.replace(/^- /, '')}
- Do not suggest direct apply/submit actions from chat; guide user to detail screens (e.g. "Please go to the university detail page to apply").
- For tracking status requests, tell user to check Track Application screen for live updates.`;
};

const persistChatTurn = async ({ userId, message, reply, intent, suggestions }) => {
    const entry = {
        message: cleanText(message).slice(0, 2000),
        reply: cleanText(reply).slice(0, 6000),
        intent: cleanText(intent) || 'general',
        suggestions: (Array.isArray(suggestions) ? suggestions : [])
            .slice(0, 5)
            .map((item) => ({
                entityType: item.entityType,
                entityId: item.entityId,
                title: item.title,
            })),
        createdAt: new Date(),
    };

    await User.findByIdAndUpdate(userId, {
        $push: {
            aiChatHistory: {
                $each: [entry],
                $slice: -CHAT_HISTORY_LIMIT,
            },
        },
    });

    const user = await User.findById(userId).select('aiChatHistory').lean();
    return Array.isArray(user?.aiChatHistory) ? user.aiChatHistory.length : 0;
};

exports.handleChat = async (req, res) => {
    try {
        const message = cleanText(req.body?.message);
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const currentRole = cleanText(req.user?.role).toLowerCase() || 'user';

        const respondQuick = async ({
            reply,
            intent = 'general',
            suggestions = [],
            diagnostics = [],
            meritInsights = [],
        }) => {
            let storedTurns = 0;
            try {
                storedTurns = await persistChatTurn({
                    userId: req.user._id,
                    message,
                    reply,
                intent,
                suggestions,
                meritInsights,
            });
            } catch (historyError) {
                console.error(
                    'Chat history persistence warning:',
                    historyError?.message || historyError
                );
            }

            return res.status(200).json({
                reply,
                intent,
                suggestions,
                diagnostics,
                meritInsights,
                meta: {
                    role: currentRole,
                    historyStoredTurns: storedTurns,
                    historyLimit: CHAT_HISTORY_LIMIT,
                },
            });
        };

        const intent = detectIntent(message);
        const scope = await buildScope(req.user, message);

        const shouldIncludeSuggestions =
            scope.role === 'user' &&
            (intent.wantsSuggestions ||
                (intent.wantsDiagnostics &&
                    ((scope.diagnostics || []).length === 0)));

        const suggestions = shouldIncludeSuggestions
            ? scope.suggestions.slice(0, PROMPT_SUGGESTION_LIMIT)
            : [];

        // Only include diagnostics when user explicitly asks about application issues/reasons
        const diagnostics = intent.wantsDiagnostics
            ? (scope.diagnostics || []).slice(0, 25)
            : [];

        // Only include merit insights when user asks about merit/selection
        const meritInsights = intent.wantsMerit
            ? (scope.meritInsights || []).slice(0, 35)
            : [];

        const promptSnapshot = buildPromptSnapshot({
            scope,
            intent,
            message,
        });

        let reply = '';

        // Model fallback chain — ordered by current quota availability
        const MODEL_CHAIN = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-8b'];
        const sysInstruction = { parts: [{ text: buildSystemPrompt(scope.role) }] };
        const formattedHistory = (scope.recentHistory || []).map(turn => [
            { role: 'user', parts: [{ text: turn.message }] },
            { role: 'model', parts: [{ text: turn.reply }] }
        ]).flat();
        const fullPrompt = `Context JSON:\n${JSON.stringify(promptSnapshot)}\n\nUser Message: ${message}`;

        for (const modelName of MODEL_CHAIN) {
            try {
                const genAI = getAI();
                const model = genAI.getGenerativeModel({
                    model: modelName,
                    systemInstruction: sysInstruction,
                });
                const chat = model.startChat({ history: formattedHistory });
                const result = await chat.sendMessage(fullPrompt);
                reply = cleanText(result?.response?.text?.());
                if (reply) {
                    console.log(`AI reply from model: ${modelName}`);
                    break;
                }
            } catch (aiError) {
                const msg = aiError?.message || '';
                console.error(`Gemini [${modelName}] warning:`, msg.slice(0, 200));
                // If rate-limited, wait briefly then try next model
                if (msg.includes('429') || msg.toLowerCase().includes('quota')) {
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                // For non-quota errors, still try next model
                continue;
            }
        }

        if (!reply) {
            reply = buildFallbackReply({
                intent,
                scope,
                suggestions,
                diagnostics,
            });
        }

        let storedTurns = 0;
        try {
            storedTurns = await persistChatTurn({
                userId: req.user._id,
                message,
                reply,
                intent: intent.type,
                suggestions,
                meritInsights,
            });
        } catch (historyError) {
            console.error('Chat history persistence warning:', historyError?.message || historyError);
        }

        return res.status(200).json({
            reply,
            intent: intent.type,
            suggestions,
            diagnostics,
            meritInsights,
            meta: {
                role: scope.role,
                historyStoredTurns: storedTurns,
                historyLimit: CHAT_HISTORY_LIMIT,
            },
        });
    } catch (error) {
        console.error('Chat API Error:', error);
        if (String(error?.message || '').toLowerCase().includes('no university linked')) {
            return res.status(403).json({ error: error.message });
        }
        if (String(error?.message || '').toLowerCase().includes('no scholarship linked')) {
            return res.status(403).json({ error: error.message });
        }
        return res.status(500).json({
            error: error.message || 'Failed to process AI chat.',
        });
    }
};
