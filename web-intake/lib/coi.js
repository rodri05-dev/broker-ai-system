const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TEMPLATE_PATH = path.join(process.cwd(), 'templates', 'coi-template.pdf');

async function fillCoiPdf(payload) {
  if (fs.existsSync(TEMPLATE_PATH)) {
    try { return await fillFromTemplate(payload); }
    catch (e) { console.warn('Template fill failed, using generated draft instead:', e.message); }
  }
  return buildDraftPdf(payload);
}

// --- Path A: the broker gave you a real fillable ACORD 25 export -------------
async function fillFromTemplate({ policy, contact, certHolderName, certHolderAddress, projectDescription }) {
  const pdfDoc = await PDFDocument.load(fs.readFileSync(TEMPLATE_PATH));
  const form = pdfDoc.getForm();
  const set = (field, value) => {
    try { form.getTextField(field).setText(String(value ?? '')); }
    catch { console.warn(`COI field not found: ${field}`); }
  };

  // EDIT these left-hand names to match your broker's template (see Step 8.2).
  set('InsuredName', contact.company_name);
  set('InsuredAddress', contact.address || '');
  set('CertificateHolderName', certHolderName);
  set('CertificateHolderAddress', certHolderAddress);
  set('DescriptionOfOperations', projectDescription || '');
  set('InsurerName', policy.carrier_name);
  set('PolicyNumber', policy.policy_number);
  set('PolicyEffectiveDate', policy.effective_date);
  set('PolicyExpirationDate', policy.expiration_date);
  set('EachOccurrenceLimit', policy.each_occurrence_limit);
  set('GeneralAggregateLimit', policy.general_aggregate_limit);
  set('CertificateDate', new Date().toLocaleDateString('en-US'));

  form.flatten();
  return Buffer.from(await pdfDoc.save());
}

// --- Path B: no template yet — generate a clearly-marked draft worksheet -----
async function buildDraftPdf({ policy, contact, certHolderName, certHolderAddress, projectDescription }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const body = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.08, 0.13, 0.22);
  const muted = rgb(0.42, 0.46, 0.53);

  let y = 740;
  const line = (label, value, gap = 26) => {
    page.drawText(label.toUpperCase(), { x: 56, y, size: 7.5, font: bold, color: muted });
    page.drawText(String(value ?? '—'), { x: 56, y: y - 13, size: 11, font: body, color: ink });
    y -= gap + 13;
  };

  page.drawText('CERTIFICATE OF INSURANCE — DRAFT', { x: 56, y, size: 17, font: bold, color: ink });
  y -= 22;
  page.drawText('Internal worksheet for producer review. Not a certificate. Not an ACORD form.',
    { x: 56, y, size: 9, font: body, color: muted });
  y -= 34;
  page.drawLine({ start: { x: 56, y }, end: { x: 556, y }, thickness: 1, color: rgb(0.85, 0.83, 0.77) });
  y -= 30;

  line('Named insured', contact.company_name || contact.full_name);
  line('Insured address', contact.address);
  line('Certificate holder', certHolderName);
  line('Holder address', certHolderAddress);
  line('Description of operations', projectDescription);
  line('Carrier', policy.carrier_name);
  line('Policy number', policy.policy_number);
  line('Line of business', policy.line_of_business);
  line('Effective / expiration', `${policy.effective_date} to ${policy.expiration_date}`);
  line('Each occurrence limit', policy.each_occurrence_limit);
  line('General aggregate limit', policy.general_aggregate_limit);
  line('Prepared', new Date().toLocaleString('en-US'));

  page.drawText('A licensed producer must verify every field against the policy before any certificate is issued.',
    { x: 56, y: 60, size: 8, font: body, color: muted });

  // Diagonal DRAFT stamp so this can never be mistaken for an issued certificate.
  page.drawText('DRAFT', {
    x: 150, y: 330, size: 110, font: bold,
    color: rgb(0.85, 0.3, 0.3), opacity: 0.14, rotate: { type: 'degrees', angle: 32 }
  });

  return Buffer.from(await pdfDoc.save());
}

async function storeDraftCoi(buffer, coiRequestId) {
  const filePath = `coi-drafts/${coiRequestId}.pdf`;
  const { error } = await supabase.storage.from('generated-files')
    .upload(filePath, buffer, { contentType: 'application/pdf', upsert: true });
  if (error) throw error;
  return supabase.storage.from('generated-files').getPublicUrl(filePath).data.publicUrl;
}

module.exports = { fillCoiPdf, storeDraftCoi };