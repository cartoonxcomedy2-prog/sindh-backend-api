const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load env vars
dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');

const resetAdmin = async () => {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected!');

        const emailToRemove = process.argv[2];
        
        if (emailToRemove) {
            console.log(`Removing specific admin: ${emailToRemove}`);
            const result = await User.deleteOne({ email: emailToRemove.toLowerCase(), role: 'admin' });
            if (result.deletedCount > 0) {
                console.log('✅ Admin removed successfully.');
            } else {
                console.log('❌ No admin found with that email.');
            }
        } else {
            console.log('No email provided. Removing ALL admins to clear previous sessions...');
            const result = await User.deleteMany({ role: 'admin' });
            console.log(`✅ Removed ${result.deletedCount} admin accounts.`);
        }

        console.log('\n--- NEXT STEPS ---');
        console.log('1. Go to your registration page in the app or admin panel.');
        console.log('2. Create a new account with your desired email.');
        console.log('3. Manually change that user\'s role to "admin" in MongoDB Compass or Atlas.');
        
        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
};

resetAdmin();
