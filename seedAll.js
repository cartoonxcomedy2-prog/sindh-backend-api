const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Banner = require('./models/Banner');
const University = require('./models/University');
const Scholarship = require('./models/Scholarship');

dotenv.config();

const seedData = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        
        // --- SEED BANNERS ---
        await Banner.deleteMany(); // Clear current
        await Banner.create({
            title: 'Welcome to Sindh Education Portal',
            imageUrl: 'https://images.unsplash.com/photo-1541339907198-e08756ebafe3?auto=format&fit=crop&q=80&w=1200',
            active: true
        });

        // --- SEED UNIVERSITIES ---
        await University.deleteMany();
        const uni = await University.create({
            name: 'University of Sindh, Jamshoro',
            location: 'Jamshoro',
            city: 'Jamshoro',
            country: 'Pakistan',
            address: 'University Road, Jamshoro, Sindh',
            type: 'Public',
            universityType: 'General',
            description: 'Established in 1947, the University of Sindh is one of the oldest and largest institutions of higher education in Pakistan.',
            logo: 'https://seeklogo.com/images/U/university-of-sindh-logo-509A3A4EB3-seeklogo.com.png',
            thumbnail: 'https://images.unsplash.com/photo-1523050853063-8951d4116935?auto=format&fit=crop&q=80&w=800',
            ranking: '#1 in Sindh',
            website: 'https://usindh.edu.pk',
            applicationFee: 'Rs. 2000',
            programs: [
                { name: 'BS Computer Science', type: 'bachelor', duration: '4 Years', feeAmount: '45,000' },
                { name: 'BS Information Technology', type: 'bachelor', duration: '4 Years', feeAmount: '45,000' }
            ]
        });

        // --- SEED SCHOLARSHIPS ---
        await Scholarship.deleteMany();
        await Scholarship.create({
            title: 'Sindh Chief Minister Merit Scholarship',
            description: 'A fully funded scholarship program for talented students from Sindh to pursue their higher education.',
            amount: 'Full Coverage',
            deadline: '2025-12-31',
            thumbnail: 'https://images.unsplash.com/photo-1546410531-bb4caa6b424d?auto=format&fit=crop&q=80&w=800',
            university: uni._id,
            university_name: uni.name,
            provider: 'Sindh Education & Literacy Department',
            coverage: ['Tuition Fee', 'Monthly Stipend', 'Books Allowance']
        });

        console.log('✅ Real-time data seeded successfully!');
        process.exit();
    } catch (error) {
        console.error('❌ Error seeding data:', error.message);
        process.exit(1);
    }
};

seedData();
