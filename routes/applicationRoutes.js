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

router.get('/total', protect, admin, getAllApplicationsTotal);
router.get('/admin/list', protect, authorize('admin', 'university', 'scholarship'), getAdminApplicationsList);
router.get('/me', protect, getMyApplications);
router.post('/apply', protect, authorize('user'), applyToOpportunity);
router.put('/bulk-status', protect, authorize('admin', 'university', 'scholarship'), bulkUpdateStatus);
router.get('/:id/download-bundle', protect, authorize('admin', 'university', 'scholarship', 'user'), downloadApplicationBundle);
router.get('/:id/download-doc/:field', protect, authorize('admin', 'university', 'scholarship', 'user'), downloadApplicationDocument);
router.put('/:id/university-status', protect, authorize('admin', 'university', 'scholarship'), appDocUpload, updateUniversityStatus);
router.get('/:type/:id', protect, authorize('admin', 'university', 'scholarship'), getApplicants);
router.route('/:id')
    .put(protect, authorize('admin', 'university', 'scholarship'), appDocUpload, updateApplicationStatus)
    .delete(protect, admin, deleteApplication);

module.exports = router;
