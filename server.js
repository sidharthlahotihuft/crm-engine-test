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

const app  = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || "huft-crm-dev-secret-change-in-prod";

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

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


// ── Rules auto-seed ───────────────────────────────────────────────────────────
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
        CASE c.stage WHEN 'brief' THEN 1 WHEN 'content' THEN 2 WHEN 'design' THEN 3 ELSE 4 END,
        c.updated_at DESC
    `);
    // Ensure data field is always a parsed object
    res.json(rows.map(r => ({
      ...r,
      data: r.data
        ? (typeof r.data === 'string' ? JSON.parse(r.data) : r.data)
        : {}
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/campaigns", authMiddleware, async (req, res) => {
  const { name, channel, product, audience_id, audience_label, segment,
          objective, offer, crm_type } = req.body;
  const id = uid();
  try {
    const rows = await db(
      `INSERT INTO campaigns
       (id,name,channel,product,audience_id,audience_label,segment,objective,offer,crm_type,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, name||"", channel||"WhatsApp", product||"", audience_id||null,
       audience_label||"", segment||"", objective||"", offer||"", crm_type||"D2C", req.user.id]
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
  ];
  const special = { copy_approver: null, design_approver: null };

  try {
    const sets = [];
    const vals = [];
    let i = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        sets.push(`${key}=$${i++}`);
        vals.push(key === "data" ? JSON.stringify(req.body[key]) : req.body[key]);
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

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

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
  console.log(`\n  HUFT CRM Creative Engine`);
  console.log(`  Running:  http://localhost:${PORT}`);
  console.log(`  Database: Supabase / PostgreSQL`);
  console.log(`  LLM:      ${PROVIDER === "gemini" ? "Gemini " + GEMINI_MODEL : PROVIDER === "claude" ? "Claude " + CLAUDE_MODEL : "MOCKED (add API key)"}\n`);
});
