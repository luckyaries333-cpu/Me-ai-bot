// ════════════════════════════════════════════════════════════
// Mahendra Estates — AI Calling Bot
// Calls leads, has a live AI conversation, qualifies them,
// and saves results back to the same Firebase used by your CRM.
// ════════════════════════════════════════════════════════════

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const OpenAI = require('openai');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, updateDoc, collection, addDoc, serverTimestamp } = require('firebase/firestore');

require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── CONFIG ──
const PORT = process.env.PORT || 3000;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SERVER_BASE_URL = process.env.SERVER_BASE_URL; // e.g. https://your-app.onrender.com
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'change-me'; // protects /api/call/start

const twilioClient = twilio(TWILIO_SID, TWILIO_AUTH);
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ── FIREBASE (same project as your CRM) ──
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};
const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

// ── IN-MEMORY CALL STATE ──
// Keyed by Twilio CallSid. Holds conversation history + leadId for the duration of the call.
const callSessions = {};

// ════════════════════════════════════════════════════════════
// AI PERSONA / SYSTEM PROMPT
// ════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `You are Riya, a friendly and professional voice assistant calling on behalf of Mahendra Estates, a real estate consultancy in NCR, India (Noida, Greater Noida, Yamuna Expressway, Gurugram).

GOAL: Have a short, natural, warm phone conversation to qualify this real estate lead. You need to find out:
1. Their budget range
2. What type of property they want (2BHK/3BHK/4BHK, villa, commercial, etc.)
3. Their timeline (urgent / 3 months / just exploring)
4. Preferred location/area in NCR

RULES:
- Speak in a natural, warm, conversational tone — like a helpful human, not a script-reader.
- Keep every response SHORT (1-2 sentences max) since this is a live voice call, not text.
- Ask ONE question at a time. Never ask multiple questions in one turn.
- If they speak Hindi or Hinglish, respond naturally in Hinglish too.
- If they say they're not interested, politely thank them and end the call gracefully.
- If they ask about a specific property (e.g. Eldeco Eden of Echoes, Sobha Rivana), give a brief, enthusiastic answer using these details if mentioned: Eldeco Eden of Echoes (Sector 22D, Yamuna Expressway, 3-4 BHK, starts 1.2 Cr); Sobha Rivana (Sector 1, Greater Noida West, 2-4 BHK, starts 2.25 Cr).
- Never make up RERA numbers, exact possession dates, or legal claims you're not sure of — say "our team will share exact details" instead.
- Once you have budget + property type + timeline, thank them warmly and say a Mahendra Estates agent will call back with matching options. Then say goodbye.
- If the call should end (they're done talking, not interested, or you've got what you need), include the exact tag [END_CALL] at the very end of your response.

