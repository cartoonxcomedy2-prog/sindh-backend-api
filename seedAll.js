const mongoose = require('mongoose');
const dotenv = require('dotenv');
const University = require('./models/University');
const Scholarship = require('./models/Scholarship');

dotenv.config();

const universities = [
  {
    name: "Mehran University of Engineering and Technology (MUET)",
    location: "Jamshoro, Sindh",
    city: "Jamshoro",
    state: "Sindh",
    country: "Pakistan",
    type: "Public",
    description: "One of the top-ranked engineering universities in Pakistan, established to provide quality education in engineering and technology.",
    thumbnail: "https://muet.edu.pk/files/images/logo.png",
    website: "https://muet.edu.pk",
    contact: "Jamshoro, Sindh. Phone: 022-2771167",
    programs: [
      { name: "B.E. Civil Engineering", type: "Bachelor", duration: "4 Years" },
      { name: "B.E. Software Engineering", type: "Bachelor", duration: "4 Years" },
      { name: "M.E. Energy Systems", type: "Master", duration: "2 Years" },
      { name: "MS Computer Science", type: "Master", duration: "2 Years" },
      { name: "PhD Mechanical Engineering", type: "PhD", duration: "3-5 Years" }
    ]
  },
  {
    name: "University of Sindh",
    location: "Jamshoro, Sindh",
    city: "Jamshoro",
    state: "Sindh",
    country: "Pakistan",
    type: "Public",
    description: "The oldest university in Pakistan, offering diverse programs in arts, sciences, and humanities.",
    thumbnail: "https://usindh.edu.pk/files/images/logo.png",
    website: "https://usindh.edu.pk",
    contact: "Allama I.I. Kazi Campus, Jamshoro.",
    programs: [
      { name: "BS Information Technology", type: "Bachelor", duration: "4 Years" },
      { name: "MBA Executive", type: "Master", duration: "2 Years" },
      { name: "MA English Literature", type: "Master", duration: "2 Years" },
      { name: "MS Mathematics", type: "Master", duration: "2 Years" },
      { name: "PhD Physics", type: "PhD", duration: "3-5 Years" }
    ]
  },
  {
    name: "Shah Abdul Latif University",
    location: "Khairpur, Sindh",
    city: "Khairpur",
    state: "Sindh",
    country: "Pakistan",
    type: "Public",
    description: "A premier educational institution in upper Sindh named after the great Sufi poet Shah Abdul Latif Bhittai.",
    thumbnail: "https://salu.edu.pk/files/images/logo.png",
    website: "https://salu.edu.pk",
    contact: "Khairpur, Sindh. Phone: 0243-928001",
    programs: [
      { name: "BBA Honours", type: "Bachelor", duration: "4 Years" },
      { name: "BS Zoology", type: "Bachelor", duration: "4 Years" },
      { name: "MS Management Sciences", type: "Master", duration: "2 Years" },
      { name: "PhD Chemistry", type: "PhD", duration: "3-0 Years" }
    ]
  },
  {
    name: "IBA Karachi",
    location: "Karachi, Sindh",
    city: "Karachi",
    state: "Sindh",
    country: "Pakistan",
    type: "Public",
    description: "The premier business school in Pakistan, known for its excellence in business, accounting, and technological education.",
    thumbnail: "https://iba.edu.pk/files/images/logo.png",
    website: "https://iba.edu.pk",
    contact: "Main Campus, University Road, Karachi.",
    programs: [
      { name: "BBA Business Administration", type: "Bachelor", duration: "4 Years" },
      { name: "BS Computer Science", type: "Bachelor", duration: "4 Years" },
      { name: "MS Data Science", type: "Master", duration: "2 Years" },
      { name: "MBA Graduate Program", type: "Master", duration: "1.5-2 Years" },
      { name: "PhD Economics", type: "PhD", duration: "3-5 Years" }
    ]
  },
  {
    name: "NED University of Engineering",
    location: "Karachi, Sindh",
    city: "Karachi",
    state: "Sindh",
    country: "Pakistan",
    type: "Public",
    description: "One of the oldest and most prestigious engineering institutions in the country.",
    thumbnail: "https://neduet.edu.pk/files/images/logo.png",
    website: "https://neduet.edu.pk",
    contact: "University Road, Karachi.",
    programs: [
      { name: "B.E. Electrical Engineering", type: "Bachelor", duration: "4 Years" },
      { name: "B.E. Textile Engineering", type: "Bachelor", duration: "4 Years" },
      { name: "MS Environmental Engineering", type: "Master", duration: "2 Years" },
      { name: "PhD Telecommunications", type: "PhD", duration: "3-0 Years" }
    ]
  },
  {
    name: "Liaquat University of Medical & Health Sciences (LUMHS)",
    location: "Jamshoro, Sindh",
    city: "Jamshoro",
    state: "Sindh",
    country: "Pakistan",
    type: "Public",
    description: "Leading medical university in Pakistan, providing top-tier medical and health education.",
    thumbnail: "https://lumhs.edu.pk/files/images/logo.png",
    website: "https://lumhs.edu.pk",
    contact: "Jamshoro, Sindh.",
    programs: [
      { name: "MBBS Medicine", type: "Bachelor", duration: "5 Years" },
      { name: "BDS Dental Surgery", type: "Bachelor", duration: "4 Years" },
      { name: "M.Phil Anatomy", type: "Master", duration: "2 Years" },
      { name: "PhD Public Health", type: "PhD", duration: "3-2 Years" }
    ]
  },
  {
    name: "Shaheed Mohtarma Benazir Bhutto Medical University",
    location: "Larkana, Sindh",
    city: "Larkana",
    state: "Sindh",
    country: "Pakistan",
    type: "Public",
    description: "Focusing on advanced healthcare education for the people of Sindh.",
    thumbnail: "https://smbbmu.edu.pk/files/images/logo.png",
    website: "https://smbbmu.edu.pk",
    contact: "Larkana, Sindh.",
    programs: [
      { name: "MBBS Program", type: "Bachelor", duration: "5 Years" },
      { name: "BDS Program", type: "Bachelor", duration: "4 Years" },
      { name: "BSc Nursing", type: "Bachelor", duration: "4 Years" },
      { name: "Masters Health System", type: "Master", duration: "2 Years" }
    ]
  },
  {
    name: "Sukkuk University of IBA",
    location: "Sukkur, Sindh",
    city: "Sukkur",
    state: "Sindh",
    country: "Pakistan",
    type: "Public",
    description: "A pioneer in modern technological and business education in upper Sindh.",
    thumbnail: "https://iba-suk.edu.pk/files/images/logo.png",
    website: "https://iba-suk.edu.pk",
    contact: "Sukkur, Sindh.",
    programs: [
      { name: "BS Computer Science", type: "Bachelor", duration: "4 Years" },
      { name: "BBA Business Administration", type: "Bachelor", duration: "4 Years" },
      { name: "Education Masters", type: "Master", duration: "2 Years" },
      { name: "MS Mathematics", type: "Master", duration: "2 Years" }
    ]
  },
  {
    name: "People's Medical University for Women",
    location: "Nawabshah, Sindh",
    city: "Nawabshah",
    state: "Sindh",
    country: "Pakistan",
    type: "Public",
    description: "Dedicated medical education provider exclusively for women in the region.",
    thumbnail: "https://pmuw.edu.pk/files/images/logo.png",
    website: "https://pmuw.edu.pk",
    contact: "Nawabshah, Sindh.",
    programs: [
      { name: "MBBS Medicine", type: "Bachelor", duration: "5 Years" },
      { name: "DPT Physiotherapy", type: "Bachelor", duration: "5 Years" },
      { name: "PhD Pharmacology", type: "PhD", duration: "4-0 Years" }
    ]
  },
  {
    name: "Dow University of Health Sciences",
    location: "Karachi, Sindh",
    city: "Karachi",
    state: "Sindh",
    country: "Pakistan",
    type: "Public",
    description: "One of the top-ranked medical and health science institutions in Karachi, producing high-quality health professionals.",
    thumbnail: "https://duhs.edu.pk/files/images/logo.png",
    website: "https://duhs.edu.pk",
    contact: "Baba-e-Urdu Road, Karachi.",
    programs: [
      { name: "MBBS Medicine", type: "Bachelor", duration: "5 Years" },
      { name: "BDS Dental Surgery", type: "Bachelor", duration: "4 Years" },
      { name: "MS Biotechnology", type: "Master", duration: "2 Years" },
      { name: "PhD Medical Sciences", type: "PhD", duration: "3-5 Years" }
    ]
  }
];

