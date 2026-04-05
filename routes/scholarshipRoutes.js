const express = require('express');
const router = express.Router();
const {
    getScholarships,
    getScholarshipsAdminList,
    getScholarshipById,
    createScholarship,
    updateScholarship,
    deleteScholarship,
    getScholarshipAccount,
    upsertScholarshipAccount,
} = require('../controllers/scholarshipController');
const { protect, admin, authorize } = require('../middleware/authMiddleware');

router.get('/admin/list', protect, authorize('admin', 'scholarship'), getScholarshipsAdminList);
router
    .route('/:id/account')
    .get(protect, admin, getScholarshipAccount)
    .put(protect, admin, upsertScholarshipAccount);
router
    .route('/:id')
    .get(getScholarshipById)
    .put(protect, authorize('admin', 'scholarship'), updateScholarship)
    .delete(protect, admin, deleteScholarship);
router.route('/').get(getScholarships).post(protect, authorize('admin', 'scholarship'), createScholarship);

module.exports = router;
