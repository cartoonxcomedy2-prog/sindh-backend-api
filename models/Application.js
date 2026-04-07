const mongoose = require('mongoose');

const applicationSchema = mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        university: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'University',
        },
        scholarship: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Scholarship',
        },
        type: {
            type: String,
            enum: ['University', 'Scholarship'],
            required: true,
        },
        status: {
            type: String,
            enum: ['Applied', 'Admit Card', 'Test', 'Interview', 'Selected', 'Rejected'],
            default: 'Applied',
        },
        selectedPrograms: [
            {
                programName: String,
                programType: String,
                duration: String,
            },
        ],
        appliedAt: {
            type: Date,
            default: Date.now,
        },
        admitCard: String,
        offerLetter: String,
        testDate: Date,
        interviewDate: Date,
        offeredUniversities: [
            {
                university: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: 'University',
                },
                status: {
                    type: String,
                    default: 'Applied',
                },
                admitCard: String,
                offerLetter: String,
            },
        ],
    },
    { timestamps: true }
);

applicationSchema.index({ user: 1, appliedAt: -1 });
applicationSchema.index({ university: 1, appliedAt: -1 });
applicationSchema.index({ scholarship: 1, appliedAt: -1 });
applicationSchema.index({ status: 1, appliedAt: -1 });
applicationSchema.index({ type: 1, appliedAt: -1 });
applicationSchema.index({ user: 1, status: 1, appliedAt: -1 });
applicationSchema.index({ 'offeredUniversities.university': 1, appliedAt: -1 });
applicationSchema.index(
    { user: 1, university: 1 },
    {
        unique: true,
        partialFilterExpression: { university: { $type: 'objectId' } },
    }
);
applicationSchema.index(
    { user: 1, scholarship: 1 },
    {
        unique: true,
        partialFilterExpression: { scholarship: { $type: 'objectId' } },
    }
);

module.exports = mongoose.model('Application', applicationSchema);
