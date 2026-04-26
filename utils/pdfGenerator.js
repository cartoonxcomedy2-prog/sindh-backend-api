const PDFDocument = require('pdfkit');

/**
 * Generates a professional PDF summary of a student's application.
 * @param {Object} application - The application object (populated with university/scholarship)
 * @param {Object} user - The student user object (with education details)
 * @returns {Promise<Buffer>}
 */
const generateApplicationSummaryPdf = (application, user) => {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];

        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', (err) => reject(err));

        // --- Header ---
        doc.fillColor('#1a5f49').fontSize(24).text('Application Summary', { align: 'center' });
        doc.moveDown(0.5);
        doc.fillColor('#444').fontSize(10).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(1.5);

        // --- Application Details Section ---
        doc.fillColor('#1a5f49').fontSize(16).text('1. Application Information', { underline: true });
        doc.moveDown(0.5);
        
        const targetName = application.type === 'University' 
            ? (application.university?.name || 'N/A')
            : (application.scholarship?.title || 'N/A');
            
        renderField(doc, 'Opportunity Type', application.type);
        renderField(doc, 'Target Institution', targetName);
        renderField(doc, 'Application ID', application._id.toString());
        renderField(doc, 'Current Status', application.status);
        renderField(doc, 'Applied Date', application.appliedAt ? new Date(application.appliedAt).toLocaleDateString() : 'N/A');

        if (application.selectedPrograms && application.selectedPrograms.length > 0) {
            doc.moveDown(0.5);
            doc.fillColor('#333').fontSize(12).text('Selected Programs (Priority Order):');
            const sortedPrograms = [...application.selectedPrograms].sort((a, b) => (a.priority || 99) - (b.priority || 99));
            sortedPrograms.forEach((p, index) => {
                doc.fontSize(10).text(`   ${index + 1}. ${p.programName} (${p.programType || 'N/A'})`);
            });
        }
        doc.moveDown(1.5);

        // --- Personal Information Section ---
        doc.fillColor('#1a5f49').fontSize(16).text('2. Personal Information', { underline: true });
        doc.moveDown(0.5);
        
        renderField(doc, 'Full Name', user.name);
        renderField(doc, 'Email', user.email);
        renderField(doc, 'Phone', user.phone || 'N/A');
        renderField(doc, 'Date of Birth', user.dateOfBirth || user.education?.personalInfo?.dateOfBirth || 'N/A');
        doc.moveDown(0.5);
        
        renderField(doc, 'Student CNIC / National ID', user.education?.nationalId?.idNumber || 'N/A');
        renderField(doc, 'Student CNIC File', user.education?.nationalId?.file ? 'Uploaded (See ZIP Bundle)' : 'Missing');
        renderField(doc, 'Father Name', user.fatherName || user.education?.personalInfo?.fatherName || 'N/A');
        renderField(doc, 'Father CNIC / National ID', user.education?.personalInfo?.fatherCnicNumber || 'N/A');
        renderField(doc, 'Father CNIC File', user.education?.personalInfo?.fatherCnicFile ? 'Uploaded (See ZIP Bundle)' : 'Missing');
        renderField(doc, 'Father Contact Number', user.education?.personalInfo?.fatherContactNumber || 'N/A');
        doc.moveDown(0.5);

        renderField(doc, 'Current Home Address', user.address || 'N/A');
        renderField(doc, 'City', user.city || 'N/A');
        renderField(doc, 'State / Province', user.state || 'N/A');
        renderField(doc, 'Country', user.country || 'Pakistan');
        doc.moveDown(1.5);

        // --- Education Section ---
        doc.fillColor('#1a5f49').fontSize(16).text('3. Education History', { underline: true });
        doc.moveDown(0.5);

        const edu = user.education || {};
        
        if (edu.matric) {
            renderEducationBlock(doc, 'Matric / O-Level', edu.matric);
        }
        if (edu.intermediate) {
            renderEducationBlock(doc, 'Intermediate / A-Level', edu.intermediate);
        }
        if (edu.bachelor) {
            renderEducationBlock(doc, 'Bachelor Degree', edu.bachelor);
        }
        if (edu.masters) {
            renderEducationBlock(doc, 'Masters Degree', edu.masters);
        }

        // --- Footer ---
        const pageCount = doc.bufferedPageRange().count;
        for (let i = 0; i < pageCount; i++) {
            doc.switchToPage(i);
            doc.fillColor('#999').fontSize(8).text(
                `Sindh Portal Application Summary - Page ${i + 1} of ${pageCount}`,
                50,
                doc.page.height - 50,
                { align: 'center' }
            );
        }

        doc.end();
    });
};

const renderField = (doc, label, value) => {
    doc.fillColor('#555').fontSize(10).font('Helvetica-Bold').text(`${label}: `, { continued: true })
       .font('Helvetica').fillColor('#000').text(value || 'N/A');
    doc.moveDown(0.3);
};

const renderEducationBlock = (doc, title, data) => {
    doc.fillColor('#333').fontSize(12).font('Helvetica-Bold').text(title);
    doc.font('Helvetica').fontSize(10);
    doc.moveDown(0.2);
    
    const fields = [
        ['Institution', data.schoolName || data.collegeName],
        ['Degree/Board', data.degreeName],
        ['Passing Year', data.passingYear],
        ['Grade/Percentage', data.grade],
        ['Location', `${data.city || ''} ${data.country || ''}`.trim()],
    ];

    fields.forEach(([label, value]) => {
        if (value) {
            doc.fillColor('#666').text(`   ${label}: `, { continued: true })
               .fillColor('#000').text(value);
        }
    });
    doc.moveDown(0.8);
};

module.exports = { generateApplicationSummaryPdf };
