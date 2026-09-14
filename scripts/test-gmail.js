require('dotenv').config();
const { sendEmail } = require('../lib/gmail');
sendEmail({ to: process.env.GMAIL_ADDRESS, subject: 'Test', body: 'It works.' })
  .then(() => console.log('Sent!'))
  .catch(e => console.error('Failed:', e));