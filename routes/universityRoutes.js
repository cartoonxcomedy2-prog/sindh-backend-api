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
const { createResponseCache } = require('../middleware/responseCache');

const cachePublicUniversities = createResponseCache({
    ttlSeconds: 30,
    tags: ['universities-public'],
});

const cacheUniversityById = createResponseCache({
    ttlSeconds: 30,
    tags: (req) => [`universities-public`, `universities-id:${req.params.id}`],
});

const cacheUniversityAdminList = createResponseCache({
    ttlSeconds: 15,
    scopeByUser: true,
    tags: ['universities-admin-list'],
});

router.get(
    '/admin/list',
    protect,
    authorize('admin', 'university', 'scholarship'),
    cacheUniversityAdminList,
    getUniversitiesAdminList
);
router
    .route('/:id/account')
    .get(protect, admin, getUniversityAccount)
    .put(protect, admin, upsertUniversityAccount);
router
    .route('/:id')
    .get(cacheUniversityById, getUniversityById)
    .put(protect, authorize('admin', 'university'), updateUniversity)
    .delete(protect, admin, deleteUniversity);
router
    .route('/')
    .get(cachePublicUniversities, getUniversities)
    .post(protect, authorize('admin', 'university'), createUniversity);

module.exports = router;
