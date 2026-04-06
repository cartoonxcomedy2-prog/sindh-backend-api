const mongoose = require('mongoose');

const scholarshipSchema = mongoose.Schema(
    {
        title: { type: String, required: true },
        description: { type: String, required: true },
        amount: { type: String },
        deadline: { type: String },
        image: { type: String },
        thumbnail: { type: String },
        university: { type: mongoose.Schema.Types.ObjectId, ref: 'University' },
        university_name: { type: String },
        linkedUniversities: [{ type: mongoose.Schema.Types.ObjectId, ref: 'University' }],
        city: { type: String },
        state: { type: String },
        country: { type: String },
        currency: { type: String },
        address: { type: String },
        type: { type: String },
        duration: { type: String },
        provider: { type: String }, // Organization name
        website: { type: String },
        testDate: { type: String },
        interviewDate: { type: String },
        isActive: { type: Boolean, default: true },
        applicationSteps: [String],
        coverage: [String], // Array of financial benefits
        eligibility: {
            minPercentage: Number,
            minGrade: String,
            description: String,
        },
        programs: [
            {
                name: { type: String },
                type: { type: String }, // Bachelor, Master, PhD
                duration: { type: String },
            },
        ],
        contact: { type: String },
        contactInfo: [
            {
                email: { type: String },
                phone: { type: String },
            },
        ],
        adminAccount: {
            email: String,
            userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Scholarship', scholarshipSchema);
