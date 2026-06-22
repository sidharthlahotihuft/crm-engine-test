/* ============================================================================
   HUFT CRM Creative Engine — Supabase / PostgreSQL build
   Express + pg + JWT + bcrypt
   Deploy on Railway / Render / Fly.io — connect to Supabase DATABASE_URL
============================================================================ */
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const path    = require("path");
const crypto  = require("crypto");

const app  = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || "huft-crm-dev-secret-change-in-prod";

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    // Never let the browser/CDN serve a stale index.html after a deploy.
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  }
}));

const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

// ── Supabase / PostgreSQL pool ────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4,
});

// Thin query helper — returns rows array
const db = async (sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  return rows;
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 11);

const authMiddleware = async (req, res, next) => {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorised" });
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

const roles = (...allowed) => (req, res, next) => {
  if (!allowed.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
  next();
};

// ── LLM provider ─────────────────────────────────────────────────────────────
const GEMINI_KEY   = process.env.GEMINI_API_KEY   || "";
const CLAUDE_KEY   = process.env.ANTHROPIC_API_KEY || "";
const PROVIDER     = CLAUDE_KEY ? "claude" : GEMINI_KEY ? "gemini" : "mock";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

async function generate(system, prompt) {
  if (PROVIDER === "gemini") {
    // Support both AIza (v1beta) and AQ. (newer) key formats
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 8192,
          temperature: 0.9,
        },
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Gemini error:", JSON.stringify(data));
      throw new Error(data.error?.message || "Gemini API error " + r.status);
    }
    return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
  }
  if (PROVIDER === "claude") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 4096, system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || "Claude error");
    return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  }
  // Mock
  await new Promise(r => setTimeout(r, 600));
  return JSON.stringify({ mock: true, note: "Add GEMINI_API_KEY to .env to enable real generation." });
}

// Vision: analyse an image (base64, no data: prefix) and return text.
async function generateVision(system, prompt, imageB64, mimeType) {
  const mime = mimeType || "image/jpeg";
  if (PROVIDER === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [
          { text: prompt },
          { inlineData: { mimeType: mime, data: imageB64 } },
        ] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 2048, temperature: 0.4 },
      }),
    });
    const data = await r.json();
    if (!r.ok) { console.error("Gemini vision error:", JSON.stringify(data)); throw new Error(data.error?.message || "Gemini vision error " + r.status); }
    return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
  }
  if (PROVIDER === "claude") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 2048, system,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mime, data: imageB64 } },
          { type: "text", text: prompt },
        ] }],
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || "Claude vision error");
    return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  }
  await new Promise(r => setTimeout(r, 600));
  return JSON.stringify({ product: "Unknown", category: "general", tags: ["mock"], description: "Mock analysis — set an API key." });
}


