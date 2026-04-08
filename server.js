const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const sanitizeMiddleware = require('./middleware/sanitizeMiddleware');

// Load environment variables
dotenv.config();

// Connect to MongoDB
connectDB();

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION! 💥', err.name, err.message, err.stack);
    // Don't exit process to prevent 521 for debugging
});

process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION! 💥', err.name, err.message, err.stack);
    // Don't exit process to prevent 521 for debugging
});

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const isStrictCors =
    isProduction && String(process.env.CORS_STRICT || '').toLowerCase() === 'true';

// Trust Render's proxy for accurate rate limiting
app.set('trust proxy', 1);

// Security imports
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Middleware
const configuredOrigins = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (configuredOrigins.includes(origin)) return callback(null, true);
            if (configuredOrigins.length === 0 && !isStrictCors) {
                return callback(null, true);
            }
            return callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
        optionsSuccessStatus: 204,
    })
);

// --- Security Middleware ---
// 1. Set security HTTP headers (fixes XSS and clickjacking vulnerabilities)
app.use(helmet());
app.use(compression({ threshold: 1024 }));
// 2. Rate limiting (prevents DDoS and brute-force login attacks)
const limiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: 'Too many requests from this IP, please try again later.',
});
app.use('/api', limiter);
// ---------------------------
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ limit: '12mb', extended: true }));
app.use(sanitizeMiddleware);
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
    const statusCode = res.statusCode >= 400 ? res.statusCode : 500;
    const message =
        statusCode >= 500 && isProduction
            ? 'Internal server error'
            : err.message || 'Request failed';
    res.status(statusCode).json({
        message,
        stack: isProduction ? null : err.stack,
    });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`🚀 Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});