Keep responses natural and brief — this is a phone call, not a chat.`;

// ════════════════════════════════════════════════════════════
// 1. START AN OUTBOUND AI CALL  (triggered from the CRM)
// ════════════════════════════════════════════════════════════
app.post('/api/call/start', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { leadId, phone, name } = req.body;
    if (!leadId || !phone) {
      return res.status(400).json({ error: 'leadId and phone are required' });
    }

    // Normalize phone number to E.164 (assume India +91 if no country code)
    let toNumber = phone.replace(/[\s\-()]/g, '');
    if (!toNumber.startsWith('+')) {
      toNumber = toNumber.startsWith('91') ? '+' + toNumber : '+91' + toNumber;
    }

    const call = await twilioClient.calls.create({
      to: toNumber,
      from: TWILIO_NUMBER,
      url: `${SERVER_BASE_URL}/voice/answer?leadId=${encodeURIComponent(leadId)}&name=${encodeURIComponent(name || '')}`,
      statusCallback: `${SERVER_BASE_URL}/voice/status?leadId=${encodeURIComponent(leadId)}`,
      statusCallbackEvent: ['completed'],
      machineDetection: 'DetectMessageEnd' // hang up gracefully on voicemail
    });

    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error('Error starting call:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// 2. CALL ANSWERED — GREET THE LEAD
// ════════════════════════════════════════════════════════════
app.post('/voice/answer', (req, res) => {
  const { leadId, name } = req.query;
  const callSid = req.body.CallSid;

  callSessions[callSid] = {
    leadId,
    name: name || '',
    history: [{ role: 'system', content: SYSTEM_PROMPT }],
    qualification: {}
  };

  const twiml = new twilio.twiml.VoiceResponse();
  const greeting = name
    ? `Hi ${name}, this is Riya calling from Mahendra Estates regarding your property enquiry. Do you have a quick minute to talk?`
    : `Hi, this is Riya calling from Mahendra Estates regarding your property enquiry. Do you have a quick minute to talk?`;

  callSessions[callSid].history.push({ role: 'assistant', content: greeting });

  const gather = twiml.gather({
    input: 'speech',
    action: `/voice/gather?leadId=${encodeURIComponent(leadId)}`,
    speechTimeout: 'auto',
    language: 'en-IN'
  });
  gather.say({ voice: 'Polly.Aditi' }, greeting);

  // If no speech detected, retry once
  twiml.redirect(`/voice/no-input?leadId=${encodeURIComponent(leadId)}`);

  res.type('text/xml').send(twiml.toString());
});

// ════════════════════════════════════════════════════════════
// 3. HANDLE WHAT THE LEAD SAYS — AI RESPONDS
// ════════════════════════════════════════════════════════════
app.post('/voice/gather', async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  const session = callSessions[callSid];
  const twiml = new twilio.twiml.VoiceResponse();

  if (!session) {
    twiml.say('Sorry, something went wrong. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  session.history.push({ role: 'user', content: speechResult });

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: session.history,
      temperature: 0.7,
      max_tokens: 120
    });

    let aiText = completion.choices[0].message.content.trim();
    const shouldEnd = aiText.includes('[END_CALL]');
    aiText = aiText.replace('[END_CALL]', '').trim();

    session.history.push({ role: 'assistant', content: aiText });

    twiml.say({ voice: 'Polly.Aditi' }, aiText);

    if (shouldEnd) {
      twiml.hangup();
      await finalizeCall(callSid, session);
    } else {
      const gather = twiml.gather({
        input: 'speech',
        action: `/voice/gather?leadId=${encodeURIComponent(session.leadId)}`,
        speechTimeout: 'auto',
        language: 'en-IN'
      });
      twiml.redirect(`/voice/no-input?leadId=${encodeURIComponent(session.leadId)}`);
    }
  } catch (err) {
    console.error('OpenAI error:', err);
    twiml.say('Sorry, I am having trouble right now. Our team will call you back shortly. Goodbye.');
    twiml.hangup();
  }

  res.type('text/xml').send(twiml.toString());
});

// ════════════════════════════════════════════════════════════
// 4. NO SPEECH DETECTED — give one more chance, then end
// ════════════════════════════════════════════════════════════
app.post('/voice/no-input', (req, res) => {
  const { leadId } = req.query;
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: `/voice/gather?leadId=${encodeURIComponent(leadId)}`,
    speechTimeout: 'auto',
    language: 'en-IN'
  });
  gather.say({ voice: 'Polly.Aditi' }, "Sorry, I couldn't hear you. Are you still there?");
  twiml.say('It seems we got disconnected. Our team will follow up by message. Goodbye.');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ════════════════════════════════════════════════════════════
// 5. CALL STATUS WEBHOOK — fires when call completes/fails
// ════════════════════════════════════════════════════════════
app.post('/voice/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus; // completed, busy, no-answer, failed
  const { leadId } = req.query;
  const session = callSessions[callSid];

  // If call ended without going through finalizeCall (e.g. no-answer, busy, failed)
  if (session && !session._finalized) {
    await finalizeCall(callSid, session, callStatus);
  } else if (!session) {
    // Call never connected to AI logic — log the raw status
    try {
      await addDoc(collection(db, 'aiCallLogs'), {
        leadId,
        callSid,
        status: callStatus,
        connected: false,
        ts: serverTimestamp()
      });
    } catch (e) { console.error(e); }
  }

  res.sendStatus(200);
});

// ════════════════════════════════════════════════════════════
// FINALIZE: extract structured qualification data via GPT,
// save transcript + result to Firestore, update lead status
// ════════════════════════════════════════════════════════════
async function finalizeCall(callSid, session, callStatus = 'completed') {
  if (session._finalized) return;
  session._finalized = true;

  const transcript = session.history.filter(m => m.role !== 'system');

  let qualification = { budget: '', propertyType: '', timeline: '', interestLevel: 'Cold', summary: '' };

  try {
    const extraction = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Extract structured data from this real estate qualifying call transcript. Respond ONLY with valid JSON, no markdown, in this exact shape:
{"budget":"string or empty","propertyType":"string or empty","timeline":"string or empty","interestLevel":"Hot or Warm or Cold","summary":"one sentence summary of the call"}
interestLevel should be "Hot" if they seem ready to buy soon and engaged, "Warm" if interested but not urgent, "Cold" if not interested or vague/unresponsive.`
        },
        { role: 'user', content: JSON.stringify(transcript) }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });
    qualification = JSON.parse(extraction.choices[0].message.content);
  } catch (e) {
    console.error('Extraction error:', e);
  }

  // Save full call log
  try {
    await addDoc(collection(db, 'aiCallLogs'), {
      leadId: session.leadId,
      callSid,
      status: callStatus,
      connected: true,
      transcript,
      qualification,
      ts: serverTimestamp()
    });

    // Update the lead itself: status + a history note + qualification fields
    if (session.leadId) {
      const leadRef = doc(db, 'leads', session.leadId);
      const leadSnap = await getDoc(leadRef);
      if (leadSnap.exists()) {
        const lead = leadSnap.data();
        const newHistory = lead.history || [];
        newHistory.push({
          id: Date.now().toString(),
          type: 'call',
          text: `🤖 AI Call: ${qualification.summary || 'Call completed'} | Budget: ${qualification.budget || 'N/A'} | Type: ${qualification.propertyType || 'N/A'} | Timeline: ${qualification.timeline || 'N/A'}`,
          ts: new Date().toISOString()
        });
        await updateDoc(leadRef, {
          history: newHistory,
          status: qualification.interestLevel || lead.status,
          budget: qualification.budget || lead.budget,
          aiQualified: true
        });
      }
    }
  } catch (e) {
    console.error('Error saving call result:', e);
  }

  delete callSessions[callSid];
}

// ════════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.send('Mahendra Estates AI Calling Bot — running ✓');
});

app.listen(PORT, () => {
  console.log(`AI Calling Bot server running on port ${PORT}`);
});
