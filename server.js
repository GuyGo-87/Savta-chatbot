require("dotenv").config();
const express = require("express");
const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) console.error("Missing GEMINI_API_KEY");

const SYSTEM_PROMPT = `You are Savta Marsel — the warm, funny, loving grandmother behind Savta's Spices. You speak like a beloved American grandmother who happens to have deep Moroccan Jewish roots. You're cozy, encouraging, and always ready to help someone make something delicious.

YOUR PERSONALITY:
Warm and welcoming — you treat every person like they just walked into your kitchen. You're patient, encouraging, and never make anyone feel like they're asking a silly question. You speak naturally, like a real person would, not like a chatbot.
Occasionally use Moroccan phrases when it feels natural — maybe once per conversation: S'htein! (to your health / cheers), Habibi or Azizi (my dear), Wallak! (really?!), Omri (my life). Use them sparingly — they add charm, not confusion.
NO Hebrew. Warm, natural English only.
Always acknowledge what the person said before jumping into your answer. Be conversational and genuine.
Every answer naturally leads back to food and flavor. Keep sentences punchy and real.
Reference Niv (your grandson who started this business) with genuine pride.
If someone is having a tough day, offer comfort and food. If someone thanks you, respond warmly.
Never be abrupt. Leave the door open for more questions.

SEASONAL AWARENESS:
- On Fridays mention that Shabbat is coming and suggest the Shabbat Rice Mix warmly
- On Jewish holidays (Rosh Hashana, Passover, Hanukkah, Purim) reference them naturally
- In winter suggest warm, hearty dishes; in summer suggest fresher, lighter ones

SPICE QUIZ:
If someone asks "what spice should I buy" or "I don't know what to get" or "help me choose", run the spice quiz:
Ask them 3 short questions one at a time:
1. "What are you cooking most these days? Fish, meat, chicken, or rice?"
2. "How do you like your heat — gentle and fragrant, or bold and fiery?"
3. "Is this for yourself or a gift for someone special?"
Then recommend the perfect product with a direct buy link.

RECIPE FORMATTING — VERY IMPORTANT:
When giving a recipe, use this EXACT format with these exact markers so the app can display it beautifully:

[RECIPE_START]
[RECIPE_TITLE]Name of the dish[/RECIPE_TITLE]
[RECIPE_DESC]One warm, inviting sentence description[/RECIPE_DESC]
[RECIPE_INGREDIENTS]
- ingredient one
- ingredient two
- ingredient three
[/RECIPE_INGREDIENTS]
[RECIPE_STEPS]
1. First step description
2. Second step description
3. Third step description
[/RECIPE_STEPS]
[RECIPE_TIP]Savta's personal tip or secret[/RECIPE_TIP]
[RECIPE_PRODUCT]product name|product url[/RECIPE_PRODUCT]
[RECIPE_END]

After the recipe block, end with something warm like: S'htein! Your kitchen is going to smell amazing. 🫙

PRODUCTS:
Everything but the Challah $10: https://savtasspices.com/collections/all/products/everything-but-the-challah
Ktzitzot Blend $10: https://savtasspices.com/collections/all/products/ktzitzot-blend
Moroccan Fish Blend $10: https://savtasspices.com/collections/all/products/moroccan-fish-blend
Savta's Za'atar $8: https://savtasspices.com/collections/all/products/savtas-zaatar
Shabbat Rice Mix $10: https://savtasspices.com/collections/all/products/shabbat-rice-mix
Tipa Spicy Red Sauce $10: https://savtasspices.com/collections/all/products/tipa-spicy-red-sauce
Tasting Box $30, Full Flavor Box $50, Deluxe Flavor Box $90
Shop all: https://savtasspices.com/collections/all

FAQ: Made in New York, small batches, organic and fair trade. Kosher suppliers, blends not officially certified yet. Shipping US only. Bulk orders: hello@savtasspices.com

RULES: Max 3-4 short paragraphs unless recipe. Never break character. If unsure say: You know what, I'm not sure about that one — send an email to hello@savtasspices.com and Niv will get you sorted out!`;

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "messages array required" });
    if (!GEMINI_API_KEY) return res.status(500).json({ reply: "Kitchen not set up yet!" });

    const contents = messages.slice(-12).map(m => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }]
    }));

    const geminiRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: { temperature: 0.85, maxOutputTokens: 2000 }
        })
      }
    );

    const data = await geminiRes.json();
    if (data.error) throw new Error(data.error.message);
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Something got lost, dear. Try again!";
    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ reply: "Oh my, something went sideways in the kitchen! Give me just a moment." });
  }
});

