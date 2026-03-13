require("dotenv").config();
const express = require("express");
const app = express();

// ============================================================
// LAYER 0: TRUST PROXY (CRITICAL — fixes rate limiter on Render)
// Without this, req.ip returns Render's internal proxy IP for
// every user, making the rate limiter completely useless.
// ============================================================
app.set("trust proxy", 1);

// ============================================================
// LAYER 1: SECURITY HEADERS (Helmet)
// Adds ~12 HTTP headers that block clickjacking, MIME sniffing,
// XSS via browser, and hide server fingerprinting.
// ============================================================
const helmet = require("helmet");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"], // allows onclick, onsubmit etc in HTML
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "fonts.gstatic.com"],
      fontSrc: ["'self'", "fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ============================================================
// LAYER 2: CORS — lock API to savtasspices.com only
// Prevents any other website from calling your /api/chat
// and burning your Gemini quota for free.
// ============================================================
const cors = require("cors");
const ALLOWED_ORIGINS = [
  "https://savtasspices.com",
  "https://www.savtasspices.com",
  "https://savta-chatbot.onrender.com",
  // Add localhost for local dev only — remove in production if desired
  "http://localhost:3000",
  "http://localhost:5000",
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Render health checks, curl, etc.)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    console.warn(`[CORS BLOCKED] Origin rejected: ${origin}`);
    callback(new Error("Not allowed by CORS"));
  },
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: false,
}));

// ============================================================
// LAYER 3: BODY PARSING + PAYLOAD SIZE LIMIT
// 10kb max prevents large payload DoS attacks.
// ============================================================
app.use(express.json({ limit: "10kb" }));

// ============================================================
// LAYER 4: RATE LIMITER — Proper express-rate-limit package
// Replaces the custom in-memory version which had IP spoofing
// vulnerability and memory leak. This version:
// - Uses real client IP (trust proxy fixes this above)
// - Auto-cleans memory
// - Sends Retry-After header so legitimate clients know when to retry
// ============================================================
const rateLimit = require("express-rate-limit");

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,          // 1 minute window
  max: 10,                       // 10 requests per minute per IP
  standardHeaders: true,         // Return rate limit info in headers
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  message: { reply: "You're moving fast! Give Savta a minute to catch up — try again shortly." },
  handler: (req, res, next, options) => {
    console.warn(`[RATE LIMIT] IP blocked: ${req.ip} at ${new Date().toISOString()}`);
    res.status(429).json(options.message);
  },
  keyGenerator: (req) => {
    // Use X-Forwarded-For (real IP) — trust proxy setting above makes this safe
    return req.ip;
  },
});

// Stricter limiter for suspicious burst patterns (50 requests in 10 min = likely bot)
const burstLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,     // 10 minute window
  max: 50,                       // 50 requests per 10 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { reply: "Too many requests. Please come back in a little while!" },
  handler: (req, res, next, options) => {
    console.warn(`[BURST LIMIT] IP flagged: ${req.ip} at ${new Date().toISOString()}`);
    res.status(429).json(options.message);
  },
});

app.use("/api/chat", burstLimiter);
app.use("/api/chat", chatLimiter);

// ============================================================
// LAYER 5: XSS CLEANING — sanitize all incoming request bodies
// Strips <script> tags and other malicious HTML from user input
// before it ever touches your code or Gemini.
// ============================================================
const xss = require("xss-clean");
app.use(xss());

// ============================================================
// LAYER 6: INPUT VALIDATION MIDDLEWARE
// Validates message structure, length, and content before
// it reaches the Gemini API call. This is your last line of
// defense before tokens get spent.
// ============================================================
const MAX_MESSAGE_LENGTH = 2000;   // chars per message
const MAX_MESSAGES_IN_HISTORY = 20; // max history depth accepted
const MAX_TOTAL_CHARS = 8000;       // total payload char limit

function validateChatInput(req, res, next) {
  const { messages } = req.body;

  // Must be a non-empty array
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Invalid request format." });
  }

  // Reject if too many messages sent (history flood attack)
  if (messages.length > MAX_MESSAGES_IN_HISTORY) {
    console.warn(`[INPUT ABUSE] Too many messages from ${req.ip}: ${messages.length}`);
    return res.status(400).json({ error: "Too many messages in history." });
  }

  let totalChars = 0;

  for (const msg of messages) {
    // Each message must have role and content
    if (!msg || typeof msg.role !== "string" || typeof msg.content !== "string") {
      return res.status(400).json({ error: "Malformed message structure." });
    }

    // Role must be user or assistant only
    if (!["user", "assistant"].includes(msg.role)) {
      console.warn(`[INPUT ABUSE] Invalid role attempted from ${req.ip}: ${msg.role}`);
      return res.status(400).json({ error: "Invalid message role." });
    }

    // Per-message length cap
    if (msg.content.length > MAX_MESSAGE_LENGTH) {
      console.warn(`[INPUT ABUSE] Oversized message from ${req.ip}: ${msg.content.length} chars`);
      return res.status(400).json({ error: "Message too long. Please keep it under 2000 characters." });
    }

    totalChars += msg.content.length;
  }

  // Total payload char cap (catches distributed large messages)
  if (totalChars > MAX_TOTAL_CHARS) {
    console.warn(`[INPUT ABUSE] Total payload too large from ${req.ip}: ${totalChars} chars`);
    return res.status(400).json({ error: "Total conversation too large." });
  }

  next();
}

// ============================================================
// ENVIRONMENT VALIDATION
// Fail loudly at startup if config is missing — not silently
// at runtime when a user hits the endpoint.
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("FATAL: Missing GEMINI_API_KEY environment variable. Server will not process chat requests.");
}

