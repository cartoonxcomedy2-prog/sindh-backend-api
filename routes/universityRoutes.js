const express = require('express');
const router = express.Router();
const {
    getUniversities,
    getUniversitiesAdminList,
    getUniversityById,
    createUniversity,
    updateUniversity,
    deleteUniversity,
    getUniversityAccount,
    upsertUniversityAccount,
} = require('../controllers/universityController');
const { protect, admin, authorize } = require('../middleware/authMiddleware');

router.get('/admin/list', protect, authorize('admin', 'university'), getUniversitiesAdminList);
router
    .route('/:id/account')
    .get(protect, admin, getUniversityAccount)
    .put(protect, admin, upsertUniversityAccount);
router
    .route('/:id')
    .get(getUniversityById)
    .put(protect, authorize('admin', 'university'), updateUniversity)
    .delete(protect, admin, deleteUniversity);
router.route('/').get(getUniversities).post(protect, authorize('admin', 'university'), createUniversity);

module.exports = router;
