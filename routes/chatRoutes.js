const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');

// Define chat route - PROTECTED to identify user role and scope data
router.post('/', protect, chatController.handleChat);

module.exports = router;
