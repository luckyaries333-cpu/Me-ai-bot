// ════════════════════════════════════════════════════════════
// Mahendra Estates — WhatsApp AI Qualifying Bot v2
// Fixed: uses Firebase Admin SDK (correct for Node.js servers)
// ════════════════════════════════════════════════════════════

const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const OpenAI = require('openai');
const admin = require('firebase-admin');

require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// ── CONFIG ──
const PORT = process.env.PORT || 3000;
const WA_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'me-verify-token';
const WA_TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'lead_welcome';
const WA_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'en';
const WA_API = 'v19.0';
const ADMIN_KEY = process.env.ADMIN_API_KEY || 'change-me';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── FIREBASE ADMIN SDK ──
// Uses FIREBASE_SERVICE_ACCOUNT env var (JSON string of your service account key)
// OR falls back to individual env vars for the project config
let db;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : {
        type: 'service_account',
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
      };

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  db = admin.firestore();
  console.log('Firebase Admin SDK initialized ✓');
} catch (e) {
  console.error('Firebase Admin init error:', e.message);
  process.exit(1);
}

// ════════════════════════════════════════════════════════════
// AI SYSTEM PROMPT — pulls live properties from Firestore
// ════════════════════════════════════════════════════════════
const BASE_PROMPT = `You are Riya, a friendly assistant texting on behalf of Mahendra Estates, a real estate consultancy in NCR India (Noida, Greater Noida, Yamuna Expressway, Gurugram).

GOAL: Through a short WhatsApp chat, find out:
1. Budget range
2. Property type (2BHK/3BHK/4BHK, villa, commercial, etc.)
3. Timeline (urgent / 3 months / just exploring)
4. Preferred location in NCR

RULES:
- Keep messages SHORT (1-3 lines). This is WhatsApp, not email.
- Ask ONE question per message.
- If they reply in Hindi/Hinglish, reply in Hinglish too.
- If not interested, thank them and stop — never push.
- Only talk about properties listed under OUR LISTINGS below. Never invent details.
- If asked about something not in the list, say our team will share details shortly.
- Never invent RERA numbers, possession dates, or legal claims.
- Once you have budget + type + timeline (or clearly not interested), send a warm closing message saying an agent will follow up, and include [END_CHAT] at the very end.

OUR CURRENT LISTINGS:
{{PROPERTIES}}`;

async function buildPrompt() {
  let propText = 'No active listings on file — tell them our team will share options.';
  try {
    const snap = await db.collection('properties').get();
    const active = snap.docs
      .map(d => d.data())
      .filter(p => (p.status || 'Active') !== 'Sold Out');
    if (active.length > 0) {
      propText = active.map(p => {
        return '- ' + [
          p.name,
          p.location && `Location: ${p.location}`,
          p.developer && `Developer: ${p.developer}`,
          p.bhk && `Config: ${p.bhk}`,
          p.type && `Type: ${p.type}`,
          p.price && `Price: ${p.price}`,
          p.status === 'Coming Soon' && '(Coming Soon)'
        ].filter(Boolean).join(' | ');
      }).join('\n');
    }
  } catch (e) { console.error('Properties fetch error:', e.message); }
  return BASE_PROMPT.replace('{{PROPERTIES}}', propText);
}

// ════════════════════════════════════════════════════════════
// PHONE HELPERS
// ════════════════════════════════════════════════════════════
function normalizePhone(phone) {
  let digits = (phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  return digits;
}

// ════════════════════════════════════════════════════════════
// WHATSAPP API HELPERS
// ════════════════════════════════════════════════════════════
async function sendTemplate(to, name) {
  const res = await fetch(`https://graph.facebook.com/${WA_API}/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: WA_TEMPLATE_NAME,
        language: { code: WA_TEMPLATE_LANG },
        components: [{ type: 'body', parameters: [{ type: 'text', text: name || 'there' }] }]
      }
    })
  });
  const data = await res.json();
  if (!res.ok) console.error('Template error:', JSON.stringify(data));
  return data;
}

async function sendText(to, text) {
  const res = await fetch(`https://graph.facebook.com/${WA_API}/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    })
  });
  const data = await res.json();
  if (!res.ok) console.error('Text send error:', JSON.stringify(data));
  return data;
}

// ════════════════════════════════════════════════════════════
// AUTO-TEXT NEW LEADS — Firestore real-time listener
// ════════════════════════════════════════════════════════════
let isFirstSnapshot = true;