// ============================================================
// SYSTEM PROMPT
// ============================================================
const SYSTEM_PROMPT = `You are Savta Marsel — the warm, loving grandmother behind Savta's Spices. You're a Jewish Moroccan grandmother with deep roots in home cooking and family tradition.

TONE:
- Warm, short, and to the point. Like a real grandmother texting you — not a lecture.
- You may use "Habibi" once at the start of a conversation as a warm greeting. After that — pure warm English. NO S'htein, NO Azizi, NO Omri, NO Wallak.
- Max 2-3 short paragraphs per response. Less is more.
- Never repeat yourself. Never over-explain.

FORMATTING RULES:
- Never use markdown: no **bold**, no *italic*, no [text](url) links, no raw URLs ever.
- Plain conversational text only, outside of the special tag blocks below.

RECIPE RULES — VERY IMPORTANT:
You have a real recipe database from the website. When someone asks for a recipe:
1. FIRST check if it matches one of the 12 recipes below. If yes, use that recipe exactly.
2. If no match, generate a recipe BUT add this note at the end (outside the recipe block): "I should mention — this one came from my heart, not the website. Niv hasn't tested it yet to give it his stamp of approval, so use your own judgment!"

RECIPE DATABASE (these are real, tested, approved recipes from savtasspices.com/blogs/news):

RECIPE 1: Yellow Curry with a Moroccan Twist
Spice: Shabbat Rice Blend
Description: A cozy, flavor-packed curry that brings together Moroccan spices with creamy yellow curry comfort.
Ingredients: 1 tbsp olive oil, 1 onion diced, 3 garlic cloves minced, 1 tbsp Savta's Shabbat Rice Blend, 1 tsp turmeric, 1 can coconut milk, 1 cup vegetable broth, 2 cups cauliflower florets, 1 can chickpeas drained, salt to taste, fresh cilantro to serve, rice to serve
Steps: 1. Heat olive oil in a large pan over medium heat. Sauté onion until soft, about 5 minutes. 2. Add garlic and cook 1 minute more. 3. Add Shabbat Rice Blend and turmeric, stir and toast for 30 seconds. 4. Pour in coconut milk and broth, stir well. 5. Add cauliflower and chickpeas. Simmer 20 minutes until cauliflower is tender. 6. Season with salt, top with cilantro, serve over rice.
Tip: The Shabbat Rice Blend is the secret — it adds that warm Moroccan depth you can't get from regular curry powder.
Product: Shabbat Rice Mix|https://savtasspices.com/products/shabbat-rice-mix
URL: https://savtasspices.com/blogs/news/yellow-curry-with-a-moroccan-twist

RECIPE 2: Eli's Ninja Creami Hummus
Spice: Za'atar or Everything but the Challah
Description: Ultra-smooth, creamy hummus made in the Ninja Creami, finished with Savta's spices.
Ingredients: 1 can chickpeas drained (save liquid), 3 tbsp tahini, 2 tbsp lemon juice, 1 garlic clove, 2 tbsp olive oil, salt to taste, ice cubes, Savta's Za'atar or Everything but the Challah for topping
Steps: 1. Add chickpeas, tahini, lemon juice, garlic, olive oil, salt and a few ice cubes to the Ninja Creami bowl. 2. Fill to the max line with chickpea liquid or water. 3. Freeze for 24 hours. 4. Process on smoothie bowl setting. 5. Re-process if needed until silky smooth. 6. Top generously with Za'atar or Everything but the Challah and a drizzle of olive oil.
Tip: The ice cubes are the trick — they make it extra fluffy and light. Don't skip them.
Product: Savta's Za'atar|https://savtasspices.com/products/savta-s-za-atar
URL: https://savtasspices.com/blogs/news/eli-s-ninja-creami-hummus-with-savta-s-spices

RECIPE 3: Meatballs with Potatoes and Peas
Spice: Ktzitzot Blend
Description: Classic Savta meatballs simmered in a Shabbat-style tomato sauce with potatoes and peas.
Ingredients: 500g ground beef, 2 tbsp Savta's Ktzitzot Blend, 1 egg, 2 tbsp breadcrumbs, 3 potatoes peeled and cubed, 1 cup frozen peas, 1 can crushed tomatoes, 1 onion diced, 3 garlic cloves, olive oil, salt, water
Steps: 1. Mix beef with Ktzitzot Blend, egg and breadcrumbs. Form into balls. 2. Brown meatballs in olive oil on all sides, set aside. 3. In the same pot, sauté onion and garlic until soft. 4. Add crushed tomatoes and a cup of water, stir. 5. Add potatoes and nestle meatballs in. 6. Cover and simmer 35 minutes. 7. Add peas in the last 5 minutes.
Tip: Don't rush the simmer — the longer it cooks, the better the sauce gets.
Product: Ktzitzot Blend|https://savtasspices.com/products/ktzitzut-blend
URL: https://savtasspices.com/blogs/news/meatballs-with-potatoes-and-peas

RECIPE 4: One-Pan Chicken & Ptitim
Spice: Shabbat Rice Blend
Description: Chicken thighs and Israeli couscous cooked together in one pan with deep Shabbat flavor.
Ingredients: 4 chicken thighs bone-in, 2 tbsp Savta's Shabbat Rice Blend, 1.5 cups ptitim (Israeli couscous), 1 onion diced, 3 garlic cloves, 2 cups chicken broth, 1 tbsp olive oil, salt
Steps: 1. Season chicken generously with Shabbat Rice Blend and salt. 2. Sear chicken skin-side down in olive oil until golden, about 7 minutes. Flip, cook 3 more minutes. Set aside. 3. In the same pan, sauté onion and garlic 3 minutes. 4. Add ptitim, stir to coat. 5. Pour in broth. Nestle chicken on top. 6. Cover and cook on low 25 minutes until ptitim is cooked and chicken is done.
Tip: Use the same pan throughout — all those chicken drippings flavor the ptitim beautifully.
Product: Shabbat Rice Mix|https://savtasspices.com/products/shabbat-rice-mix
URL: https://savtasspices.com/blogs/news/one-pan-chicken-ptitim-with-shabbat-rice-blend

RECIPE 5: Sourdough with Everything but the Challah
Spice: Everything but the Challah
Description: Crusty sourdough with a savory, herby Everything but the Challah topping baked right into the crust.
Ingredients: 1 sourdough loaf (store bought or homemade), 2 tbsp olive oil, 2 tbsp Savta's Everything but the Challah blend, flaky sea salt
Steps: 1. Preheat oven to 400°F (200°C). 2. Score the top of the loaf with a sharp knife. 3. Brush generously with olive oil. 4. Sprinkle Everything but the Challah over the top, pressing lightly. 5. Add a pinch of flaky salt. 6. Bake 15-20 minutes until crust is crispy and golden.
Tip: Works incredible with a store-bought loaf too — don't let anyone tell you otherwise.
Product: Everything but the Challah|https://savtasspices.com/products/everything-but-the-challah
URL: https://savtasspices.com/blogs/news/sourdough-bread-with-everything-but-the-challah

RECIPE 6: Savta's Smash Burger
Spice: Ktzitzot Blend
Description: Juicy, crispy smash burgers with Savta's twist, served in a tortilla.
Ingredients: 400g ground beef (80/20), 1.5 tbsp Savta's Ktzitzot Blend, salt, 2 flour tortillas, sliced cheese, pickles, lettuce, tomato, mayo or sauce of choice
Steps: 1. Mix beef with Ktzitzot Blend and a pinch of salt. Divide into 4 balls. 2. Heat a cast iron pan or heavy skillet very hot. 3. Place a ball on the pan, immediately smash flat with a spatula. Press hard. 4. Cook 2 minutes until edges are crispy. Flip, add cheese. Cook 1 more minute. 5. Stack two patties per tortilla. Add toppings. Fold and eat.
Tip: The pan needs to be smoking hot — that's what gives you the crispy edges.
Product: Ktzitzot Blend|https://savtasspices.com/products/ktzitzut-blend
URL: https://savtasspices.com/blogs/news/savta-s-smash-burger

RECIPE 7: Savta's One-Pan Chicken Shawarma
Spice: Ktzitzot Blend + Everything but the Challah
Description: Real shawarma flavor at home, one pan, done in under 30 minutes.
Ingredients: 600g chicken thighs boneless, 1.5 tbsp Savta's Ktzitzot Blend, 1 tbsp Savta's Everything but the Challah, 2 tbsp olive oil, salt, pita or laffa to serve, tahini, parsley, onion
Steps: 1. Slice chicken thighs into strips. 2. Mix with both spice blends, olive oil and salt. Marinate 10 minutes minimum. 3. Heat pan on high. Cook chicken strips in a single layer without touching. 4. Let them sear 3-4 minutes before flipping — you want color and crispiness. 5. Cook until done, about 8 minutes total. 6. Serve in pita with tahini, parsley and raw onion.
Tip: Don't crowd the pan — cook in batches if needed. Crowding = steaming, not searing.
Product: Ktzitzot Blend|https://savtasspices.com/products/ktzitzut-blend
URL: https://savtasspices.com/blogs/news/savta-s-one-pan-chicken-shawarma

RECIPE 8: Savta's Roasted Pumpkin and Chestnuts
Spice: Tipa Spicy Red Sauce
Description: Warm roasted pumpkin with sweet chestnuts and gentle spice — a cozy fall dish.
Ingredients: 1 small pumpkin or butternut squash cubed, 1 cup cooked chestnuts, 2 tbsp olive oil, 1.5 tbsp Savta's Tipa Spicy Red Sauce Blend, salt, honey for drizzling
Steps: 1. Preheat oven to 425°F (220°C). 2. Toss pumpkin cubes with olive oil, Tipa Blend and salt. 3. Spread on a baking sheet in a single layer. 4. Roast 25 minutes, turning once halfway. 5. Add chestnuts in the last 10 minutes. 6. Drizzle with a little honey right before serving.
Tip: The honey at the end is the move — it balances the spice beautifully.
Product: Tipa Spicy Red Sauce|https://savtasspices.com/products/ktzat-spicy-red-sauce
URL: https://savtasspices.com/blogs/news/savta-s-roasted-pumpkin-and-chestnuts

RECIPE 9: Tipa Spicy Autumn Soup
Spice: Tipa Spicy Red Sauce
Description: Silky butternut squash and carrot soup with warm spice and deep color.
Ingredients: 1 butternut squash peeled and cubed, 3 carrots peeled and chopped, 1 onion diced, 3 garlic cloves, 2 tbsp Savta's Tipa Spicy Red Sauce Blend, 4 cups vegetable broth, 2 tbsp olive oil, salt, sour cream or yogurt to serve
Steps: 1. Heat olive oil in a large pot. Sauté onion and garlic until soft. 2. Add Tipa Blend, stir and cook 1 minute. 3. Add squash, carrots and broth. Bring to a boil. 4. Reduce heat, cover and simmer 25 minutes until everything is very soft. 5. Blend until completely smooth. 6. Season with salt. Serve with a swirl of sour cream.
Tip: The blend gives it that beautiful deep orange color — and a gentle kick that sneaks up on you.
Product: Tipa Spicy Red Sauce|https://savtasspices.com/products/ktzat-spicy-red-sauce
URL: https://savtasspices.com/blogs/news/tipa-spicy-autumn-soup

RECIPE 10: Sivan's Healthy Rice
Spice: Shabbat Rice Blend
Description: A hearty, wholesome bowl with quinoa, lentils and Shabbat Rice Blend.
Ingredients: 1 cup white rice, 1/2 cup quinoa, 1/2 cup green or brown lentils, 2 tbsp Savta's Shabbat Rice Blend, 3.5 cups water or broth, 1 tbsp olive oil, salt, caramelized onions to top
Steps: 1. Rinse rice, quinoa and lentils well. 2. Heat olive oil in a pot. Add Shabbat Rice Blend and toast 30 seconds. 3. Add the rinsed grains and lentils, stir to coat. 4. Pour in broth. Bring to a boil. 5. Cover and cook on low 20-25 minutes until liquid is absorbed. 6. Fluff with a fork. Top with caramelized onions.
Tip: Caramelize the onions low and slow — 20 minutes minimum. They make the whole dish.
Product: Shabbat Rice Mix|https://savtasspices.com/products/shabbat-rice-mix
URL: https://savtasspices.com/blogs/news/sivans-healthy-rice

RECIPE 11: Everything with the Challah Stuffing
Spice: Everything but the Challah
Description: Golden, savory challah stuffing with crispy edges and soft center — a showstopper side.
Ingredients: 1 loaf stale challah torn into chunks, 1 onion diced, 3 celery stalks diced, 3 tbsp Savta's Everything but the Challah blend, 2 eggs, 1.5 cups chicken or vegetable broth, 3 tbsp butter or olive oil, salt
Steps: 1. Preheat oven to 375°F (190°C). 2. Sauté onion and celery in butter until soft, about 8 minutes. 3. In a large bowl, combine challah chunks, sautéed vegetables and Everything but the Challah. 4. Whisk eggs with broth, pour over challah. Toss well. 5. Transfer to a greased baking dish. 6. Bake 35-40 minutes until top is golden and crispy.
Tip: The more stale the challah, the better it absorbs everything. Day-old is perfect.
Product: Everything but the Challah|https://savtasspices.com/products/everything-but-the-challah
URL: https://savtasspices.com/blogs/news/everything-with-the-challah-stuffing

RECIPE 12: Savta's Feta and Tomato Party Stealer
Spice: Za'atar or Everything but the Challah
Description: Roasted cherry tomatoes with a block of feta, finished with Savta's spices — perfect for gatherings.
Ingredients: 500g cherry tomatoes, 200g block feta cheese, 3 tbsp olive oil, 2 tbsp Savta's Za'atar, 2 garlic cloves sliced, fresh thyme (optional), crusty bread to serve
Steps: 1. Preheat oven to 400°F (200°C). 2. Place cherry tomatoes in a baking dish. Add garlic and thyme. 3. Drizzle with 2 tbsp olive oil. 4. Nestle the feta block in the center. Drizzle remaining oil over feta. 5. Sprinkle Za'atar generously over everything. 6. Roast 25-30 minutes until tomatoes burst and feta is golden. 7. Serve immediately with crusty bread for dipping.
Tip: Put this in the middle of the table and watch it disappear in 5 minutes. Every time.
Product: Savta's Za'atar|https://savtasspices.com/products/savta-s-za-atar
URL: https://savtasspices.com/blogs/news/savta-s-feta-and-tomato-party-stealer

SEASONAL AWARENESS:
- On Fridays mention Shabbat is coming and suggest the Shabbat Rice Mix warmly
- On Jewish holidays reference them naturally

SPICE QUIZ:
If someone asks what to buy or needs help choosing, ask 3 quick questions one at a time:
1. "What do you cook most — fish, chicken, meat, or rice?"
2. "Mild and fragrant, or bold and spicy?"
3. "For yourself or a gift?"
Then recommend with a [REC] block.

GIFT BOXES:
- The Tasting Box ($30): Pick ANY 3 blends. Perfect intro or thoughtful gift. Comes in a signature gift box.
- The Full Flavor Box ($50): All 6 blends — Moroccan Fish Blend, Tipa Spicy Red Sauce, Ktzitzot Blend, Shabbat Rice Mix, Savta's Za'atar, Everything but the Challah. The complete Shabbat kitchen.
- The Deluxe Flavor Box ($90): Everything. Currently sold out — suggest Full Flavor Box instead.

RECOMMENDATION FORMAT:
[REC_START]
[REC_TITLE]Product Name[/REC_TITLE]
[REC_PRICE]$XX[/REC_PRICE]
[REC_DESC]One warm sentence about why this fits them.[/REC_DESC]
[REC_REASON]One personal note from Savta.[/REC_REASON]
[REC_URL]https://savtasspices.com/products/product-slug[/REC_URL]
[REC_END]

RECIPE FORMAT:
[RECIPE_START]
[RECIPE_TITLE]Dish name[/RECIPE_TITLE]
[RECIPE_DESC]One warm sentence[/RECIPE_DESC]
[RECIPE_INGREDIENTS]
- ingredient
[/RECIPE_INGREDIENTS]
[RECIPE_STEPS]
1. step
[/RECIPE_STEPS]
[RECIPE_TIP]Savta's tip[/RECIPE_TIP]
[RECIPE_PRODUCT]product name|product url[/RECIPE_PRODUCT]
[RECIPE_END]

PRODUCTS & URLS:
Everything but the Challah $10: https://savtasspices.com/products/everything-but-the-challah
Ktzitzot Blend $10: https://savtasspices.com/products/ktzitzut-blend
Moroccan Fish Blend $10: https://savtasspices.com/products/moroccan-fish-blend
Savta's Za'atar $8: https://savtasspices.com/products/savta-s-za-atar
Shabbat Rice Mix $10: https://savtasspices.com/products/shabbat-rice-mix
Tipa Spicy Red Sauce $10: https://savtasspices.com/products/ktzat-spicy-red-sauce
The Tasting Box $30: https://savtasspices.com/products/the-tasting-box
The Full Flavor Box $50: https://savtasspices.com/products/savta-s-shabbat-kit-1
The Deluxe Flavor Box $90 (sold out): https://savtasspices.com/products/savta-x-romano-the-holiday-box
Shop all: https://savtasspices.com/collections/all

FAQ: Made in New York, small batches, organic and fair trade. Kosher suppliers, not officially certified yet. US shipping only. Questions: hello@savtasspices.com

If you don't know something: "Not sure about that one — email hello@savtasspices.com and Niv will sort you out!"`;

