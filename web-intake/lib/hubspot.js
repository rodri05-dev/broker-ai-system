const HUBSPOT_BASE = 'https://api.hubapi.com';
const authHeaders = () => ({
  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
});

async function findContactByEmail(email) {
  if (!email) return null;
  const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      limit: 1
    })
  });
  const data = await res.json();
  return data.results?.[0] || null;
}

// Creates a new HubSpot contact, or updates the existing one if the email already exists —
// so re-submitting a form or calling back doesn't create duplicate records.
async function createOrUpdateContact({ email, fullName, companyName, phone, businessType, linesOfBusiness, qualificationScore }) {
  const [firstname, ...rest] = (fullName || '').split(' ');
  const properties = {
    email, firstname, lastname: rest.join(' '), company: companyName, phone,
    business_type: businessType,
    lines_of_business: Array.isArray(linesOfBusiness) ? linesOfBusiness.join(';') : linesOfBusiness,
    ...(qualificationScore !== undefined ? { qualification_score: String(qualificationScore) } : {})
  };
  Object.keys(properties).forEach(k => (properties[k] === undefined || properties[k] === '') && delete properties[k]);

  const existing = await findContactByEmail(email);
  if (existing) {
    await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/${existing.id}`, {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ properties })
    });
    return existing.id;
  }
  const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ properties })
  });
  const data = await res.json();
  return data.id;
}

// Logs a call as a HubSpot activity. Note: associationTypeId 194 is HubSpot's default
// "call to contact" association as of this writing — if the call doesn't show up linked
// to the contact's timeline, check HubSpot's current association type reference and adjust
// this number; the call still gets created either way, just possibly unlinked.
async function logCallActivity(contactId, summary) {
  await fetch(`${HUBSPOT_BASE}/crm/v3/objects/calls`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({
      properties: { hs_call_body: summary, hs_timestamp: Date.now() },
      associations: contactId
        ? [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }] }]
        : []
    })
  });
}

module.exports = { findContactByEmail, createOrUpdateContact, logCallActivity };