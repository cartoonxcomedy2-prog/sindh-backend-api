const mongoose = require('mongoose');
const dotenv = require('dotenv');
const University = require('./models/University');
const Scholarship = require('./models/Scholarship');

dotenv.config();

const universities = [
  {
    name: "Mehran University of Engineering and Technology (MUET)",
    location: { country: "Pakistan", state: "Sindh", city: "Jamshoro" },
    details: { about: "One of the top-ranked engineering universities in Pakistan.", contact: "Jamshoro, Sindh. Phone: 022-2771167" },
    type: "Public",
    thumbnail: "https://muet.edu.pk/files/images/logo.png",
    programs: ["B.E. Civil", "B.E. Software", "M.E. Energy Systems", "MS Computer Science", "PhD Mechanical"]
  },
  {
    name: "University of Sindh",
    location: { country: "Pakistan", state: "Sindh", city: "Jamshoro" },
    details: { about: "Oldest University of Pakistan with a rich academic history.", contact: "Allama I.I. Kazi Campus, Jamshoro." },
    type: "Public",
    thumbnail: "https://usindh.edu.pk/files/images/logo.png",
    programs: ["BS IT", "MBA Executive", "MA English", "MS Mathematics", "PhD Physics"]
  },
  {
    name: "Shah Abdul Latif University",
    location: { country: "Pakistan", state: "Sindh", city: "Khairpur" },
    details: { about: "Premier educational institution in upper Sindh.", contact: "Khairpur, Sindh. Phone: 0243-928001" },
    type: "Public",
    thumbnail: "https://salu.edu.pk/files/images/logo.png",
    programs: ["BBA", "BS Zoology", "MS Management", "PhD Chemistry"]
  },
  {
    name: "IBA Karachi",
    location: { country: "Pakistan", state: "Sindh", city: "Karachi" },
    details: { about: "Excellence in business and technological education.", contact: "Main Campus, University Road, Karachi." },
    type: "Public",
    thumbnail: "https://iba.edu.pk/files/images/logo.png",
    programs: ["BBA", "BS CS", "MS Data Science", "MBA", "PhD Economics"]
  },
  {
    name: "NED University of Engineering",
    location: { country: "Pakistan", state: "Sindh", city: "Karachi" },
    details: { about: "Legacy institution for engineering and technology.", contact: "University Road, Karachi." },
    type: "Public",
    thumbnail: "https://neduet.edu.pk/files/images/logo.png",
    programs: ["B.E. Electrical", "B.E. Textiles", "MS Environmental", "PhD Telecom"]
  },
  {
    name: "Liaquat University of Medical & Health Sciences (LUMHS)",
    location: { country: "Pakistan", state: "Sindh", city: "Jamshoro" },
    details: { about: "Leading medical university in Pakistan.", contact: "Jamshoro, Sindh." },
    type: "Public",
    thumbnail: "https://lumhs.edu.pk/files/images/logo.png",
    programs: ["MBBS", "BDS", "M.Phil Anatomy", "PhD Public Health"]
  },
  {
    name: "Shaheed Mohtarma Benazir Bhutto Medical University",
    location: { country: "Pakistan", state: "Sindh", city: "Larkana" },
    details: { about: "Advanced healthcare education for Sindh.", contact: "Larkana, Sindh." },
    type: "Public",
    thumbnail: "https://smbbmu.edu.pk/files/images/logo.png",
    programs: ["MBBS", "BDS", "Nursing", "Masters Health System"]
  },
  {
    name: "Sukkuk University of IBA",
    location: { country: "Pakistan", state: "Sindh", city: "Sukkur" },
    details: { about: "Pioneer in modern technological education.", contact: "Sukkur, Sindh." },
    type: "Public",
    thumbnail: "https://iba-suk.edu.pk/files/images/logo.png",
    programs: ["BS CS", "BBA", "Education Masters", "MS Maths"]
  },
  {
    name: "People's Medical University for Women",
    location: { country: "Pakistan", state: "Sindh", city: "Nawabshah" },
    details: { about: "Dedicated medical education for women.", contact: "Nawabshah, Sindh." },
    type: "Public",
    thumbnail: "https://pmuw.edu.pk/files/images/logo.png",
    programs: ["MBBS", "DPT", "PhD Pharmacology"]
  },
  {
    name: "Dow University of Health Sciences",
    location: { country: "Pakistan", state: "Sindh", city: "Karachi" },
    details: { about: "Top medical and health science institution in Karachi.", contact: "Baba-e-Urdu Road, Karachi." },
    type: "Public",
    thumbnail: "https://duhs.edu.pk/files/images/logo.png",
    programs: ["MBBS", "BDS", "MS Biotech", "PhD Medical"]
  }
];