function watchNewLeads() {
  db.collection('leads').onSnapshot(async (snapshot) => {
    if (isFirstSnapshot) { isFirstSnapshot = false; return; }
    for (const change of snapshot.docChanges()) {
      if (change.type !== 'added') continue;
      const lead = change.doc.data();
      const leadId = change.doc.id;
      if (!lead.phone || lead.waInitiated) continue;
      const phone = normalizePhone(lead.phone);
      if (phone.length < 11) continue;
      try {
        await db.collection('leads').doc(leadId).update({ waInitiated: true });
        await sendTemplate(phone, lead.name);
        await db.collection('waSessions').doc(phone).set({
          leadId,
          leadName: lead.name || '',
          history: [],
          active: true,
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastInboundAt: null
        });
        console.log(`WhatsApp intro sent → ${lead.name} (${phone})`);
      } catch (e) { console.error('Auto-text error:', e.message); }
    }
  }, err => console.error('Firestore listener error:', err.message));
}

// ════════════════════════════════════════════════════════════
// WEBHOOK VERIFICATION
// ════════════════════════════════════════════════════════════
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WA_VERIFY_TOKEN) {
    console.log('Webhook verified ✓');
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ════════════════════════════════════════════════════════════
// INCOMING MESSAGES — AI replies
// ════════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // always ack Meta immediately

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const fromPhone = message.from;
    const userText = message.text.body;

    const sessionRef = db.collection('waSessions').doc(fromPhone);
    const sessionSnap = await sessionRef.get();

    let session = sessionSnap.exists
      ? sessionSnap.data()
      : { leadId: null, leadName: '', history: [], active: true };

    if (!session.active) return;

    const history = session.history || [];
    history.push({ role: 'user', content: userText });

    const systemPrompt = await buildPrompt();
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, ...history],
      temperature: 0.7,
      max_tokens: 200
    });

    let aiText = completion.choices[0].message.content.trim();
    const shouldEnd = aiText.includes('[END_CHAT]');
    aiText = aiText.replace('[END_CHAT]', '').trim();
    history.push({ role: 'assistant', content: aiText });

    await sendText(fromPhone, aiText);

    await sessionRef.set({
      ...session,
      history,
      active: !shouldEnd,
      lastInboundAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (shouldEnd) await finalizeChat(fromPhone, session.leadId, history);

  } catch (err) { console.error('Webhook error:', err.message); }
});

// ════════════════════════════════════════════════════════════
// FINALIZE — extract qualification, update lead in CRM
// ════════════════════════════════════════════════════════════
async function finalizeChat(phone, leadId, history) {
  let q = { budget: '', propertyType: '', timeline: '', interestLevel: 'Cold', summary: '' };
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Extract from this WhatsApp real estate chat. Reply ONLY valid JSON (no markdown): {"budget":"","propertyType":"","timeline":"","interestLevel":"Hot or Warm or Cold","summary":"one sentence"}' },
        { role: 'user', content: JSON.stringify(history) }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });
    q = JSON.parse(res.choices[0].message.content);
  } catch (e) { console.error('Extraction error:', e.message); }

  try {
    await db.collection('waCallLogs').add({ leadId, phone, transcript: history, qualification: q, ts: admin.firestore.FieldValue.serverTimestamp() });

    if (leadId) {
      const leadRef = db.collection('leads').doc(leadId);
      const leadSnap = await leadRef.get();
      if (leadSnap.exists) {
        const lead = leadSnap.data();
        const newHistory = lead.history || [];
        newHistory.push({
          id: Date.now().toString(),
          type: 'wa',
          text: `🤖 AI WhatsApp: ${q.summary || 'Chat completed'} | Budget: ${q.budget || 'N/A'} | Type: ${q.propertyType || 'N/A'} | Timeline: ${q.timeline || 'N/A'}`,
          ts: new Date().toISOString()
        });
        await leadRef.update({
          history: newHistory,
          status: q.interestLevel || lead.status,
          budget: q.budget || lead.budget,
          aiQualified: true
        });
        console.log(`Lead ${leadId} updated → ${q.interestLevel}`);
      }
    }
  } catch (e) { console.error('Finalize error:', e.message); }
}

// ════════════════════════════════════════════════════════════
// MANUAL TRIGGER — for existing leads
// ════════════════════════════════════════════════════════════
app.post('/api/qualify/start', async (req, res) => {
  if (req.headers['x-api-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { leadId, phone, name } = req.body;
  if (!leadId || !phone) return res.status(400).json({ error: 'leadId and phone required' });
  try {
    const toPhone = normalizePhone(phone);
    await sendTemplate(toPhone, name);
    await db.collection('leads').doc(leadId).update({ waInitiated: true });
    await db.collection('waSessions').doc(toPhone).set({
      leadId, leadName: name || '', history: [], active: true,
      startedAt: admin.firestore.FieldValue.serverTimestamp(), lastInboundAt: null
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.send('Mahendra Estates WhatsApp AI Bot v2 — running ✓'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  watchNewLeads();
});
