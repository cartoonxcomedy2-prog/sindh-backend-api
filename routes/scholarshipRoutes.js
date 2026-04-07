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
const { createResponseCache } = require('../middleware/responseCache');

const cachePublicScholarships = createResponseCache({
    ttlSeconds: 30,
    tags: ['scholarships-public'],
});

const cacheScholarshipById = createResponseCache({
    ttlSeconds: 30,
    tags: (req) => [
        'scholarships-public',
        `scholarships-id:${req.params.id}`,
    ],
});

const cacheScholarshipAdminList = createResponseCache({
    ttlSeconds: 15,
    scopeByUser: true,
    tags: ['scholarships-admin-list'],
});

router.get(
    '/admin/list',
    protect,
    authorize('admin', 'scholarship'),
    cacheScholarshipAdminList,
    getScholarshipsAdminList
);
router
    .route('/:id/account')
    .get(protect, admin, getScholarshipAccount)
    .put(protect, admin, upsertScholarshipAccount);
router
    .route('/:id')
    .get(cacheScholarshipById, getScholarshipById)
    .put(protect, authorize('admin', 'scholarship'), updateScholarship)
    .delete(protect, admin, deleteScholarship);
router
    .route('/')
    .get(cachePublicScholarships, getScholarships)
    .post(protect, authorize('admin', 'scholarship'), createScholarship);

module.exports = router;