// ============================================================
// LAYER 7: GEMINI API CALL WITH TIMEOUT
// FIX: Correct model name — gemini-3.1-flash-lite-preview
// (the model is still in preview; omitting "-preview" causes 404/500)
// AbortController kills the request if Gemini doesn't respond
// within 25 seconds. Prevents hanging connections.
// ============================================================
async function callGemini(contents) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 second timeout

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=" + GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: { temperature: 0.75, maxOutputTokens: 2000 }
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);

    // FIX: Check HTTP status before trying to parse JSON
    // A non-2xx response (404, 429, 500 from Gemini) would previously
    // parse as JSON but contain an error object — now we catch it clearly.
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini HTTP ${response.status}: ${errorText.slice(0, 200)}`);
    }

    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("TIMEOUT: Gemini API took too long to respond.");
    }
    throw err;
  }
}

// ============================================================
// LAYER 8: CHAT ENDPOINT
// All security layers above run before this is ever reached.
// ============================================================
app.post("/api/chat", validateChatInput, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ reply: "Kitchen not set up yet — check back soon!" });
  }

  try {
    const { messages } = req.body;

    // Trim history to last 12 exchanges and sanitize roles
    const contents = messages.slice(-12).map(m => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: String(m.content).trim() }]
    }));

    const geminiRes = await callGemini(contents);
    const data = await geminiRes.json();

    if (data.error) {
      console.error("[GEMINI ERROR]", data.error.message);
      throw new Error(data.error.message);
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Something got lost — try again!";
    res.json({ reply });

  } catch (err) {
    const isTimeout = err.message?.includes("TIMEOUT");
    console.error(`[CHAT ERROR] ${isTimeout ? "Timeout" : "API Error"}: ${err.message}`);
    res.status(isTimeout ? 504 : 500).json({
      reply: isTimeout
        ? "Savta is thinking a little too hard — try again in a moment!"
        : "Something went wrong on my end. Try again in a moment!"
    });
  }
});

// ============================================================
// HEALTH CHECK ENDPOINT
// Render uses this to verify the app is alive.
// Also useful for uptime monitors like UptimeRobot (free).
// ============================================================
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    gemini: GEMINI_API_KEY ? "configured" : "MISSING",
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// SERVE FRONTEND (HTML embedded at build time by build script)
// FIX: Duplicate `var block` declaration in renderText() caused
// a strict-mode JS error in some environments. Renamed to
// recipeBlock / recBlock to avoid the redeclaration.
// FIX: [REC_END] slice offset corrected from +9 to +11
// (tag is 9 chars but we need to include it fully in the slice).
// FIX: Frontend fetch now wraps r.json() in try/catch so a
// non-JSON error response doesn't throw an uncaught exception.
// FIX: chatHistory trimmed to last 40 entries client-side to
// prevent unbounded memory growth on long sessions.
// ============================================================
const HTML_CONTENT = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\"/>\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>\n<title>Savta's Spices</title>\n<link href=\"https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400;1,700&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&family=Lora:ital,wght@0,400;0,600;1,400;1,600&display=swap\" rel=\"stylesheet\">\n<style>\n*{box-sizing:border-box;margin:0;padding:0}\n:root{\n  --cream:#faf7f2;\n  --warm-white:#fffdf9;\n  --red:#7a2318;\n  --red-light:#c0392b;\n  --gold:#f59e0b;\n  --brown:#2c1a0e;\n  --brown-mid:#7a6a5a;\n  --border:#e8d5c0;\n  --bg-tint:#fff8f0;\n  --parchment:#fdf6e9;\n}\nbody{font-family:\"DM Sans\",sans-serif;background:var(--cream);color:var(--brown);min-height:100vh;}\n.page{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:0 20px 120px;}\n.hero{text-align:center;padding:64px 20px 48px;max-width:680px;width:100%;}\n.hero h1{font-family:\"Playfair Display\",serif;font-size:clamp(38px,6vw,62px);color:var(--red);line-height:1.1;letter-spacing:-1px;margin-bottom:16px;}\n.hero h1 em{font-style:italic;color:var(--brown);}\n.hero p{font-size:16px;color:var(--brown-mid);line-height:1.7;margin-bottom:32px;}\n.hero-badge{display:inline-flex;align-items:center;gap:7px;padding:6px 16px;border-radius:999px;background:rgba(122,35,24,0.08);border:1px solid rgba(122,35,24,0.18);font-size:12px;font-weight:600;color:var(--red);letter-spacing:0.5px;text-transform:uppercase;margin-bottom:22px;}\n.features{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-bottom:48px;}\n.feature-pill{display:flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;background:var(--warm-white);border:1px solid var(--border);font-size:13px;font-weight:500;color:var(--brown);}\n\n#savta-bubble{position:fixed;bottom:28px;right:28px;width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#7a2318,#c0392b);box-shadow:0 8px 32px rgba(122,35,24,0.5);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:9999;border:none;outline:none;transition:transform 0.2s;overflow:hidden;}\n#savta-bubble:hover{transform:scale(1.1);}\n#savta-bubble img{width:100%;height:100%;object-fit:cover;object-position:center top;border-radius:50%;}\n.bubble-ping{position:absolute;top:0;right:0;width:18px;height:18px;border-radius:50%;background:var(--gold);border:2.5px solid var(--cream);animation:ping 2.5s ease-in-out infinite;}\n@keyframes ping{0%,100%{transform:scale(1);opacity:1}60%{transform:scale(1.5);opacity:0.5}}\n\n#savta-window{position:fixed;bottom:122px;right:28px;width:400px;max-width:calc(100vw - 40px);height:600px;max-height:calc(100vh - 146px);background:var(--warm-white);border-radius:26px;box-shadow:0 40px 100px rgba(0,0,0,0.2);display:flex;flex-direction:column;z-index:9998;overflow:hidden;transform:scale(0.88) translateY(24px);opacity:0;pointer-events:none;transition:transform 0.32s cubic-bezier(0.34,1.56,0.64,1),opacity 0.24s;transform-origin:bottom right;}\n#savta-window.open{transform:scale(1) translateY(0);opacity:1;pointer-events:all;}\n\n.savta-header{background:linear-gradient(135deg,#7a2318,#c0392b);padding:18px;display:flex;align-items:center;gap:12px;flex-shrink:0;}\n.savta-avatar{width:48px;height:48px;border-radius:50%;border:2px solid rgba(255,255,255,0.3);overflow:hidden;flex-shrink:0;}\n.savta-avatar img{width:100%;height:100%;object-fit:cover;object-position:center top;}\n.savta-name{font-family:\"Playfair Display\",serif;font-size:17px;font-weight:700;color:#fff;}\n.savta-status{font-size:11px;color:rgba(255,255,255,0.75);margin-top:3px;display:flex;align-items:center;gap:5px;}\n.status-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;animation:pulse 2s infinite;}\n@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}\n.savta-close{width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.2);color:#fff;font-size:14px;cursor:pointer;margin-left:auto;font-family:inherit;transition:background 0.15s;}\n.savta-close:hover{background:rgba(255,255,255,0.25);}\n\n.quick-prompts{padding:10px 12px 8px;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid var(--border);background:var(--bg-tint);}\n.quick-btn{padding:5px 11px;border-radius:999px;background:#fff;border:1px solid var(--border);color:var(--red);font-size:11.5px;font-weight:600;font-family:\"DM Sans\",sans-serif;cursor:pointer;white-space:nowrap;transition:all 0.15s;}\n.quick-btn:hover{background:var(--red);color:#fff;border-color:var(--red);}\n\n.savta-messages{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;}\n.savta-messages::-webkit-scrollbar{width:4px;}\n.savta-messages::-webkit-scrollbar-track{background:transparent;}\n.savta-messages::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}\n\n.msg{display:flex;gap:8px;align-items:flex-end;animation:msgIn 0.25s ease;}\n@keyframes msgIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}\n.msg.user{flex-direction:row-reverse;}\n.msg-mini-avatar{width:28px;height:28px;border-radius:50%;overflow:hidden;flex-shrink:0;}\n.msg-mini-avatar img{width:100%;height:100%;object-fit:cover;object-position:center top;}\n.msg-bubble{max-width:82%;padding:11px 14px;font-size:13.5px;line-height:1.65;font-family:\"DM Sans\",sans-serif;}\n.msg-bubble p{margin:0 0 8px;}\n.msg-bubble p:last-child{margin-bottom:0;}\n.msg.bot .msg-bubble{background:#fff;color:var(--brown);border-radius:18px 18px 18px 4px;box-shadow:0 2px 10px rgba(0,0,0,0.07);border:1px solid #f0e8dc;}\n.msg.user .msg-bubble{background:linear-gradient(135deg,#7a2318,#a0341f);color:#fff;border-radius:18px 18px 4px 18px;}\n.msg-bubble a{color:var(--red);font-weight:700;text-decoration:underline;}\n\n/* RECIPE CARD */\n.recipe-card{background:var(--parchment);border:1px solid #dcc9a0;border-radius:16px;overflow:hidden;margin:4px 0;box-shadow:0 6px 28px rgba(44,26,14,0.12);font-family:\"Lora\",serif;}\n.recipe-header{background:linear-gradient(160deg,#7a2318 0%,#9b2d20 60%,#7a2318 100%);padding:20px 20px 16px;text-align:center;}\n.recipe-header-stars{display:block;font-size:9px;letter-spacing:6px;color:rgba(255,255,255,0.4);margin-bottom:10px;font-family:\"DM Sans\",sans-serif;}\n.recipe-header-stars-bottom{display:block;font-size:9px;letter-spacing:6px;color:rgba(255,255,255,0.4);margin-top:10px;font-family:\"DM Sans\",sans-serif;}\n.recipe-title{font-family:\"Playfair Display\",serif;font-size:19px;font-weight:700;font-style:italic;color:#fff;letter-spacing:0.3px;line-height:1.25;}\n.recipe-desc{font-size:12px;color:rgba(255,255,255,0.82);line-height:1.55;font-family:\"DM Sans\",sans-serif;margin-top:6px;}\n.recipe-divider{display:flex;align-items:center;gap:10px;padding:14px 18px 0;color:#b8905a;font-size:9px;letter-spacing:4px;font-family:\"DM Sans\",sans-serif;text-transform:uppercase;}\n.recipe-divider::before,.recipe-divider::after{content:\"\";flex:1;height:1px;background:linear-gradient(to right,transparent,#d4b896,transparent);}\n.recipe-body{padding:14px 0 16px;}\n.recipe-section-label{font-family:\"DM Sans\",sans-serif;font-size:9.5px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9b6a3a;margin-bottom:10px;margin-top:16px;display:flex;align-items:center;gap:8px;padding:0 18px;}\n.recipe-section-label:first-of-type{margin-top:0;}\n.recipe-section-label::after{content:\"\";flex:1;height:1px;background:#e2c9a4;}\n.recipe-ingredients{list-style:none;display:flex;flex-direction:column;gap:3px;padding:0 18px;}\n.recipe-ingredients li{font-size:13px;color:var(--brown);padding:6px 10px 6px 14px;position:relative;line-height:1.45;border-bottom:1px dashed #e8d5b8;font-family:\"Lora\",serif;}\n.recipe-ingredients li:last-child{border-bottom:none;}\n.recipe-ingredients li::before{content:\"\u2022\";position:absolute;left:2px;color:#c0784a;font-size:15px;line-height:1.2;}\n.recipe-steps{display:flex;flex-direction:column;gap:10px;padding:0 18px;}\n.recipe-step{display:flex;gap:12px;align-items:flex-start;}\n.step-num{width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#7a2318,#c0392b);color:#fff;font-size:11px;font-weight:700;font-family:\"DM Sans\",sans-serif;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;box-shadow:0 2px 6px rgba(122,35,24,0.3);}\n.step-text{font-size:13px;color:var(--brown);line-height:1.6;font-family:\"Lora\",serif;padding-top:2px;}\n.recipe-tip-wrap{padding:0 18px;}\n.recipe-tip{background:linear-gradient(135deg,rgba(245,158,11,0.08),rgba(249,115,22,0.06));border:1px solid rgba(245,158,11,0.35);border-left:3px solid var(--gold);border-radius:10px;padding:10px 14px;font-size:12.5px;color:#7a5020;line-height:1.55;font-family:\"DM Sans\",sans-serif;font-style:italic;margin-top:16px;}\n.recipe-tip-label{font-weight:700;font-style:normal;color:#9b6a2a;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;display:block;margin-bottom:4px;}\n.recipe-buy-wrap{padding:14px 18px 0;}\n.recipe-buy-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px;background:linear-gradient(135deg,#5a1810,#7a2318);color:#ffffff !important;font-size:14px;font-weight:800;font-family:\"DM Sans\",sans-serif;border:none;border-radius:12px;cursor:pointer;text-align:center;text-decoration:none;transition:all 0.2s;letter-spacing:0.8px;text-transform:uppercase;box-shadow:0 4px 18px rgba(122,35,24,0.45);}\n.recipe-buy-btn:hover{background:linear-gradient(135deg,#7a2318,#c0392b);transform:translateY(-2px);box-shadow:0 8px 24px rgba(122,35,24,0.55);}\n\n.rec-card{background:var(--parchment);border:1px solid #dcc9a0;border-radius:16px;overflow:hidden;margin:4px 0;box-shadow:0 6px 28px rgba(44,26,14,0.12);}\n.rec-header{background:linear-gradient(135deg,#7a2318,#9b2d20);padding:16px 18px 14px;text-align:center;}\n.rec-icon{font-size:28px;display:block;margin-bottom:6px;}\n.rec-title{font-family:\"Playfair Display\",serif;font-size:18px;font-weight:700;font-style:italic;color:#fff;line-height:1.2;}\n.rec-price{font-family:\"DM Sans\",sans-serif;font-size:13px;color:rgba(255,255,255,0.75);margin-top:4px;font-weight:600;letter-spacing:0.5px;}\n.rec-body{padding:14px 18px 16px;display:flex;flex-direction:column;gap:10px;}\n.rec-desc{font-family:\"Lora\",serif;font-size:13.5px;color:var(--brown);line-height:1.6;}\n.rec-reason{background:linear-gradient(135deg,rgba(245,158,11,0.08),rgba(249,115,22,0.06));border:1px solid rgba(245,158,11,0.35);border-left:3px solid var(--gold);border-radius:10px;padding:10px 14px;font-size:12.5px;color:#7a5020;line-height:1.55;font-family:\"DM Sans\",sans-serif;font-style:italic;}\n.rec-reason-label{font-weight:700;font-style:normal;color:#9b6a2a;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;display:block;margin-bottom:4px;}\n.rec-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px;background:linear-gradient(135deg,#5a1810,#7a2318);color:#ffffff !important;font-size:14px;font-weight:800;font-family:\"DM Sans\",sans-serif;border:none;border-radius:12px;cursor:pointer;text-align:center;text-decoration:none;transition:all 0.2s;letter-spacing:0.8px;text-transform:uppercase;box-shadow:0 4px 18px rgba(122,35,24,0.45);}\n.rec-btn:hover{background:linear-gradient(135deg,#7a2318,#c0392b);transform:translateY(-2px);box-shadow:0 8px 24px rgba(122,35,24,0.55);}\n\n.typing-wrap{display:flex;gap:4px;align-items:center;padding:4px 2px;}\n.t-dot{width:7px;height:7px;border-radius:50%;background:#c0a080;animation:tdot 1.2s infinite ease-in-out;}\n.t-dot:nth-child(2){animation-delay:.18s}\n.t-dot:nth-child(3){animation-delay:.36s}\n@keyframes tdot{0%,80%,100%{transform:translateY(0);opacity:0.4}40%{transform:translateY(-7px);opacity:1}}\n\n.savta-input-row{padding:11px 13px 13px;border-top:1px solid #f0e8dc;background:var(--warm-white);display:flex;gap:9px;align-items:flex-end;flex-shrink:0;}\n.savta-input{flex:1;padding:10px 14px;border-radius:14px;border:1.5px solid var(--border);background:#fff;font-size:13.5px;font-family:\"DM Sans\",sans-serif;color:var(--brown);outline:none;resize:none;max-height:100px;min-height:42px;line-height:1.5;transition:border-color 0.15s;}\n.savta-input:focus{border-color:var(--red);}\n.savta-input::placeholder{color:#c0a880;}\n.savta-send{width:42px;height:42px;border-radius:13px;background:linear-gradient(135deg,#7a2318,#c0392b);border:none;color:white;font-size:17px;cursor:pointer;flex-shrink:0;transition:opacity 0.15s;}\n.savta-send:disabled{opacity:0.45;cursor:not-allowed;}\n.savta-footer-brand{text-align:center;padding:5px 0 9px;font-size:10px;color:#c0a880;font-weight:500;flex-shrink:0;}\n.savta-footer-brand a{color:var(--red);text-decoration:none;font-weight:600;}\n\n@media(max-width:480px){\n  #savta-window{right:12px;bottom:96px;width:calc(100vw - 24px);}\n  #savta-bubble{right:18px;bottom:20px;}\n}\n</style>\n</head>\n<body>\n\n<div class=\"page\">\n  <div class=\"hero\">\n    <div class=\"hero-badge\">\ud83e\uded9 Live Demo</div>\n    <h1>Meet <em>Savta</em><br>Marsel</h1>\n    <p>The AI grandmother behind Savta's Spices. Warm, welcoming, and always in the kitchen.</p>\n    <div class=\"features\">\n      <div class=\"feature-pill\">\ud83d\udc75 Grandmotherly warmth</div>\n      <div class=\"feature-pill\">\ud83c\udf73 Full recipes on demand</div>\n      <div class=\"feature-pill\">\ud83e\uded9 Product recommendations</div>\n      <div class=\"feature-pill\">\ud83d\udce6 Shipping and orders</div>\n    </div>\n  </div>\n</div>\n\n<button id=\"savta-bubble\" onclick=\"toggleSavta()\" aria-label=\"Chat with Savta\">\n  <img id=\"savta-bubble-img\" src=\"\" alt=\"Savta Marsel\" />\n  <span class=\"bubble-ping\"></span>\n</button>\n\n<div id=\"savta-window\">\n  <div class=\"savta-header\">\n    <div class=\"savta-avatar\">\n      <img id=\"savta-header-img\" src=\"\" alt=\"Savta Marsel\" />\n    </div>\n    <div>\n      <div class=\"savta-name\">Savta Marsel</div>\n      <div class=\"savta-status\"><span class=\"status-dot\"></span>In the kitchen, ready for you</div>\n    </div>\n    <button class=\"savta-close\" onclick=\"toggleSavta()\">&#x2715;</button>\n  </div>\n  <div class=\"quick-prompts\" id=\"quick-prompts\">\n    <button class=\"quick-btn\" onclick=\"sendQuick('What spice blends do you sell?')\">&#x1F9D0; Our Blends</button>\n    <button class=\"quick-btn\" onclick=\"sendQuick('Give me a Shabbat dinner recipe!')\">&#x1F37D;&#xFE0F; Recipes</button>\n    <button class=\"quick-btn\" onclick=\"sendQuick('Help me choose the right spice for me')\">&#x2728; Find My Spice</button>\n    <button class=\"quick-btn\" onclick=\"sendQuick('Are your spices kosher?')\">Kosher?</button>\n    <button class=\"quick-btn\" onclick=\"sendQuick('Tell me about your gift boxes \u2014 what\\'s the difference between the Tasting Box, Full Flavor Box, and Deluxe Flavor Box?')\">&#x1F381; Gifts</button>\n    <button class=\"quick-btn\" onclick=\"sendQuick('Tell me the story behind Savta Marsel and these spices')\">&#x1F49B; Our Story</button>\n  </div>\n  <div class=\"savta-messages\" id=\"savta-messages\"></div>\n  <div class=\"savta-input-row\">\n    <textarea class=\"savta-input\" id=\"savta-input\" placeholder=\"Ask me anything about spices, recipes, or orders...\" rows=\"1\" onkeydown=\"handleKey(event)\" oninput=\"autoResize(this)\"></textarea>\n    <button class=\"savta-send\" id=\"savta-send-btn\" onclick=\"sendMessage()\">&#9658;</button>\n  </div>\n  <div class=\"savta-footer-brand\">Powered by <a href=\"https://savtasspices.com\" target=\"_blank\">Savta's Spices</a> &#x1F9D0;</div>\n</div>\n\n<script>\n// Avatar image (base64)\nvar AVATAR_B64 = \"data:image/png;base64,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\";\n\ndocument.getElementById(\"savta-bubble-img\").src = AVATAR_B64;\ndocument.getElementById(\"savta-header-img\").src = AVATAR_B64;\n\nvar isOpen = false;\nvar isLoading = false;\nvar chatHistory = [];\nvar greeted = false;\n\nfunction getSeasonalGreeting() {\n  var now = new Date();\n  var month = now.getMonth() + 1;\n  var day = now.getDay();\n  if (day === 5) return \"Welcome, welcome! Come on in \u2014 Shabbat is almost here and there's so much to cook. I'm Savta Marsel. What can I help you make tonight? \ud83e\udec6\";\n  if (month === 9 || month === 10) return \"Welcome! The holidays are here and the kitchen is calling. I'm Savta Marsel \u2014 so glad you stopped by. Ask me anything! \ud83e\udec6\";\n  if (month === 12) return \"Welcome in from the cold! The kitchen is warm and so am I. I\u2019m Savta Marsel. What can I help you cook up today? \ud83e\udec6\";\n  return \"Welcome! I'm so glad you stopped by. I'm Savta Marsel. Pull up a chair and tell me what you're cooking \u2014 my kitchen is always open. \ud83e\udec6\";\n}\n\nfunction toggleSavta() {\n  isOpen = !isOpen;\n  var win = document.getElementById(\"savta-window\");\n  if (isOpen) {\n    win.classList.add(\"open\");\n    if (!greeted) {\n      greeted = true;\n      setTimeout(function() { addBotMsg(getSeasonalGreeting()); }, 400);\n    }\n    setTimeout(function() { document.getElementById(\"savta-input\").focus(); }, 350);\n  } else {\n    win.classList.remove(\"open\");\n  }\n}\n\nfunction parseRecipe(text) {\n  if (text.indexOf(\"[RECIPE_START]\") === -1) return null;\n  function getTag(tag, t) {\n    var re = new RegExp(\"\\\\[\" + tag + \"\\\\]([\\\\s\\\\S]*?)\\\\[\\\\/\" + tag + \"\\\\]\");\n    var m = t.match(re);\n    return m ? m[1].trim() : \"\";\n  }\n  return {\n    title: getTag(\"RECIPE_TITLE\", text),\n    desc: getTag(\"RECIPE_DESC\", text),\n    ingredients: getTag(\"RECIPE_INGREDIENTS\", text).split(\"\\n\").map(function(l){ return l.replace(/^-\\s*/, \"\").trim(); }).filter(Boolean),\n    steps: getTag(\"RECIPE_STEPS\", text).split(\"\\n\").map(function(l){ return l.replace(/^\\d+\\.\\s*/, \"\").trim(); }).filter(Boolean),\n    tip: getTag(\"RECIPE_TIP\", text),\n    product: getTag(\"RECIPE_PRODUCT\", text)\n  };\n}\n\nfunction escHtml(str) {\n  var d = document.createElement(\"div\");\n  d.appendChild(document.createTextNode(str || \"\"));\n  return d.innerHTML;\n}\n\nfunction buildRecipeCard(r) {\n  var card = document.createElement(\"div\");\n  card.className = \"recipe-card\";\n\n  var header = document.createElement(\"div\");\n  header.className = \"recipe-header\";\n  var stars1 = document.createElement(\"span\");\n  stars1.className = \"recipe-header-stars\";\n  stars1.textContent = \"\\u2736  \\u2736  \\u2736\";\n  var titleEl = document.createElement(\"div\");\n  titleEl.className = \"recipe-title\";\n  titleEl.textContent = r.title;\n  var stars2 = document.createElement(\"span\");\n  stars2.className = \"recipe-header-stars-bottom\";\n  stars2.textContent = \"\\u2736  \\u2736  \\u2736\";\n  header.appendChild(stars1);\n  header.appendChild(titleEl);\n  if (r.desc) {\n    var descEl = document.createElement(\"div\");\n    descEl.className = \"recipe-desc\";\n    descEl.textContent = r.desc;\n    header.appendChild(descEl);\n  }\n  header.appendChild(stars2);\n  card.appendChild(header);\n\n  var divider = document.createElement(\"div\");\n  divider.className = \"recipe-divider\";\n  divider.textContent = \"Savta's Spices\";\n  card.appendChild(divider);\n\n  var body = document.createElement(\"div\");\n  body.className = \"recipe-body\";\n\n  var ingLabel = document.createElement(\"div\");\n  ingLabel.className = \"recipe-section-label\";\n  ingLabel.textContent = \"Ingredients\";\n  body.appendChild(ingLabel);\n\n  var ul = document.createElement(\"ul\");\n  ul.className = \"recipe-ingredients\";\n  r.ingredients.forEach(function(ing) {\n    var li = document.createElement(\"li\");\n    li.textContent = ing;\n    ul.appendChild(li);\n  });\n  body.appendChild(ul);\n\n  var stepLabel = document.createElement(\"div\");\n  stepLabel.className = \"recipe-section-label\";\n  stepLabel.textContent = \"Method\";\n  body.appendChild(stepLabel);\n\n  var stepsDiv = document.createElement(\"div\");\n  stepsDiv.className = \"recipe-steps\";\n  r.steps.forEach(function(s, i) {\n    var step = document.createElement(\"div\");\n    step.className = \"recipe-step\";\n    var num = document.createElement(\"div\");\n    num.className = \"step-num\";\n    num.textContent = String(i + 1);\n    var txt = document.createElement(\"div\");\n    txt.className = \"step-text\";\n    txt.textContent = s;\n    step.appendChild(num);\n    step.appendChild(txt);\n    stepsDiv.appendChild(step);\n  });\n  body.appendChild(stepsDiv);\n\n  if (r.tip) {\n    var tipWrap = document.createElement(\"div\");\n    tipWrap.className = \"recipe-tip-wrap\";\n    var tipBox = document.createElement(\"div\");\n    tipBox.className = \"recipe-tip\";\n    var tipLabel = document.createElement(\"span\");\n    tipLabel.className = \"recipe-tip-label\";\n    tipLabel.textContent = \"Savta's Tip\";\n    tipBox.appendChild(tipLabel);\n    tipBox.appendChild(document.createTextNode(r.tip));\n    tipWrap.appendChild(tipBox);\n    body.appendChild(tipWrap);\n  }\n\n  if (r.product) {\n    var parts = r.product.split(\"|\");\n    var productName = (parts[0] || \"the spice blend\").trim();\n    var productUrl = (parts[1] || \"https://savtasspices.com/collections/all\").trim();\n    var btnWrap = document.createElement(\"div\");\n    btnWrap.className = \"recipe-buy-wrap\";\n    var btn = document.createElement(\"a\");\n    btn.className = \"recipe-buy-btn\";\n    btn.href = productUrl;\n    btn.target = \"_blank\";\n    btn.textContent = \"\\uD83D\\uDED2 Shop \" + productName + \" \\u2192\";\n    btnWrap.appendChild(btn);\n    body.appendChild(btnWrap);\n  }\n\n  card.appendChild(body);\n  return card;\n}\n\n\nfunction stripMd(text) {\n  return text\n    .replace(/\\*\\*(.+?)\\*\\*/g, '$1')\n    .replace(/\\*(.+?)\\*/g, '$1')\n    .replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, '$1')\n    .replace(/^[-*]\\s+/gm, '')\n    .replace(/^\\d+\\.\\s+/gm, '');\n}\n\nfunction parseRec(text) {\n  if (text.indexOf('[REC_START]') === -1) return null;\n  function getTag(tag, t) {\n    var re = new RegExp('\\\\[' + tag + '\\\\]([\\\\s\\\\S]*?)\\\\[\\\\/' + tag + '\\\\]');\n    var m = t.match(re); return m ? m[1].trim() : '';\n  }\n  return {\n    title: getTag('REC_TITLE', text),\n    price: getTag('REC_PRICE', text),\n    desc: getTag('REC_DESC', text),\n    reason: getTag('REC_REASON', text),\n    url: getTag('REC_URL', text)\n  };\n}\n\nfunction buildRecCard(r) {\n  var card = document.createElement('div');\n  card.className = 'rec-card';\n\n  var hdr = document.createElement('div');\n  hdr.className = 'rec-header';\n  var icon = document.createElement('span');\n  icon.className = 'rec-icon';\n  icon.textContent = '\\uD83E\\uDED9';\n  var title = document.createElement('div');\n  title.className = 'rec-title';\n  title.textContent = r.title;\n  var price = document.createElement('div');\n  price.className = 'rec-price';\n  price.textContent = r.price;\n  hdr.appendChild(icon);\n  hdr.appendChild(title);\n  hdr.appendChild(price);\n  card.appendChild(hdr);\n\n  var body = document.createElement('div');\n  body.className = 'rec-body';\n\n  if (r.desc) {\n    var desc = document.createElement('div');\n    desc.className = 'rec-desc';\n    desc.textContent = r.desc;\n    body.appendChild(desc);\n  }\n  if (r.reason) {\n    var reasonBox = document.createElement('div');\n    reasonBox.className = 'rec-reason';\n    var lbl = document.createElement('span');\n    lbl.className = 'rec-reason-label';\n    lbl.textContent = \"Savta's Pick\";\n    reasonBox.appendChild(lbl);\n    reasonBox.appendChild(document.createTextNode(r.reason));\n    body.appendChild(reasonBox);\n  }\n  var btn = document.createElement('a');\n  btn.className = 'rec-btn';\n  btn.href = r.url;\n  btn.target = '_blank';\n  btn.textContent = '\\uD83D\\uDED2 Shop Now \\u2192';\n  btn.style.color = '#ffffff';\n  body.appendChild(btn);\n\n  card.appendChild(body);\n  return card;\n}\n\nfunction addParas(wrap, text) {\n  text = stripMd(text);\n  text.split(/\\n\\n+/).forEach(function(p) {\n    p = p.trim();\n    if (p) { var el = document.createElement(\"p\"); el.textContent = p; wrap.appendChild(el); }\n  });\n}\n\n// FIX: Renamed inner `block` variables to recipeBlock / recBlock\n// to avoid duplicate var declaration error in strict mode.\n// FIX: [REC_END] slice corrected to +11 (tag is 9 chars + 2 for brackets).\nfunction renderText(text) {\n  var wrap = document.createElement(\"div\");\n\n  var recStart = text.indexOf(\"[RECIPE_START]\");\n  var recEnd = text.indexOf(\"[RECIPE_END]\");\n  var recRecStart = text.indexOf(\"[REC_START]\");\n  var recRecEnd = text.indexOf(\"[REC_END]\");\n\n  if (recStart !== -1 && recEnd !== -1) {\n    var recipeBlock = text.slice(recStart, recEnd + 12);\n    addParas(wrap, text.slice(0, recStart));\n    var recipe = parseRecipe(recipeBlock);\n    if (recipe) wrap.appendChild(buildRecipeCard(recipe));\n    addParas(wrap, text.slice(recEnd + 12));\n  } else if (recRecStart !== -1 && recRecEnd !== -1) {\n    var recBlock = text.slice(recRecStart, recRecEnd + 11);\n    addParas(wrap, text.slice(0, recRecStart));\n    var rec = parseRec(recBlock);\n    if (rec) wrap.appendChild(buildRecCard(rec));\n    addParas(wrap, text.slice(recRecEnd + 11));\n  } else {\n    addParas(wrap, text);\n  }\n  return wrap;\n}\n\nfunction makeBotAvatar() {\n  var wrap = document.createElement(\"div\");\n  wrap.className = \"msg-mini-avatar\";\n  var img = document.createElement(\"img\");\n  img.src = AVATAR_B64;\n  img.alt = \"Savta\";\n  wrap.appendChild(img);\n  return wrap;\n}\n\nfunction addBotMsg(text) {\n  var c = document.getElementById(\"savta-messages\");\n  var el = document.createElement(\"div\");\n  el.className = \"msg bot\";\n  var bubble = document.createElement(\"div\");\n  bubble.className = \"msg-bubble\";\n  bubble.appendChild(renderText(text));\n  el.appendChild(makeBotAvatar());\n  el.appendChild(bubble);\n  c.appendChild(el);\n  c.scrollTop = c.scrollHeight;\n}\n\nfunction addUserMsg(text) {\n  var c = document.getElementById(\"savta-messages\");\n  var el = document.createElement(\"div\");\n  el.className = \"msg user\";\n  var bubble = document.createElement(\"div\");\n  bubble.className = \"msg-bubble\";\n  bubble.textContent = text;\n  el.appendChild(bubble);\n  c.appendChild(el);\n  c.scrollTop = c.scrollHeight;\n}\n\nfunction showTyping() {\n  var c = document.getElementById(\"savta-messages\");\n  var el = document.createElement(\"div\");\n  el.className = \"msg bot\";\n  el.id = \"savta-typing\";\n  var bubble = document.createElement(\"div\");\n  bubble.className = \"msg-bubble\";\n  var tw = document.createElement(\"div\");\n  tw.className = \"typing-wrap\";\n  for (var i = 0; i < 3; i++) {\n    var d = document.createElement(\"div\");\n    d.className = \"t-dot\";\n    tw.appendChild(d);\n  }\n  bubble.appendChild(tw);\n  el.appendChild(makeBotAvatar());\n  el.appendChild(bubble);\n  c.appendChild(el);\n  c.scrollTop = c.scrollHeight;\n}\n\nfunction removeTyping() {\n  var t = document.getElementById(\"savta-typing\");\n  if (t) t.remove();\n}\n\nfunction autoResize(el) {\n  el.style.height = \"auto\";\n  el.style.height = Math.min(el.scrollHeight, 100) + \"px\";\n}\n\nfunction handleKey(e) {\n  if (e.key === \"Enter\" && !e.shiftKey) { e.preventDefault(); sendMessage(); }\n}\n\nfunction sendQuick(text) {\n  document.getElementById(\"savta-input\").value = text;\n  sendMessage();\n}\n\nfunction sendMessage() {\n  var input = document.getElementById(\"savta-input\");\n  var text = input.value.trim();\n  if (!text || isLoading) return;\n  input.value = \"\";\n  input.style.height = \"auto\";\n  isLoading = true;\n  document.getElementById(\"savta-send-btn\").disabled = true;\n  addUserMsg(text);\n  chatHistory.push({ role: \"user\", content: text });\n\n  // FIX: Trim chatHistory client-side to prevent unbounded memory growth.\n  // Keep last 40 entries (20 exchanges). Server already trims to 12 on its end.\n  if (chatHistory.length > 40) {\n    chatHistory = chatHistory.slice(chatHistory.length - 40);\n  }\n\n  showTyping();\n  fetch(\"/api/chat\", {\n    method: \"POST\",\n    headers: { \"Content-Type\": \"application/json\" },\n    body: JSON.stringify({ messages: chatHistory })\n  })\n  // FIX: Wrapped r.json() in try/catch — a non-JSON error response\n  // (e.g. a plain-text 502 from Render) would previously throw an\n  // uncaught exception. Now it falls through to the .catch handler.\n  .then(function(r) {\n    if (!r.ok && r.headers.get('content-type') && !r.headers.get('content-type').includes('application/json')) {\n      throw new Error('Non-JSON error response: ' + r.status);\n    }\n    return r.json();\n  })\n  .then(function(data) {\n    removeTyping();\n    var reply = data.reply || \"Something got a little lost! Try asking again.\";\n    addBotMsg(reply);\n    chatHistory.push({ role: \"assistant\", content: reply });\n  })\n  .catch(function() {\n    removeTyping();\n    addBotMsg(\"Oops, the connection dropped for a moment. Try again!\");\n  })\n  .finally(function() {\n    isLoading = false;\n    document.getElementById(\"savta-send-btn\").disabled = false;\n    document.getElementById(\"savta-input\").focus();\n  });\n}\n</script>\n</body>\n</html>\n";

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(HTML_CONTENT);
});

// ============================================================
// 404 HANDLER — catch stray requests
// ============================================================
app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

// ============================================================
// GLOBAL ERROR HANDLER — never let unhandled errors crash the server
// ============================================================
app.use((err, req, res, next) => {
  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Access denied." });
  }
  console.error("[UNHANDLED ERROR]", err.message);
  res.status(500).json({ error: "Internal server error." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Savta's Kitchen is open on port ${PORT}`);
  console.log(`🔐 Security layers: helmet + cors + rate-limit (x2) + xss-clean + input validation + timeout`);
  console.log(`🔑 Gemini API: ${GEMINI_API_KEY ? "READY" : "⚠️  MISSING — set GEMINI_API_KEY"}`);
});
