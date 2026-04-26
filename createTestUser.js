const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');

dotenv.config();

const createTestUser = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        
        await User.findOneAndDelete({ email: 'user@sindh.com' }); // Clean old test user if exists

        await User.create({
            name: 'Test User',
            email: 'user@sindh.com',
            password: 'user123',
            role: 'user'
        });

        console.log('✅ Test user created successfully for App login!');
        console.log('Email: user@sindh.com');
        console.log('Password: user123');
        process.exit();
    } catch (error) {
        console.error('❌ Error creating test user:', error.message);
        process.exit(1);
    }
};

createTestUser();
