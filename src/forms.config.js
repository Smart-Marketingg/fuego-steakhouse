// Per-site form and pipeline definitions. This is the ONE file that describes
// the website's forms; everything else (API, portal, emails, CSV) reads it.
// Override at deploy time without code changes by setting the FORMS_JSON var
// to a JSON object of the same shape.
//
// Stages are stored internally as new / contacted / scheduled / won / closed;
// only the labels differ per pipeline.

export const STAGES = ['new', 'contacted', 'scheduled', 'won', 'closed'];

export const DEFAULT_FORMS = {
  reservation: {
    label: 'Reservation',
    eyebrow: 'Reservation request',
    pipeline: 'reservations',
    // name/email/phone/message are first-class columns; everything else lands in `fields`.
    fields: [
      { key: 'name',  label: 'Name',       required: true,  max: 120 },
      { key: 'email', label: 'Email',      required: true,  type: 'email' },
      { key: 'phone', label: 'Phone',      required: true,  type: 'phone' },
      { key: 'date',  label: 'Date',       required: true,  max: 40 },
      { key: 'time',  label: 'Time',       required: true,  max: 20 },
      { key: 'party', label: 'Party size', required: false, max: 10 },
      { key: 'message', label: 'Notes',    required: false, max: 2000 }
    ],
    topicFrom: 'party', // short descriptor shown in list view ("Party of 4")
    topicFormat: (v) => (v ? `Party of ${v}` : ''),
    autoReply: {
      enabled: true,
      subject: 'We received your reservation request',
      body: "Thank you, {first_name}. We've received your request for {date} at {time} for {party}. Our team will confirm by phone or email shortly. For same-day tables call {phone_number}."
    },
    thanks: 'reservation'
  },
  event: {
    label: 'Private event',
    eyebrow: 'Private event inquiry',
    pipeline: 'events',
    fields: [
      { key: 'name',   label: 'Name',        required: true,  max: 120 },
      { key: 'email',  label: 'Email',       required: true,  type: 'email' },
      { key: 'phone',  label: 'Phone',       required: true,  type: 'phone' },
      { key: 'date',   label: 'Event date',  required: false, max: 40 },
      { key: 'time',   label: 'Time',        required: false, max: 20 },
      { key: 'guests', label: 'Guests',      required: false, max: 10 },
      { key: 'message', label: 'Details',    required: false, max: 4000 }
    ],
    topicFrom: 'guests',
    topicFormat: (v) => (v ? `${v} guests` : ''),
    autoReply: {
      enabled: true,
      subject: 'Your private event inquiry',
      body: "Thank you, {first_name}. Our events team has your inquiry{for_date} and will reach out within one business day to start planning with you."
    },
    thanks: 'event'
  },
  contact: {
    label: 'Contact',
    eyebrow: 'Website message',
    pipeline: 'contact',
    fields: [
      { key: 'name',    label: 'Name',    required: true,  max: 120 },
      { key: 'email',   label: 'Email',   required: true,  type: 'email' },
      { key: 'phone',   label: 'Phone',   required: false, type: 'phone' },
      { key: 'subject', label: 'Subject', required: false, max: 200 },
      { key: 'message', label: 'Message', required: true,  max: 4000 }
    ],
    topicFrom: 'subject',
    topicFormat: (v) => v || '',
    autoReply: {
      enabled: true,
      subject: 'We got your message',
      body: "Thank you, {first_name}. We've received your message and will get back to you shortly."
    },
    thanks: 'contact'
  },
  newsletter: {
    label: 'Newsletter',
    eyebrow: 'Newsletter signup',
    pipeline: 'newsletter',
    fields: [
      { key: 'email', label: 'Email', required: true, type: 'email' },
      { key: 'name',  label: 'Name',  required: false, max: 120 }
    ],
    topicFrom: null,
    topicFormat: () => '',
    autoReply: {
      enabled: false,
      subject: "You're on the list",
      body: 'Thanks for subscribing. Look out for updates on events, specials and more.'
    },
    thanks: 'newsletter'
  }
};

export const DEFAULT_PIPELINES = {
  reservations: { label: 'Reservations', form: 'reservation',
    stages: { new: 'New request', contacted: 'Contacted', scheduled: 'Confirmed', won: 'Seated', closed: 'Closed' },
    wonLabel: 'seated' },
  events: { label: 'Private events', form: 'event',
    stages: { new: 'New inquiry', contacted: 'Contacted', scheduled: 'Tour / proposal', won: 'Booked', closed: 'Closed' },
    wonLabel: 'booked' },
  contact: { label: 'Contact', form: 'contact',
    stages: { new: 'New', contacted: 'Replied', scheduled: 'Follow-up', won: 'Resolved', closed: 'Closed' },
    wonLabel: 'resolved' },
  newsletter: { label: 'Newsletter', form: 'newsletter',
    stages: { new: 'New', contacted: 'Welcomed', scheduled: 'Engaged', won: 'Subscriber', closed: 'Unsubscribed' },
    wonLabel: 'subscribed' }
};

/** Resolve the active form/pipeline config, honoring the FORMS_JSON var override. */
export function getConfig(env) {
  let forms = DEFAULT_FORMS, pipelines = DEFAULT_PIPELINES;
  if (env && env.FORMS_JSON) {
    try {
      const o = JSON.parse(env.FORMS_JSON);
      if (o.forms) forms = o.forms;
      if (o.pipelines) pipelines = o.pipelines;
    } catch (e) { /* fall back to defaults; surfaced on the dashboard as a config warning */ }
  }
  return { forms, pipelines, stages: STAGES };
}

/** JSON-safe copy for the portal (functions stripped). */
export function publicConfig(env) {
  const { forms, pipelines, stages } = getConfig(env);
  const f = {};
  for (const [id, def] of Object.entries(forms)) {
    f[id] = { label: def.label, eyebrow: def.eyebrow, pipeline: def.pipeline, fields: def.fields, thanks: def.thanks };
  }
  return { forms: f, pipelines, stages };
}
