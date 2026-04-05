const mongoose = require('mongoose');

const bannerSchema = mongoose.Schema(
    {
        title: { type: String, required: true },
        imageUrl: { type: String, required: true },
        active: { type: Boolean, default: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Banner', bannerSchema);
