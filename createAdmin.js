const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');

dotenv.config();

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const createAdmin = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

        const adminEmail = normalizeEmail(process.env.DEFAULT_ADMIN_EMAIL);
        const adminPassword = String(process.env.DEFAULT_ADMIN_PASSWORD || '').trim();
        const adminName =
            String(process.env.DEFAULT_ADMIN_NAME || '').trim() || 'Super Admin';

        if (!adminEmail || !adminPassword) {
            throw new Error(
                'Set DEFAULT_ADMIN_EMAIL and DEFAULT_ADMIN_PASSWORD in environment before running this script.'
            );
        }

        const adminExists = await User.findOne({ email: adminEmail });
        if (adminExists) {
            console.log('Admin already exists');
            process.exit();
        }

        await User.create({
            name: adminName,
            email: adminEmail,
            password: adminPassword,
            role: 'admin',
        });

        console.log('Admin created successfully');
        console.log(`Email: ${adminEmail}`);
        console.log('Password: [hidden]');
        process.exit();
    } catch (error) {
        console.error('Error creating admin:', error.message);
        process.exit(1);
    }
};

createAdmin();
