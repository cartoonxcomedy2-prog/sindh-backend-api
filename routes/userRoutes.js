const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const {
    authUser,
    registerUser,
    getUserProfile,
    updateUserProfile,
    getUsers,
    getUserById,
    updateUserByAdmin,
    updateUserEducation,
    deleteUserEducationField,
    downloadUserEducationFile,
    getUserNotifications,
    markAllNotificationsAsRead,
    deleteUserByAdmin,
} = require('../controllers/userController');
const { protect, admin, authorize } = require('../middleware/authMiddleware');
const { mixedUpload } = require('../middleware/uploadMiddleware');
const { createResponseCache } = require('../middleware/responseCache');

const cacheUsersList = createResponseCache({
    ttlSeconds: 10,
    scopeByUser: true,
    tags: ['users-list'],
});

const cacheUserById = createResponseCache({
    ttlSeconds: 10,
    scopeByUser: true,
    tags: (req) => ['users-list', `users-id:${req.params.id}`],
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: 'Too many login attempts. Please try again later.',
});

router.post('/', registerUser);
router.post('/login', authLimiter, authUser);
router.get('/', protect, admin, cacheUsersList, getUsers);
router.get('/profile', protect, getUserProfile);
router.put('/profile', protect, mixedUpload, updateUserProfile);
router.get('/notifications', protect, getUserNotifications);
router.put('/notifications/read', protect, markAllNotificationsAsRead);
router.get('/:id/education/:section/:field/download', protect, downloadUserEducationFile);
router.get('/:id', protect, authorize('admin', 'university', 'scholarship'), cacheUserById, getUserById);
router.put('/:id/education', protect, mixedUpload, updateUserEducation);
router.delete('/:id/education/:section/:field', protect, deleteUserEducationField);
router.put('/:id/profile', protect, authorize('admin', 'university', 'scholarship'), updateUserByAdmin);
router.delete('/:id', protect, admin, deleteUserByAdmin);

module.exports = router;
