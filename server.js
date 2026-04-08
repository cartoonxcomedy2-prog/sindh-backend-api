const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const dotenv = require('dotenv');
const path = require('path');
const connectDB = require('./config/db');
const sanitizeMiddleware = require('./middleware/sanitizeMiddleware');
const { getResponseCacheStats } = require('./middleware/responseCache');
const { getQueueStats } = require('./utils/jobQueue');

// Load environment variables
dotenv.config();

// Connect to MongoDB (with internal reconnect handling).
connectDB();
const getMongoConnectionState =
    typeof connectDB.getMongoConnectionState === 'function'
        ? connectDB.getMongoConnectionState
        : () => 0;

const MONGO_STATES = Object.freeze({
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
});

const toMegabytes = (bytes) =>
    Number((Number(bytes || 0) / (1024 * 1024)).toFixed(2));

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION!', err?.name, err?.message, err?.stack);
    // Keep process alive so transient errors do not bring down the host.
});

process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION!', err?.name, err?.message, err?.stack);
    // Keep process alive so transient errors do not bring down the host.
});

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

// Trust Render's proxy (1 for single hop)
app.set('trust proxy', 1);

// Middleware
app.use(
    cors({
        origin: true,
        credentials: true,
        optionsSuccessStatus: 204,
    })
);

app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ limit: '12mb', extended: true }));
app.use(sanitizeMiddleware);
app.use(morgan('dev'));

// Prevent caching on all API responses - always serve fresh data
app.use((req, res, next) => {
    res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
    );
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

// Always return 200 to avoid restart loops from transient DB outages.
app.get('/healthz', (req, res) => {
    const dbReadyState = getMongoConnectionState();
    const memory = process.memoryUsage();
    res.status(200).json({
        status: 'ok',
        uptimeSeconds: Math.floor(process.uptime()),
        db: {
            readyState: dbReadyState,
            state: MONGO_STATES[dbReadyState] || 'unknown',
        },
        runtime: {
            pid: process.pid,
            node: process.version,
            memoryMb: {
                rss: toMegabytes(memory.rss),
                heapTotal: toMegabytes(memory.heapTotal),
                heapUsed: toMegabytes(memory.heapUsed),
                external: toMegabytes(memory.external),
            },
            cache: getResponseCacheStats(),
            queue: getQueueStats(),
        },
        timestamp: new Date().toISOString(),
    });
});

app.use('/api/users', userRoutes);
app.use('/api/banners', bannerRoutes);
app.use('/api/universities', universityRoutes);
app.use('/api/scholarships', scholarshipRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/applications', applicationRoutes);

// Static folder for uploads
app.use('/uploads', express.static(path.join(__dirname, '/uploads')));

// Error handling middleware
app.use((err, req, res, _next) => {
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
const HOST = '0.0.0.0'; // Explicitly bind to all IPv4 addresses

app.listen(PORT, HOST, () => {
    console.log(`Server running in ${process.env.NODE_ENV} mode on ${HOST}:${PORT}`);
});
