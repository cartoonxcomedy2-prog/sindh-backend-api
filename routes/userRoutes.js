const express = require('express');
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
const { protect, admin } = require('../middleware/authMiddleware');
const { mixedUpload } = require('../middleware/uploadMiddleware');

router.post('/', registerUser);
router.post('/login', authUser);
router.get('/', protect, admin, getUsers);
router.get('/profile', protect, getUserProfile);
router.put('/profile', protect, mixedUpload, updateUserProfile);
router.get('/notifications', protect, getUserNotifications);
router.put('/notifications/read', protect, markAllNotificationsAsRead);
router.get('/:id/education/:section/:field/download', protect, downloadUserEducationFile);
router.get('/:id', protect, admin, getUserById);
router.put('/:id/education', protect, mixedUpload, updateUserEducation);
router.delete('/:id/education/:section/:field', protect, deleteUserEducationField);
router.put('/:id/profile', protect, admin, updateUserByAdmin);
router.delete('/:id', protect, admin, deleteUserByAdmin);

module.exports = router;
