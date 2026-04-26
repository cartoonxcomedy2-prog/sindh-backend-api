const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    } else if (req.query && req.query.token) {
        token = req.query.token;
    }

    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = await User.findById(decoded.id).select('-password');
            if (!req.user) {
                return res.status(401).json({ message: 'Not authorized, user does not exist' });
            }
            if (req.user.isActive === false) {
                return res.status(401).json({ message: 'Not authorized, account inactive' });
            }
            const tokenSessionVersion = Number(decoded?.sv);
            const currentSessionVersion = Number(req.user.sessionVersion || 0);
            if (!Number.isFinite(tokenSessionVersion) || tokenSessionVersion !== currentSessionVersion) {
                return res.status(401).json({ message: 'Session expired, please login again' });
            }
            next();
            return;
        } catch (error) {
            console.error(error);
            return res.status(401).json({ message: 'Not authorized, token failed' });
        }
    }

    if (!token) {
        return res.status(401).json({ message: 'Not authorized, no token' });
    }
};

const admin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        return res.status(401).json({ message: 'Not authorized as an admin' });
    }
};

const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({
                message: `User role ${req.user?.role || 'unknown'} is not authorized to access this route`,
            });
        }
        next();
    };
};

module.exports = { protect, admin, authorize };
