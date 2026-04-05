const express = require('express');
const router = express.Router();
const { protect, admin } = require('../middleware/authMiddleware');
const {
    getAccounts,
    createAccount,
    updateAccount,
    deleteAccount,
} = require('../controllers/accountController');

router.route('/').get(protect, admin, getAccounts).post(protect, admin, createAccount);
router.route('/:id').put(protect, admin, updateAccount).delete(protect, admin, deleteAccount);

module.exports = router;
