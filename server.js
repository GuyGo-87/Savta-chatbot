require("dotenv").config();
const express = require("express");
const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) console.error("Missing GEMINI_API_KEY");

const SYSTEM_PROMPT = `You are Savta Marsel — the warm, funny, loving Moroccan Jewish grandmother behind Savta's Spices. You speak with the soul of a Moroccan kitchen — loud, loving, a little chaotic, and always delicious.

YOUR PERSONALITY:
Warm and grandmotherly. Use Moroccan phrases naturally: S'htein! (cheers), Habibi or Azizi (my dear), Wallak! (really?!), Omri (my life), Balak! (careful!), Mshkan (poor thing), Bish? (why?), Safi (enough).
NO Hebrew. English with Moroccan warmth only.
Every answer leads back to food. Short punchy sentences. Never corporate.
Reference Niv (your grandson who started this) with pride.
If someone is sad, offer food as comfort.

SEASONAL AWARENESS:
- On Fridays mention Shabbat warmly and suggest Shabbat Rice Mix
- On Jewish holidays (Rosh Hashana, Passover, Hanukkah, Purim) reference them naturally
- In winter suggest warm comforting dishes, in summer suggest lighter fresh ones

SPICE QUIZ:
If someone asks "what spice should I buy" or "I don't know what to get" or "help me choose", run the spice quiz:
Ask them 3 short questions one at a time:
1. "Habibi, tell me — what are you cooking most? Fish, meat, chicken, or rice?"
2. "And how spicy do you like it? Like a gentle kiss or like fire??"
3. "Is this for you or a gift for someone special?"
Then recommend the perfect product with a direct buy link.

RECIPE FORMATTING — VERY IMPORTANT:
Every recipe MUST start with: "First of all, relax! 🫙"
Then use this EXACT format with these exact markers so the app can display it beautifully:

[RECIPE_START]
[RECIPE_TITLE]Name of the dish[/RECIPE_TITLE]
[RECIPE_DESC]One warm sentence description from Savta[/RECIPE_DESC]
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

After the recipe block, end with: S'htein! Your kitchen will thank you. 🫙

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

RULES: Max 3-4 short paragraphs unless recipe. Never break character. If unsure say: Wallak, I am not sure habibi — email hello@savtasspices.com and Niv will sort it out!`;

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
          generationConfig: { temperature: 0.85, maxOutputTokens: 800 }
        })
      }
    );

    const data = await geminiRes.json();
    if (data.error) throw new Error(data.error.message);
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Something got lost habibi. Try again!";
    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ reply: "Wallak, the tajine is stuck! Give me a moment habibi." });
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
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--cream:#faf7f2;--warm-white:#fffdf9;--red:#7a2318;--gold:#f59e0b;--gold-light:#fde68a;--brown:#2c1a0e;--brown-mid:#7a6a5a;--border:#e8d5c0;--bg-tint:#fff8f0;}
body{font-family:"DM Sans",sans-serif;background:var(--cream);color:var(--brown);min-height:100vh;}
.page{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:0 20px 120px;}
.hero{text-align:center;padding:64px 20px 48px;max-width:680px;width:100%;}
.hero h1{font-family:"Playfair Display",serif;font-size:clamp(38px,6vw,62px);color:var(--red);line-height:1.1;letter-spacing:-1px;margin-bottom:16px;}
.hero h1 em{font-style:italic;color:var(--brown);}
.hero p{font-size:16px;color:var(--brown-mid);line-height:1.7;margin-bottom:32px;}
.hero-badge{display:inline-flex;align-items:center;gap:7px;padding:6px 16px;border-radius:999px;background:rgba(122,35,24,0.08);border:1px solid rgba(122,35,24,0.18);font-size:12px;font-weight:600;color:var(--red);letter-spacing:0.5px;text-transform:uppercase;margin-bottom:22px;}
.features{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-bottom:48px;}
.feature-pill{display:flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;background:var(--warm-white);border:1px solid var(--border);font-size:13px;font-weight:500;color:var(--brown);}
#savta-bubble{position:fixed;bottom:28px;right:28px;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#7a2318,#c0392b);box-shadow:0 8px 32px rgba(122,35,24,0.5);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:9999;border:none;outline:none;}
#savta-bubble:hover{transform:scale(1.1);}
.bubble-emoji{font-size:30px;line-height:1;display:block;pointer-events:none;}
.bubble-ping{position:absolute;top:0;right:0;width:18px;height:18px;border-radius:50%;background:var(--gold);border:2.5px solid var(--cream);animation:ping 2.5s ease-in-out infinite;}
@keyframes ping{0%,100%{transform:scale(1);opacity:1}60%{transform:scale(1.5);opacity:0.5}}
#savta-window{position:fixed;bottom:106px;right:28px;width:390px;max-width:calc(100vw - 40px);height:580px;max-height:calc(100vh - 130px);background:var(--warm-white);border-radius:26px;box-shadow:0 40px 100px rgba(0,0,0,0.2);display:flex;flex-direction:column;z-index:9998;overflow:hidden;transform:scale(0.88) translateY(24px);opacity:0;pointer-events:none;transition:transform 0.32s,opacity 0.24s;transform-origin:bottom right;}
#savta-window.open{transform:scale(1) translateY(0);opacity:1;pointer-events:all;}
.savta-header{background:linear-gradient(135deg,#7a2318,#c0392b);padding:18px;display:flex;align-items:center;gap:12px;flex-shrink:0;}
.savta-avatar{width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#f97316);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;}
.savta-name{font-family:"Playfair Display",serif;font-size:17px;font-weight:700;color:#fff;}
.savta-status{font-size:11px;color:rgba(255,255,255,0.7);margin-top:3px;display:flex;align-items:center;gap:5px;}
.status-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
.savta-close{width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.2);color:#fff;font-size:14px;cursor:pointer;margin-left:auto;font-family:inherit;}
.quick-prompts{padding:10px 12px 8px;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid var(--border);background:var(--bg-tint);}
.quick-btn{padding:5px 11px;border-radius:999px;background:#fff;border:1px solid var(--border);color:var(--red);font-size:11.5px;font-weight:600;font-family:"DM Sans",sans-serif;cursor:pointer;white-space:nowrap;}
.quick-btn:hover{background:var(--red);color:#fff;}
.savta-messages{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;}
.msg{display:flex;gap:8px;align-items:flex-end;}
.msg.user{flex-direction:row-reverse;}
.msg-mini-avatar{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#f97316);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;}
.msg-bubble{max-width:82%;padding:11px 14px;font-size:13.5px;line-height:1.65;font-family:"DM Sans",sans-serif;}
.msg-bubble p{margin:0 0 8px;}
.msg-bubble p:last-child{margin-bottom:0;}
.msg.bot .msg-bubble{background:#fff;color:var(--brown);border-radius:18px 18px 18px 4px;box-shadow:0 2px 10px rgba(0,0,0,0.07);border:1px solid #f0e8dc;}
.msg.user .msg-bubble{background:linear-gradient(135deg,#7a2318,#a0341f);color:#fff;border-radius:18px 18px 4px 18px;}
.msg-bubble a{color:var(--red);font-weight:700;text-decoration:underline;}

/* ── RECIPE CARD ── */
.recipe-card{background:linear-gradient(160deg,#fffdf7,#fff8ee);border:1.5px solid #e8d5b0;border-radius:18px;overflow:hidden;margin:4px 0;box-shadow:0 4px 20px rgba(122,35,24,0.08);}
.recipe-header{background:linear-gradient(135deg,#7a2318,#c0392b);padding:16px 18px 14px;position:relative;}
.recipe-header::after{content:"🫙";position:absolute;right:14px;top:50%;transform:translateY(-50%);font-size:28px;opacity:0.4;}
.recipe-title{font-family:"Playfair Display",serif;font-size:17px;font-weight:700;color:#fff;margin-bottom:4px;}
.recipe-desc{font-size:12px;color:rgba(255,255,255,0.8);line-height:1.5;font-style:italic;}
.recipe-body{padding:14px 16px;}
.recipe-section-label{font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--red);margin-bottom:8px;margin-top:12px;display:flex;align-items:center;gap:6px;}
.recipe-section-label:first-child{margin-top:0;}
.recipe-section-label::after{content:"";flex:1;height:1px;background:linear-gradient(to right,var(--border),transparent);}
.recipe-ingredients{list-style:none;display:flex;flex-direction:column;gap:4px;}
.recipe-ingredients li{font-size:12.5px;color:var(--brown);padding:5px 10px;background:rgba(122,35,24,0.04);border-radius:8px;border-left:3px solid var(--gold);line-height:1.4;}
.recipe-steps{display:flex;flex-direction:column;gap:8px;}
.recipe-step{display:flex;gap:10px;align-items:flex-start;}
.step-num{width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#7a2318,#c0392b);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;}
.step-text{font-size:12.5px;color:var(--brown);line-height:1.55;}
.recipe-tip{background:linear-gradient(135deg,rgba(245,158,11,0.1),rgba(249,115,22,0.08));border:1px solid rgba(245,158,11,0.3);border-radius:10px;padding:10px 12px;font-size:12px;color:#92400e;line-height:1.5;font-style:italic;}
.recipe-tip::before{content:"💡 Savta's secret: ";font-weight:700;font-style:normal;}
.recipe-buy-btn{display:block;width:100%;margin-top:14px;padding:11px;background:linear-gradient(135deg,#7a2318,#c0392b);color:#fff;font-size:13px;font-weight:700;font-family:"DM Sans",sans-serif;border:none;border-radius:12px;cursor:pointer;text-align:center;text-decoration:none;transition:opacity 0.2s;}
.recipe-buy-btn:hover{opacity:0.88;}
.recipe-buy-btn::before{content:"🛒 ";} 

.typing-wrap{display:flex;gap:4px;align-items:center;padding:4px 2px;}
.t-dot{width:7px;height:7px;border-radius:50%;background:#c0a080;animation:tdot 1.2s infinite ease-in-out;}
.t-dot:nth-child(2){animation-delay:.18s}
.t-dot:nth-child(3){animation-delay:.36s}
@keyframes tdot{0%,80%,100%{transform:translateY(0);opacity:0.4}40%{transform:translateY(-7px);opacity:1}}
.savta-input-row{padding:11px 13px 13px;border-top:1px solid #f0e8dc;background:var(--warm-white);display:flex;gap:9px;align-items:flex-end;flex-shrink:0;}
.savta-input{flex:1;padding:10px 14px;border-radius:14px;border:1.5px solid var(--border);background:#fff;font-size:13.5px;font-family:"DM Sans",sans-serif;color:var(--brown);outline:none;resize:none;max-height:100px;min-height:42px;line-height:1.5;}
.savta-input:focus{border-color:var(--red);}
.savta-input::placeholder{color:#c0a880;}
.savta-send{width:42px;height:42px;border-radius:13px;background:linear-gradient(135deg,#7a2318,#c0392b);border:none;color:white;font-size:17px;cursor:pointer;flex-shrink:0;}
.savta-send:disabled{opacity:0.45;cursor:not-allowed;}
.savta-footer-brand{text-align:center;padding:5px 0 9px;font-size:10px;color:#c0a880;font-weight:500;flex-shrink:0;}
.savta-footer-brand a{color:var(--red);text-decoration:none;font-weight:600;}
@media(max-width:480px){#savta-window{right:12px;bottom:96px;width:calc(100vw - 24px);}#savta-bubble{right:18px;bottom:20px;}}
</style>
</head>
<body>
<div class="page">
  <div class="hero">
    <div class="hero-badge">🫙 Live Demo</div>
    <h1>Meet <em>Savta</em><br>Marsel</h1>
    <p>The AI grandmother behind Savta's Spices. Warm, Moroccan, and always in the kitchen.</p>
    <div class="features">
      <div class="feature-pill">👵 Grandmotherly personality</div>
      <div class="feature-pill">🍳 Full recipes on demand</div>
      <div class="feature-pill">🫙 Product recommendations</div>
      <div class="feature-pill">📦 Shipping and orders</div>
    </div>
  </div>
</div>

<button id="savta-bubble" onclick="toggleSavta()" aria-label="Chat with Savta">
  <span class="bubble-emoji">👵</span>
  <span class="bubble-ping"></span>
</button>

<div id="savta-window">
  <div class="savta-header">
    <div class="savta-avatar">👵</div>
    <div>
      <div class="savta-name">Savta Marsel</div>
      <div class="savta-status"><span class="status-dot"></span>In the kitchen, ready for you</div>
    </div>
    <button class="savta-close" onclick="toggleSavta()">✕</button>
  </div>
  <div class="quick-prompts" id="quick-prompts">
    <button class="quick-btn" onclick="sendQuick('What spice blends do you sell?')">🫙 Blends</button>
    <button class="quick-btn" onclick="sendQuick('Give me a Shabbat recipe!')">🍽️ Recipes</button>
    <button class="quick-btn" onclick="sendQuick('Help me choose the right spice')">✨ Spice Quiz</button>
    <button class="quick-btn" onclick="sendQuick('Are your spices kosher?')">✡️ Kosher?</button>
    <button class="quick-btn" onclick="sendQuick('I need a gift idea')">🎁 Gifts</button>
    <button class="quick-btn" onclick="sendQuick('Tell me the story behind Savta Marsel')">💛 Story</button>
  </div>
  <div class="savta-messages" id="savta-messages"></div>
  <div class="savta-input-row">
    <textarea class="savta-input" id="savta-input" placeholder="Ask me anything!" rows="1" onkeydown="handleKey(event)" oninput="autoResize(this)"></textarea>
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
  if (day === 5) return "Habibi, welcome! And Shabbat is almost here — let me help you make something beautiful for the table. I am Savta Marsel, Niv's grandmother. Ask me anything! 🕯️";
  if (month === 9 || month === 10) return "Habibi, welcome! The High Holidays are here — the best time for cooking! I am Savta Marsel, Niv's grandmother. Ask me anything! 🍎";
  if (month === 12) return "Habibi, welcome! The kitchen smells like Hanukkah! I am Savta Marsel, Niv's grandmother. Ask me anything! 🕎";
  return "Habibi, welcome! I am Savta Marsel — Niv's grandmother, the one behind all these spices. Ask me anything! My kitchen is always open 🫙";
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
    ingredients: getTag("RECIPE_INGREDIENTS", text).split("\n").map(function(l){return l.replace(/^-\s*/,"").trim();}).filter(Boolean),
    steps: getTag("RECIPE_STEPS", text).split("\n").map(function(l){return l.replace(/^\d+\.\s*/,"").trim();}).filter(Boolean),
    tip: getTag("RECIPE_TIP", text),
    product: getTag("RECIPE_PRODUCT", text)
  };
}

function buildRecipeCard(r) {
  var card = document.createElement("div");
  card.className = "recipe-card";

  var header = document.createElement("div");
  header.className = "recipe-header";
  header.innerHTML = '<div class="recipe-title">' + r.title + '</div>' +
    (r.desc ? '<div class="recipe-desc">' + r.desc + '</div>' : '');
  card.appendChild(header);

  var body = document.createElement("div");
  body.className = "recipe-body";

  // Ingredients
  body.innerHTML += '<div class="recipe-section-label">Ingredients</div>';
  var ul = document.createElement("ul");
  ul.className = "recipe-ingredients";
  r.ingredients.forEach(function(ing) {
    var li = document.createElement("li");
    li.textContent = ing;
    ul.appendChild(li);
  });
  body.appendChild(ul);

  // Steps
  body.innerHTML += '<div class="recipe-section-label">How to make it</div>';
  var steps = document.createElement("div");
  steps.className = "recipe-steps";
  r.steps.forEach(function(s, i) {
    steps.innerHTML += '<div class="recipe-step"><div class="step-num">' + (i+1) + '</div><div class="step-text">' + s + '</div></div>';
  });
  body.appendChild(steps);

  // Tip
  if (r.tip) {
    var tip = document.createElement("div");
    tip.className = "recipe-tip";
    tip.style.marginTop = "12px";
    tip.textContent = r.tip;
    body.appendChild(tip);
  }

  // Buy button
  if (r.product) {
    var parts = r.product.split("|");
    var productName = parts[0] ? parts[0].trim() : "the spice";
    var productUrl = parts[1] ? parts[1].trim() : "https://savtasspices.com/collections/all";
    var btn = document.createElement("a");
    btn.className = "recipe-buy-btn";
    btn.href = productUrl;
    btn.target = "_blank";
    btn.textContent = "Get " + productName + " →";
    body.appendChild(btn);
  }

  card.appendChild(body);
  return card;
}

function renderText(text) {
  var recipeMatch = text.match(/\[RECIPE_START\][\s\S]*?\[RECIPE_END\]/);
  var wrap = document.createElement("div");

  if (recipeMatch) {
    var recipe = parseRecipe(recipeMatch[0]);
    var before = text.substring(0, text.indexOf("[RECIPE_START]")).trim();
    var after = text.substring(text.indexOf("[RECIPE_END]") + 12).trim();

    if (before) {
      before.split("\n\n").forEach(function(p) {
        if (p.trim()) { var el = document.createElement("p"); el.textContent = p.trim(); wrap.appendChild(el); }
      });
    }
    if (recipe) wrap.appendChild(buildRecipeCard(recipe));
    if (after) {
      after.split("\n\n").forEach(function(p) {
        if (p.trim()) { var el = document.createElement("p"); el.textContent = p.trim(); wrap.appendChild(el); }
      });
    }
  } else {
    text.split("\n\n").forEach(function(p) {
      if (p.trim()) { var el = document.createElement("p"); el.textContent = p.trim(); wrap.appendChild(el); }
    });
  }
  return wrap;
}

function addBotMsg(text) {
  var c = document.getElementById("savta-messages");
  var el = document.createElement("div");
  el.className = "msg bot";
  var avatar = document.createElement("div");
  avatar.className = "msg-mini-avatar";
  avatar.textContent = "👵";
  var bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.appendChild(renderText(text));
  el.appendChild(avatar);
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
  var avatar = document.createElement("div");
  avatar.className = "msg-mini-avatar";
  avatar.textContent = "👵";
  var bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.innerHTML = '<div class="typing-wrap"><div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div></div>';
  el.appendChild(avatar);
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
    var reply = data.reply || "Something got lost! Try again habibi.";
    addBotMsg(reply);
    chatHistory.push({ role: "assistant", content: reply });
  })
  .catch(function() {
    removeTyping();
    addBotMsg("Wallak, connection dropped! Try again habibi.");
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