// ── Audiences auto-seed ───────────────────────────────────────────────────────
async function seedAudiences() {
  try {
    const { rows } = await pool.query("SELECT COUNT(*) FROM audiences");
    if (parseInt(rows[0].count) >= 10) return; // already seeded
    const audiences = [
      // DOG SEGMENTS
      { name: "New Dog Parent", description: "First-time dog parent, 25–35, urban, slightly anxious, research-heavy. Just brought home a puppy or rescue.", segment_code: "DOG_NEW", pet_type: "dog", lifecycle_stage: "Acquisition / Onboarding", trigger_event: "New puppy adoption, rescue event, first HUFT purchase", key_insight: "Anxiety is high, trust is fragile, information need is high. They want a trusted guide, not a salesperson. Reassurance converts. Simplicity wins. 'We've got you' is the message.", channel_pref: "WhatsApp, Email", notes: "Tone: warm, simple, expert. Relevant: Hearty, Sara's Puppy, YIMT, HUFT Originals." },
      { name: "Loyalist Dog Parent", description: "Active buyer, 2–5 years HUFT relationship. Regularly purchases, emotionally invested in the brand.", segment_code: "DOG_LOYALIST", pet_type: "dog", lifecycle_stage: "Retention / Advocacy", trigger_event: "New launch, seasonal event, birthday/adoption anniversary, milestone", key_insight: "They know HUFT. They trust HUFT. They want to feel like insiders and be the first to know. Recognition matters more than discounts.", channel_pref: "WhatsApp, Push, Email", notes: "Lead with celebration and insider access. Avoid over-discounting. Relevant: new launches, DashDog, HUFT Spa." },
      { name: "Home Cooker (Dog)", description: "Feeds dog home-cooked meals. Health-conscious, slightly suspicious of packaged food.", segment_code: "DOG_HOMECOOK", pet_type: "dog", lifecycle_stage: "Conversion / Education", trigger_event: "Vet advice, nutritional concern, sharing home-cook recipes online", key_insight: "Their love for their dog drives the cooking. Sara's feels like 'home cooking, but done right.' Validate the love; show what it misses.", channel_pref: "WhatsApp, Email", notes: "Key message: 'Your love is the foundation — Sara's completes it.' Primary Sara's SWF audience." },
      { name: "Kibble Switcher (Dog)", description: "Currently on RC / Farmina / Pedigree / Drools. Open to upgrade, triggered by digestion issue or curiosity.", segment_code: "DOG_KIBBLE_SWITCH", pet_type: "dog", lifecycle_stage: "Conversion / Upsell", trigger_event: "Dog shows digestion issues, coat dullness, vet recommendation, price review", key_insight: "Not unhappy — just don't know better is possible. Story is not 'your food is bad' but 'your dog can feel even better.' Curiosity is the entry, benefit is the close.", channel_pref: "WhatsApp, Push", notes: "Hearty's primary audience. Lead with baking vs extrusion story. Never shame current choices." },
      { name: "Lapsed Dog Buyer", description: "Customer who purchased 60–180 days ago with no recent activity.", segment_code: "DOG_LAPSED", pet_type: "dog", lifecycle_stage: "Win-back", trigger_event: "60 days since last purchase, stock replenishment window", key_insight: "Life got in the way, not dissatisfaction. They remember HUFT fondly. The right warm nudge brings them back.", channel_pref: "WhatsApp, Email", notes: "Win-back tone: warm, 'we missed you and [dog name].' Lead with replenishment SKU + one adjacent product." },
      { name: "Treat Buyer (Dog)", description: "Buys treats regularly but hasn't crossed over into main nutrition products.", segment_code: "DOG_TREAT", pet_type: "dog", lifecycle_stage: "Upsell / Cross-sell", trigger_event: "Treat reorder time, new treat flavour launch, training milestone", key_insight: "Treats are a daily emotional ritual. Treats open the door to trust in nutrition. YIMT → Sara's Treats → Sara's SWF is the upgrade ladder.", channel_pref: "WhatsApp, Push", notes: "Joyful, taste-first tone. YIMT and Sara's Treats are the heroes." },
      { name: "Health-Anxious Dog Parent", description: "Dog has digestion, skin, or allergy issues. Actively seeking solutions.", segment_code: "DOG_HEALTH_ANXIOUS", pet_type: "dog", lifecycle_stage: "Conversion / Education", trigger_event: "Vet visit, skin flare-up, loose stools, itching, switching from current food", key_insight: "Fear and guilt drive their search but they want to be helped, not scared. They've usually already tried 2–3 things. Position HUFT as the calm expert.", channel_pref: "WhatsApp, Email", notes: "Empathetic problem-solver tone. Never fear language. Relevant: Sara's Hypoallergenic, Probiotic Chews, Hearty sensitive." },
      { name: "Senior Dog Parent", description: "Dog is 7+ years. Parent is emotionally attuned to ageing signs — joint stiffness, lower energy.", segment_code: "DOG_SENIOR", pet_type: "dog", lifecycle_stage: "Retention / Upsell", trigger_event: "Dog's birthday, vet mention of ageing, noticeable behaviour changes", key_insight: "Emotional peak. This parent wants to give their dog the best final years. 'They've given you everything' lands hard. Quality of life is the purchase driver.", channel_pref: "WhatsApp, Email", notes: "Gentle, responsible, celebratory of the bond. Relevant: Sara's Classic, Probiotic Chews, HUFT Beds, Spa gentle grooms." },
      // CAT SEGMENTS
      { name: "New Cat Parent", description: "First cat, 22–32 urban, often rescue/adoption. Unsure about nutrition.", segment_code: "CAT_NEW", pet_type: "cat", lifecycle_stage: "Acquisition / Onboarding", trigger_event: "New cat adoption, first HUFT cat purchase", key_insight: "New cat parents feel they don't fully understand cats. Clear, non-judgemental education builds deep loyalty fast.", channel_pref: "WhatsApp, Email", notes: "Tone: friendly, non-judgemental. Start with NutriMeow or Meowsi intro. Don't overwhelm with science." },
      { name: "Label Reader (Cat)", description: "Checks ingredients obsessively. Avoids fillers. Researches taurine, organ meats, moisture. Willing to pay more for clean.", segment_code: "CAT_LABELREADER", pet_type: "cat", lifecycle_stage: "Conversion", trigger_event: "Ingredient research online, disappointment with current brand, vet guidance", key_insight: "They've already done the homework — they just need Meowsi to pass the test. Treat them as a peer, not a prospect.", channel_pref: "WhatsApp, Email", notes: "Knowledgeable peer-to-peer tone. Lead with specifics: real muscle meat, organ meat, AAFCO-complete. Primary Meowsi audience." },
      { name: "Kibble Cat Parent", description: "Feeds dry food only (Farmina, RC, Whiskas dry). May not know cats dehydrate on dry-only diets.", segment_code: "CAT_KIBBLE", pet_type: "cat", lifecycle_stage: "Education / Upsell", trigger_event: "Vet mention of dehydration/UTI, dry stools, picky behaviour", key_insight: "'You don't have to replace Farmina — pair it with Meowsi.' Pairing angle is less threatening. Hydration is the hook.", channel_pref: "WhatsApp, Push", notes: "Lead with pairing story. Educate on moisture gap (80–84% moisture in Meowsi). Non-threatening upgrade tone." },
      { name: "Wet Food Cat Parent (Upgrader)", description: "Already buys Sheba / Whiskas wet. Treats it as a topper, not a complete meal.", segment_code: "CAT_WET_UPGRADE", pet_type: "cat", lifecycle_stage: "Conversion / Upsell", trigger_event: "Buying Sheba regularly, cat not finishing meals, nutrition concern", key_insight: "'Sheba is a snack. Meowsi is a meal.' Most wet food users don't realise their product is a complementary topper. That single reframe is the conversion insight.", channel_pref: "WhatsApp, Email", notes: "Complete vs complementary is the story. Respectful comparison. Primary Meowsi audience." },
      { name: "Value Cat Parent", description: "Budget-conscious. Currently on Whiskas / Me-O. Cares about their cat but managing costs.", segment_code: "CAT_VALUE", pet_type: "cat", lifecycle_stage: "Conversion", trigger_event: "Price comparison research, cat health concern, recommendation", key_insight: "Not cheap — careful. NutriMeow delivers more energy per pouch at Rs.65. Price parity + quality upgrade is the win.", channel_pref: "WhatsApp, Push", notes: "'Feed right. Pay smart.' Lead with taurine education. Price comparison: Rs.65. Primary NutriMeow audience." },
      { name: "Lapsed Cat Buyer", description: "Purchased cat product 60–180 days ago, no recent activity.", segment_code: "CAT_LAPSED", pet_type: "cat", lifecycle_stage: "Win-back", trigger_event: "60 days since last purchase, replenishment window", key_insight: "Cat parents are routine-driven. If they lapsed, the product ran out and they defaulted to convenience. A warm nudge reactivates the habit.", channel_pref: "WhatsApp, Email", notes: "Warm win-back tone. 'Your cat misses the good stuff.' Lead with last purchased product + replenishment." },
      { name: "Multi-Cat Home", description: "2+ cats. Daily feeding cost is a real practical concern.", segment_code: "CAT_MULTI", pet_type: "cat", lifecycle_stage: "Retention / Upsell", trigger_event: "Second cat adoption, budget review, routine feeding optimisation", key_insight: "When feeding 3 cats twice a day, Rs.65 vs Rs.70 actually matters. Consistency and acceptance (cats finishing the meal) are key purchase drivers.", channel_pref: "WhatsApp, Email", notes: "NutriMeow primary audience. Practical, no-frills tone. Bulk messaging: cost + quality + familiar textures." },
      // RETAIL / CROSS-CATEGORY
      { name: "Store Visitor (Retail)", description: "Customer engaged through HUFT retail stores. NSO-specific or in-store context. No web or app links.", segment_code: "RETAIL_STORE", pet_type: "both", lifecycle_stage: "Conversion / Retention", trigger_event: "Store visit, NSO launch, in-store event, Spa appointment", key_insight: "Retail customers have a higher trust baseline — they chose to walk in. The store IS the relationship. CRM should amplify the in-store experience.", channel_pref: "WhatsApp", notes: "RETAIL CRM — NO web/app links. Lead with store experience. Tone: welcoming, community-warm." },
      { name: "Grooming Customer", description: "Has used or enquired about HUFT Spa & Grooming.", segment_code: "SPA_GROOM", pet_type: "both", lifecycle_stage: "Retention / Upsell", trigger_event: "Post-groom follow-up, seasonal grooming, grooming interval reminder", key_insight: "The groom is a moment of trust — the parent handed over their pet. Post-groom re-engagement within 72 hours has highest response rates.", channel_pref: "WhatsApp", notes: "Warm, expert, caring. 'Your pet felt so comfortable.' Upsell: Spa packages, care products. RETAIL context." },
      { name: "High-Value Customer", description: "Top-decile customer by LTV. Regular, multi-category, emotionally invested in HUFT.", segment_code: "HIGH_LTV", pet_type: "both", lifecycle_stage: "Advocacy / Retention", trigger_event: "Anniversary, new launch, exclusive event, thank-you moment", key_insight: "They don't need to be convinced. They need to feel seen. Early access, behind-the-scenes, being part of HUFT's story — these are their currency.", channel_pref: "WhatsApp, Email", notes: "Celebratory, insider, warm. No hard sell. 'Thank you for being part of the HUFT family.' Never lead with discount." },
    ];
    for (const a of audiences) {
      await pool.query(
        `INSERT INTO audiences (name,description,segment_code,pet_type,lifecycle_stage,trigger_event,key_insight,channel_pref,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [a.name, a.description, a.segment_code, a.pet_type, a.lifecycle_stage, a.trigger_event, a.key_insight, a.channel_pref, a.notes]
      );
    }
    console.log(`✓ Audiences seeded (${audiences.length} segments added)`);
  } catch (e) {
    console.error("Audiences seed failed:", e.message);
  }
}


async function seedRules() {
  try {
    const { rows } = await pool.query("SELECT COUNT(*) FROM rules");
    if (parseInt(rows[0].count) >= 20) return; // already seeded
    const copyRules = [
      "British English only — colour not color, favour not favor.",
      "Write like a human. Natural sentences, clear language, emotion where appropriate.",
      "Clarity first, warmth second, cleverness only if clarity stays intact.",
      "Say \"pet parents\" never \"consumers\" or \"customers\" in copy body.",
      "Use \"furry family\" not \"furry friend\". Never \"fur baby\".",
      "Words to avoid: premium, luxury, cutting-edge, state-of-the-art, revolutionary, game-changing.",
      "Never shame pet parents for feeding choices or care mistakes. Always guide kindly.",
      "No fear-based messaging. No exaggerated claims. Trust matters more than hype.",
      "No medical or cure claims. Use \"supportive\", \"gentle\", \"vet-aware\" instead.",
      "Never invent prices or discounts. Write \"Rs.XX [confirm]\" as placeholder.",
      "WhatsApp body: 1 warm opener → 3–5 ✓ bullets → short sign-off → one CTA.",
      "Emoji: max 1–2 per asset. Never decorative emoji strings.",
      "Push title: MAX 50 characters. Push body: MAX 90 characters, one sentence.",
      "Retail CRM: NO website or app deep links. Lead with store experience.",
      "D2C CRM: app deep links and website URLs are fine.",
      "One message rule — one clear takeaway per asset.",
      "Sara\'s tone: nurturing, expert, warm. \"Real Food. Real Love.\"",
      "Hearty tone: reliable, accessible. \"Made with all our heart.\"",
      "Meowsi tone: witty, sophisticated, feline-first.",
      "HUFT Spa tone: reassuring, gentle. \"Grooming that feels like care.\"",
    ];
    const promptRules = [
      "Always feature real Indian dog or cat breeds — Indie, Lab, Golden, Persian.",
      "Pet must be the emotional hero of the frame. Product supports, never dominates.",
      "Real pet moments — genuine expressions of joy, curiosity, comfort. No posed stock-photo looks.",
      "Show correct pack proportions and label orientation. No distorted packaging.",
      "No added text overlaid on product pack in the generated image.",
      "Warm, natural lighting. Avoid harsh studio strobes or clinical white backgrounds.",
      "Indian home or lifestyle context preferred — warm interiors, natural textures.",
      "Leave visual negative space on one side for text/headline overlay in post.",
      "Negative prompt always include: distorted faces, extra limbs, blurry text, watermark, oversaturated.",
      "For FLUX: photorealistic style, natural depth of field. Specify Indian breed explicitly.",
    ];
    for (const text of copyRules) {
      await pool.query("INSERT INTO rules (type, text, active) VALUES ($1,$2,$3)", ["copy", text, true]);
    }
    for (const text of promptRules) {
      await pool.query("INSERT INTO rules (type, text, active) VALUES ($1,$2,$3)", ["prompt", text, true]);
    }
    console.log("✓ Rules seeded (30 default rules added)");
  } catch (e) {
    console.error("Rules seed failed:", e.message);
  }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const rows = await db("SELECT * FROM users WHERE email = $1 LIMIT 1", [email.toLowerCase().trim()]);
    if (!rows.length) return res.status(401).json({ error: "Invalid email or password" });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Invalid email or password" });
    await db("UPDATE users SET last_login = NOW() WHERE id = $1", [user.id]);
    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role },
      JWT_SECRET, { expiresIn: "7d" }
    );
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/auth/me", authMiddleware, (req, res) => res.json(req.user));

// ── USERS ─────────────────────────────────────────────────────────────────────

app.get("/api/users", authMiddleware, roles("admin"), async (req, res) => {
  try {
    res.json(await db("SELECT id,name,email,role,created_at,last_login FROM users ORDER BY created_at DESC"));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/users", authMiddleware, roles("admin"), async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "name, email, password required" });
  const validRoles = ["admin","business","content","design"];
  const userRole = validRoles.includes(role) ? role : "content";
  try {
    const hash = await bcrypt.hash(password, 10);
    const id = uid();
    await db(
      "INSERT INTO users (id,name,email,password,role) VALUES ($1,$2,$3,$4,$5)",
      [id, name, email.toLowerCase().trim(), hash, userRole]
    );
    res.json({ ok: true, id });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Email already exists" });
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/users/:id", authMiddleware, roles("admin"), async (req, res) => {
  const { name, role, password } = req.body;
  const validRoles = ["admin","business","content","design"];
  try {
    if (password) await db("UPDATE users SET password=$1 WHERE id=$2", [await bcrypt.hash(password, 10), req.params.id]);
    if (name)                      await db("UPDATE users SET name=$1     WHERE id=$2", [name, req.params.id]);
    if (role && validRoles.includes(role)) await db("UPDATE users SET role=$1 WHERE id=$2", [role, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/users/:id", authMiddleware, roles("admin"), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "Cannot delete yourself" });
  try { await db("DELETE FROM users WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUDIENCES ─────────────────────────────────────────────────────────────────

app.get("/api/audiences", authMiddleware, async (req, res) => {
  try { res.json(await db("SELECT * FROM audiences ORDER BY created_at DESC")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/audiences", authMiddleware, async (req, res) => {
  const { name, description, segment_code, pet_type, lifecycle_stage,
          trigger_event, key_insight, size_estimate, channel_pref, notes } = req.body;
  if (!name) return res.status(400).json({ error: "Audience name required" });
  try {
    const id = uid();
    const rows = await db(
      `INSERT INTO audiences
       (id,name,description,segment_code,pet_type,lifecycle_stage,trigger_event,key_insight,size_estimate,channel_pref,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, name, description||null, segment_code||null, pet_type||"both",
       lifecycle_stage||null, trigger_event||null, key_insight||null,
       size_estimate||null, channel_pref||null, notes||null, req.user.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/audiences/:id", authMiddleware, async (req, res) => {
  const fields = ["name","description","segment_code","pet_type","lifecycle_stage",
                  "trigger_event","key_insight","size_estimate","channel_pref","notes"];
  const updates = fields.filter(f => req.body[f] !== undefined);
  if (!updates.length) return res.json({ ok: true });
  try {
    const sql = `UPDATE audiences SET ${updates.map((f,i) => `${f}=$${i+1}`).join(",")} WHERE id=$${updates.length+1}`;
    await db(sql, [...updates.map(f => req.body[f]), req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/audiences/:id", authMiddleware, roles("admin","business"), async (req, res) => {
  try { await db("DELETE FROM audiences WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CAMPAIGNS ─────────────────────────────────────────────────────────────────

app.get("/api/campaigns", authMiddleware, async (req, res) => {
  try {
    const rows = await db(`
      SELECT c.*,
             a.name            AS audience_name,
             a.key_insight     AS audience_insight,
             a.trigger_event,
             a.lifecycle_stage,
             a.segment_code
      FROM   campaigns c
      LEFT JOIN audiences a ON c.audience_id = a.id
      ORDER BY
        CASE c.stage WHEN 'brief' THEN 1 WHEN 'content' THEN 2 WHEN 'brand_review' THEN 3 WHEN 'design' THEN 4 ELSE 5 END,
        c.updated_at DESC
    `);
    const parse = (v, fb) => v == null ? fb : (typeof v === "string" ? (()=>{try{return JSON.parse(v);}catch{return fb;}})() : v);
    res.json(rows.map(r => ({
      ...r,
      data: parse(r.data, {}),
      rtbs: parse(r.rtbs, []),
      references: parse(r.references, []),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/campaigns", authMiddleware, async (req, res) => {
  const b = req.body || {};
  const id = uid();
  // Columns that can be set at creation time
  const cols = ["name","channel","product","audience_id","audience_label","segment",
    "objective","offer","crm_type","stage","go_live_date","campaign_week","campaign_month",
    "tat_brief_due","tat_content_due","tat_design_due","brief_started_at"];
  const jsonCols = { data: true, rtbs: true, references: true };
  try {
    const names = ["id"]; const ph = ["$1"]; const vals = [id]; let i = 2;
    for (const c of cols) {
      if (b[c] !== undefined) { names.push(c); ph.push(`$${i++}`); vals.push(b[c]); }
    }
    for (const c of Object.keys(jsonCols)) {
      if (b[c] !== undefined) {
        names.push(c === "references" ? '"references"' : c);
        ph.push(`$${i++}`); vals.push(JSON.stringify(b[c]));
      }
    }
    names.push("created_by"); ph.push(`$${i++}`); vals.push(req.user.id);
    const rows = await db(
      `INSERT INTO campaigns (${names.join(",")}) VALUES (${ph.join(",")}) RETURNING *`,
      vals
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/campaigns/:id", authMiddleware, async (req, res) => {
  const allowed = [
    "name","channel","product","audience_id","audience_label","segment","objective",
    "offer","crm_type","stage","data","go_live_date","campaign_week","campaign_month",
    "tat_brief_due","tat_content_due","tat_design_due",
    "brief_started_at","content_started_at","design_started_at","went_live_at",
    "rtbs","references",
  ];
  const special = { copy_approver: null, design_approver: null };

  try {
    const sets = [];
    const vals = [];
    let i = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        const col = key === "references" ? '"references"' : key;       // reserved word
        sets.push(`${col}=$${i++}`);
        const jsonCols = key === "data" || key === "rtbs" || key === "references";
        vals.push(jsonCols ? JSON.stringify(req.body[key]) : req.body[key]);
      }
    }
    if (req.body.copy_approver !== undefined) {
      sets.push(`copy_approver=$${i++}`, `copy_approved_at=NOW()`);
      vals.push(req.body.copy_approver);
    }
    if (req.body.design_approver !== undefined) {
      sets.push(`design_approver=$${i++}`, `design_approved_at=NOW()`);
      vals.push(req.body.design_approver);
    }
    if (req.body.brand_approver !== undefined) {
      sets.push(`brand_approver=$${i++}`, `brand_approved_at=NOW()`);
      vals.push(req.body.brand_approver);
    }

    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id);
    const rows = await db(
      `UPDATE campaigns SET ${sets.join(",")} WHERE id=$${i} RETURNING *`,
      vals
    );
    res.json(rows[0] || { ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/campaigns/:id", authMiddleware, roles("admin","business"), async (req, res) => {
  try { await db("DELETE FROM campaigns WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RULES ─────────────────────────────────────────────────────────────────────

app.get("/api/rules", authMiddleware, async (req, res) => {
  try { res.json(await db("SELECT * FROM rules ORDER BY created_at DESC")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/rules", authMiddleware, async (req, res) => {
  const { type, text } = req.body;
  if (!type || !text) return res.status(400).json({ error: "type and text required" });
  try {
    const rows = await db(
      "INSERT INTO rules (id,type,text,created_by) VALUES ($1,$2,$3,$4) RETURNING *",
      [uid(), type, text, req.user.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/rules/:id", authMiddleware, async (req, res) => {
  try {
    if (req.body.active !== undefined) await db("UPDATE rules SET active=$1 WHERE id=$2", [req.body.active, req.params.id]);
    if (req.body.text)                 await db("UPDATE rules SET text=$1   WHERE id=$2", [req.body.text,   req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/rules/:id", authMiddleware, roles("admin"), async (req, res) => {
  try { await db("DELETE FROM rules WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FEEDBACK ──────────────────────────────────────────────────────────────────

app.get("/api/feedback", authMiddleware, async (req, res) => {
  try { res.json(await db("SELECT * FROM feedback ORDER BY created_at DESC LIMIT 50")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/feedback", authMiddleware, async (req, res) => {
  const { stage, text, campaign_id } = req.body;
  if (!stage || !text) return res.status(400).json({ error: "stage and text required" });
  try {
    const rows = await db(
      "INSERT INTO feedback (id,stage,text,by_name,campaign_id) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [uid(), stage, text, req.user.name, campaign_id||null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── BRAND REVIEW · COMMENTS · SHEETS SYNC (v2) ───────────────────────────────
// BLOCK B — Comments API
// Paste anywhere among the other route definitions (e.g. after the
// feedback routes).
// ─────────────────────────────────────────────────────────────

// List comments for a campaign (optionally by context)
app.get("/api/campaigns/:id/comments", authMiddleware, async (req, res) => {
  try {
    const ctx = req.query.context;
    const rows = ctx
      ? await db("SELECT * FROM comments WHERE campaign_id=$1 AND context=$2 ORDER BY created_at ASC", [req.params.id, ctx])
      : await db("SELECT * FROM comments WHERE campaign_id=$1 ORDER BY created_at ASC", [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add a comment or reply. Any authenticated user can comment & reply.
app.post("/api/campaigns/:id/comments", authMiddleware, async (req, res) => {
  const { body, context, parent_id } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "Empty comment" });
  try {
    const rows = await db(
      `INSERT INTO comments (campaign_id, context, parent_id, body, author_id, author_name, author_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, context === "design" ? "design" : "copy", parent_id || null,
       body.trim(), req.user.id, req.user.name, req.user.role]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resolve / unresolve a comment thread (brand lead or admin)
app.put("/api/comments/:id", authMiddleware, async (req, res) => {
  try {
    if (req.body.resolved !== undefined)
      await db("UPDATE comments SET resolved=$1 WHERE id=$2", [!!req.body.resolved, req.params.id]);
    if (req.body.body !== undefined)
      await db("UPDATE comments SET body=$1 WHERE id=$2 AND author_id=$3", [req.body.body, req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/comments/:id", authMiddleware, async (req, res) => {
  try {
    // author or admin can delete
    await db("DELETE FROM comments WHERE id=$1 AND (author_id=$2 OR $3='admin')",
      [req.params.id, req.user.id, req.user.role]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─────────────────────────────────────────────────────────────
// BLOCK C — Brand approval gate (server-side enforcement)
// This makes the brand approval authoritative: only a 'brand' or
// 'admin' user can move a campaign from brand_review → design.
// Paste among the routes.
// ─────────────────────────────────────────────────────────────

app.post("/api/campaigns/:id/brand-approve", authMiddleware, roles("brand", "admin"), async (req, res) => {
  try {
    const rows = await db(
      `UPDATE campaigns
         SET stage='design', brand_approver=$1, brand_approved_at=NOW()
       WHERE id=$2 AND stage='brand_review'
       RETURNING *`,
      [req.user.name, req.params.id]
    );
    if (!rows.length) return res.status(409).json({ error: "Campaign is not awaiting brand review." });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Brand lead sends copy back to the content team with required changes
app.post("/api/campaigns/:id/brand-reject", authMiddleware, roles("brand", "admin"), async (req, res) => {
  try {
    const rows = await db(
      `UPDATE campaigns SET stage='content', copy_approver=NULL WHERE id=$1 AND stage='brand_review' RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(409).json({ error: "Campaign is not awaiting brand review." });
    // Optionally log the reason as a comment
    if (req.body.reason && req.body.reason.trim()) {
      await db(
        `INSERT INTO comments (campaign_id, context, body, author_id, author_name, author_role)
         VALUES ($1,'copy',$2,$3,$4,$5)`,
        [req.params.id, "Sent back: " + req.body.reason.trim(), req.user.id, req.user.name, req.user.role]
      );
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─────────────────────────────────────────────────────────────
// BLOCK D — Google Sheets sync
// Requires a Google service account with read access to the sheet,
// OR a sheet published to the web as CSV. The simplest, credential-free
// path is the published-CSV approach used below.
//
// Env needed: none for published-CSV. For private sheets, set
//   GOOGLE_SHEETS_API_KEY  and share the sheet as "anyone with link (viewer)".
//
// Paste among the routes.
// ─────────────────────────────────────────────────────────────

const rowKey = (r) => crypto.createHash("md5").update(JSON.stringify(r)).digest("hex").slice(0, 12);

// Save / connect the sheet config (admin or business)
app.put("/api/sheet-sync", authMiddleware, roles("admin", "business"), async (req, res) => {
  const { sheet_id, sheet_range, enabled } = req.body;
  try {
    await db(
      `INSERT INTO sheet_sync (id, sheet_id, sheet_range, enabled, created_by)
       VALUES ('default',$1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET sheet_id=$1, sheet_range=$2, enabled=$3`,
      [sheet_id || null, sheet_range || "Briefs!A:K", !!enabled, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/sheet-sync", authMiddleware, async (req, res) => {
  try {
    const rows = await db("SELECT id, sheet_id, sheet_range, enabled, last_synced FROM sheet_sync WHERE id='default'");
    res.json(rows[0] || { enabled: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Core sync routine — fetch sheet rows, skip already-imported, generate + insert briefs.
async function runSheetSync() {
  const cfgRows = await db("SELECT * FROM sheet_sync WHERE id='default'");
  const cfg = cfgRows[0];
  if (!cfg || !cfg.enabled || !cfg.sheet_id) return { skipped: true, reason: "sync disabled or no sheet" };

  // Published-CSV fetch (sheet must be: File → Share → Publish to web → CSV)
  // Format: https://docs.google.com/spreadsheets/d/<ID>/gviz/tq?tqx=out:csv&sheet=Briefs
  const sheetName = (cfg.sheet_range || "Briefs").split("!")[0];
  const url = `https://docs.google.com/spreadsheets/d/${cfg.sheet_id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Could not fetch sheet (is it published to web as CSV?)");
  const csv = await r.text();

  // Minimal CSV parse (handles quoted cells)
  const parseCSV = (text) => {
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else {
        if (ch === '"') q = true;
        else if (ch === ",") { row.push(cell); cell = ""; }
        else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
        else if (ch === "\r") {} else cell += ch;
      }
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows;
  };
  const raw = parseCSV(csv).filter(r => r.some(c => (c || "").trim()));
  if (!raw.length) return { created: 0, reason: "empty sheet" };

  const hdrIdx = raw.findIndex(r => r.some(c => String(c).trim().toLowerCase() === "product"));
  if (hdrIdx < 0) throw new Error("No 'Product' header found in sheet");
  const headers = raw[hdrIdx].map(c => String(c || "").trim().toLowerCase());
  const col = (n) => headers.findIndex(h => h === n);
  const map = { crmType: col("crm type"), channel: col("channel"), product: col("product"),
    pillar: col("pillar"), audience: col("audience"), objective: col("objective"),
    offer: col("offer"), hook: col("hook / angle"), rtbs: col("rtbs"),
    references: col("reference links"), goLive: col("go live date") };
  const splitList = v => String(v || "").split(/[;\n]/).map(x => x.trim()).filter(Boolean);

  const imported = new Set(cfg.imported_keys || []);
  let created = 0; const newKeys = [];

  for (let idx = hdrIdx + 1; idx < raw.length; idx++) {
    const rr = raw[idx];
    const get = k => (map[k] >= 0 ? rr[map[k]] : undefined);
    const product = String(get("product") || "").trim();
    if (!product || String(get("goLive") || "").includes("example")) continue;

    const norm = {
      crmType: String(get("crmType") || "D2C").trim(),
      channel: String(get("channel") || "WhatsApp").trim(),
      product,
      pillar: String(get("pillar") || "").trim(),
      audience: String(get("audience") || "").trim(),
      objective: String(get("objective") || "").trim(),
      offer: String(get("offer") || "").trim(),
      hook: String(get("hook") || "").trim(),
      rtbs: splitList(get("rtbs")),
      references: splitList(get("references")),
      goLive: String(get("goLive") || "").trim(),
    };
    const key = rowKey(norm);
    if (imported.has(key)) continue;       // already imported this exact row

    // Generate the brief via the LLM
    const sys = `You write tight CRM creative briefs for HUFT. Return ONLY JSON: {"campaignName":"MonYY_Product_Hook_Aud","strategicInsight":"","idea":"","proofPoints":["","",""],"pillar":"Importance","copyDirection":"","whatsappNote":""}`;
    const usr = `CRM type: ${norm.crmType}\nChannel: ${norm.channel}\nProduct: ${norm.product}\nPillar: ${norm.pillar || "Importance"}\nAudience: ${norm.audience}\nObjective: ${norm.objective}\nOffer: ${norm.offer || "none"}\nHook: ${norm.hook || "derive"}\nRTBs: ${norm.rtbs.join("; ") || "derive"}\nReferences: ${norm.references.join(" , ") || "none"}`;
    let j = {};
    try { const txt = await generate(sys, usr); j = JSON.parse(txt.replace(/```json|```/g, "").trim().replace(/^[^[{]*/, "")); }
    catch { j = { campaignName: norm.product, strategicInsight: "", idea: "", proofPoints: norm.rtbs, pillar: norm.pillar || "Importance", copyDirection: "", whatsappNote: "" }; }
    if (norm.rtbs.length) j.proofPoints = norm.rtbs;

    const isRetail = norm.crmType.toLowerCase() === "retail";
    const channel = isRetail ? "WhatsApp" : norm.channel;
    const gl = norm.goLive || null;
    await db(
      `INSERT INTO campaigns (name, channel, product, audience_label, segment, objective, offer, crm_type, go_live_date, rtbs, "references", data, stage, brief_started_at)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,'content',NOW())`,
      [j.campaignName || norm.product, channel, norm.product, norm.audience, norm.objective,
       norm.offer, norm.crmType, gl, JSON.stringify(norm.rtbs), JSON.stringify(norm.references),
       JSON.stringify({ brief: { ...j, rtbs: norm.rtbs, references: norm.references, source: "sheet" } })]
    );
    created++; newKeys.push(key);
  }

  const merged = [...(cfg.imported_keys || []), ...newKeys].slice(-5000); // cap memory
  await db("UPDATE sheet_sync SET last_synced=NOW(), imported_keys=$1 WHERE id='default'", [JSON.stringify(merged)]);
  return { created };
}

// Manual trigger (button in the app) — admin/business
app.post("/api/sheet-sync/run", authMiddleware, roles("admin", "business"), async (req, res) => {
  try { res.json(await runSheetSync()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Cron trigger — called by Vercel Cron every 6h. Protected by a shared secret.
app.get("/api/cron/sheet-sync", async (req, res) => {
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: "CRON_SECRET not configured" });
  const secret = req.headers["authorization"] || req.query.key || "";
  if (secret !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorised" });
  }
  try { res.json(await runSheetSync()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});


// ── IMAGE LIBRARY (AI-tagged) ─────────────────────────────────────────────────

// Upload an image: the engine analyses it (product, category, tags, context) then stores it.
// body: { file_name, file_data (data URL or raw base64), file_type, notes }
app.post("/api/image-library", authMiddleware, roles("admin", "brand"), async (req, res) => {
  const { file_name, file_data, file_type, notes } = req.body;
  if (!file_data) return res.status(400).json({ error: "file_data required" });
  // Strip a data: URL prefix if present, to get raw base64 for the vision call
  const b64 = String(file_data).includes(",") ? String(file_data).split(",")[1] : String(file_data);
  const mime = file_type || (String(file_data).match(/^data:(.*?);/)?.[1]) || "image/jpeg";

  let analysis = { product: "", category: "", tags: [], description: "" };
  try {
    const sys = `You are an image cataloguer for HUFT, a premium Indian pet care brand with sub-brands like Sara's Wholesome Food, Hearty, Meowsi, NutriWag, NutriMeow, Yakies, HUFT Spa, HUFT Originals, DashDog and more. Look at the image and identify what it shows for a marketing image library. Return ONLY JSON: {"product":"best-guess product or sub-brand, or '' if unclear","category":"one of: dry food, wet food, treats, chews, grooming, accessories, apparel, toys, supplements, lifestyle, packshot, other","tags":["6-12 short descriptive tags: subject, setting, colours, mood, pet type, composition"],"description":"one sentence describing what the image shows and how it could be used"}`;
    const out = await generateVision(sys, "Catalogue this image for our marketing library.", b64, mime);
    const parsed = JSON.parse(out.replace(/```json|```/g, "").trim().replace(/^[^[{]*/, ""));
    analysis = {
      product: parsed.product || "",
      category: parsed.category || "other",
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      description: parsed.description || "",
    };
  } catch (e) {
    console.error("Image analysis failed:", e.message);
    // Store anyway, without tags — better than losing the upload
  }

  try {
    const rows = await db(
      `INSERT INTO image_library (file_name, file_data, file_type, product, category, tags, description, notes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, file_name, file_type, product, category, tags, description, notes, uploaded_by, uploaded_at`,
      [file_name || null, file_data, mime, analysis.product, analysis.category,
       JSON.stringify(analysis.tags), analysis.description, notes || null, req.user.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List / search the library. ?q= free-text across product/category/tags/description.
// Metadata only by default (no base64) for speed; ?withData=1 to include image data.
app.get("/api/image-library", authMiddleware, async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  const cols = req.query.withData === "1"
    ? "id, file_name, file_data, file_type, product, category, tags, description, notes, uploaded_at"
    : "id, file_name, file_type, product, category, tags, description, notes, uploaded_at";
  try {
    let rows;
    if (q) {
      rows = await db(
        `SELECT ${cols} FROM image_library
         WHERE lower(coalesce(product,'')) LIKE $1
            OR lower(coalesce(category,'')) LIKE $1
            OR lower(coalesce(description,'')) LIKE $1
            OR lower(tags::text) LIKE $1
         ORDER BY uploaded_at DESC LIMIT 200`,
        [`%${q}%`]
      );
    } else {
      rows = await db(`SELECT ${cols} FROM image_library ORDER BY uploaded_at DESC LIMIT 200`);
    }
    res.json(rows.map(r => ({ ...r, tags: typeof r.tags === "string" ? (() => { try { return JSON.parse(r.tags); } catch { return []; } })() : (r.tags || []) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fetch a single image's full data (for preview / download)
app.get("/api/image-library/:id", authMiddleware, async (req, res) => {
  try {
    const rows = await db("SELECT * FROM image_library WHERE id=$1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const r = rows[0];
    res.json({ ...r, tags: typeof r.tags === "string" ? JSON.parse(r.tags) : (r.tags || []) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update tags/product/notes manually (admin/brand can correct the AI)
app.put("/api/image-library/:id", authMiddleware, roles("admin", "brand"), async (req, res) => {
  const sets = [], vals = []; let i = 1;
  for (const k of ["product", "category", "description", "notes"]) {
    if (req.body[k] !== undefined) { sets.push(`${k}=$${i++}`); vals.push(req.body[k]); }
  }
  if (req.body.tags !== undefined) { sets.push(`tags=$${i++}`); vals.push(JSON.stringify(req.body.tags)); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  try { await db(`UPDATE image_library SET ${sets.join(",")} WHERE id=$${i}`, vals); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/image-library/:id", authMiddleware, roles("admin", "brand"), async (req, res) => {
  try { await db("DELETE FROM image_library WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Smart suggest for the design prompt: given a campaign's product/brief, return relevant images.
app.get("/api/image-library-suggest/:campaignId", authMiddleware, async (req, res) => {
  try {
    const crows = await db("SELECT product, objective, audience_label, data FROM campaigns WHERE id=$1", [req.params.campaignId]);
    if (!crows.length) return res.json([]);
    const c = crows[0];
    const product = (c.product || "").toLowerCase();
    // Pull candidate images: same product first, then broaden
    const all = await db("SELECT id, file_name, product, category, tags, description, uploaded_at FROM image_library ORDER BY uploaded_at DESC LIMIT 300");
    const norm = (r) => ({ ...r, tags: typeof r.tags === "string" ? (() => { try { return JSON.parse(r.tags); } catch { return []; } })() : (r.tags || []) });
    const scored = all.map(norm).map(img => {
      let score = 0;
      const ip = (img.product || "").toLowerCase();
      if (product && ip && (ip.includes(product) || product.includes(ip))) score += 5;
      const hay = (img.category + " " + (img.tags || []).join(" ") + " " + (img.description || "")).toLowerCase();
      (product.split(/\s+/).filter(Boolean)).forEach(w => { if (w.length > 2 && hay.includes(w)) score += 1; });
      (String(c.objective || "").toLowerCase().split(/\W+/).filter(w => w.length > 3)).forEach(w => { if (hay.includes(w)) score += 0.5; });
      return { img, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 12).map(x => x.img);
    res.json(scored);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PERFORMANCE REPORTS ───────────────────────────────────────────────────────

app.get("/api/reports", authMiddleware, async (req, res) => {
  try {
    let sql = "SELECT id,campaign_id,report_month,file_name,file_type,notes,metrics,uploaded_by,uploaded_at FROM performance_reports";
    const vals = [];
    if (req.query.campaign_id) { sql += " WHERE campaign_id=$1"; vals.push(req.query.campaign_id); }
    else if (req.query.month)  { sql += " WHERE report_month=$1"; vals.push(req.query.month); }
    sql += " ORDER BY uploaded_at DESC" + (vals.length ? "" : " LIMIT 100");
    res.json(await db(sql, vals));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/reports", authMiddleware, async (req, res) => {
  const { campaign_id, report_month, file_name, file_data, file_type, notes, metrics } = req.body;
  if (!campaign_id || !report_month) return res.status(400).json({ error: "campaign_id and report_month required" });
  try {
    const rows = await db(
      `INSERT INTO performance_reports
       (id,campaign_id,report_month,file_name,file_data,file_type,notes,metrics,uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,campaign_id,report_month,file_name,file_type,notes,metrics,uploaded_by,uploaded_at`,
      [uid(), campaign_id, report_month, file_name||null, file_data||null,
       file_type||null, notes||null, metrics ? JSON.stringify(metrics) : null, req.user.id]
    );
    await db("UPDATE campaigns SET went_live_at=COALESCE(went_live_at,NOW()) WHERE id=$1", [campaign_id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/reports/:id", authMiddleware, roles("admin","business"), async (req, res) => {
  try { await db("DELETE FROM performance_reports WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GENERATE ──────────────────────────────────────────────────────────────────

app.post("/api/generate", authMiddleware, async (req, res) => {
  const { system = "", prompt = "" } = req.body;
  try {
    const text = await generate(system, prompt);
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Manual rules seed endpoint ───────────────────────────────────────────────
app.post("/api/rules/seed", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  try {
    await pool.query("DELETE FROM rules"); // wipe and reseed
    const copyRules = [
      "British English only — colour not color, favour not favor.",
      "Write like a human. Natural sentences, clear language, emotion where appropriate.",
      "Clarity first, warmth second, cleverness only if clarity stays intact.",
      "Say \"pet parents\" never \"consumers\" in copy body.",
      "Use \"furry family\" not \"furry friend\". Never \"fur baby\".",
      "Words to avoid: premium, luxury, cutting-edge, state-of-the-art, revolutionary, game-changing.",
      "Never shame pet parents for feeding choices or care mistakes. Always guide kindly.",
      "No fear-based messaging. No exaggerated claims.",
      "No medical or cure claims. Use \"supportive\", \"gentle\", \"vet-aware\" instead.",
      "Never invent prices or discounts. Write \"Rs.XX [confirm]\" as placeholder.",
      "WhatsApp body: 1 warm opener → 3–5 ✓ bullets → short sign-off → one CTA.",
      "Emoji: max 1–2 per asset. Never decorative emoji strings.",
      "Push title: MAX 50 characters. Push body: MAX 90 characters, one sentence.",
      "Retail CRM: NO website or app deep links. Lead with store experience.",
      "D2C CRM: app deep links and website URLs are fine.",
      "One message rule — one clear takeaway per asset.",
      "Sara\'s tone: nurturing, expert, warm. \"Real Food. Real Love.\"",
      "Hearty tone: reliable, accessible. \"Made with all our heart.\"",
      "Meowsi tone: witty, sophisticated, feline-first.",
      "HUFT Spa tone: reassuring, gentle. \"Grooming that feels like care.\"",
    ];
    const promptRules = [
      "Always feature real Indian dog or cat breeds — Indie, Lab, Golden, Persian.",
      "Pet must be the emotional hero of the frame. Product supports, never dominates.",
      "Real pet moments — genuine joy, curiosity, comfort. No posed stock-photo looks.",
      "Show correct pack proportions and label orientation. No distorted packaging.",
      "No added text overlaid on product pack in the generated image.",
      "Warm, natural lighting. Avoid harsh studio strobes or clinical white backgrounds.",
      "Indian home or lifestyle context preferred — warm interiors, natural textures.",
      "Leave visual negative space on one side for text/headline overlay in post.",
      "Negative prompt always include: distorted faces, extra limbs, blurry text, watermark, oversaturated.",
      "For FLUX: photorealistic style, natural depth of field. Specify Indian breed explicitly.",
    ];
    for (const text of copyRules) {
      await pool.query("INSERT INTO rules (type, text, active) VALUES ($1,$2,$3)", ["copy", text, true]);
    }
    for (const text of promptRules) {
      await pool.query("INSERT INTO rules (type, text, active) VALUES ($1,$2,$3)", ["prompt", text, true]);
    }
    res.json({ seeded: copyRules.length + promptRules.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Manual audiences seed endpoint ──────────────────────────────────────────
app.post("/api/audiences/seed", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  try {
    await pool.query("DELETE FROM audiences WHERE created_by IS NULL"); // wipe system-seeded only
    await seedAudiences();
    const { rows } = await pool.query("SELECT COUNT(*) FROM audiences");
    res.json({ seeded: parseInt(rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  try {
    await pool.query("SELECT 1");
    console.log("✓ Supabase / PostgreSQL connected");
  } catch (e) {
    console.error("✗ Database connection failed:", e.message);
    console.error("  Check DATABASE_URL in your .env file");
  }
  await seedRules();
  await seedAudiences();
  console.log(`\n  HUFT CRM Creative Engine`);
  console.log(`  Running:  http://localhost:${PORT}`);
  console.log(`  Database: Supabase / PostgreSQL`);
  console.log(`  LLM:      ${PROVIDER === "gemini" ? "Gemini " + GEMINI_MODEL : PROVIDER === "claude" ? "Claude " + CLAUDE_MODEL : "MOCKED (add API key)"}\n`);
});
