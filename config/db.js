const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const toPositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
};

const connectDB = async () => {
    try {
        mongoose.set('strictQuery', true);

        const conn = await mongoose.connect(
            process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sindh_db',
            {
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
            }
        );

        console.log(`MongoDB connected: ${conn.connection.host}`);
    } catch (error) {
        console.error(`MongoDB connection error: ${error.message}`);
        process.exit(1);
    }
};

module.exports = connectDB;
