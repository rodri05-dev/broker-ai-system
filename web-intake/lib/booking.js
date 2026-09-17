const CAL_BASE = 'https://api.cal.com/v2';
const EVENT_SLUG = process.env.CAL_EVENT_SLUG || 'commercial-insurance-consultation';

const calEnabled = () => Boolean(process.env.CAL_API_KEY && process.env.CAL_USERNAME);

const calHeaders = () => ({
  Authorization: `Bearer ${process.env.CAL_API_KEY}`,
  'cal-api-version': '2024-08-13',
  'Content-Type': 'application/json'
});

// Returns an array of ISO start times, or null if Cal.com isn't usable right now.
async function getAvailableSlots({ days = 5 } = {}) {
  if (!calEnabled()) return null;
  try {
    const params = new URLSearchParams({
      eventTypeSlug: EVENT_SLUG,
      username: process.env.CAL_USERNAME,
      start: new Date().toISOString(),
      end: new Date(Date.now() + days * 86400000).toISOString()
    });
    const res = await fetch(`${CAL_BASE}/slots?${params}`, { headers: calHeaders() });
    if (!res.ok) { console.warn('Cal.com slots', res.status, await res.text()); return null; }
    const json = await res.json();

    // Cal.com has shipped a couple of response shapes. Handle both.
    const payload = json.data ?? json;
    const out = [];
    if (Array.isArray(payload)) {
      payload.forEach(s => out.push(s.start || s.time || s));
    } else if (payload && typeof payload === 'object') {
      Object.values(payload).forEach(day => {
        (Array.isArray(day) ? day : []).forEach(s => out.push(s.start || s.time || s));
      });
    }
    return out.filter(Boolean).slice(0, 12);
  } catch (e) {
    console.warn('Cal.com slots failed:', e.message);
    return null;
  }
}

// Returns { mode: 'booked', booking } or { mode: 'manual', reason }.
// 'manual' means the producer has to confirm it by hand — lib/actions.js emails them.
async function bookMeeting({ attendeeName, attendeeEmail, startTimeIso, notes }) {
  if (!calEnabled()) return { mode: 'manual', reason: 'cal_not_configured' };
  if (!startTimeIso) return { mode: 'manual', reason: 'no_time_chosen' };
  try {
    const res = await fetch(`${CAL_BASE}/bookings`, {
      method: 'POST',
      headers: calHeaders(),
      body: JSON.stringify({
        eventTypeSlug: EVENT_SLUG,
        username: process.env.CAL_USERNAME,
        start: startTimeIso,
        attendee: {
          name: attendeeName,
          email: attendeeEmail,
          timeZone: process.env.BROKER_TIMEZONE || 'America/New_York'
        },
        metadata: { source: 'ai_agent' },
        bookingFieldsResponses: { notes: notes || '' }
      })
    });
    if (!res.ok) {
      console.warn('Cal.com booking', res.status, await res.text());
      return { mode: 'manual', reason: `cal_error_${res.status}` };
    }
    return { mode: 'booked', booking: await res.json() };
  } catch (e) {
    return { mode: 'manual', reason: e.message };
  }
}

module.exports = { getAvailableSlots, bookMeeting, calEnabled };