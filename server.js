const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const dotenv = require('dotenv');
const connectDB = require('./config/db');

// Load environment variables
dotenv.config();

// Connect to MongoDB
connectDB();

const app = express();

// Security imports
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const rateLimit = require('express-rate-limit');

// Middleware
app.use(cors());

// --- Security Middleware ---
// 1. Set security HTTP headers (fixes XSS and clickjacking vulnerabilities)
app.use(helmet());
// 2. Prevent NoSQL Injection attacks (sanitizes req.body, req.query, and req.params)
app.use(mongoSanitize());
// 3. Rate limiting (prevents DDoS and brute-force login attacks)
const limiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 mins
    max: 500, // limit each IP to 500 requests per 10 mins
    message: 'Too many requests from this IP, please try again later.'
});
app.use('/api', limiter);
// ---------------------------
app.use(express.json());
app.use(morgan('dev'));

// Prevent caching on all API responses - always serve fresh data
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
});

// Routes
const userRoutes = require('./routes/userRoutes');
const bannerRoutes = require('./routes/bannerRoutes');
const universityRoutes = require('./routes/universityRoutes');
const scholarshipRoutes = require('./routes/scholarshipRoutes');
const accountRoutes = require('./routes/accountRoutes');
const applicationRoutes = require('./routes/applicationRoutes');

app.get('/', (req, res) => {
    res.json({ message: 'Welcome to Sindh API' });
});

app.use('/api/users', userRoutes);
app.use('/api/banners', bannerRoutes);
app.use('/api/universities', universityRoutes);
app.use('/api/scholarships', scholarshipRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/applications', applicationRoutes);

// Static folder for uploads
const path = require('path');
app.use('/uploads', express.static(path.join(__dirname, '/uploads')));

// Error handling middleware
app.use((err, req, res, next) => {
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    res.status(statusCode).json({
        message: err.message,
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`🚀 Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});
