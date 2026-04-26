const axios = require('axios');
const pdf = require('pdf-parse');

/**
 * Downloads a PDF from a URL and extracts its text content.
 * @param {string} url - The Cloudinary or local URL of the PDF.
 * @returns {Promise<string>} - The extracted text.
 */
exports.extractTextFromPdf = async (url) => {
    if (!url || typeof url !== 'string' || !url.toLowerCase().includes('.pdf')) {
        return '';
    }

    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const data = await pdf(response.data);
        // Clean up the text: remove excess whitespace and non-printable characters
        return data.text
            .replace(/\s+/g, ' ')
            .replace(/[^\x20-\x7E\x0A\x0D]/g, '')
            .slice(0, 10000); // Limit to 10k chars to avoid blowing up context
    } catch (error) {
        console.error('Error extracting PDF text:', error.message);
        return '';
    }
};