const scholarships = [
  {
    title: "Need Based Scholarship Sindh - 2026",
    university: null,
    location: { country: "Pakistan", state: "Sindh", city: "All" },
    details: {
      description: "Support for deserving students in Sindh.",
      eligibility: "Sindh Domicile, Family income < 50,000 PKR, Minimum 2.5 CGPA.",
      contact: "E-mail: help@scholarship.onrender.com"
    },
    status: "Upcoming",
    dates: {
      openingDate: new Date("2026-05-01"),
      closingDate: new Date("2026-06-30"),
      testDate: "July 15, 2026",
      interviewDate: "August 01, 2026"
    }
  },
  {
    title: "MUET Alumni Scholarship - Phase 2",
    university: null,
    location: { country: "Pakistan", state: "Sindh", city: "Jamshoro" },
    details: {
      description: "Funded by MUET alumni for engineering students.",
      eligibility: "Current MUET student, No other scholarship, Minimum 75% Marks.",
      contact: "Alumni Office, MUET Jamshoro."
    },
    status: "Open",
    dates: {
      openingDate: new Date("2026-04-01"),
      closingDate: new Date("2026-04-20"),
      testDate: "April 25, 2026",
      interviewDate: "May 05, 2026"
    }
  },
  {
    title: "Sindh Education Endowment Fund (SEEF)",
    university: null,
    location: { country: "Pakistan", state: "Sindh", city: "All" },
    details: {
      description: "Government of Sindh fully funded scholarship.",
      eligibility: "Sindh domiciled, Enrolled in Public University, Income < 100,000/Month.",
      contact: "Education Dept, Karachi."
    },
    status: "Upcoming",
    dates: {
      openingDate: new Date("2026-08-01"),
      closingDate: new Date("2026-09-30"),
      testDate: "October 10, 2026",
      interviewDate: "October 20, 2026"
    }
  },
  {
    title: "USAID Merit and Need Based Scholarship",
    university: null,
    location: { country: "Pakistan", state: "Sindh", city: "All" },
    details: {
      description: "International support for higher education in Pakistan.",
      eligibility: "Merit based, Must show financial need, Available in 30+ universities.",
      contact: "USAID local office or University Financial Aid Office."
    },
    status: "Upcoming",
    dates: {
      openingDate: new Date("2026-06-05"),
      closingDate: new Date("2026-07-15"),
      testDate: "August 10, 2026",
      interviewDate: "August 20, 2026"
    }
  },
  {
    title: "OGDCL National Talent Hunt Program",
    university: null,
    location: { country: "Pakistan", state: "Sindh", city: "All" },
    details: {
      description: "For underprivileged students from remote areas of Sindh.",
      eligibility: "Domicile of specific districts, Enrolled in select partner universities.",
      contact: "Financial Aid Office, Sukkur IBA."
    },
    status: "Upcoming",
    dates: {
      openingDate: new Date("2026-03-25"),
      closingDate: new Date("2026-05-15"),
      testDate: "May 25, 2026",
      interviewDate: "June 05, 2026"
    }
  },
  {
    title: "IBA Karachi Talent Hunt Program",
    university: null,
    location: { country: "Pakistan", state: "Sindh", city: "Karachi" },
    details: {
      description: "Targeted support for talented students seeking admission at IBA.",
      eligibility: "Merit based, Special consideration for first-generation students.",
      contact: "THP Office, IBA Karachi."
    },
    status: "Upcoming",
    dates: {
      openingDate: new Date("2026-05-10"),
      closingDate: new Date("2026-06-10"),
      testDate: "June 20, 2026",
      interviewDate: "June 30, 2026"
    }
  },
  {
    title: "Scottish Scholarship for Women",
    university: null,
    location: { country: "Pakistan", state: "Sindh", city: "All" },
    details: {
      description: "Encouraging higher education among women in Sindh.",
      eligibility: "Female students only, Master's degree students, All disciplines.",
      contact: "British Council Pakistan."
    },
    status: "Upcoming",
    dates: {
      openingDate: new Date("2026-07-20"),
      closingDate: new Date("2026-08-31"),
      testDate: "No Test",
      interviewDate: "September 10, 2026"
    }
  },
  {
    title: "PEEF Higher Education Scholarship",
    university: null,
    location: { country: "Pakistan", state: "Sindh", city: "All" },
    details: {
      description: "Punjab Education Endowment Fund support for other provinces.",
      eligibility: "Top 20% in Intermediate, Income criteria applies.",
      contact: "PEEF local office or Website."
    },
    status: "Upcoming",
    dates: {
      openingDate: new Date("2026-09-01"),
      closingDate: new Date("2026-10-15"),
      testDate: "None",
      interviewDate: "October 30, 2026"
    }
  },
  {
    title: "Higher Education Sindh Council Merit",
    university: null,
    location: { country: "Pakistan", state: "Sindh", city: "All" },
    details: {
      description: "State-wide merit scholarship for top performers.",
      eligibility: "80%+ Marks in Board exam, Sindh resident.",
      contact: "HEC Sindh Office."
    },
    status: "Upcoming",
    dates: {
      openingDate: new Date("2026-01-15"),
      closingDate: new Date("2026-03-30"),
      testDate: "April 10, 2026",
      interviewDate: "April 20, 2026"
    }
  },
  {
    title: "Private University Need Support (PUNS)",
    university: null,
    location: { country: "Pakistan", state: "Sindh", city: "Karachi" },
    details: {
      description: "Financial assistance for students in private chartered universities.",
      eligibility: "Enrolled in HEC recognized Private University, Sindh domicile.",
      contact: "Respective University Financial Aid Office."
    },
    status: "Open",
    dates: {
      openingDate: new Date("2026-04-01"),
      closingDate: new Date("2026-04-18"),
      testDate: "April 22, 2026",
      interviewDate: "April 28, 2026"
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

    // Seed Data
    const savedUniversities = await University.insertMany(universities);
    console.log(`✅ Seeded ${savedUniversities.length} universities.`);

    // Linking scholarships to first university as example (Optional)
    const linkedScholarships = scholarships.map(s => ({
      ...s,
      university: savedUniversities[0]._id // Link to MUET for now
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