app.get("/", (req, res) => {
  res.send(getPage());
});

function getPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Savta's Spices</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400;1,700&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&family=Lora:ital,wght@0,400;0,600;1,400;1,600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --cream:#faf7f2;
  --warm-white:#fffdf9;
  --red:#7a2318;
  --red-light:#c0392b;
  --gold:#f59e0b;
  --gold-light:#fde68a;
  --brown:#2c1a0e;
  --brown-mid:#7a6a5a;
  --border:#e8d5c0;
  --bg-tint:#fff8f0;
  --parchment:#fdf6e9;
}
body{font-family:"DM Sans",sans-serif;background:var(--cream);color:var(--brown);min-height:100vh;}
.page{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:0 20px 120px;}
.hero{text-align:center;padding:64px 20px 48px;max-width:680px;width:100%;}
.hero h1{font-family:"Playfair Display",serif;font-size:clamp(38px,6vw,62px);color:var(--red);line-height:1.1;letter-spacing:-1px;margin-bottom:16px;}
.hero h1 em{font-style:italic;color:var(--brown);}
.hero p{font-size:16px;color:var(--brown-mid);line-height:1.7;margin-bottom:32px;}
.hero-badge{display:inline-flex;align-items:center;gap:7px;padding:6px 16px;border-radius:999px;background:rgba(122,35,24,0.08);border:1px solid rgba(122,35,24,0.18);font-size:12px;font-weight:600;color:var(--red);letter-spacing:0.5px;text-transform:uppercase;margin-bottom:22px;}
.features{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-bottom:48px;}
.feature-pill{display:flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;background:var(--warm-white);border:1px solid var(--border);font-size:13px;font-weight:500;color:var(--brown);}

/* Floating bubble */
#savta-bubble{position:fixed;bottom:28px;right:28px;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#7a2318,#c0392b);box-shadow:0 8px 32px rgba(122,35,24,0.5);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:9999;border:none;outline:none;transition:transform 0.2s;}
#savta-bubble:hover{transform:scale(1.1);}
.bubble-emoji{font-size:30px;line-height:1;display:block;pointer-events:none;}
.bubble-ping{position:absolute;top:0;right:0;width:18px;height:18px;border-radius:50%;background:var(--gold);border:2.5px solid var(--cream);animation:ping 2.5s ease-in-out infinite;}
@keyframes ping{0%,100%{transform:scale(1);opacity:1}60%{transform:scale(1.5);opacity:0.5}}

/* Chat window */
#savta-window{position:fixed;bottom:106px;right:28px;width:400px;max-width:calc(100vw - 40px);height:600px;max-height:calc(100vh - 130px);background:var(--warm-white);border-radius:26px;box-shadow:0 40px 100px rgba(0,0,0,0.2);display:flex;flex-direction:column;z-index:9998;overflow:hidden;transform:scale(0.88) translateY(24px);opacity:0;pointer-events:none;transition:transform 0.32s cubic-bezier(0.34,1.56,0.64,1),opacity 0.24s;transform-origin:bottom right;}
#savta-window.open{transform:scale(1) translateY(0);opacity:1;pointer-events:all;}

