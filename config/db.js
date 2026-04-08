const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const toPositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
};

const MONGO_RECONNECT_DELAY_MS = toPositiveInt(
    process.env.MONGO_RECONNECT_DELAY_MS,
    5000
);
const MONGO_MAX_RECONNECT_DELAY_MS = toPositiveInt(
    process.env.MONGO_MAX_RECONNECT_DELAY_MS,
    60000
);

let isConnecting = false;
let reconnectAttempt = 0;
let reconnectTimer = null;

const mongoConnectOptions = () => ({
    maxPoolSize: toPositiveInt(process.env.MONGO_MAX_POOL_SIZE, 60),
    minPoolSize: toPositiveInt(process.env.MONGO_MIN_POOL_SIZE, 5),
    maxIdleTimeMS: toPositiveInt(process.env.MONGO_MAX_IDLE_MS, 60000),
    serverSelectionTimeoutMS: toPositiveInt(
        process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
        10000
    ),
    socketTimeoutMS: toPositiveInt(process.env.MONGO_SOCKET_TIMEOUT_MS, 45000),
    connectTimeoutMS: toPositiveInt(process.env.MONGO_CONNECT_TIMEOUT_MS, 10000),
    autoIndex: process.env.NODE_ENV !== 'production',
});

const scheduleReconnect = () => {
    if (
        reconnectTimer ||
        isConnecting ||
        mongoose.connection.readyState === 1 ||
        mongoose.connection.readyState === 2
    ) {
        return;
    }

    reconnectAttempt += 1;
    const delay = Math.min(
        MONGO_RECONNECT_DELAY_MS * reconnectAttempt,
        MONGO_MAX_RECONNECT_DELAY_MS
    );

    console.warn(
        `MongoDB reconnect scheduled in ${delay}ms (attempt ${reconnectAttempt})`
    );

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectDB().catch((error) => {
            console.error(
                `MongoDB reconnect attempt failed: ${error?.message || error}`
            );
        });
    }, delay);

    if (typeof reconnectTimer.unref === 'function') {
        reconnectTimer.unref();
    }
};

const connectDB = async () => {
    if (mongoose.connection.readyState === 1) {
        return true;
    }

    if (isConnecting || mongoose.connection.readyState === 2) {
        return false;
    }

    try {
        isConnecting = true;
        mongoose.set('strictQuery', true);

        const conn = await mongoose.connect(
            process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sindh_db',
            mongoConnectOptions()
        );

        reconnectAttempt = 0;
        console.log(`MongoDB connected: ${conn.connection.host}`);
        return true;
    } catch (error) {
        console.error(`MongoDB connection error: ${error.message}`);
        scheduleReconnect();
        return false;
    } finally {
        isConnecting = false;
    }
};

mongoose.connection.on('connected', () => {
    reconnectAttempt = 0;
});

mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB disconnected');
    scheduleReconnect();
});

mongoose.connection.on('error', (error) => {
    console.error(`MongoDB runtime error: ${error.message}`);
});

const getMongoConnectionState = () => mongoose.connection.readyState;

connectDB.getMongoConnectionState = getMongoConnectionState;

module.exports = connectDB;
