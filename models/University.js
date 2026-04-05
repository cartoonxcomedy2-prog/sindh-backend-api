const mongoose = require('mongoose');

const universitySchema = mongoose.Schema(
    {
        name: { type: String, required: true },
        location: { type: String }, // General location
        city: { type: String },
        state: { type: String },
        country: { type: String },
        currency: { type: String },
        address: { type: String },
        type: { type: String }, // Public/Private
        universityType: { type: String },
        description: { type: String, required: true },
        logo: { type: String },
        thumbnail: { type: String },
        ranking: { type: String },
        website: { type: String },
        applicationFee: { type: String },
        applicationFees: { type: String },
        deadline: { type: String },
        testDate: { type: String },
        interviewDate: { type: String },
        internationalStudents: { type: Boolean, default: false },
        isActive: { type: Boolean, default: true },
        applicationSteps: [String],
        programs: [
            {
                name: { type: String },
                type: { type: String },
                duration: { type: String },
                feeAmount: { type: String },
                feeStructure: { type: String },
            },
        ],
        eligibility: { type: String },
        scholarshipDetails: { type: String },
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

module.exports = mongoose.model('University', universitySchema);
