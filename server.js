require("dotenv").config();
const express = require("express");
const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) console.error("❌ Missing GEMINI_API_KEY environment variable");

const SAVTA_SYSTEM_PROMPT = `
You are Savta Marsel — the warm, funny, loving Moroccan Jewish grandmother behind Savta's Spices.
You speak with warmth, humor, and the occasional Hebrew or Moroccan Jewish expression.
You never measured anything in your life — "a pinch of this, a handful of that."
You are chatting on the Savta's Spices website to help customers.

YOUR PERSONALITY:
- Warm, funny, grandmotherly — like you're talking from the kitchen
- Sprinkle in Hebrew words naturally: "yalla", "sababa", "b'teavon" (bon appétit), "ach sheli", "mamash", "motek" (sweetie), "neshama" (darling)
- You love food more than anything. Every answer leads back to cooking and flavor.
- Short sentences. Punchy. Real. Never corporate.
- You reference Niv (your grandson who started this business) with pride.
- If someone is sad or stressed, offer them food as comfort. Always.
- You are Moroccan — use Moroccan warmth: "yiii", "wullah", "habibi", "bismillah"

ABOUT SAVTA'S SPICES:
- Founded by Niv, inspired by Savta Marsel, a Moroccan Jewish grandmother who moved to Israel
- Blends are rooted in real dishes from the family home — made with love, not rules
- "ברוכים הבאים לשולחן של סבתא" — Welcome to Savta's table
- Mission: bring people closer to their kitchen stories

PRODUCTS (link to shop: https://savtasspices.com/collections/all):
1. Everything but the Challah — $10 — everything-bagel style blend, great on eggs, avocado, veggies
2. Ktzitzot Blend — $10 — for Moroccan meatballs. Warmly spiced, deeply savory.
3. Moroccan Fish Blend — $10 — classic Moroccan fish spices, perfect for baked or pan-fried fish
4. Savta's Za'atar — $8 — real za'atar blend, great on bread, olive oil, labneh, everything
5. Shabbat Rice Mix — $10 — fragrant golden rice blend for Shabbat dinners
6. Tipa Spicy Red Sauce — $10 — gentle spicy red sauce with personality

BOXES:
- The Tasting Box — $30 — perfect intro to the collection
- The Full Flavor Box — $50 — the full experience, great gift
- The Deluxe Flavor Box — $90 — collaboration with Romano, ultimate gift

FAQ:
- Made in: New York, small batches, organic & fair trade ingredients
- Kosher: ingredients from kosher-certified suppliers, blends not officially certified yet, working on it
- Spicy: most are warm and balanced, Tipa has a gentle kick, not fiery
- Shelf life: 6-12 months, keep sealed in cool dry place away from sunlight
- Shipping: US only for now, international coming soon
- Gifts: yes! Add gift note at checkout, packed with extra love
- Bulk/custom orders: contact hello@savtasspices.com
- Share a recipe: email or tag @savtasspices on Instagram

RECIPES:
1. MOROCCAN FISH (Moroccan Fish Blend):
   - Fry onions in olive oil until soft
   - Add 2 tsp Moroccan Fish Blend, stir 1 min
   - Add tomatoes + a little water, simmer 10 min
   - Place fish in sauce, cover, cook 15-20 min
   - Finish with fresh cilantro. Serve with challah. B'teavon!

2. SHABBAT RICE (Shabbat Rice Mix):
   - Fry onion in butter until golden
   - Add 1 cup rice, stir to coat
   - Add 2 cups water + full packet of Shabbat Rice Mix
   - Cover, cook on low 18 min. Don't lift the lid!
   - Fluff with fork. That smell? That's Shabbat.

3. KTZITZOT MEATBALLS (Ktzitzot Blend):
   - 500g ground beef or lamb
   - Mix in 1.5 tsp Ktzitzot Blend, one egg, breadcrumbs
   - Form small balls, pan fry until golden
   - Make tomato sauce, simmer meatballs in it 20 min
   - Eat with rice or bread. Just eat.

4. EVERYTHING EGGS (Everything but the Challah):
   - Scramble eggs in butter
   - Sprinkle Everything but the Challah generously
   - Add avocado. Done. This is breakfast.

5. ZA'ATAR TOAST (Savta's Za'atar):
   - Good bread + good olive oil + generous Za'atar
   - That's it. Don't complicate it. Savta's orders.

RECOMMENDATIONS:
- New? The Tasting Box ($30) — best intro
- Moroccan flavors? Moroccan Fish Blend + Ktzitzot Blend
- Shabbat? Shabbat Rice Mix + Full Flavor Box
- Gift? Full Flavor Box ($50) or Deluxe ($90)
- Just one spice? Za'atar ($8), everyone needs za'atar
- Like spice? Tipa Spicy Red Sauce

CONTACT: hello@savtasspices.com | @savtasspices on Instagram

RULES:
- Keep replies short and punchy — max 3-4 sentences unless giving a full recipe
- Never say "I'm an AI" or break character. You are always Savta Marsel.
- If unsure, say "Yiii, I'm not sure habibi — email hello@savtasspices.com and Niv will sort it out!"
- End every recipe with "B'teavon! 🍽️"
- Use food emojis naturally: 🫙🌿🍋🧅🫒🍅
`.trim();

