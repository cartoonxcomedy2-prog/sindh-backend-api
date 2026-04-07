const express = require('express');
const router = express.Router();
const {
    getApplicants,
    getAdminApplicationsList,
    getAllApplicationsTotal,
    getMyApplications,
    applyToOpportunity,
    updateApplicationStatus,
    updateUniversityStatus,
    bulkUpdateStatus,
    downloadApplicationDocument,
    downloadApplicationBundle,
    deleteApplication,
} = require('../controllers/applicationController');
const { protect, admin, authorize } = require('../middleware/authMiddleware');
const { appDocUpload } = require('../middleware/uploadMiddleware');
const { createResponseCache } = require('../middleware/responseCache');

const cacheAdminApplicationsTotal = createResponseCache({
    ttlSeconds: 10,
    scopeByUser: true,
    tags: ['applications-summary'],
});

const cacheAdminApplicationsList = createResponseCache({
    ttlSeconds: 12,
    scopeByUser: true,
    tags: ['applications-admin-list'],
});

const cacheMyApplications = createResponseCache({
    ttlSeconds: 10,
    scopeByUser: true,
    tags: ['applications-user-list'],
});

const cacheApplicantsByType = createResponseCache({
    ttlSeconds: 12,
    scopeByUser: true,
    tags: (req) => [
        'applications-admin-list',
        `applications-applicants:${req.params.type}:${req.params.id}`,
    ],
});

router.get('/total', protect, admin, cacheAdminApplicationsTotal, getAllApplicationsTotal);
router.get(
    '/admin/list',
    protect,
    authorize('admin', 'university', 'scholarship'),
    cacheAdminApplicationsList,
    getAdminApplicationsList
);
router.get('/me', protect, cacheMyApplications, getMyApplications);
router.post('/apply', protect, authorize('user'), applyToOpportunity);
router.put('/bulk-status', protect, authorize('admin', 'university', 'scholarship'), bulkUpdateStatus);
router.get('/:id/download-bundle', protect, authorize('admin', 'university', 'scholarship', 'user'), downloadApplicationBundle);
router.get('/:id/download-doc/:field', protect, authorize('admin', 'university', 'scholarship', 'user'), downloadApplicationDocument);
router.put('/:id/university-status', protect, authorize('admin', 'university', 'scholarship'), appDocUpload, updateUniversityStatus);
router.get(
    '/:type/:id',
    protect,
    authorize('admin', 'university', 'scholarship'),
    cacheApplicantsByType,
    getApplicants
);
router.route('/:id')
    .put(protect, authorize('admin', 'university', 'scholarship'), appDocUpload, updateApplicationStatus)
    .delete(protect, admin, deleteApplication);

module.exports = router;
