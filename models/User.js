const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const documentFieldsSchema = new mongoose.Schema(
    {
        transcript: String,
        certificate: String,
        degreeName: String,
        schoolName: String,
        collegeName: String,
        passingYear: String,
        grade: String,
        state: String,
        city: String,
        country: String,
        isAttested: { type: Boolean, default: false },
    },
    { _id: false }
);

const educationSchema = new mongoose.Schema(
    {
        personalInfo: {
            fatherName: String,
            contactNumber: String, // User's phone (backward compatibility)
            dateOfBirth: String,
            cnicNumber: String,   // User's CNIC
            fatherContactNumber: String, // NEW
            fatherCnicNumber: String,   // NEW
            fatherCnicFile: String,     // NEW
        },
        nationalId: {
            idNumber: String,
            file: String,
            country: String,
        },
        matric: documentFieldsSchema,
        intermediate: documentFieldsSchema,
        bachelor: documentFieldsSchema,
        masters: documentFieldsSchema,
        international: {
            passportNumber: String,
            englishTestType: String,
            testScore: String,
            passportPdf: String,
            testTranscript: String,
            cv: String,
            recommendationLetter: String,
        },
    },
    { _id: false }
);

const notificationSchema = new mongoose.Schema(
    {
        title: { type: String, required: true },
        body: { type: String, required: true },
        type: { type: String, default: 'application' },
        entityType: String,
        entityId: String,
        entityName: String,
        entityThumbnail: String,
        isRead: { type: Boolean, default: false },
        data: { type: mongoose.Schema.Types.Mixed, default: {} },
        createdAt: { type: Date, default: Date.now },
    },
    { _id: true }
);

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    email: {
        type: String,
        required: true,
        unique: true,
        match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please add a valid email'],
    },
    password: {
        type: String,
        required: true,
        minlength: 6,
        select: false, // Don't return password by default
    },
    role: {
        type: String,
        enum: ['user', 'admin', 'university', 'scholarship'],
        default: 'user',
    },
    phone: String,
    countryCode: String,
    country: { type: String, default: 'Pakistan' },
    age: Number,
    fatherName: String,
    address: String,
    state: String,
    city: String,
    dateOfBirth: String,
    avatar: String,
    education: {
        type: educationSchema,
        default: () => ({}),
    },
    notifications: {
        type: [notificationSchema],
        default: [],
    },
    sessionVersion: {
        type: Number,
        default: 0,
        min: 0,
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Encrypt password before saving
userSchema.pre('save', async function () {
    if (!this.isModified('password')) {
        return;
    }
    if (!this.password) {
        return;
    }
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

// Compare password
userSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ role: 1, state: 1, city: 1 });
userSchema.index({ role: 1, name: 1 });
userSchema.index({ role: 1, phone: 1 });

module.exports = mongoose.model('User', userSchema);
