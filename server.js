process.env.DOTENV_QUIET = "true";
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const path = require('path');
const cluster = require('cluster');
const os = require('os');
const connectDB = require('./config/db');
const sanitizeMiddleware = require('./middleware/sanitizeMiddleware');

// ==================== CLUSTERING FOR MULTI-CORE ====================
// Only spawn multiple workers if we are in production on Render, otherwise use 1 worker for clean local logs
const isRender = process.env.RENDER === 'true';
const numCPUs = isRender ? os.cpus().length : 1;

if (cluster.isMaster && numCPUs > 1) {
    console.log(`🚀 Master process ${process.pid} spawning ${numCPUs} workers...`);
    
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`⚠️ Worker ${worker.process.pid} died. Restarting...`);
        cluster.fork();
    });

    cluster.on('online', (worker) => {
        console.log(`✅ Worker ${worker.process.pid} is online`);
    });
} else {
    // Worker process starts here
    // Load environment variables
    dotenv.config({ quiet: true });

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

const toPositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
};

// Trust Render's proxy (1 for single hop)
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Middleware
app.use(
    cors({
        origin: true,
        credentials: true,
        optionsSuccessStatus: 204,
    })
);

app.use(
    helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
);
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ limit: '12mb', extended: true }));
app.use(sanitizeMiddleware);
if (!isProduction || process.env.ENABLE_REQUEST_LOGS === 'true') {
    app.use(morgan('dev'));
}

// Prevent stale API responses without disabling static asset caching.
app.use('/api', (req, res, next) => {
    res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
    );
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
});

const apiLimiter = rateLimit({
    windowMs: toPositiveInt(process.env.API_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    max: toPositiveInt(process.env.API_RATE_LIMIT_MAX, 1200),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: 'Too many requests. Please try again shortly.',
    skip: (req) => req.path === '/healthz',
});
app.use('/api', apiLimiter);

// Routes
const userRoutes = require('./routes/userRoutes');
const bannerRoutes = require('./routes/bannerRoutes');
const universityRoutes = require('./routes/universityRoutes');
const scholarshipRoutes = require('./routes/scholarshipRoutes');
const accountRoutes = require('./routes/accountRoutes');
const applicationRoutes = require('./routes/applicationRoutes');
const chatRoutes = require('./routes/chatRoutes');

app.get('/', (req, res) => {
    res.json({ message: 'Welcome to Sindh API' });
});

app.get('/api', (req, res) => {
    res.json({ message: 'Welcome to Sindh API', status: 'online' });
});

// Always return 200 to avoid restart loops from transient DB outages.
app.get('/healthz', (req, res) => {
    const dbReadyState = getMongoConnectionState();
    res.status(200).json({
        status: 'ok',
        uptimeSeconds: Math.floor(process.uptime()),
        db: {
            readyState: dbReadyState,
            state: MONGO_STATES[dbReadyState] || 'unknown',
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
app.use('/api/chat', chatRoutes);

// Static folder for uploads
app.use(
    '/uploads',
    express.static(path.join(__dirname, '/uploads'), {
        maxAge: isProduction ? '10m' : 0,
    })
);

// Error handling middleware
app.use((err, req, res, _next) => {
    const fs = require('fs');
    const path = require('path');
    const logMsg = `${new Date().toISOString()} - ${err.name}: ${err.message}\n${err.stack}\n\n`;
    fs.appendFileSync(path.join(__dirname, 'error_log.txt'), logMsg);

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
    console.log(`✅ Server running in ${process.env.NODE_ENV} mode on ${HOST}:${PORT} (Worker ${process.pid})`);
    console.log(`🔗 API Check Link: http://localhost:${PORT}/api`);
});

// Close worker gracefully
process.on('SIGTERM', () => {
    console.log(`⚠️ Worker ${process.pid} received SIGTERM, shutting down...`);
    process.exit(0);
});
}