const scholarships = [
  {
    title: "Need Based Scholarship Sindh - 2026",
    description: "Support for deserving students in Sindh to pursue their higher education dreams.",
    city: "All",
    state: "Sindh",
    country: "Pakistan",
    status: "Upcoming",
    testDate: "July 15, 2026",
    interviewDate: "August 01, 2026",
    contact: "E-mail: help@scholarship.onrender.com",
    eligibility: {
      description: "Sindh Domicile, Family income < 50,000 PKR, Minimum 2.5 CGPA."
    }
  },
  {
    title: "MUET Alumni Scholarship - Phase 2",
    description: "Financial assistance funded by MUET alumni for brilliant engineering students.",
    city: "Jamshoro",
    state: "Sindh",
    country: "Pakistan",
    status: "Open",
    testDate: "April 25, 2026",
    interviewDate: "May 05, 2026",
    contact: "Alumni Office, MUET Jamshoro.",
    eligibility: {
      description: "Current MUET student, No other scholarship, Minimum 75% Marks."
    }
  },
  {
    title: "Sindh Education Endowment Fund (SEEF)",
    description: "Fully funded scholarship for talented and deserving students of Sindh.",
    city: "All",
    state: "Sindh",
    country: "Pakistan",
    status: "Upcoming",
    testDate: "October 10, 2026",
    interviewDate: "October 20, 2026",
    contact: "Education Dept, Karachi.",
    eligibility: {
      description: "Sindh domiciled, Enrolled in Public University, Income < 100,000/Month."
    }
  },
  {
    title: "USAID Merit and Need Based Scholarship",
    description: "Empowering disadvantaged Pakistani students through international higher education support.",
    city: "All",
    state: "Sindh",
    country: "Pakistan",
    status: "Upcoming",
    testDate: "August 10, 2026",
    interviewDate: "August 20, 2026",
    contact: "USAID local office or University Financial Aid Office.",
    eligibility: {
      description: "Merit based, Must show financial need, Available in 30+ universities."
    }
  },
  {
    title: "OGDCL National Talent Hunt Program",
    description: "Supporting students from marginalized districts of Sindh for top-tier education.",
    city: "All",
    state: "Sindh",
    country: "Pakistan",
    status: "Upcoming",
    testDate: "May 25, 2026",
    interviewDate: "June 05, 2026",
    contact: "Financial Aid Office, Sukkur IBA.",
    eligibility: {
      description: "Domicile of specific districts, Enrolled in select partner universities."
    }
  },
  {
    title: "IBA Karachi Talent Hunt Program",
    description: "An initiative to provide quality education to talented students from diverse backgrounds.",
    city: "Karachi",
    state: "Sindh",
    country: "Pakistan",
    status: "Upcoming",
    testDate: "June 20, 2026",
    interviewDate: "June 30, 2026",
    contact: "THP Office, IBA Karachi.",
    eligibility: {
      description: "Merit based, Special consideration for first-generation students."
    }
  },
  {
    title: "Scottish Scholarship for Women",
    description: "Promoting gender equality through dedicated scholarship support for women.",
    city: "All",
    state: "Sindh",
    country: "Pakistan",
    status: "Upcoming",
    testDate: "No Test",
    interviewDate: "September 10, 2026",
    contact: "British Council Pakistan.",
    eligibility: {
      description: "Female students only, Master's degree students, All disciplines."
    }
  },
  {
    title: "PEEF Higher Education Scholarship",
    description: "Encouraging inter-provincial academic support and excellence.",
    city: "All",
    state: "Sindh",
    country: "Pakistan",
    status: "Upcoming",
    testDate: "None",
    interviewDate: "October 30, 2026",
    contact: "PEEF local office or Website.",
    eligibility: {
      description: "Top 20% in Intermediate, Income criteria applies."
    }
  },
  {
    title: "Higher Education Sindh Council Merit",
    description: "Reward for top academic performance across the province.",
    city: "All",
    state: "Sindh",
    country: "Pakistan",
    status: "Upcoming",
    testDate: "April 10, 2026",
    interviewDate: "April 20, 2026",
    contact: "HEC Sindh Office.",
    eligibility: {
      description: "80%+ Marks in Board exam, Sindh resident."
    }
  },
  {
    title: "Private University Need Support (PUNS)",
    description: "Making premium private education accessible through need-based aid.",
    city: "Karachi",
    state: "Sindh",
    country: "Pakistan",
    status: "Open",
    testDate: "April 22, 2026",
    interviewDate: "April 28, 2026",
    contact: "Respective University Financial Aid Office.",
    eligibility: {
      description: "Enrolled in HEC recognized Private University, Sindh domicile."
    }
  }
];

const seedDB = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error("MONGO_URI not found in environment variables");
    }
    
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB for seeding...");

    // Clear existing data
    await University.deleteMany({});
    await Scholarship.deleteMany({});

    // Seed Universities
    const savedUniversities = await University.insertMany(universities);
    console.log(`✅ Seeded ${savedUniversities.length} universities.`);

    // Linking scholarships to MUIET as example
    const linkedScholarships = scholarships.map(s => ({
      ...s,
      university: savedUniversities[0]._id, // Link to MUET
      university_name: savedUniversities[0].name
    }));

    const savedScholarships = await Scholarship.insertMany(linkedScholarships);
    console.log(`✅ Seeded ${savedScholarships.length} scholarships.`);

    console.log("🚀 All Data Seeded Successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Seed Error:", error);
    process.exit(1);
  }
};

seedDB();