/* Header */
.savta-header{background:linear-gradient(135deg,#7a2318,#c0392b);padding:18px;display:flex;align-items:center;gap:12px;flex-shrink:0;}
.savta-avatar{width:48px;height:48px;border-radius:50%;border:2px solid rgba(255,255,255,0.3);overflow:hidden;flex-shrink:0;}
.savta-avatar img{width:100%;height:100%;object-fit:cover;object-position:center top;}
.savta-name{font-family:"Playfair Display",serif;font-size:17px;font-weight:700;color:#fff;}
.savta-status{font-size:11px;color:rgba(255,255,255,0.75);margin-top:3px;display:flex;align-items:center;gap:5px;}
.status-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
.savta-close{width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.2);color:#fff;font-size:14px;cursor:pointer;margin-left:auto;font-family:inherit;transition:background 0.15s;}
.savta-close:hover{background:rgba(255,255,255,0.25);}

/* Quick prompts */
.quick-prompts{padding:10px 12px 8px;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid var(--border);background:var(--bg-tint);}
.quick-btn{padding:5px 11px;border-radius:999px;background:#fff;border:1px solid var(--border);color:var(--red);font-size:11.5px;font-weight:600;font-family:"DM Sans",sans-serif;cursor:pointer;white-space:nowrap;transition:all 0.15s;}
.quick-btn:hover{background:var(--red);color:#fff;border-color:var(--red);}

/* Messages */
.savta-messages{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;}
.savta-messages::-webkit-scrollbar{width:4px;}
.savta-messages::-webkit-scrollbar-track{background:transparent;}
.savta-messages::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}

.msg{display:flex;gap:8px;align-items:flex-end;animation:msgIn 0.25s ease;}
@keyframes msgIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.msg.user{flex-direction:row-reverse;}
.msg-mini-avatar{width:28px;height:28px;border-radius:50%;overflow:hidden;flex-shrink:0;}
.msg-mini-avatar img{width:100%;height:100%;object-fit:cover;object-position:center top;}
.msg-bubble{max-width:82%;padding:11px 14px;font-size:13.5px;line-height:1.65;font-family:"DM Sans",sans-serif;}
.msg-bubble p{margin:0 0 8px;}
.msg-bubble p:last-child{margin-bottom:0;}
.msg.bot .msg-bubble{background:#fff;color:var(--brown);border-radius:18px 18px 18px 4px;box-shadow:0 2px 10px rgba(0,0,0,0.07);border:1px solid #f0e8dc;}
.msg.user .msg-bubble{background:linear-gradient(135deg,#7a2318,#a0341f);color:#fff;border-radius:18px 18px 4px 18px;}
.msg-bubble a{color:var(--red);font-weight:700;text-decoration:underline;}

/* ═══════════════════════════════════════
   COOKBOOK-STYLE RECIPE CARD
═══════════════════════════════════════ */
.recipe-card{
  background:var(--parchment);
  border:1px solid #dcc9a0;
  border-radius:16px;
  overflow:hidden;
  margin:4px 0;
  box-shadow:0 6px 28px rgba(44,26,14,0.12), 0 1px 0 #e8d5a0 inset;
  font-family:"Lora",serif;
}

/* Top banner with decorative rule */
.recipe-header{
  background:linear-gradient(160deg,#7a2318 0%,#9b2d20 60%,#7a2318 100%);
  padding:20px 20px 16px;
  position:relative;
  text-align:center;
}
.recipe-header::before{
  content:"✦  ✦  ✦";
  display:block;
  font-size:9px;
  letter-spacing:6px;
  color:rgba(255,255,255,0.4);
  margin-bottom:10px;
  font-family:"DM Sans",sans-serif;
}
.recipe-header::after{
  content:"✦  ✦  ✦";
  display:block;
  font-size:9px;
  letter-spacing:6px;
  color:rgba(255,255,255,0.4);
  margin-top:10px;
  font-family:"DM Sans",sans-serif;
}
.recipe-title{
  font-family:"Playfair Display",serif;
  font-size:19px;
  font-weight:700;
  font-style:italic;
  color:#fff;
  letter-spacing:0.3px;
  line-height:1.25;
}
.recipe-desc{
  font-size:12px;
  color:rgba(255,255,255,0.82);
  line-height:1.55;
  font-family:"DM Sans",sans-serif;
  font-style:normal;
  margin-top:6px;
}

/* Decorative divider */
.recipe-divider{
  display:flex;
  align-items:center;
  gap:10px;
  padding:14px 18px 0;
  color:#b8905a;
  font-size:9px;
  letter-spacing:4px;
  font-family:"DM Sans",sans-serif;
  text-transform:uppercase;
}
.recipe-divider::before,.recipe-divider::after{content:"";flex:1;height:1px;background:linear-gradient(to right,transparent,#d4b896,transparent);}

/* Section labels */
.recipe-section-label{
  font-family:"DM Sans",sans-serif;
  font-size:9.5px;
  font-weight:700;
  letter-spacing:2px;
  text-transform:uppercase;
  color:#9b6a3a;
  margin-bottom:10px;
  margin-top:16px;
  display:flex;
  align-items:center;
  gap:8px;
  padding:0 18px;
}
.recipe-section-label:first-of-type{margin-top:0;}
.recipe-section-label span{white-space:nowrap;}
.recipe-section-label::after{content:"";flex:1;height:1px;background:#e2c9a4;}

/* Body */
.recipe-body{padding:14px 0 16px;}

/* Ingredients */
.recipe-ingredients{
  list-style:none;
  display:flex;
  flex-direction:column;
  gap:3px;
  padding:0 18px;
}
.recipe-ingredients li{
  font-size:13px;
  color:var(--brown);
  padding:6px 10px 6px 14px;
  position:relative;
  line-height:1.45;
  border-bottom:1px dashed #e8d5b8;
  font-family:"Lora",serif;
}
.recipe-ingredients li:last-child{border-bottom:none;}
.recipe-ingredients li::before{
  content:"•";
  position:absolute;
  left:2px;
  color:#c0784a;
  font-size:15px;
  line-height:1.2;
}

/* Steps */
.recipe-steps{
  display:flex;
  flex-direction:column;
  gap:10px;
  padding:0 18px;
}
.recipe-step{
  display:flex;
  gap:12px;
  align-items:flex-start;
}
.step-num{
  width:24px;
  height:24px;
  border-radius:50%;
  background:linear-gradient(135deg,#7a2318,#c0392b);
  color:#fff;
  font-size:11px;
  font-weight:700;
  font-family:"DM Sans",sans-serif;
  display:flex;
  align-items:center;
  justify-content:center;
  flex-shrink:0;
  margin-top:1px;
  box-shadow:0 2px 6px rgba(122,35,24,0.3);
}
.step-text{
  font-size:13px;
  color:var(--brown);
  line-height:1.6;
  font-family:"Lora",serif;
  padding-top:2px;
}

/* Savta's tip box */
.recipe-tip-wrap{padding:0 18px;}
.recipe-tip{
  background:linear-gradient(135deg,rgba(245,158,11,0.08),rgba(249,115,22,0.06));
  border:1px solid rgba(245,158,11,0.35);
  border-left:3px solid var(--gold);
  border-radius:10px;
  padding:10px 14px;
  font-size:12.5px;
  color:#7a5020;
  line-height:1.55;
  font-family:"DM Sans",sans-serif;
  font-style:italic;
  margin-top:16px;
}
.recipe-tip-label{
  font-weight:700;
  font-style:normal;
  color:#9b6a2a;
  font-size:10px;
  letter-spacing:1.5px;
  text-transform:uppercase;
  display:block;
  margin-bottom:4px;
}

/* Buy button */
.recipe-buy-wrap{padding:14px 18px 0;}
.recipe-buy-btn{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:8px;
  width:100%;
  padding:12px;
  background:linear-gradient(135deg,#7a2318,#c0392b);
  color:#fff;
  font-size:13px;
  font-weight:600;
  font-family:"DM Sans",sans-serif;
  border:none;
  border-radius:12px;
  cursor:pointer;
  text-align:center;
  text-decoration:none;
  transition:opacity 0.2s, transform 0.1s;
  letter-spacing:0.3px;
}
.recipe-buy-btn:hover{opacity:0.9;transform:translateY(-1px);}
.recipe-buy-btn:active{transform:translateY(0);}

/* Typing indicator */
.typing-wrap{display:flex;gap:4px;align-items:center;padding:4px 2px;}
.t-dot{width:7px;height:7px;border-radius:50%;background:#c0a080;animation:tdot 1.2s infinite ease-in-out;}
.t-dot:nth-child(2){animation-delay:.18s}
.t-dot:nth-child(3){animation-delay:.36s}
@keyframes tdot{0%,80%,100%{transform:translateY(0);opacity:0.4}40%{transform:translateY(-7px);opacity:1}}

/* Input area */
.savta-input-row{padding:11px 13px 13px;border-top:1px solid #f0e8dc;background:var(--warm-white);display:flex;gap:9px;align-items:flex-end;flex-shrink:0;}
.savta-input{flex:1;padding:10px 14px;border-radius:14px;border:1.5px solid var(--border);background:#fff;font-size:13.5px;font-family:"DM Sans",sans-serif;color:var(--brown);outline:none;resize:none;max-height:100px;min-height:42px;line-height:1.5;transition:border-color 0.15s;}
.savta-input:focus{border-color:var(--red);}
.savta-input::placeholder{color:#c0a880;}
.savta-send{width:42px;height:42px;border-radius:13px;background:linear-gradient(135deg,#7a2318,#c0392b);border:none;color:white;font-size:17px;cursor:pointer;flex-shrink:0;transition:opacity 0.15s;}
.savta-send:disabled{opacity:0.45;cursor:not-allowed;}
.savta-footer-brand{text-align:center;padding:5px 0 9px;font-size:10px;color:#c0a880;font-weight:500;flex-shrink:0;}
.savta-footer-brand a{color:var(--red);text-decoration:none;font-weight:600;}

@media(max-width:480px){
  #savta-window{right:12px;bottom:96px;width:calc(100vw - 24px);}
  #savta-bubble{right:18px;bottom:20px;}
}
</style>
</head>
<body>
<div class="page">
  <div class="hero">
    <div class="hero-badge">🫙 Live Demo</div>
    <h1>Meet <em>Savta</em><br>Marsel</h1>
    <p>The AI grandmother behind Savta's Spices. Warm, welcoming, and always in the kitchen.</p>
    <div class="features">
      <div class="feature-pill">👵 Grandmotherly warmth</div>
      <div class="feature-pill">🍳 Full recipes on demand</div>
      <div class="feature-pill">🫙 Product recommendations</div>
      <div class="feature-pill">📦 Shipping and orders</div>
    </div>
  </div>
</div>

<button id="savta-bubble" onclick="toggleSavta()" aria-label="Chat with Savta">
  <span class="bubble-emoji" style="display:block;width:100%;height:100%;border-radius:50%;background-image:url(data:image/jpeg;base64,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);background-size:cover;background-position:center top;"></span>
  <span class="bubble-ping"></span>
</button>

<div id="savta-window">
  <div class="savta-header">
    <div class="savta-avatar">
      <img src="data:image/jpeg;base64,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" alt="Savta Marsel" />
    </div>
    <div>
      <div class="savta-name">Savta Marsel</div>
      <div class="savta-status"><span class="status-dot"></span>In the kitchen, ready for you</div>
    </div>
    <button class="savta-close" onclick="toggleSavta()">✕</button>
  </div>
  <div class="quick-prompts" id="quick-prompts">
    <button class="quick-btn" onclick="sendQuick('What spice blends do you sell?')">🫙 Our Blends</button>
    <button class="quick-btn" onclick="sendQuick('Give me a Shabbat dinner recipe!')">🍽️ Recipes</button>
    <button class="quick-btn" onclick="sendQuick('Help me choose the right spice for me')">✨ Find My Spice</button>
    <button class="quick-btn" onclick="sendQuick('Are your spices kosher?')">✡️ Kosher?</button>
    <button class="quick-btn" onclick="sendQuick('I need a gift idea for someone who loves to cook')">🎁 Gifts</button>
    <button class="quick-btn" onclick="sendQuick('Tell me the story behind Savta Marsel and these spices')">💛 Our Story</button>
  </div>
  <div class="savta-messages" id="savta-messages"></div>
  <div class="savta-input-row">
    <textarea class="savta-input" id="savta-input" placeholder="Ask me anything about spices, recipes, or orders..." rows="1" onkeydown="handleKey(event)" oninput="autoResize(this)"></textarea>
    <button class="savta-send" id="savta-send-btn" onclick="sendMessage()">&#9658;</button>
  </div>
  <div class="savta-footer-brand">Powered by <a href="https://savtasspices.com" target="_blank">Savta's Spices</a> 🫙</div>
</div>

<script>
var isOpen = false;
var isLoading = false;
var chatHistory = [];
var greeted = false;

function getSeasonalGreeting() {
  var now = new Date();
  var month = now.getMonth() + 1;
  var day = now.getDay(); // 0=Sun, 5=Fri, 6=Sat
  if (day === 5) return "Welcome, welcome! Come on in — Shabbat is almost here and there's so much to cook. I'm Savta Marsel, Niv's grandmother and the heart behind these spices. What can I help you make tonight? 🕯️";
  if (month === 9 || month === 10) return "Welcome! The holidays are here and the kitchen is calling. I'm Savta Marsel — Niv's grandmother, and the one behind all these flavors. Ask me anything! 🍎";
  if (month === 12) return "Welcome in from the cold! The kitchen is warm and so am I. I'm Savta Marsel, Niv's grandmother. What can I help you cook up today? 🫙";
  return "Welcome! I'm so glad you stopped by. I'm Savta Marsel — Niv's grandmother and the spirit behind every jar of Savta's Spices. Pull up a chair and tell me what you're cooking. My kitchen is always open. 🫙";
}

function toggleSavta() {
  isOpen = !isOpen;
  var win = document.getElementById("savta-window");
  if (isOpen) {
    win.classList.add("open");
    if (!greeted) {
      greeted = true;
      setTimeout(function() { addBotMsg(getSeasonalGreeting()); }, 400);
    }
    setTimeout(function() { document.getElementById("savta-input").focus(); }, 350);
  } else {
    win.classList.remove("open");
  }
}

function parseRecipe(text) {
  if (!text.includes("[RECIPE_START]")) return null;
  var getTag = function(tag, t) {
    var m = t.match(new RegExp("\\[" + tag + "\\]([\\s\\S]*?)\\[\\/" + tag + "\\]"));
    return m ? m[1].trim() : "";
  };
  return {
    title: getTag("RECIPE_TITLE", text),
    desc: getTag("RECIPE_DESC", text),
    ingredients: getTag("RECIPE_INGREDIENTS", text).split("\\n").map(function(l){return l.replace(/^-\\s*/,"").trim();}).filter(Boolean),
    steps: getTag("RECIPE_STEPS", text).split("\\n").map(function(l){return l.replace(/^\\d+\\.\\s*/,"").trim();}).filter(Boolean),
    tip: getTag("RECIPE_TIP", text),
    product: getTag("RECIPE_PRODUCT", text)
  };
}

function buildRecipeCard(r) {
  var card = document.createElement("div");
  card.className = "recipe-card";

  // Header
  var header = document.createElement("div");
  header.className = "recipe-header";
  header.innerHTML = '<div class="recipe-title">' + escHtml(r.title) + '</div>' +
    (r.desc ? '<div class="recipe-desc">' + escHtml(r.desc) + '</div>' : '');
  card.appendChild(header);

  // Divider
  var div = document.createElement("div");
  div.className = "recipe-divider";
  div.innerHTML = "<span>Savta's Spices</span>";
  card.appendChild(div);

  // Body
  var body = document.createElement("div");
  body.className = "recipe-body";

  // Ingredients
  var ingLabel = document.createElement("div");
  ingLabel.className = "recipe-section-label";
  ingLabel.innerHTML = '<span>Ingredients</span>';
  body.appendChild(ingLabel);

  var ul = document.createElement("ul");
  ul.className = "recipe-ingredients";
  r.ingredients.forEach(function(ing) {
    var li = document.createElement("li");
    li.textContent = ing;
    ul.appendChild(li);
  });
  body.appendChild(ul);

  // Steps
  var stepLabel = document.createElement("div");
  stepLabel.className = "recipe-section-label";
  stepLabel.innerHTML = '<span>Method</span>';
  body.appendChild(stepLabel);

  var steps = document.createElement("div");
  steps.className = "recipe-steps";
  r.steps.forEach(function(s, i) {
    var step = document.createElement("div");
    step.className = "recipe-step";
    step.innerHTML = '<div class="step-num">' + (i+1) + '</div><div class="step-text">' + escHtml(s) + '</div>';
    steps.appendChild(step);
  });
  body.appendChild(steps);

  // Tip
  if (r.tip) {
    var tipWrap = document.createElement("div");
    tipWrap.className = "recipe-tip-wrap";
    var tip = document.createElement("div");
    tip.className = "recipe-tip";
    tip.innerHTML = '<span class="recipe-tip-label">Savta&#39;s Tip</span>' + escHtml(r.tip);
    tipWrap.appendChild(tip);
    body.appendChild(tipWrap);
  }

  // Buy button
  if (r.product) {
    var parts = r.product.split("|");
    var productName = parts[0] ? parts[0].trim() : "the spice blend";
    var productUrl = parts[1] ? parts[1].trim() : "https://savtasspices.com/collections/all";
    var btnWrap = document.createElement("div");
    btnWrap.className = "recipe-buy-wrap";
    var btn = document.createElement("a");
    btn.className = "recipe-buy-btn";
    btn.href = productUrl;
    btn.target = "_blank";
    btn.innerHTML = '🛒 Shop ' + escHtml(productName) + ' →';
    btnWrap.appendChild(btn);
    body.appendChild(btnWrap);
  }

  card.appendChild(body);
  return card;
}

function escHtml(str) {
  var d = document.createElement('div');
  d.appendChild(document.createTextNode(str || ''));
  return d.innerHTML;
}

function renderText(text) {
  var recipeMatch = text.match(/\[RECIPE_START\][\s\S]*?\[RECIPE_END\]/);
  var wrap = document.createElement("div");

  if (recipeMatch) {
    var recipe = parseRecipe(recipeMatch[0]);
    var before = text.substring(0, text.indexOf("[RECIPE_START]")).trim();
    var after = text.substring(text.indexOf("[RECIPE_END]") + 12).trim();

    if (before) {
      before.split(/\n\n+/).forEach(function(p) {
        if (p.trim()) { var el = document.createElement("p"); el.textContent = p.trim(); wrap.appendChild(el); }
      });
    }
    if (recipe) wrap.appendChild(buildRecipeCard(recipe));
    if (after) {
      after.split(/\n\n+/).forEach(function(p) {
        if (p.trim()) { var el = document.createElement("p"); el.textContent = p.trim(); wrap.appendChild(el); }
      });
    }
  } else {
    text.split(/\n\n+/).forEach(function(p) {
      if (p.trim()) { var el = document.createElement("p"); el.textContent = p.trim(); wrap.appendChild(el); }
    });
  }
  return wrap;
}

var AVATAR_SRC = "data:image/jpeg;base64,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";

function makeBotAvatar() {
  var wrap = document.createElement("div");
  wrap.className = "msg-mini-avatar";
  var img = document.createElement("img");
  img.src = AVATAR_SRC;
  img.alt = "Savta";
  wrap.appendChild(img);
  return wrap;
}

function addBotMsg(text) {
  var c = document.getElementById("savta-messages");
  var el = document.createElement("div");
  el.className = "msg bot";
  var bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.appendChild(renderText(text));
  el.appendChild(makeBotAvatar());
  el.appendChild(bubble);
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
}

function addUserMsg(text) {
  var c = document.getElementById("savta-messages");
  var el = document.createElement("div");
  el.className = "msg user";
  var bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = text;
  el.appendChild(bubble);
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
}

function showTyping() {
  var c = document.getElementById("savta-messages");
  var el = document.createElement("div");
  el.className = "msg bot";
  el.id = "savta-typing";
  var bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.innerHTML = '<div class="typing-wrap"><div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div></div>';
  el.appendChild(makeBotAvatar());
  el.appendChild(bubble);
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
}

function removeTyping() {
  var t = document.getElementById("savta-typing");
  if (t) t.remove();
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 100) + "px";
}

function handleKey(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function sendQuick(text) {
  document.getElementById("quick-prompts").style.display = "none";
  document.getElementById("savta-input").value = text;
  sendMessage();
}

function sendMessage() {
  var input = document.getElementById("savta-input");
  var text = input.value.trim();
  if (!text || isLoading) return;
  input.value = "";
  input.style.height = "auto";
  isLoading = true;
  document.getElementById("savta-send-btn").disabled = true;
  addUserMsg(text);
  chatHistory.push({ role: "user", content: text });
  showTyping();
  fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: chatHistory })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    removeTyping();
    var reply = data.reply || "Something got a little lost! Try asking again.";
    addBotMsg(reply);
    chatHistory.push({ role: "assistant", content: reply });
  })
  .catch(function() {
    removeTyping();
    addBotMsg("Oops — looks like the connection dropped for a moment. Try again!");
  })
  .finally(function() {
    isLoading = false;
    document.getElementById("savta-send-btn").disabled = false;
    document.getElementById("savta-input").focus();
  });
}
</script>
</body>
</html>`;
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Savta is live on port " + port));
