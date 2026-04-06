const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');

dotenv.config();

const createAdmin = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        
        const adminExists = await User.findOne({ email: 'admin@sindh.com' });
        if (adminExists) {
            console.log('Admin already exists');
            process.exit();
        }

        const admin = await User.create({
            name: 'Super Admin',
            email: 'admin@sindh.com',
            password: 'admin123',
            role: 'admin'
        });

        console.log('Admin created successfully');
        console.log('Email: admin@sindh.com');
        console.log('Password: admin123');
        process.exit();
    } catch (error) {
        console.error('Error creating admin:', error.message);
        process.exit(1);
    }
};

createAdmin();
