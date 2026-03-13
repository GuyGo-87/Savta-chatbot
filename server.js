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
// AbortController kills the request if Gemini doesn't respond
// within 25 seconds. Prevents hanging connections.
// ============================================================
async function callGemini(contents) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 second timeout

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=" + GEMINI_API_KEY,
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
// ============================================================
const HTML_CONTENT = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\"/>\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>\n<title>Savta's Spices</title>\n<link href=\"https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400;1,700&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&family=Lora:ital,wght@0,400;0,600;1,400;1,600&display=swap\" rel=\"stylesheet\">\n<style>\n*{box-sizing:border-box;margin:0;padding:0}\n:root{\n  --cream:#faf7f2;\n  --warm-white:#fffdf9;\n  --red:#7a2318;\n  --red-light:#c0392b;\n  --gold:#f59e0b;\n  --brown:#2c1a0e;\n  --brown-mid:#7a6a5a;\n  --border:#e8d5c0;\n  --bg-tint:#fff8f0;\n  --parchment:#fdf6e9;\n}\nbody{font-family:\"DM Sans\",sans-serif;background:var(--cream);color:var(--brown);min-height:100vh;}\n.page{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:0 20px 120px;}\n.hero{text-align:center;padding:64px 20px 48px;max-width:680px;width:100%;}\n.hero h1{font-family:\"Playfair Display\",serif;font-size:clamp(38px,6vw,62px);color:var(--red);line-height:1.1;letter-spacing:-1px;margin-bottom:16px;}\n.hero h1 em{font-style:italic;color:var(--brown);}\n.hero p{font-size:16px;color:var(--brown-mid);line-height:1.7;margin-bottom:32px;}\n.hero-badge{display:inline-flex;align-items:center;gap:7px;padding:6px 16px;border-radius:999px;background:rgba(122,35,24,0.08);border:1px solid rgba(122,35,24,0.18);font-size:12px;font-weight:600;color:var(--red);letter-spacing:0.5px;text-transform:uppercase;margin-bottom:22px;}\n.features{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-bottom:48px;}\n.feature-pill{display:flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;background:var(--warm-white);border:1px solid var(--border);font-size:13px;font-weight:500;color:var(--brown);}\n\n#savta-bubble{position:fixed;bottom:28px;right:28px;width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#7a2318,#c0392b);box-shadow:0 8px 32px rgba(122,35,24,0.5);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:9999;border:none;outline:none;transition:transform 0.2s;overflow:hidden;}\n#savta-bubble:hover{transform:scale(1.1);}\n#savta-bubble img{width:100%;height:100%;object-fit:cover;object-position:center top;border-radius:50%;}\n.bubble-ping{position:absolute;top:0;right:0;width:18px;height:18px;border-radius:50%;background:var(--gold);border:2.5px solid var(--cream);animation:ping 2.5s ease-in-out infinite;}\n@keyframes ping{0%,100%{transform:scale(1);opacity:1}60%{transform:scale(1.5);opacity:0.5}}\n\n#savta-window{position:fixed;bottom:122px;right:28px;width:400px;max-width:calc(100vw - 40px);height:600px;max-height:calc(100vh - 146px);background:var(--warm-white);border-radius:26px;box-shadow:0 40px 100px rgba(0,0,0,0.2);display:flex;flex-direction:column;z-index:9998;overflow:hidden;transform:scale(0.88) translateY(24px);opacity:0;pointer-events:none;transition:transform 0.32s cubic-bezier(0.34,1.56,0.64,1),opacity 0.24s;transform-origin:bottom right;}\n#savta-window.open{transform:scale(1) translateY(0);opacity:1;pointer-events:all;}\n\n.savta-header{background:linear-gradient(135deg,#7a2318,#c0392b);padding:18px;display:flex;align-items:center;gap:12px;flex-shrink:0;}\n.savta-avatar{width:48px;height:48px;border-radius:50%;border:2px solid rgba(255,255,255,0.3);overflow:hidden;flex-shrink:0;}\n.savta-avatar img{width:100%;height:100%;object-fit:cover;object-position:center top;}\n.savta-name{font-family:\"Playfair Display\",serif;font-size:17px;font-weight:700;color:#fff;}\n.savta-status{font-size:11px;color:rgba(255,255,255,0.75);margin-top:3px;display:flex;align-items:center;gap:5px;}\n.status-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;animation:pulse 2s infinite;}\n@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}\n.savta-close{width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.2);color:#fff;font-size:14px;cursor:pointer;margin-left:auto;font-family:inherit;transition:background 0.15s;}\n.savta-close:hover{background:rgba(255,255,255,0.25);}\n\n.quick-prompts{padding:10px 12px 8px;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid var(--border);background:var(--bg-tint);}\n.quick-btn{padding:5px 11px;border-radius:999px;background:#fff;border:1px solid var(--border);color:var(--red);font-size:11.5px;font-weight:600;font-family:\"DM Sans\",sans-serif;cursor:pointer;white-space:nowrap;transition:all 0.15s;}\n.quick-btn:hover{background:var(--red);color:#fff;border-color:var(--red);}\n\n.savta-messages{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;}\n.savta-messages::-webkit-scrollbar{width:4px;}\n.savta-messages::-webkit-scrollbar-track{background:transparent;}\n.savta-messages::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}\n\n.msg{display:flex;gap:8px;align-items:flex-end;animation:msgIn 0.25s ease;}\n@keyframes msgIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}\n.msg.user{flex-direction:row-reverse;}\n.msg-mini-avatar{width:28px;height:28px;border-radius:50%;overflow:hidden;flex-shrink:0;}\n.msg-mini-avatar img{width:100%;height:100%;object-fit:cover;object-position:center top;}\n.msg-bubble{max-width:82%;padding:11px 14px;font-size:13.5px;line-height:1.65;font-family:\"DM Sans\",sans-serif;}\n.msg-bubble p{margin:0 0 8px;}\n.msg-bubble p:last-child{margin-bottom:0;}\n.msg.bot .msg-bubble{background:#fff;color:var(--brown);border-radius:18px 18px 18px 4px;box-shadow:0 2px 10px rgba(0,0,0,0.07);border:1px solid #f0e8dc;}\n.msg.user .msg-bubble{background:linear-gradient(135deg,#7a2318,#a0341f);color:#fff;border-radius:18px 18px 4px 18px;}\n.msg-bubble a{color:var(--red);font-weight:700;text-decoration:underline;}\n\n/* RECIPE CARD */\n.recipe-card{background:var(--parchment);border:1px solid #dcc9a0;border-radius:16px;overflow:hidden;margin:4px 0;box-shadow:0 6px 28px rgba(44,26,14,0.12);font-family:\"Lora\",serif;}\n.recipe-header{background:linear-gradient(160deg,#7a2318 0%,#9b2d20 60%,#7a2318 100%);padding:20px 20px 16px;text-align:center;}\n.recipe-header-stars{display:block;font-size:9px;letter-spacing:6px;color:rgba(255,255,255,0.4);margin-bottom:10px;font-family:\"DM Sans\",sans-serif;}\n.recipe-header-stars-bottom{display:block;font-size:9px;letter-spacing:6px;color:rgba(255,255,255,0.4);margin-top:10px;font-family:\"DM Sans\",sans-serif;}\n.recipe-title{font-family:\"Playfair Display\",serif;font-size:19px;font-weight:700;font-style:italic;color:#fff;letter-spacing:0.3px;line-height:1.25;}\n.recipe-desc{font-size:12px;color:rgba(255,255,255,0.82);line-height:1.55;font-family:\"DM Sans\",sans-serif;margin-top:6px;}\n.recipe-divider{display:flex;align-items:center;gap:10px;padding:14px 18px 0;color:#b8905a;font-size:9px;letter-spacing:4px;font-family:\"DM Sans\",sans-serif;text-transform:uppercase;}\n.recipe-divider::before,.recipe-divider::after{content:\"\";flex:1;height:1px;background:linear-gradient(to right,transparent,#d4b896,transparent);}\n.recipe-body{padding:14px 0 16px;}\n.recipe-section-label{font-family:\"DM Sans\",sans-serif;font-size:9.5px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9b6a3a;margin-bottom:10px;margin-top:16px;display:flex;align-items:center;gap:8px;padding:0 18px;}\n.recipe-section-label:first-of-type{margin-top:0;}\n.recipe-section-label::after{content:\"\";flex:1;height:1px;background:#e2c9a4;}\n.recipe-ingredients{list-style:none;display:flex;flex-direction:column;gap:3px;padding:0 18px;}\n.recipe-ingredients li{font-size:13px;color:var(--brown);padding:6px 10px 6px 14px;position:relative;line-height:1.45;border-bottom:1px dashed #e8d5b8;font-family:\"Lora\",serif;}\n.recipe-ingredients li:last-child{border-bottom:none;}\n.recipe-ingredients li::before{content:\"\u2022\";position:absolute;left:2px;color:#c0784a;font-size:15px;line-height:1.2;}\n.recipe-steps{display:flex;flex-direction:column;gap:10px;padding:0 18px;}\n.recipe-step{display:flex;gap:12px;align-items:flex-start;}\n.step-num{width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#7a2318,#c0392b);color:#fff;font-size:11px;font-weight:700;font-family:\"DM Sans\",sans-serif;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;box-shadow:0 2px 6px rgba(122,35,24,0.3);}\n.step-text{font-size:13px;color:var(--brown);line-height:1.6;font-family:\"Lora\",serif;padding-top:2px;}\n.recipe-tip-wrap{padding:0 18px;}\n.recipe-tip{background:linear-gradient(135deg,rgba(245,158,11,0.08),rgba(249,115,22,0.06));border:1px solid rgba(245,158,11,0.35);border-left:3px solid var(--gold);border-radius:10px;padding:10px 14px;font-size:12.5px;color:#7a5020;line-height:1.55;font-family:\"DM Sans\",sans-serif;font-style:italic;margin-top:16px;}\n.recipe-tip-label{font-weight:700;font-style:normal;color:#9b6a2a;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;display:block;margin-bottom:4px;}\n.recipe-buy-wrap{padding:14px 18px 0;}\n.recipe-buy-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px;background:linear-gradient(135deg,#5a1810,#7a2318);color:#ffffff !important;font-size:14px;font-weight:800;font-family:\"DM Sans\",sans-serif;border:none;border-radius:12px;cursor:pointer;text-align:center;text-decoration:none;transition:all 0.2s;letter-spacing:0.8px;text-transform:uppercase;box-shadow:0 4px 18px rgba(122,35,24,0.45);}\n.recipe-buy-btn:hover{background:linear-gradient(135deg,#7a2318,#c0392b);transform:translateY(-2px);box-shadow:0 8px 24px rgba(122,35,24,0.55);}\n\n.rec-card{background:var(--parchment);border:1px solid #dcc9a0;border-radius:16px;overflow:hidden;margin:4px 0;box-shadow:0 6px 28px rgba(44,26,14,0.12);}\n.rec-header{background:linear-gradient(135deg,#7a2318,#9b2d20);padding:16px 18px 14px;text-align:center;}\n.rec-icon{font-size:28px;display:block;margin-bottom:6px;}\n.rec-title{font-family:\"Playfair Display\",serif;font-size:18px;font-weight:700;font-style:italic;color:#fff;line-height:1.2;}\n.rec-price{font-family:\"DM Sans\",sans-serif;font-size:13px;color:rgba(255,255,255,0.75);margin-top:4px;font-weight:600;letter-spacing:0.5px;}\n.rec-body{padding:14px 18px 16px;display:flex;flex-direction:column;gap:10px;}\n.rec-desc{font-family:\"Lora\",serif;font-size:13.5px;color:var(--brown);line-height:1.6;}\n.rec-reason{background:linear-gradient(135deg,rgba(245,158,11,0.08),rgba(249,115,22,0.06));border:1px solid rgba(245,158,11,0.35);border-left:3px solid var(--gold);border-radius:10px;padding:10px 14px;font-size:12.5px;color:#7a5020;line-height:1.55;font-family:\"DM Sans\",sans-serif;font-style:italic;}\n.rec-reason-label{font-weight:700;font-style:normal;color:#9b6a2a;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;display:block;margin-bottom:4px;}\n.rec-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px;background:linear-gradient(135deg,#5a1810,#7a2318);color:#ffffff !important;font-size:14px;font-weight:800;font-family:\"DM Sans\",sans-serif;border:none;border-radius:12px;cursor:pointer;text-align:center;text-decoration:none;transition:all 0.2s;letter-spacing:0.8px;text-transform:uppercase;box-shadow:0 4px 18px rgba(122,35,24,0.45);}\n.rec-btn:hover{background:linear-gradient(135deg,#7a2318,#c0392b);transform:translateY(-2px);box-shadow:0 8px 24px rgba(122,35,24,0.55);}\n\n.typing-wrap{display:flex;gap:4px;align-items:center;padding:4px 2px;}\n.t-dot{width:7px;height:7px;border-radius:50%;background:#c0a080;animation:tdot 1.2s infinite ease-in-out;}\n.t-dot:nth-child(2){animation-delay:.18s}\n.t-dot:nth-child(3){animation-delay:.36s}\n@keyframes tdot{0%,80%,100%{transform:translateY(0);opacity:0.4}40%{transform:translateY(-7px);opacity:1}}\n\n.savta-input-row{padding:11px 13px 13px;border-top:1px solid #f0e8dc;background:var(--warm-white);display:flex;gap:9px;align-items:flex-end;flex-shrink:0;}\n.savta-input{flex:1;padding:10px 14px;border-radius:14px;border:1.5px solid var(--border);background:#fff;font-size:13.5px;font-family:\"DM Sans\",sans-serif;color:var(--brown);outline:none;resize:none;max-height:100px;min-height:42px;line-height:1.5;transition:border-color 0.15s;}\n.savta-input:focus{border-color:var(--red);}\n.savta-input::placeholder{color:#c0a880;}\n.savta-send{width:42px;height:42px;border-radius:13px;background:linear-gradient(135deg,#7a2318,#c0392b);border:none;color:white;font-size:17px;cursor:pointer;flex-shrink:0;transition:opacity 0.15s;}\n.savta-send:disabled{opacity:0.45;cursor:not-allowed;}\n.savta-footer-brand{text-align:center;padding:5px 0 9px;font-size:10px;color:#c0a880;font-weight:500;flex-shrink:0;}\n.savta-footer-brand a{color:var(--red);text-decoration:none;font-weight:600;}\n\n@media(max-width:480px){\n  #savta-window{right:12px;bottom:96px;width:calc(100vw - 24px);}\n  #savta-bubble{right:18px;bottom:20px;}\n}\n</style>\n</head>\n<body>\n\n<div class=\"page\">\n  <div class=\"hero\">\n    <div class=\"hero-badge\">\ud83e\uded9 Live Demo</div>\n    <h1>Meet <em>Savta</em><br>Marsel</h1>\n    <p>The AI grandmother behind Savta's Spices. Warm, welcoming, and always in the kitchen.</p>\n    <div class=\"features\">\n      <div class=\"feature-pill\">\ud83d\udc75 Grandmotherly warmth</div>\n      <div class=\"feature-pill\">\ud83c\udf73 Full recipes on demand</div>\n      <div class=\"feature-pill\">\ud83e\uded9 Product recommendations</div>\n      <div class=\"feature-pill\">\ud83d\udce6 Shipping and orders</div>\n    </div>\n  </div>\n</div>\n\n<button id=\"savta-bubble\" onclick=\"toggleSavta()\" aria-label=\"Chat with Savta\">\n  <img id=\"savta-bubble-img\" src=\"\" alt=\"Savta Marsel\" />\n  <span class=\"bubble-ping\"></span>\n</button>\n\n<div id=\"savta-window\">\n  <div class=\"savta-header\">\n    <div class=\"savta-avatar\">\n      <img id=\"savta-header-img\" src=\"\" alt=\"Savta Marsel\" />\n    </div>\n    <div>\n      <div class=\"savta-name\">Savta Marsel</div>\n      <div class=\"savta-status\"><span class=\"status-dot\"></span>In the kitchen, ready for you</div>\n    </div>\n    <button class=\"savta-close\" onclick=\"toggleSavta()\">&#x2715;</button>\n  </div>\n  <div class=\"quick-prompts\" id=\"quick-prompts\">\n    <button class=\"quick-btn\" onclick=\"sendQuick('What spice blends do you sell?')\">&#x1F9D0; Our Blends</button>\n    <button class=\"quick-btn\" onclick=\"sendQuick('Give me a Shabbat dinner recipe!')\">&#x1F37D;&#xFE0F; Recipes</button>\n    <button class=\"quick-btn\" onclick=\"sendQuick('Help me choose the right spice for me')\">&#x2728; Find My Spice</button>\n    <button class=\"quick-btn\" onclick=\"sendQuick('Are your spices kosher?')\">Kosher?</button>\n    <button class=\"quick-btn\" onclick=\"sendQuick('Tell me about your gift boxes \u2014 what\\'s the difference between the Tasting Box, Full Flavor Box, and Deluxe Flavor Box?')\">&#x1F381; Gifts</button>\n    <button class=\"quick-btn\" onclick=\"sendQuick('Tell me the story behind Savta Marsel and these spices')\">&#x1F49B; Our Story</button>\n  </div>\n  <div class=\"savta-messages\" id=\"savta-messages\"></div>\n  <div class=\"savta-input-row\">\n    <textarea class=\"savta-input\" id=\"savta-input\" placeholder=\"Ask me anything about spices, recipes, or orders...\" rows=\"1\" onkeydown=\"handleKey(event)\" oninput=\"autoResize(this)\"></textarea>\n    <button class=\"savta-send\" id=\"savta-send-btn\" onclick=\"sendMessage()\">&#9658;</button>\n  </div>\n  <div class=\"savta-footer-brand\">Powered by <a href=\"https://savtasspices.com\" target=\"_blank\">Savta's Spices</a> &#x1F9D0;</div>\n</div>\n\n<script>\n// Avatar image (base64)\nvar AVATAR_B64 = \"data:image/png;base64,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\";\n\ndocument.getElementById(\"savta-bubble-img\").src = AVATAR_B64;\ndocument.getElementById(\"savta-header-img\").src = AVATAR_B64;\n\nvar isOpen = false;\nvar isLoading = false;\nvar chatHistory = [];\nvar greeted = false;\n\nfunction getSeasonalGreeting() {\n  var now = new Date();\n  var month = now.getMonth() + 1;\n  var day = now.getDay();\n  if (day === 5) return \"Welcome, welcome! Come on in \u2014 Shabbat is almost here and there's so much to cook. I'm Savta Marsel. What can I help you make tonight? \ud83e\udec6\";\n  if (month === 9 || month === 10) return \"Welcome! The holidays are here and the kitchen is calling. I'm Savta Marsel \u2014 so glad you stopped by. Ask me anything! \ud83e\udec6\";\n  if (month === 12) return \"Welcome in from the cold! The kitchen is warm and so am I. I\u2019m Savta Marsel. What can I help you cook up today? \ud83e\udec6\";\n  return \"Welcome! I'm so glad you stopped by. I'm Savta Marsel. Pull up a chair and tell me what you're cooking \u2014 my kitchen is always open. \ud83e\udec6\";\n}\n\nfunction toggleSavta() {\n  isOpen = !isOpen;\n  var win = document.getElementById(\"savta-window\");\n  if (isOpen) {\n    win.classList.add(\"open\");\n    if (!greeted) {\n      greeted = true;\n      setTimeout(function() { addBotMsg(getSeasonalGreeting()); }, 400);\n    }\n    setTimeout(function() { document.getElementById(\"savta-input\").focus(); }, 350);\n  } else {\n    win.classList.remove(\"open\");\n  }\n}\n\nfunction parseRecipe(text) {\n  if (text.indexOf(\"[RECIPE_START]\") === -1) return null;\n  function getTag(tag, t) {\n    var re = new RegExp(\"\\\\[\" + tag + \"\\\\]([\\\\s\\\\S]*?)\\\\[\\\\/\" + tag + \"\\\\]\");\n    var m = t.match(re);\n    return m ? m[1].trim() : \"\";\n  }\n  return {\n    title: getTag(\"RECIPE_TITLE\", text),\n    desc: getTag(\"RECIPE_DESC\", text),\n    ingredients: getTag(\"RECIPE_INGREDIENTS\", text).split(\"\\n\").map(function(l){ return l.replace(/^-\\s*/, \"\").trim(); }).filter(Boolean),\n    steps: getTag(\"RECIPE_STEPS\", text).split(\"\\n\").map(function(l){ return l.replace(/^\\d+\\.\\s*/, \"\").trim(); }).filter(Boolean),\n    tip: getTag(\"RECIPE_TIP\", text),\n    product: getTag(\"RECIPE_PRODUCT\", text)\n  };\n}\n\nfunction escHtml(str) {\n  var d = document.createElement(\"div\");\n  d.appendChild(document.createTextNode(str || \"\"));\n  return d.innerHTML;\n}\n\nfunction buildRecipeCard(r) {\n  var card = document.createElement(\"div\");\n  card.className = \"recipe-card\";\n\n  var header = document.createElement(\"div\");\n  header.className = \"recipe-header\";\n  var stars1 = document.createElement(\"span\");\n  stars1.className = \"recipe-header-stars\";\n  stars1.textContent = \"\\u2736  \\u2736  \\u2736\";\n  var titleEl = document.createElement(\"div\");\n  titleEl.className = \"recipe-title\";\n  titleEl.textContent = r.title;\n  var stars2 = document.createElement(\"span\");\n  stars2.className = \"recipe-header-stars-bottom\";\n  stars2.textContent = \"\\u2736  \\u2736  \\u2736\";\n  header.appendChild(stars1);\n  header.appendChild(titleEl);\n  if (r.desc) {\n    var descEl = document.createElement(\"div\");\n    descEl.className = \"recipe-desc\";\n    descEl.textContent = r.desc;\n    header.appendChild(descEl);\n  }\n  header.appendChild(stars2);\n  card.appendChild(header);\n\n  var divider = document.createElement(\"div\");\n  divider.className = \"recipe-divider\";\n  divider.textContent = \"Savta's Spices\";\n  card.appendChild(divider);\n\n  var body = document.createElement(\"div\");\n  body.className = \"recipe-body\";\n\n  var ingLabel = document.createElement(\"div\");\n  ingLabel.className = \"recipe-section-label\";\n  ingLabel.textContent = \"Ingredients\";\n  body.appendChild(ingLabel);\n\n  var ul = document.createElement(\"ul\");\n  ul.className = \"recipe-ingredients\";\n  r.ingredients.forEach(function(ing) {\n    var li = document.createElement(\"li\");\n    li.textContent = ing;\n    ul.appendChild(li);\n  });\n  body.appendChild(ul);\n\n  var stepLabel = document.createElement(\"div\");\n  stepLabel.className = \"recipe-section-label\";\n  stepLabel.textContent = \"Method\";\n  body.appendChild(stepLabel);\n\n  var stepsDiv = document.createElement(\"div\");\n  stepsDiv.className = \"recipe-steps\";\n  r.steps.forEach(function(s, i) {\n    var step = document.createElement(\"div\");\n    step.className = \"recipe-step\";\n    var num = document.createElement(\"div\");\n    num.className = \"step-num\";\n    num.textContent = String(i + 1);\n    var txt = document.createElement(\"div\");\n    txt.className = \"step-text\";\n    txt.textContent = s;\n    step.appendChild(num);\n    step.appendChild(txt);\n    stepsDiv.appendChild(step);\n  });\n  body.appendChild(stepsDiv);\n\n  if (r.tip) {\n    var tipWrap = document.createElement(\"div\");\n    tipWrap.className = \"recipe-tip-wrap\";\n    var tipBox = document.createElement(\"div\");\n    tipBox.className = \"recipe-tip\";\n    var tipLabel = document.createElement(\"span\");\n    tipLabel.className = \"recipe-tip-label\";\n    tipLabel.textContent = \"Savta's Tip\";\n    tipBox.appendChild(tipLabel);\n    tipBox.appendChild(document.createTextNode(r.tip));\n    tipWrap.appendChild(tipBox);\n    body.appendChild(tipWrap);\n  }\n\n  if (r.product) {\n    var parts = r.product.split(\"|\");\n    var productName = (parts[0] || \"the spice blend\").trim();\n    var productUrl = (parts[1] || \"https://savtasspices.com/collections/all\").trim();\n    var btnWrap = document.createElement(\"div\");\n    btnWrap.className = \"recipe-buy-wrap\";\n    var btn = document.createElement(\"a\");\n    btn.className = \"recipe-buy-btn\";\n    btn.href = productUrl;\n    btn.target = \"_blank\";\n    btn.textContent = \"\\uD83D\\uDED2 Shop \" + productName + \" \\u2192\";\n    btnWrap.appendChild(btn);\n    body.appendChild(btnWrap);\n  }\n\n  card.appendChild(body);\n  return card;\n}\n\n\nfunction stripMd(text) {\n  return text\n    .replace(/\\*\\*(.+?)\\*\\*/g, '$1')\n    .replace(/\\*(.+?)\\*/g, '$1')\n    .replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, '$1')\n    .replace(/^[-*]\\s+/gm, '')\n    .replace(/^\\d+\\.\\s+/gm, '');\n}\n\nfunction parseRec(text) {\n  if (text.indexOf('[REC_START]') === -1) return null;\n  function getTag(tag, t) {\n    var re = new RegExp('\\\\[' + tag + '\\\\]([\\\\s\\\\S]*?)\\\\[\\\\/' + tag + '\\\\]');\n    var m = t.match(re); return m ? m[1].trim() : '';\n  }\n  return {\n    title: getTag('REC_TITLE', text),\n    price: getTag('REC_PRICE', text),\n    desc: getTag('REC_DESC', text),\n    reason: getTag('REC_REASON', text),\n    url: getTag('REC_URL', text)\n  };\n}\n\nfunction buildRecCard(r) {\n  var card = document.createElement('div');\n  card.className = 'rec-card';\n\n  var hdr = document.createElement('div');\n  hdr.className = 'rec-header';\n  var icon = document.createElement('span');\n  icon.className = 'rec-icon';\n  icon.textContent = '\\uD83E\\uDED9';\n  var title = document.createElement('div');\n  title.className = 'rec-title';\n  title.textContent = r.title;\n  var price = document.createElement('div');\n  price.className = 'rec-price';\n  price.textContent = r.price;\n  hdr.appendChild(icon);\n  hdr.appendChild(title);\n  hdr.appendChild(price);\n  card.appendChild(hdr);\n\n  var body = document.createElement('div');\n  body.className = 'rec-body';\n\n  if (r.desc) {\n    var desc = document.createElement('div');\n    desc.className = 'rec-desc';\n    desc.textContent = r.desc;\n    body.appendChild(desc);\n  }\n  if (r.reason) {\n    var reasonBox = document.createElement('div');\n    reasonBox.className = 'rec-reason';\n    var lbl = document.createElement('span');\n    lbl.className = 'rec-reason-label';\n    lbl.textContent = \"Savta's Pick\";\n    reasonBox.appendChild(lbl);\n    reasonBox.appendChild(document.createTextNode(r.reason));\n    body.appendChild(reasonBox);\n  }\n  var btn = document.createElement('a');\n  btn.className = 'rec-btn';\n  btn.href = r.url;\n  btn.target = '_blank';\n  btn.textContent = '\\uD83D\\uDED2 Shop Now \\u2192';\n    btn.style.color = '#ffffff';\n  body.appendChild(btn);\n\n  card.appendChild(body);\n  return card;\n}\n\nfunction addParas(wrap, text) {\n  text = stripMd(text);\n  text.split(/\\n\\n+/).forEach(function(p) {\n    p = p.trim();\n    if (p) { var el = document.createElement(\"p\"); el.textContent = p; wrap.appendChild(el); }\n  });\n}\n\nfunction renderText(text) {\n  var wrap = document.createElement(\"div\");\n\n  var recStart = text.indexOf(\"[RECIPE_START]\");\n  var recEnd = text.indexOf(\"[RECIPE_END]\");\n  var recRecStart = text.indexOf(\"[REC_START]\");\n  var recRecEnd = text.indexOf(\"[REC_END]\");\n\n  if (recStart !== -1 && recEnd !== -1) {\n    var block = text.slice(recStart, recEnd + 12);\n    addParas(wrap, text.slice(0, recStart));\n    var recipe = parseRecipe(block);\n    if (recipe) wrap.appendChild(buildRecipeCard(recipe));\n    addParas(wrap, text.slice(recEnd + 12));\n  } else if (recRecStart !== -1 && recRecEnd !== -1) {\n    var block = text.slice(recRecStart, recRecEnd + 9);\n    addParas(wrap, text.slice(0, recRecStart));\n    var rec = parseRec(block);\n    if (rec) wrap.appendChild(buildRecCard(rec));\n    addParas(wrap, text.slice(recRecEnd + 9));\n  } else {\n    addParas(wrap, text);\n  }\n  return wrap;\n}\n\nfunction makeBotAvatar() {\n  var wrap = document.createElement(\"div\");\n  wrap.className = \"msg-mini-avatar\";\n  var img = document.createElement(\"img\");\n  img.src = AVATAR_B64;\n  img.alt = \"Savta\";\n  wrap.appendChild(img);\n  return wrap;\n}\n\nfunction addBotMsg(text) {\n  var c = document.getElementById(\"savta-messages\");\n  var el = document.createElement(\"div\");\n  el.className = \"msg bot\";\n  var bubble = document.createElement(\"div\");\n  bubble.className = \"msg-bubble\";\n  bubble.appendChild(renderText(text));\n  el.appendChild(makeBotAvatar());\n  el.appendChild(bubble);\n  c.appendChild(el);\n  c.scrollTop = c.scrollHeight;\n}\n\nfunction addUserMsg(text) {\n  var c = document.getElementById(\"savta-messages\");\n  var el = document.createElement(\"div\");\n  el.className = \"msg user\";\n  var bubble = document.createElement(\"div\");\n  bubble.className = \"msg-bubble\";\n  bubble.textContent = text;\n  el.appendChild(bubble);\n  c.appendChild(el);\n  c.scrollTop = c.scrollHeight;\n}\n\nfunction showTyping() {\n  var c = document.getElementById(\"savta-messages\");\n  var el = document.createElement(\"div\");\n  el.className = \"msg bot\";\n  el.id = \"savta-typing\";\n  var bubble = document.createElement(\"div\");\n  bubble.className = \"msg-bubble\";\n  var tw = document.createElement(\"div\");\n  tw.className = \"typing-wrap\";\n  for (var i = 0; i < 3; i++) {\n    var d = document.createElement(\"div\");\n    d.className = \"t-dot\";\n    tw.appendChild(d);\n  }\n  bubble.appendChild(tw);\n  el.appendChild(makeBotAvatar());\n  el.appendChild(bubble);\n  c.appendChild(el);\n  c.scrollTop = c.scrollHeight;\n}\n\nfunction removeTyping() {\n  var t = document.getElementById(\"savta-typing\");\n  if (t) t.remove();\n}\n\nfunction autoResize(el) {\n  el.style.height = \"auto\";\n  el.style.height = Math.min(el.scrollHeight, 100) + \"px\";\n}\n\nfunction handleKey(e) {\n  if (e.key === \"Enter\" && !e.shiftKey) { e.preventDefault(); sendMessage(); }\n}\n\nfunction sendQuick(text) {\n  document.getElementById(\"savta-input\").value = text;\n  sendMessage();\n}\n\nfunction sendMessage() {\n  var input = document.getElementById(\"savta-input\");\n  var text = input.value.trim();\n  if (!text || isLoading) return;\n  input.value = \"\";\n  input.style.height = \"auto\";\n  isLoading = true;\n  document.getElementById(\"savta-send-btn\").disabled = true;\n  addUserMsg(text);\n  chatHistory.push({ role: \"user\", content: text });\n  showTyping();\n  fetch(\"/api/chat\", {\n    method: \"POST\",\n    headers: { \"Content-Type\": \"application/json\" },\n    body: JSON.stringify({ messages: chatHistory })\n  })\n  .then(function(r) { return r.json(); })\n  .then(function(data) {\n    removeTyping();\n    var reply = data.reply || \"Something got a little lost! Try asking again.\";\n    addBotMsg(reply);\n    chatHistory.push({ role: \"assistant\", content: reply });\n  })\n  .catch(function() {\n    removeTyping();\n    addBotMsg(\"Oops, the connection dropped for a moment. Try again!\");\n  })\n  .finally(function() {\n    isLoading = false;\n    document.getElementById(\"savta-send-btn\").disabled = false;\n    document.getElementById(\"savta-input\").focus();\n  });\n}\n</script>\n</body>\n</html>\n";
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
