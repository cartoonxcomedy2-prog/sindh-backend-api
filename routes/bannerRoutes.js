const express = require('express');
const router = express.Router();
const { getBanners, createBanner, updateBanner, deleteBanner } = require('../controllers/bannerController');
const { protect, admin } = require('../middleware/authMiddleware');
const { createResponseCache } = require('../middleware/responseCache');

const cachePublicBanners = createResponseCache({
    ttlSeconds: 45,
    tags: ['banners-public'],
});

router.route('/').get(cachePublicBanners, getBanners).post(protect, admin, createBanner);
router.route('/:id').patch(protect, admin, updateBanner).delete(protect, admin, deleteBanner);

module.exports = router;