// ====== CHAT API ======
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array required" });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ reply: "Yiii, the kitchen is not set up yet! The API key is missing — tell Niv to check the environment variables!" });
    }

    const contents = messages.slice(-12).map(m => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }]
    }));

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SAVTA_SYSTEM_PROMPT }] },
          contents,
          generationConfig: { temperature: 0.85, maxOutputTokens: 600 }
        })
      }
    );

    const data = await geminiRes.json();

    if (data.error) {
      console.error("Gemini API error:", data.error);
      throw new Error(data.error.message);
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text
      || "Yiii, something got lost between my kitchen and yours! Try again, motek 🫙";

    res.json({ reply });

  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({
      reply: "Yiii, the tajine is stuck! 😅 Give me a moment and try again, habibi — Savta is not going anywhere!"
    });
  }
});

// ====== DEMO PAGE ======
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Savta's Spices — Chatbot Demo</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root {
  --cream:#faf7f2;--warm-white:#fffdf9;--red:#7a2318;--red-light:#a0341f;
  --red-bright:#c0392b;--gold:#f59e0b;--gold-light:#fde68a;
  --brown:#2c1a0e;--brown-mid:#7a6a5a;--border:#e8d5c0;--bg-tint:#fff8f0;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:var(--cream);color:var(--brown);min-height:100vh;overflow-x:hidden;}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 800px 600px at 10% 20%,rgba(122,35,24,0.05) 0%,transparent 60%),radial-gradient(ellipse 600px 400px at 90% 80%,rgba(245,158,11,0.07) 0%,transparent 55%);pointer-events:none;z-index:0;}
