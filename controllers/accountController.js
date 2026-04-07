const User = require('../models/User');
const University = require('../models/University');
const Scholarship = require('../models/Scholarship');

const ACCOUNT_TYPES = ['admin', 'university', 'scholarship'];

const normalizeAccountType = (rawType) =>
    String(rawType || '')
        .trim()
        .toLowerCase();

const normalizeEmail = (rawEmail) =>
    String(rawEmail || '')
        .trim()
        .toLowerCase();

const findAssociationByEmail = async (email) => {
    if (!email) return null;

    const [university, scholarship] = await Promise.all([
        University.findOne({ 'adminAccount.email': email }).select('name').lean(),
        Scholarship.findOne({ 'adminAccount.email': email }).select('title').lean(),
    ]);

    return university?.name || scholarship?.title || null;
};

// @desc    List staff accounts
// @route   GET /api/accounts
// @access  Private/Admin
const getAccounts = async (req, res) => {
    try {
        const accounts = await User.find({ role: { $in: ACCOUNT_TYPES } })
            .sort({ createdAt: -1 })
            .lean();

        const enriched = await Promise.all(
            accounts.map(async (account) => ({
                ...account,
                type: normalizeAccountType(account.type || account.role),
                associatedName: await findAssociationByEmail(account.email),
            })),
        );

        res.json({ data: enriched });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Create staff account
// @route   POST /api/accounts
// @access  Private/Admin
const createAccount = async (req, res) => {
    try {
        const { name, password } = req.body;
        const email = normalizeEmail(req.body.email);
        const type = normalizeAccountType(req.body.type);

        if (!name || !email || !password || !type) {
            return res.status(400).json({ message: 'Name, email, password and type are required' });
        }

        if (!ACCOUNT_TYPES.includes(type)) {
            return res.status(400).json({ message: 'Invalid account type' });
        }

        const exists = await User.findOne({ email });
        if (exists) {
            return res.status(400).json({ message: 'Account with this email already exists' });
        }

        const account = await User.create({
            name,
            email,
            password,
            role: type,
        });

        const plain = account.toObject();
        delete plain.password;
        plain.type = normalizeAccountType(plain.type || plain.role);
        plain.associatedName = await findAssociationByEmail(plain.email);

        res.status(201).json({ data: plain });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// @desc    Update staff account
// @route   PUT /api/accounts/:id
// @access  Private/Admin
const updateAccount = async (req, res) => {
    try {
        const { name, password } = req.body;
        const email = normalizeEmail(req.body.email);
        const type = normalizeAccountType(req.body.type);
        const account = await User.findById(req.params.id).select('+password');

        if (!account) {
            return res.status(404).json({ message: 'Account not found' });
        }

        if (!ACCOUNT_TYPES.includes(account.role)) {
            return res.status(400).json({ message: 'Only staff accounts can be updated from this panel' });
        }

        if (type && !ACCOUNT_TYPES.includes(type)) {
            return res.status(400).json({ message: 'Invalid account type' });
        }

        if (email && email !== account.email) {
            const emailTaken = await User.findOne({ email, _id: { $ne: account._id } });
            if (emailTaken) {
                return res.status(400).json({ message: 'Email already in use' });
            }
            account.email = email;
        }

        if (typeof name === 'string') account.name = name;
        if (type) account.role = type;
        if (typeof password === 'string' && password.trim()) {
            account.password = password.trim();
        }

        await account.save();

        const plain = account.toObject();
        delete plain.password;
        plain.type = normalizeAccountType(plain.type || plain.role);
        plain.associatedName = await findAssociationByEmail(plain.email);

        res.json({ data: plain });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// @desc    Delete staff account
// @route   DELETE /api/accounts/:id
// @access  Private/Admin
const deleteAccount = async (req, res) => {
    try {
        const account = await User.findById(req.params.id).lean();

        if (!account) {
            return res.status(404).json({ message: 'Account not found' });
        }

        if (!ACCOUNT_TYPES.includes(account.role)) {
            return res.status(400).json({ message: 'Only staff accounts can be deleted from this panel' });
        }

        await User.findByIdAndDelete(req.params.id);
        res.json({ message: 'Account deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getAccounts,
    createAccount,
    updateAccount,
    deleteAccount,
};
