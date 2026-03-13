# 🍯 Savta Marsel: The AI Spice Concierge
### *Tradition meets Technology in the Kitchen*

**Savta Marsel** is a custom-built AI Brand Ambassador designed for small businesses in the culinary and heritage sectors. It combines a warm, grandmotherly persona with a sophisticated technical engine to provide recipe guidance, spice education, and a seamless customer experience.

---

## ✨ Key Features
* **Heritage-Driven Persona:** Custom-prompted to provide advice in a warm, traditional "Savta" (Grandmother) voice.
* **Recipe Intelligence:** Deep knowledge of spice blends, kosher requirements, and traditional Middle Eastern cooking.
* **Conversion Focused:** Built-in "Quick Action" buttons to drive users toward product discovery and gift options.
* **Safety First:** Hard-coded guardrails to prevent the bot from giving dangerous kitchen advice (e.g., chemical safety).

---

## 🔒 Security & Architecture
This project is a secured, production-ready application featuring:

* **Engine:** Node.js (Express) + Google Gemini 1.5 Pro.
* **Sanitization:** Real-time XSS filtering on all user inputs to prevent code injection.
* **Rate Limiting:** Protects the business from bot-spam and API cost-spikes (set to 20 requests / 15 min).
* **Prompt Shielding:** Uses XML-delimited instruction guarding to prevent "Jailbreaking" and intellectual property theft.
* **Deployment:** Fully optimized for Render with auto-dependency locking via npm ci.

---

## 🛠️ Installation (Local Testing)

1. Clone the repository:
git clone https://github.com/GuyGo-87/Savta-chatbot.git

2. Install dependencies:
npm install

3. Set your environment variable:
Create a .env file and add GEMINI_API_KEY=your_key_here

4. Start the server:
node server.js

---

## 📊 Business Value
1. **Reduced Support Load:** Handles 80% of common questions about product ingredients.
2. **Increased Engagement:** Interactive recipe discovery keeps users on the site longer.
3. **Customer Insights:** Provides monthly analytics on top spice trends and user needs.

---

### 🚀 Try the Live Demo:
[Savta Marsel Live on Render](https://savta-chatbot.onrender.com/)