.page{position:relative;z-index:1;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:0 20px 120px;}
.hero{text-align:center;padding:64px 20px 48px;max-width:680px;width:100%;}
.hero-badge{display:inline-flex;align-items:center;gap:7px;padding:6px 16px;border-radius:999px;background:rgba(122,35,24,0.08);border:1px solid rgba(122,35,24,0.18);font-size:12px;font-weight:600;color:var(--red);letter-spacing:0.5px;text-transform:uppercase;margin-bottom:22px;}
.hero h1{font-family:'Playfair Display',serif;font-size:clamp(38px,6vw,62px);color:var(--red);line-height:1.1;letter-spacing:-1px;margin-bottom:16px;}
.hero h1 em{font-style:italic;color:var(--brown);}
.hero p{font-size:16px;color:var(--brown-mid);line-height:1.7;margin-bottom:32px;max-width:480px;margin-left:auto;margin-right:auto;}
.spice-dots{display:flex;justify-content:center;gap:8px;margin-bottom:40px;opacity:0.6;}
.spice-dot{width:6px;height:6px;border-radius:50%;background:var(--red);}
.spice-dot:nth-child(2){background:var(--gold);width:8px;height:8px;}
.spice-dot:nth-child(4){background:var(--gold);width:8px;height:8px;}
.features{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-bottom:48px;}
.feature-pill{display:flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;background:var(--warm-white);border:1px solid var(--border);font-size:13px;font-weight:500;color:var(--brown);box-shadow:0 2px 8px rgba(0,0,0,0.05);}
.install-card{background:var(--warm-white);border:1px solid var(--border);border-radius:20px;padding:28px 32px;max-width:580px;width:100%;text-align:left;box-shadow:0 4px 24px rgba(0,0,0,0.06);}
.install-card h3{font-family:'Playfair Display',serif;font-size:20px;color:var(--red);margin-bottom:16px;display:flex;align-items:center;gap:10px;}
.install-steps{list-style:none;display:flex;flex-direction:column;gap:12px;}
.install-steps li{display:flex;gap:12px;align-items:flex-start;font-size:14px;line-height:1.5;color:var(--brown-mid);}
.step-num{width:24px;height:24px;border-radius:50%;background:var(--red);color:white;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;}
.install-steps code{background:#f0e8dc;padding:1px 6px;border-radius:4px;font-size:12px;color:var(--red);}

/* BUBBLE */
#savta-bubble{position:fixed;bottom:28px;right:28px;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#7a2318,#c0392b);box-shadow:0 8px 32px rgba(122,35,24,0.5),0 2px 8px rgba(0,0,0,0.15);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:9999;border:none;outline:none;transition:transform 0.25s cubic-bezier(.34,1.56,.64,1),box-shadow 0.25s;}
#savta-bubble:hover{transform:scale(1.1);box-shadow:0 14px 48px rgba(122,35,24,0.6);}
#savta-bubble .bubble-emoji{font-size:30px;line-height:1;transition:transform 0.3s;display:block;}
#savta-bubble.open .bubble-emoji{transform:rotate(15deg);}
.bubble-ping{position:absolute;top:0;right:0;width:18px;height:18px;border-radius:50%;background:var(--gold);border:2.5px solid var(--cream);animation:ping 2.5s ease-in-out infinite;}
@keyframes ping{0%,100%{transform:scale(1);opacity:1}60%{transform:scale(1.5);opacity:0.5}}

/* WINDOW */
#savta-window{position:fixed;bottom:106px;right:28px;width:390px;max-width:calc(100vw - 40px);height:580px;max-height:calc(100vh - 130px);background:var(--warm-white);border-radius:26px;box-shadow:0 40px 100px rgba(0,0,0,0.2),0 4px 20px rgba(0,0,0,0.08),inset 0 0 0 1px rgba(122,35,24,0.10);display:flex;flex-direction:column;z-index:9998;overflow:hidden;transform:scale(0.88) translateY(24px);opacity:0;pointer-events:none;transition:transform 0.32s cubic-bezier(.34,1.4,.64,1),opacity 0.24s ease;transform-origin:bottom right;}
#savta-window.open{transform:scale(1) translateY(0);opacity:1;pointer-events:all;}

/* HEADER */
.savta-header{background:linear-gradient(135deg,#7a2318 0%,#9b2e1c 50%,#c0392b 100%);padding:18px 18px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0;position:relative;overflow:hidden;}
.savta-header::before{content:'';position:absolute;top:-30px;right:-20px;width:120px;height:120px;border-radius:50%;background:rgba(255,255,255,0.06);}
.savta-header::after{content:'';position:absolute;bottom:-40px;left:20px;width:90px;height:90px;border-radius:50%;background:rgba(255,255,255,0.04);}
.savta-avatar{width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#f97316);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;box-shadow:0 4px 14px rgba(0,0,0,0.28);position:relative;z-index:1;}
.savta-header-info{flex:1;position:relative;z-index:1;}
.savta-name{font-family:'Playfair Display',serif;font-size:17px;font-weight:700;color:#fff;line-height:1.1;}
.savta-status{font-size:11px;color:rgba(255,255,255,0.7);margin-top:3px;display:flex;align-items:center;gap:5px;}
.status-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;box-shadow:0 0 6px rgba(74,222,128,0.8);animation:statusPulse 2s infinite;}
@keyframes statusPulse{0%,100%{opacity:1}50%{opacity:0.6}}
.savta-close{width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.9);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;z-index:1;transition:background 0.2s;font-family:inherit;}
.savta-close:hover{background:rgba(255,255,255,0.25);}

/* QUICK PROMPTS */
.quick-prompts{padding:10px 12px 8px;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid var(--border);background:var(--bg-tint);}
.quick-btn{padding:5px 11px;border-radius:999px;background:#fff;border:1px solid var(--border);color:var(--red);font-size:11.5px;font-weight:600;font-family:'DM Sans',sans-serif;cursor:pointer;transition:all 0.18s;white-space:nowrap;}
.quick-btn:hover{background:var(--red);color:#fff;border-color:var(--red);transform:translateY(-1px);}

/* MESSAGES */
.savta-messages{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;}
.savta-messages::-webkit-scrollbar{width:3px;}
.savta-messages::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}
.msg{display:flex;gap:8px;align-items:flex-end;animation:msgIn 0.28s cubic-bezier(.34,1.4,.64,1) forwards;}
@keyframes msgIn{from{opacity:0;transform:translateY(10px) scale(0.95)}to{opacity:1;transform:translateY(0) scale(1)}}
.msg.user{flex-direction:row-reverse;}
.msg-mini-avatar{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#f97316);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;}
.msg-bubble{max-width:82%;padding:11px 14px;font-size:13.5px;line-height:1.65;font-family:'DM Sans',sans-serif;}
.msg-bubble p{margin:0 0 6px;}
.msg-bubble p:last-child{margin-bottom:0;}
.msg.bot .msg-bubble{background:#fff;color:var(--brown);border-radius:18px 18px 18px 4px;box-shadow:0 2px 10px rgba(0,0,0,0.07);border:1px solid #f0e8dc;}
.msg.user .msg-bubble{background:linear-gradient(135deg,#7a2318,#a0341f);color:#fff;border-radius:18px 18px 4px 18px;}
.msg-bubble a{color:var(--red);font-weight:600;}
.msg.user .msg-bubble a{color:var(--gold-light);}

/* TYPING */
.typing-wrap{display:flex;gap:4px;align-items:center;padding:4px 2px;}
.t-dot{width:7px;height:7px;border-radius:50%;background:#c0a080;animation:tdot 1.2s infinite ease-in-out;}
.t-dot:nth-child(2){animation-delay:.18s}
.t-dot:nth-child(3){animation-delay:.36s}
@keyframes tdot{0%,80%,100%{transform:translateY(0);opacity:0.4}40%{transform:translateY(-7px);opacity:1}}

/* INPUT */
.savta-input-row{padding:11px 13px 13px;border-top:1px solid #f0e8dc;background:var(--warm-white);display:flex;gap:9px;align-items:flex-end;flex-shrink:0;}
.savta-input{flex:1;padding:10px 14px;border-radius:14px;border:1.5px solid var(--border);background:#fff;font-size:13.5px;font-family:'DM Sans',sans-serif;color:var(--brown);outline:none;resize:none;max-height:100px;min-height:42px;line-height:1.5;transition:border-color 0.2s;}
.savta-input:focus{border-color:var(--red);}
.savta-input::placeholder{color:#c0a880;}
.savta-send{width:42px;height:42px;border-radius:13px;background:linear-gradient(135deg,#7a2318,#c0392b);border:none;color:white;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform 0.2s,box-shadow 0.2s;flex-shrink:0;}
.savta-send:hover{transform:scale(1.08);box-shadow:0 6px 20px rgba(122,35,24,0.45);}
.savta-send:disabled{opacity:0.45;cursor:not-allowed;transform:none;box-shadow:none;}
.savta-footer-brand{text-align:center;padding:5px 0 9px;font-size:10px;color:#c0a880;font-weight:500;letter-spacing:0.3px;flex-shrink:0;}
.savta-footer-brand a{color:var(--red);text-decoration:none;font-weight:600;}
@media(max-width:480px){#savta-window{right:12px;bottom:96px;width:calc(100vw - 24px);}#savta-bubble{right:18px;bottom:20px;}}
</style>
</head>
<body>
<div class="page">
  <div class="hero">
    <div class="hero-badge">🫙 Live Demo</div>
    <h1>Meet <em>Savta</em><br>Marsel</h1>
    <p>The AI grandmother behind Savta's Spices. She answers questions, shares recipes, recommends products — all in her own warm, Hebrew-spiced way.</p>
    <div class="spice-dots">
      <div class="spice-dot"></div><div class="spice-dot"></div><div class="spice-dot"></div>
      <div class="spice-dot"></div><div class="spice-dot"></div>
    </div>
    <div class="features">
      <div class="feature-pill">👵 Grandmotherly personality</div>
      <div class="feature-pill">🍳 Full recipes on demand</div>
      <div class="feature-pill">🫙 Product recommendations</div>
      <div class="feature-pill">✡️ FAQ answers</div>
      <div class="feature-pill">🌿 Hebrew + English</div>
      <div class="feature-pill">📦 Shipping & orders</div>
    </div>
    <div class="install-card">
      <h3>🛍️ Adding to Shopify</h3>
      <ol class="install-steps">
        <li><span class="step-num">1</span><span>Shopify Admin → <code>Online Store</code> → <code>Themes</code> → <code>Edit code</code></span></li>
        <li><span class="step-num">2</span><span>Open <code>theme.liquid</code> and find the closing <code>&lt;/body&gt;</code> tag</span></li>
        <li><span class="step-num">3</span><span>Paste the embed snippet just before <code>&lt;/body&gt;</code> and save</span></li>
        <li><span class="step-num">4</span><span>Savta appears on every page instantly! 🎉</span></li>
      </ol>
    </div>
  </div>
</div>

<!-- CHATBOT WIDGET -->
<button id="savta-bubble" onclick="toggleSavta()" aria-label="Chat with Savta">
  <span class="bubble-emoji">👵</span>
  <span class="bubble-ping" id="savta-ping"></span>
</button>

<div id="savta-window" role="dialog" aria-label="Chat with Savta Marsel">
  <div class="savta-header">
    <div class="savta-avatar">👵</div>
    <div class="savta-header-info">
      <div class="savta-name">Savta Marsel</div>
      <div class="savta-status">
        <span class="status-dot"></span>
        ברוכים הבאים לשולחן שלי
      </div>
    </div>
    <button class="savta-close" onclick="toggleSavta()">✕</button>
  </div>

  <div class="quick-prompts" id="quick-prompts">
    <button class="quick-btn" onclick="sendQuick('What spice blends do you sell?')">🫙 Blends</button>
    <button class="quick-btn" onclick="sendQuick('Give me a Shabbat recipe!')">🍽️ Recipes</button>
    <button class="quick-btn" onclick="sendQuick('Are your spices kosher?')">✡️ Kosher?</button>
    <button class="quick-btn" onclick="sendQuick('Do you ship internationally?')">📦 Shipping</button>
    <button class="quick-btn" onclick="sendQuick('I need a gift idea')">🎁 Gifts</button>
    <button class="quick-btn" onclick="sendQuick('Tell me the story behind Savta Marsel and this brand')">💛 Story</button>
  </div>

  <div class="savta-messages" id="savta-messages"></div>

  <div class="savta-input-row">
    <textarea
      class="savta-input"
      id="savta-input"
      placeholder="שאל אותי כל דבר… Ask me anything!"
      rows="1"
      onkeydown="handleKey(event)"
      oninput="autoResize(this)"
    ></textarea>
    <button class="savta-send" id="savta-send-btn" onclick="sendMessage()">➤</button>
  </div>
  <div class="savta-footer-brand">
    Powered by <a href="https://savtasspices.com" target="_blank">Savta's Spices</a> 🫙
  </div>
</div>

<script>
let isOpen = false;
let isLoading = false;
let history = [];
let greeted = false;

function toggleSavta() {
  isOpen = !isOpen;
  const win = document.getElementById('savta-window');
  const bubble = document.getElementById('savta-bubble');
  const ping = document.getElementById('savta-ping');
  if (isOpen) {
    win.classList.add('open');
    bubble.classList.add('open');
    if (ping) ping.style.display = 'none';
    if (!greeted) {
      greeted = true;
      setTimeout(() => addBotMsg("Shalom shalom, motek! 👵\\n\\nAni Savta Marsel — Niv's savta, the one who taught him everything in the kitchen.\\n\\nAsk me about our spices, I'll give you a recipe, help you find a gift, or just farbreng a bisl. My kitchen is always open! 🫙"), 420);
    }
    setTimeout(() => document.getElementById('savta-input').focus(), 360);
  } else {
    win.classList.remove('open');
    bubble.classList.remove('open');
  }
}

function addBotMsg(text) {
  const c = document.getElementById('savta-messages');
  const el = document.createElement('div');
  el.className = 'msg bot';
  el.innerHTML = '<div class="msg-mini-avatar">👵</div><div class="msg-bubble">' + fmt(text) + '</div>';
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
}

function addUserMsg(text) {
  const c = document.getElementById('savta-messages');
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = '<div class="msg-bubble">' + esc(text) + '</div>';
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
}

function showTyping() {
  const c = document.getElementById('savta-messages');
  const el = document.createElement('div');
  el.className = 'msg bot';
  el.id = 'savta-typing';
  el.innerHTML = '<div class="msg-mini-avatar">👵</div><div class="msg-bubble"><div class="typing-wrap"><div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div></div></div>';
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
}

function removeTyping() {
  const t = document.getElementById('savta-typing');
  if (t) t.remove();
}

function fmt(text) {
  return esc(text)
    .replace(/\\n\\n/g, '</p><p>')
    .replace(/\\n/g, '<br>')
    .replace(/^/, '<p>').replace(/$/, '</p>')
    .replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank">$1</a>');
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function sendQuick(text) {
  document.getElementById('quick-prompts').style.display = 'none';
  document.getElementById('savta-input').value = text;
  sendMessage();
}

async function sendMessage() {
  const input = document.getElementById('savta-input');
  const text = input.value.trim();
  if (!text || isLoading) return;

  input.value = '';
  input.style.height = 'auto';
  isLoading = true;
  document.getElementById('savta-send-btn').disabled = true;

  addUserMsg(text);
  history.push({ role: 'user', content: text });
  showTyping();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history })
    });
    const data = await res.json();
    removeTyping();
    const reply = data.reply || "Yiii, something got lost! Try again, motek 🫙";
    addBotMsg(reply);
    history.push({ role: 'assistant', content: reply });
  } catch(e) {
    removeTyping();
    addBotMsg("Yiii, the connection is like my cousin Moshe — unreliable! 😄 Try again in a second, motek!");
  }

  isLoading = false;
  document.getElementById('savta-send-btn').disabled = false;
  input.focus();
}
</script>
</body>
</html>`);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🫙 Savta is live on port ${port}`));
