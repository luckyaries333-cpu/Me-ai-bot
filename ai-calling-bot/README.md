# Mahendra Estates — AI Calling Bot

Calls a lead's real phone number, has a live spoken conversation (in English/Hinglish),
asks about budget / property type / timeline, then automatically:
- Saves the full transcript to Firebase
- Updates the lead's status (Hot/Warm/Cold) in your CRM
- Adds a note to the lead's history — visible instantly in Field CRM & Head CRM

---

## What you need (all free to create, pay-per-use after)

| Service | Why | Free tier |
|---|---|---|
| **Twilio** | Makes the actual phone call | $15 trial credit |
| **OpenAI** | The AI brain that talks | Pay-as-you-go, ~$0.50 per 100 calls |
| **Render.com** | Hosts this server 24/7 | Free tier (server sleeps after 15 min idle — fine for this use case) |

---

## STEP 1 — Create Twilio Account

1. Go to **twilio.com/try-twilio** → sign up (free, no card needed for trial)
2. Verify your own phone number (they'll call/text you a code)
3. On the Twilio Console dashboard, copy:
   - **Account SID**
   - **Auth Token** (click "show")
4. Buy a phone number: **Phone Numbers → Buy a Number** → choose any number with **Voice** capability (trial credit covers this)
   - For calling India numbers, you may need to request access: **Twilio Console → Messaging/Voice → Geo Permissions** → enable **India**

> ⚠️ On a **trial account**, Twilio can only call phone numbers you've manually verified in the console (Console → Phone Numbers → Verified Caller IDs). To call ANY number freely, you'll need to upgrade by adding a payment method (still pay-per-use, no subscription).

---

## STEP 2 — Create OpenAI Account

1. Go to **platform.openai.com** → sign up
2. Go to **Billing** → add a payment method and add a small amount ($5 is plenty to start)
3. Go to **API Keys** → **Create new secret key** → copy it (starts with `sk-...`)

---

## STEP 3 — Fill in Your `.env` File

1. Copy `.env.example` → rename to `.env`
2. Paste in:
   - Twilio Account SID, Auth Token, Phone Number
   - OpenAI API Key
   - Your Firebase config (same as your CRM — already filled in for you below)
   - Make up a long random string for `ADMIN_API_KEY` (this protects your call-trigger endpoint from strangers)

---

## STEP 4 — Deploy to Render.com (Free)

1. Go to **render.com** → sign up free (use GitHub login, easiest)
2. Push this `ai-calling-bot` folder to a **new GitHub repository** (e.g. `me-ai-bot`)
   - Easiest: create repo on GitHub → "uploading an existing file" → drag in all files from this folder
3. In Render: **New +** → **Web Service** → connect your `me-ai-bot` repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Under **Environment Variables**, add every key from your `.env` file (Render won't read the .env file directly — you paste each variable in their dashboard)
6. Click **Create Web Service** — wait ~2 minutes for it to deploy
7. Copy your live URL, e.g. `https://me-ai-bot.onrender.com`
8. Go back into Render's Environment Variables → update `SERVER_BASE_URL` to that exact URL → save (it will redeploy)

> Free Render services "sleep" after 15 minutes of no traffic and take ~30 seconds to wake up on the next request. For a calling bot triggered occasionally from your CRM, this is usually fine. If you need instant response always, upgrade to Render's $7/month tier later.

---

## STEP 5 — Test It

Send a test request (use a tool like Postman, or curl from terminal):

```bash
curl -X POST https://your-app-name.onrender.com/api/call/start \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_ADMIN_API_KEY" \
  -d '{"leadId":"test123","phone":"+919876543210","name":"Rajesh"}'
```

Your phone should ring within a few seconds with the AI on the line.

---

## STEP 6 — Connect to Your CRM

Open `crm-integration-snippet.html` in this folder — it has the exact code to paste into your Field CRM or Head CRM lead detail drawer to add a **"📞 Call with AI"** button.

You'll need to set two values at the top of that snippet:
```js
const AI_BOT_URL = 'https://your-app-name.onrender.com';
const AI_BOT_API_KEY = 'the same ADMIN_API_KEY you set in .env';
```

---

## Where Results Show Up

After every AI call:
- A new entry appears in Firestore collection **`aiCallLogs`** (full transcript + extracted qualification)
- The lead's **`history`** array gets a new note: `🤖 AI Call: <summary> | Budget: ... | Type: ... | Timeline: ...`
- The lead's **`status`** auto-updates to Hot / Warm / Cold based on the AI's read of the conversation
- All of this appears **instantly** in both your Field CRM and Head CRM (same Firebase, real-time sync)

---

## Customizing the AI's Personality / Script

Open `server.js` → find the `SYSTEM_PROMPT` constant near the top. Edit that text to:
- Change the AI's name/persona
- Add more properties it should know about
- Change what questions it asks
- Adjust tone (more formal, more casual, etc.)

No need to touch any other code — just edit that one block of text and redeploy (push to GitHub, Render auto-redeploys).

---

## Estimated Cost Per Call

- Twilio voice (India): ~₹3-6/min
- OpenAI GPT-4o-mini: ~₹0.50 per call (very cheap, used only for text generation)
- Average qualifying call: 2-3 minutes → **₹6-18 per call total**

100 calls/month ≈ ₹600-1800/month. There is no way to make live AI phone calls cheaper than this — the cost is almost entirely the Twilio voice-minute charge, which is a real telecom cost.
