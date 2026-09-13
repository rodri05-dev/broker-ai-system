require('dotenv').config({ path: '../.env' });
const axios = require('axios');

async function testHubSpot() {
  const res = await axios.post(
    'https://api.hubapi.com/crm/v3/objects/contacts',
    {
      properties: {
        firstname: 'Test',
        lastname: 'Broker Lead',
        email: 'test-lead@example.com',
        business_type: 'General Contractor'
      }
    },
    { headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}` } }
  );
  console.log('Created contact:', res.data.id);
}

testHubSpot().catch(e => console.error(e.response?.data || e.message));