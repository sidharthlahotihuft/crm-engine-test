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

app.use(express.json({ limit: "25mb" }));
// gzip responses (the image backfill compresses ~70%). Guarded: no-ops until `npm i compression`.
try { app.use(require("compression")()); } catch (e) { console.warn("compression not installed — run: npm i compression"); }
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
const safeJson = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

// ── HARDEST RULES (server-enforced, cannot be skipped) ───────────────────────
// 1) Forbidden tokens (M-hash + unfilled merge/template placeholders) must NEVER
//    appear in any generated copy. 2) Hard length caps per field.
// Applied to every /api/generate copy response, regardless of client path.
const stripForbidden = (s) => {
  if (typeof s !== "string") return s;
  let out = s;
  const SEP = "[\\s\\-_.\\u2010\\u2011\\u2012\\u2013\\u2014\\u2212]?"; // space, hyphen, underscore, dot, unicode dashes
  out = out.replace(new RegExp("\\bm" + SEP + "hash\\b", "gi"), "");  // M-hash / m hash / mhash / M–hash
  out = out.replace(new RegExp("\\bm" + SEP + "#", "gi"), "");         // M# / M-#
  out = out.replace(/#\s*m\b/gi, "");                                  // #M
  out = out.replace(/\{\{[^}]*\}\}/g, "");                             // {{1}}, {{name}}
  out = out.replace(/\{[A-Za-z0-9_ .#-]{1,30}\}/g, "");               // {name}, {M-hash}
  out = out.replace(/#[A-Z0-9_]{2,30}#/gi, "");                        // #VAR#, #MOBILE#
  out = out.replace(/\[[A-Za-z][A-Za-z0-9_ .#-]{1,30}\]/g, "");       // [VARIABLE]
  out = out.replace(/[<\u2039][A-Za-z][A-Za-z0-9_ .#-]{1,30}[>\u203A]/g, ""); // <VAR>
  out = out.replace(/[(\[\{][\s,.;:\u2013\u2014-]*[)\]\}]/g, "");     // empty () [] {} left behind
  // Remove opt-out / unsubscribe / "reply STOP" boilerplate — the platform handles this, it is never creative copy.
  out = out.replace(/[^.!?\n]*\b(?:opt[\s-]?out|unsubscribe)\b[^.!?\n]*[.!?]?/gi, "");
  out = out.replace(/[^.!?\n]*\breply\s+stop\b[^.!?\n]*[.!?]?/gi, "");
  out = out.replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?])/g, "$1").replace(/\s+([,.])/g, "$1").replace(/^[\s,;:]+/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return out;
};
const deepStrip = (v) => {
  if (typeof v === "string") return stripForbidden(applyBrandRules(v));
  if (Array.isArray(v)) return v.map(deepStrip);
  if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = deepStrip(v[k]); return o; }
  return v;
};
// British English + banned-term substitutions — mechanical, high-confidence, applied to every copy string.
const BRIT_MAP = { color:"colour",colors:"colours",colored:"coloured",coloring:"colouring",colorful:"colourful",
  flavor:"flavour",flavors:"flavours",flavored:"flavoured",flavorful:"flavourful",
  favorite:"favourite",favorites:"favourites",favor:"favour",favors:"favours",favorable:"favourable",
  realize:"realise",realized:"realised",realizes:"realises",realizing:"realising",
  organize:"organise",organized:"organised",organizing:"organising",
  personalize:"personalise",personalized:"personalised",personalizing:"personalising",
  recognize:"recognise",recognized:"recognised",prioritize:"prioritise",prioritized:"prioritised",
  center:"centre",centers:"centres",centered:"centred",
  traveling:"travelling",traveled:"travelled",traveler:"traveller",
  catalog:"catalogue",catalogs:"catalogues",fiber:"fibre",fibers:"fibres",
  odor:"odour",odors:"odours",behavior:"behaviour",neighbor:"neighbour",fulfill:"fulfil",
  apologize:"apologise",apologized:"apologised",customize:"customise",customized:"customised" };
const applyBrandRules = (s) => {
  if (typeof s !== "string") return s;
  let out = s.replace(/[A-Za-z]+/g, (w) => {
    const rep = BRIT_MAP[w.toLowerCase()];
    if (!rep) return w;
    if (w === w.toUpperCase()) return rep.toUpperCase();
    if (w[0] === w[0].toUpperCase()) return rep[0].toUpperCase() + rep.slice(1);
    return rep;
  });
  // Brand-banned terms → approved language (HUFT voice)
  out = out.replace(/\bfur[\s-]?bab(?:y|ies)\b/gi, "furry family");
  out = out.replace(/\bfurry friends?\b/gi, "furry family");
  out = out.replace(/\bconsumers\b/gi, "pet parents").replace(/\bconsumer\b/gi, "pet parent");
  return out;
};
// Truncate to a hard char cap on a word boundary, no mid-word cut, no dangling punctuation.
const clampLen = (s, max) => {
  if (typeof s !== "string" || !max || s.length <= max) return s;
  let t = s.slice(0, max);
  const sp = t.lastIndexOf(" ");
  if (sp > max * 0.55) t = t.slice(0, sp);
  return t.replace(/[\s,;:.\u2013\u2014-]+$/, "").trim();
};
// Universal safe maxima always applied; `limits` (from the client, channel-aware) tightens them.
const HARD_MAX = { subject: 60, cta: 30, headerLine: 64 };
const enforceCopyLimits = (opt, L) => {
  if (!opt || typeof opt !== "object") return opt;
  const o = { ...opt };
  if (typeof o.subject === "string") o.subject = clampLen(o.subject, Math.min(L.subject || 1e9, HARD_MAX.subject));
  if (typeof o.cta === "string") o.cta = clampLen(o.cta, Math.min(L.cta || 1e9, HARD_MAX.cta));
  if (typeof o.header === "string") o.header = o.header.split(/\r?\n/).map(ln => clampLen(ln, Math.min(L.header || 1e9, HARD_MAX.headerLine))).join("\n");
  if (L.body && typeof o.body === "string") o.body = clampLen(o.body, L.body); // body cap only when the client knows the channel (e.g. push 90)
  return o;
};
// The single chokepoint: strip forbidden tokens everywhere + clamp lengths.
const enforceCopyHardRules = (text, limits) => {
  let parsed = null;
  try { parsed = JSON.parse(text); }
  catch (e) { const m = text && text.match(/[\[{][\s\S]*[\]}]/); if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} } }
  if (parsed !== null && typeof parsed === "object") {
    let p = deepStrip(parsed);
    const L = limits || {};
    p = Array.isArray(p) ? p.map(o => enforceCopyLimits(o, L)) : enforceCopyLimits(p, L);
    return JSON.stringify(p);
  }
  return stripForbidden(text); // plain-text response → still strip forbidden tokens
};
// ── Review pass (warn, don't auto-correct) ───────────────────────────────────
// A cheap, cold second pass (Gemini Flash) that FLAGS possible language errors without
// changing the copy. The rulebook is passed in so intentional brand choices (e.g. "furry
// family", "pet parents", punchy headline fragments) are NOT flagged. Each flagged option
// gets a `_warn` array [{field,issue,suggestion}] which the UI shows with an Allow / Apply choice.
// Fails safe: any error leaves the copy untouched and unflagged.
const REVIEW_SYS =
  "You are a careful copy reviewer for HUFT, an Indian pet-care brand. You receive a JSON array of "
+ "marketing-copy options. DO NOT rewrite or change any copy. Only REVIEW it and report issues so a human can decide. "
+ "Flag TWO kinds of problem:\n"
+ "A) LANGUAGE ERRORS: broken or incomplete sentences, sentence fragments (NEVER flag the 'header' field for being short — it is a deliberate poster headline), unfinished or non-parallel bullets, subject-verb/agreement errors, wrong or awkward tense (in win-back/re-order copy, a past tense that implies the pet is gone, e.g. 'the food they loved'), double possessives, awkward word order, and clear typos.\n"
+ "B) HUFT RULEBOOK VIOLATIONS — flag only when clearly present:\n"
+ "  - Title Case used where sentence case is required (headlines, body, WhatsApp). Suggest sentence case. KEEP capitalised and do NOT flag: sub-brand names (Sara's Wholesome Food, NutriMeow, Meowsi), product category labels (Dog Food), event names (Mother's Day), and city names.\n"
+ "  - The discount CODE or the offer leads the copy ('use code'/the code/the % in the first line, before any hook or product). The hook or product must lead; the code belongs last. Suggest a version that opens on the hook.\n"
+ "  - A discount/offer with NO reason-to-believe anywhere (every discount needs a product reason — an ingredient/quality/format proof). Suggest adding the product reason.\n"
+ "  - Disease-prevention or medical claims (e.g. 'prevents gum disease', 'cures'): suggest a supportive phrasing ('helps support oral hygiene').\n"
+ "  - BANNED words/phrases: 'pampering'/'pamper' (Spa) -> 'expert grooming'/'gentle care'; for Meowsi a specific 'named meat' instead of 'human-grade chicken and fish'/'real muscle meat'/the protein name; 'novel proteins' -> 'gut-first, gentle nutrition'; bone broth called a 'super snack' -> 'hydration they'll actually love'; 'feline'/'canine' -> 'cat'/'dog'; for Hearty 'kibble' -> 'food'; a standalone 'Shop' heading; repeating the brand name in text when the context already has it.\n"
+ "  - YAKIES, HARD RULE: if the copy is for Yakies and mentions 'milk' (cow or yak), ALWAYS flag it — milk must never appear. Suggest the same line with the milk reference removed.\n"
+ "  - HUFT Spa copy that does not lead to or carry the line 'in hands that understand' may be flagged once if it reads off-platform — but only if clearly generic; do not nitpick.\n"
+ "Be conservative — only flag clear, confident issues; when unsure, do NOT flag. Max value is precision, not volume. "
+ "NEVER flag: the 'header' field for being a short fragment; emojis; British spelling (colour, favourite, centre); Hinglish that reads naturally (e.g. 'Garmi', 'cats ki asli diet'); or anything the ALLOWED BRAND RULES below permit. "
+ "Do NOT flag these (they are auto-corrected downstream): 'Rs'/'Rs.' vs the rupee sign, missing thousands commas, multiple '!', a full stop before an emoji, Bangalore vs Bengaluru, T&Cs formatting, 'Applicable' vs 'Valid', a leading 'FLAT', or 'fur baby'/'furball'. "
+ "Return ONLY JSON: {\"warnings\":[{\"i\":<option index number>,\"field\":\"body|header|subject|cta\",\"issue\":\"<=10 word description\",\"suggestion\":\"the corrected version of just that field\"}]}. "
+ "If there are no real issues, return {\"warnings\":[]}.";
async function reviewCopy(text, ruleStr) {
  const parse = (s) => { try { return JSON.parse(s); } catch (_) { const m = s && s.match(/[\[{][\s\S]*[\]}]/); if (m) { try { return JSON.parse(m[0]); } catch (__) {} } return null; } };
  const parsed = parse(text);
  if (parsed === null || typeof parsed !== "object") return text;
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  try {
    const sys = REVIEW_SYS + (ruleStr ? "\n\nALLOWED BRAND RULES (never flag anything these permit):\n" + ruleStr : "");
    const raw = await generate(sys, JSON.stringify(arr), "gemini", 0.2); // cheap Flash, cold — never Opus
    const rev = parse(raw);
    const warns = Array.isArray(rev && rev.warnings) ? rev.warnings : (Array.isArray(rev) ? rev : []);
    arr.forEach((o, i) => {
      if (!o || typeof o !== "object") return;
      const w = warns
        .filter(x => x && Number(x.i) === i && (x.issue || x.suggestion))
        .map(x => ({ field: String(x.field || "body"), issue: String(x.issue || "").slice(0, 120), suggestion: typeof x.suggestion === "string" ? x.suggestion : "" }))
        .slice(0, 4);
      if (w.length) o._warn = w; else if (o._warn) delete o._warn;
    });
  } catch (e) { console.error("[review] skipped:", e.message); }
  return JSON.stringify(Array.isArray(parsed) ? arr : arr[0]);
}
const SERVER_BUILD = "v29.75s - Copy reviewer now also flags HUFT RULEBOOK violations (not just language errors): Title-case-where-sentence-case, code/offer leading before the hook, a discount with no RTB, disease/medical claims, banned words (pampering, named meat, novel proteins, bone-broth super-snack, feline/canine, Hearty 'kibble', standalone 'Shop'), and a HARD Yakies-milk flag. Still WARNS only (never auto-edits), stays conservative, and skips items the deterministic client fixer already auto-corrects. Plus v29.74s warns + v29.72s creative_requests self-heal + v29.71s claude log + v29.70s caching.";

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

// v29 role aliasing: old keys ↔ new keys, plus capability groups, so existing roles() guards keep working.
const ROLE_ALIAS = { admin: "super_admin", brand: "brand_lead", content: "brand_team", design: "design_team", business: "business" };
const normRole = (r) => ROLE_ALIAS[r] || r || "brand_team";
// When a guard names an OLD key, also let the matching NEW role(s) through (and vice-versa).
const ROLE_EQUIV = {
  admin: ["admin", "super_admin"], super_admin: ["admin", "super_admin"],
  brand: ["brand", "brand_lead"], brand_lead: ["brand", "brand_lead"],
  content: ["content", "brand_team"], brand_team: ["content", "brand_team"],
  design: ["design", "design_team", "design_lead"], design_team: ["design", "design_team"], design_lead: ["design", "design_lead"],
  business: ["business"],
  cxo: ["cxo"], head_marketing: ["head_marketing"],
};
const roles = (...allowed) => (req, res, next) => {
  const expanded = new Set();
  allowed.forEach(a => (ROLE_EQUIV[a] || [a]).forEach(x => expanded.add(x)));
  // a Brand Lead also satisfies any "brand" guard; Design Lead satisfies "design"; super_admin satisfies "admin"
  if (allowed.includes("design")) { expanded.add("design_lead"); }
  if (allowed.includes("brand")) { expanded.add("brand_lead"); }
  const ur = req.user.role;
  if (!expanded.has(ur) && !expanded.has(normRole(ur))) return res.status(403).json({ error: "Forbidden" });
  next();
};

// ── LLM provider ─────────────────────────────────────────────────────────────
const GEMINI_KEY   = process.env.GEMINI_API_KEY   || "";
const CLAUDE_KEY   = process.env.ANTHROPIC_API_KEY || "";
// Text/content generation provider. Default: prefer Gemini (uses GEMINI_API_KEY) so copy
// and briefs run on the Gemini key. Force a provider explicitly with LLM_PROVIDER=gemini|claude.
const _FORCED_PROVIDER = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
const PROVIDER = (_FORCED_PROVIDER === "claude" || _FORCED_PROVIDER === "gemini")
  ? _FORCED_PROVIDER
  : (GEMINI_KEY ? "gemini" : CLAUDE_KEY ? "claude" : "mock");
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
// Image generation uses a Gemini image model (works even if text PROVIDER is Claude).
// gemini-2.5-flash-image works today; gemini-2.5-flash-image retires Oct 2 2026 — swap to
// gemini-3.1-flash-image (Nano Banana 2) via env when ready, no code change needed.
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

// Text-to-image via Gemini. Returns a data URL (data:image/png;base64,...).
// aspectRatio is one of Gemini's supported ratios: 1:1, 4:5, 9:16, 16:9, 3:4, 4:3, etc.
async function generateImageFromPrompt(prompt, aspectRatio = "1:1", productImages = null) {
  if (!GEMINI_KEY) throw new Error("Image generation needs GEMINI_API_KEY in the server env.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const reqParts = [];
  const arr = Array.isArray(productImages) ? productImages : (productImages ? [productImages] : []);
  for (const pi of arr) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(String(pi));
    if (m) reqParts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  }
  reqParts.push({ text: prompt });
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: reqParts }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio } },
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("Gemini image error:", JSON.stringify(data));
    throw new Error(data.error?.message || "Gemini image error " + r.status);
  }
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData || p.inline_data);
  const inline = imgPart && (imgPart.inlineData || imgPart.inline_data);
  if (!inline?.data) {
    // Model sometimes returns a text refusal instead of an image
    const txt = parts.map(p => p.text || "").join(" ").trim();
    throw new Error(txt ? ("No image returned: " + txt.slice(0, 200)) : "No image returned by the model.");
  }
  const mime = inline.mimeType || inline.mime_type || "image/png";
  return `data:${mime};base64,${inline.data}`;
}

function pickProvider(want){
  let p = (want === "claude" || want === "gemini") ? want : PROVIDER;
  if (p === "claude" && !CLAUDE_KEY) p = GEMINI_KEY ? "gemini" : "mock";
  if (p === "gemini" && !GEMINI_KEY) p = CLAUDE_KEY ? "claude" : "mock";
  return p;
}
async function generate(system, prompt, providerOverride, temperature) {
  const PV = pickProvider(providerOverride);
  if (PV === "gemini") {
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
          temperature: typeof temperature === "number" ? temperature : 0.9,
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
  if (PV === "claude") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 4096,
        // Prompt caching: the big, stable system prompt (brand context + rules + voice + rulebook) is cached,
        // so repeat copy calls pay ~10% of input price on the cached prefix instead of the full rate.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || "Claude error");
    // Proof line: shows which model ran + caching activity. cache_read>0 means the cached system prompt was reused.
    const u = data.usage || {};
    console.log(`[claude] model=${CLAUDE_MODEL} in=${u.input_tokens||0} out=${u.output_tokens||0} cache_write=${u.cache_creation_input_tokens||0} cache_read=${u.cache_read_input_tokens||0}`);
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

// Idempotently add the researched best-practice copy rules to the live rulebook.
async function seedBestPractices() {
  const BEST = [
    "One objective, one CTA per message — never stack multiple offers or asks.",
    "Lead with the value the reader cares about — open with the benefit, not the setup.",
    "Tie every line to the brief's objective; cut anything that doesn't serve it.",
    "Write to one person, conversationally — use the name, plain language, no jargon.",
    "Strong first line that sparks curiosity; use action verbs (discover, switch, try, get).",
    "Short and scannable — no fluff, filler or repetition. Make the next step obvious.",
    "No ALL-CAPS words and no spammy phrasing; emojis sparingly, only where they add warmth.",
    "Image copy (the on-creative overlay / 'header') is a SHORT, FUN, punchy headline — 3-6 words, two short lines max, with real personality (playful, witty, warm). Never long, flat, generic or a literal restatement; the action goes in the CTA, the overlay's job is to make them feel something and stop scrolling.",
    "Every piece of copy must be ACTION-LED — give the reader a clear thing to do (tap, switch, try, shop, book, learn, save). Even awareness copy must drive an action, never just inform.",
    "Push notifications: the action must be in the FIRST line (the title). Every push — even an awareness one — drives an action; if the first line doesn't move the reader to act, rewrite it. Push has no image, so never write image/overlay copy or image RTBs for it.",
    "WhatsApp: a STRONG first line (hook) that earns the 'read more' tap → payoff → RTB/USP proof. Put the store/app/website action in the CTA field, not the body.",
    "Never include opt-out, unsubscribe or 'reply STOP' lines, or any channel/system boilerplate — that is handled by the platform, not the creative copy.",
    "Never output placeholder tokens or merge tags (e.g. 'M-hash', {{1}}, {name}) — write the real words.",
  ];
  try {
    const ex = await pool.query("SELECT text FROM rules WHERE type='copy'");
    const have = new Set(ex.rows.map(r => (r.text || "").trim()));
    let added = 0;
    for (const text of BEST) {
      if (!have.has(text.trim())) {
        await pool.query("INSERT INTO rules (type, text, active) VALUES ($1,$2,$3)", ["copy", text, true]);
        added++;
      }
    }
    if (added) console.log("✓ Best-practice copy rules added:", added);
  } catch (e) { console.error("Best-practice seed failed:", e.message); }
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
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, approval_slots: user.approval_slots || [], sub_brands: user.sub_brands || [] } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    const r = await db("SELECT id,name,email,role,approval_slots,sub_brands FROM users WHERE id=$1", [req.user.id]);
    if (r.length) return res.json({ ...req.user, ...r[0] });
    res.json(req.user);
  } catch (e) { res.json(req.user); }
});

// ── USERS ─────────────────────────────────────────────────────────────────────

app.get("/api/users", authMiddleware, roles("admin"), async (req, res) => {
  try {
    res.json(await db("SELECT id,name,email,role,approval_slots,sub_brands,created_at,last_login FROM users ORDER BY created_at DESC"));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/users", authMiddleware, roles("admin"), async (req, res) => {
  const { name, email, password, role, approval_slots, sub_brands } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "name, email, password required" });
  const validRoles = ["super_admin","cxo","head_marketing","brand_lead","brand_team","design_lead","design_team","business","admin","brand","content","design"];
  const userRole = validRoles.includes(role) ? role : "brand_team";
  const VALID_SLOTS = ["copy","design","asset","final"];
  const slots = Array.isArray(approval_slots) ? approval_slots.filter(s => VALID_SLOTS.includes(s)) : [];
  const brands = Array.isArray(sub_brands) ? sub_brands.filter(Boolean).map(String) : [];
  try {
    const hash = await bcrypt.hash(password, 10);
    const id = uid();
    await db(
      "INSERT INTO users (id,name,email,password,role,approval_slots,sub_brands) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, name, email.toLowerCase().trim(), hash, userRole, slots, brands]
    );
    res.json({ ok: true, id });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Email already exists" });
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/users/:id", authMiddleware, roles("admin"), async (req, res) => {
  const { name, role, password, approval_slots, sub_brands } = req.body;
  const validRoles = ["super_admin","cxo","head_marketing","brand_lead","brand_team","design_lead","design_team","business","admin","brand","content","design"];
  const VALID_SLOTS = ["copy","design","asset","final"];
  try {
    if (password) await db("UPDATE users SET password=$1 WHERE id=$2", [await bcrypt.hash(password, 10), req.params.id]);
    if (name)                      await db("UPDATE users SET name=$1     WHERE id=$2", [name, req.params.id]);
    if (role && validRoles.includes(role)) await db("UPDATE users SET role=$1 WHERE id=$2", [role, req.params.id]);
    if (Array.isArray(approval_slots)) await db("UPDATE users SET approval_slots=$1 WHERE id=$2", [approval_slots.filter(s => VALID_SLOTS.includes(s)), req.params.id]);
    if (Array.isArray(sub_brands))     await db("UPDATE users SET sub_brands=$1 WHERE id=$2", [sub_brands.filter(Boolean).map(String), req.params.id]);
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
             a.segment_code,
             u.name            AS created_by_name
      FROM   campaigns c
      LEFT JOIN audiences a ON c.audience_id = a.id
      LEFT JOIN users u ON u.id = c.created_by
      ORDER BY
        CASE c.stage WHEN 'brief' THEN 1 WHEN 'content' THEN 2 WHEN 'brand_review' THEN 3 WHEN 'design' THEN 4 ELSE 5 END,
        c.updated_at DESC
    `);
    const parse = (v, fb) => v == null ? fb : (typeof v === "string" ? (()=>{try{return JSON.parse(v);}catch{return fb;}})() : v);
    // Keep the list response light: drop heavy base64 image blobs (they're
    // backfilled by /api/campaign-images after first paint). Markers tell the UI an image exists.
    const stripImages = (d) => {
      if (!d || typeof d !== "object") return d;
      const out = { ...d };
      if (out.design && typeof out.design === "object") {
        const dz = { ...out.design };
        if (dz.finalFile && dz.finalFile.dataUrl) { dz.finalFile = { ...dz.finalFile, dataUrl: undefined, _stripped: true }; dz._hasFinal = true; }
        if (dz.generatedImage) { dz.generatedImage = undefined; dz._hasGenerated = true; }
        if (Array.isArray(dz.refImages) && dz.refImages.length) { dz._refCount = dz.refImages.length; dz.refImages = []; }
        out.design = dz;
      }
      return out;
    };
    res.json(rows.map(r => ({
      ...r,
      data: stripImages(parse(r.data, {})),
      rtbs: parse(r.rtbs, []),
      references: parse(r.references, []),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Image backfill — returns only the heavy base64 fields, fetched in the background
// after the (now slim) campaigns list, so initial load paints fast.
app.get("/api/campaign-images", authMiddleware, async (req, res) => {
  try {
    const rows = await db(`SELECT id, data FROM campaigns`);
    const parse = (v) => v == null ? {} : (typeof v === "string" ? (()=>{try{return JSON.parse(v);}catch{return {};}})() : v);
    const out = [];
    for (const r of rows) {
      const dz = (parse(r.data).design) || {};
      const img = {};
      if (dz.finalFile && dz.finalFile.dataUrl) img.finalFile = dz.finalFile;
      if (dz.generatedImage) img.generatedImage = dz.generatedImage;
      if (Array.isArray(dz.refImages) && dz.refImages.length) img.refImages = dz.refImages;
      if (Object.keys(img).length) out.push({ id: r.id, design: img });
    }
    res.json(out);
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
    "rtbs","references","category","copy_author",
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

app.delete("/api/campaigns/:id", authMiddleware, roles("admin","business","brand"), async (req, res) => {
  try { await db("DELETE FROM campaigns WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RULES ─────────────────────────────────────────────────────────────────────

app.get("/api/rules", authMiddleware, async (req, res) => {
  try { res.json(await db("SELECT * FROM rules ORDER BY created_at DESC")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Category routing rules (writer ↔ category) ──────────────────────────────
const CRM_CATEGORIES = ["cat edibles", "dog edibles", "lifestyle & spa", "litter"];
app.get("/api/category-rules", authMiddleware, async (req, res) => {
  try { res.json(await db("SELECT * FROM category_rules ORDER BY category")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Super-admin replaces the whole mapping. Body: { rules: [{category, user_id, user_email}] }
app.put("/api/category-rules", authMiddleware, roles("admin"), async (req, res) => {
  try {
    const rules = Array.isArray(req.body.rules) ? req.body.rules : [];
    await db("DELETE FROM category_rules", []);
    for (const r of rules) {
      if (!r.category || !r.user_id) continue;
      await db("INSERT INTO category_rules (id,category,user_id,user_email) VALUES ($1,$2,$3,$4)",
        [uid(), r.category, r.user_id, r.user_email || null]);
    }
    res.json(await db("SELECT * FROM category_rules ORDER BY category"));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// One-time seed of the default writer↔category mapping (super-admin).
app.post("/api/category-rules/seed", authMiddleware, roles("admin"), async (req, res) => {
  try {
    const wanted = [
      { email: "arushi.mathur@headsupfortails.com", cats: ["cat edibles", "litter"] },
      { email: "ritika.sharma@headsupfortails.com", cats: ["dog edibles"] },
      { email: "isha.ray@headsupfortails.com", cats: ["lifestyle & spa"] },
    ];
    await db("DELETE FROM category_rules", []);
    for (const w of wanted) {
      const u = await db("SELECT id,email FROM users WHERE email=$1", [w.email]);
      if (!u.length) continue;
      for (const cat of w.cats) {
        await db("INSERT INTO category_rules (id,category,user_id,user_email) VALUES ($1,$2,$3,$4)",
          [uid(), cat, u[0].id, u[0].email]);
      }
    }
    res.json(await db("SELECT * FROM category_rules ORDER BY category"));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const ctx = context === "design" ? "design" : context === "final" ? "final" : "copy";
    const rows = await db(
      `INSERT INTO comments (campaign_id, context, parent_id, body, author_id, author_name, author_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, ctx, parent_id || null,
       body.trim(), req.user.id, req.user.name, req.user.role]
    );
    const exec = ["cxo", "head_marketing"].includes(req.user.role);
    if (exec || ctx === "final") {
      const who = req.user.name + " (" + (req.user.role || "exec").replace("_", " ") + ")";
      notify({ toRole: "brand_lead", campaignId: req.params.id, kind: "Comment on final asset",
        body: who + ": " + body.trim().slice(0, 240) });
      notify({ toRole: "design_lead", campaignId: req.params.id, kind: "Comment on final asset",
        body: who + ": " + body.trim().slice(0, 240) });
    }
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
    const prod = rows[0].product || rows[0].name || "An asset";
    notify({ toRole: "design_team", campaignId: req.params.id, kind: "Copy approved — design needed",
      body: prod + " — copy approved by " + req.user.name + ". Ready for design." });
    notify({ toRole: "design_lead", campaignId: req.params.id, kind: "Copy approved — design needed",
      body: prod + " — copy approved. Design can begin." });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Brand lead sends copy back to the content team with required changes
app.post("/api/campaigns/:id/brand-reject", authMiddleware, roles("brand", "admin"), async (req, res) => {
  try {
    const reason = (req.body.reason && req.body.reason.trim()) ? req.body.reason.trim() : "";
    const rows = await db(
      `UPDATE campaigns SET stage='content', copy_approver=NULL,
         data = COALESCE(data,'{}'::jsonb) || jsonb_build_object('selectedCopyIdx', null, 'sentBack', true, 'lastRejectReason', $2::text, 'sentBackBy', $3::text, 'sentBackAt', $4::text)
       WHERE id=$1 AND stage='brand_review' RETURNING *`,
      [req.params.id, reason, req.user.name || "", new Date().toISOString()]
    );
    if (!rows.length) return res.status(409).json({ error: "Campaign is not awaiting brand review." });
    // The reason is already surfaced to the writer in the "Revision needed" banner
    // (stored as lastRejectReason). Only drop a thread breadcrumb when NO reason was
    // typed, so the same text isn't echoed twice. Notify either way.
    if (!reason) {
      await db(
        `INSERT INTO comments (campaign_id, context, body, author_id, author_name, author_role)
         VALUES ($1,'copy',$2,$3,$4,$5)`,
        [req.params.id, "Sent back to copy for changes — see comments above.", req.user.id, req.user.name, req.user.role]
      );
    }
    notify({ toRole: "brand_team", campaignId: req.params.id, kind: "Copy sent back",
      body: (rows[0].product || rows[0].name || "An asset") + " — " + (reason ? ("Sent back: " + reason) : "Sent back for changes") });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─────────────────────────────────────────────────────────────
// NOTIFICATIONS — in-app (DB) + optional email (nodemailer via SMTP_* env)
// In-app works out of the box. Email sends only if SMTP_HOST/USER/PASS are set.
// ─────────────────────────────────────────────────────────────
let _mailer = null, _mailerTried = false;
function getMailer() {
  if (_mailerTried) return _mailer;
  _mailerTried = true;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  try {
    const nodemailer = require("nodemailer");
    _mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: String(process.env.SMTP_SECURE || "false") === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  } catch (e) { console.error("nodemailer not available:", e.message); _mailer = null; }
  return _mailer;
}
async function sendEmail(to, subject, text) {
  const m = getMailer();
  if (!m || !to) return false;
  try {
    await m.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    return true;
  } catch (e) { console.error("email send failed:", e.message); return false; }
}
function roleEquivList(role) {
  const map = {
    brand_lead: ["brand", "brand_lead"], brand: ["brand", "brand_lead"],
    design_lead: ["design_lead"], design_team: ["design", "design_team"], design: ["design", "design_team"],
    brand_team: ["content", "brand_team"], super_admin: ["admin", "super_admin"],
    head_marketing: ["head_marketing"], cxo: ["cxo"], business: ["business"],
  };
  return map[role] || [role];
}
async function notify({ toRole, toUserIds, campaignId, kind, body, url }) {
  const made = [];
  try {
    let emails = [];
    if (toRole) {
      const id = uid();
      await db(`INSERT INTO notifications (id,to_role,campaign_id,kind,body,url) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, toRole, campaignId || null, kind || null, body || "", url || null]);
      made.push(id);
      const r = await db(`SELECT email FROM users WHERE role=ANY($1)`, [roleEquivList(toRole)]);
      emails = emails.concat(r.map(x => x.email).filter(Boolean));
    }
    if (Array.isArray(toUserIds) && toUserIds.length) {
      for (const u of toUserIds) {
        const id = uid();
        await db(`INSERT INTO notifications (id,to_user_id,campaign_id,kind,body,url) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, u, campaignId || null, kind || null, body || "", url || null]);
        made.push(id);
      }
      const r = await db(`SELECT email FROM users WHERE id=ANY($1)`, [toUserIds]);
      emails = emails.concat(r.map(x => x.email).filter(Boolean));
    }
    emails = [...new Set(emails)];
    if (emails.length) await sendEmail(emails.join(","), "[HUFT CRM] " + (kind || "Update"), body || "");
  } catch (e) { console.error("notify failed:", e.message); }
  return made;
}
app.get("/api/notifications", authMiddleware, async (req, res) => {
  try {
    const isAdmin = normRole(req.user.role) === "super_admin" || req.user.role === "admin";
    const rows = isAdmin
      ? await db(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100`)
      : await db(
          `SELECT * FROM notifications WHERE to_user_id=$1 OR to_role=ANY($2) ORDER BY created_at DESC LIMIT 100`,
          [req.user.id, roleEquivList(req.user.role)]
        );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/notifications/:id/read", authMiddleware, async (req, res) => {
  try { await db(`UPDATE notifications SET read=true WHERE id=$1`, [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/notifications/read-all", authMiddleware, async (req, res) => {
  try {
    const isAdmin = normRole(req.user.role) === "super_admin" || req.user.role === "admin";
    if (isAdmin) await db(`UPDATE notifications SET read=true`);
    else await db(`UPDATE notifications SET read=true WHERE to_user_id=$1 OR to_role=ANY($2)`,
      [req.user.id, roleEquivList(req.user.role)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/notify", authMiddleware, async (req, res) => {
  try {
    const { toRole, toUserIds, campaignId, kind, body, url } = req.body || {};
    const made = await notify({ toRole, toUserIds, campaignId, kind, body, url });
    res.json({ ok: true, created: made.length, emailConfigured: !!getMailer() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Daily team digest (cron) ──────────────────────────────────────────
// Emails every user the actions still waiting on them. Idempotent & safe to
// call repeatedly. Schedule once/day via Vercel Cron or Supabase pg_cron.
// Protect with CRON_SECRET env: header  x-cron-secret: <secret>  (or ?key=<secret>).
// No-ops silently if SMTP isn't configured. No schema change.
app.get("/api/cron/daily-digest", async (req, res) => {
  try {
    const secret = process.env.CRON_SECRET;
    const bearer = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (secret && req.get("x-cron-secret") !== secret && req.query.key !== secret && bearer !== secret)
      return res.status(401).json({ error: "unauthorized" });
    if (!getMailer()) return res.json({ ok: true, sent: 0, note: "SMTP not configured — no emails sent" });

    const users = await db(`SELECT id,name,email,role,approval_slots FROM users WHERE email IS NOT NULL AND email <> ''`);
    const rawCamps = await db(`SELECT id,name,product,stage,data,tat_brief_due,tat_content_due,tat_design_due FROM campaigns`);
    const camps = rawCamps.map(c => {
      const d = c.data ? (typeof c.data === "string" ? JSON.parse(c.data) : c.data) : {};
      return { label: c.product || c.name || "Untitled", stage: c.stage, d,
               tat_brief_due: c.tat_brief_due, tat_content_due: c.tat_content_due, tat_design_due: c.tat_design_due };
    }).filter(c => c.stage !== "done" && !c.d.archived);

    const now = new Date();
    const startToday = new Date(now); startToday.setHours(0,0,0,0);
    const endToday = new Date(now); endToday.setHours(23,59,59,999);
    const dueFlag = (c, field) => {
      const v = c[field]; const due = v ? new Date(v) : null;
      if (!due || isNaN(due.getTime())) return { rank: 2, prefix: "" };
      if (due < startToday) return { rank: 0, prefix: "[OVERDUE] " };
      if (due <= endToday)  return { rank: 1, prefix: "[TODAY] " };
      return { rank: 2, prefix: "" };
    };

    const APP = process.env.APP_URL || "https://crm-engine-test.vercel.app";
    const CAP = 40;
    let sent = 0;
    for (const u of users) {
      const role = normRole(u.role);
      const isAdmin = role === "super_admin" || u.role === "admin";
      const slots = Array.isArray(u.approval_slots) ? u.approval_slots : [];
      const holds = (s) => isAdmin || slots.includes(s);
      const tasks = [];
      const add = (label, c, field) => { const f = dueFlag(c, field); tasks.push({ rank: f.rank, text: f.prefix + label + " — " + c.label }); };

      if (role === "business") camps.filter(c => c.stage === "brief" && !c.d.brief).forEach(c => add("Write the brief", c, "tat_brief_due"));
      if (role === "brand_team") camps.filter(c => c.stage === "content" && !(c.d.copyOptions && c.d.selectedCopyIdx != null)).forEach(c => add("Write copy", c, "tat_content_due"));
      if (role === "design_team" || role === "design_lead") camps.filter(c => c.stage === "design" && !(c.d.design && (c.d.design.approvedPromptIdx != null || c.d.design.libraryPick || c.d.design.pendingApproval))).forEach(c => add("Build the design", c, "tat_design_due"));
      if (holds("copy")) camps.filter(c => c.stage === "brand_review").forEach(c => add("Approve copy", c, "tat_content_due"));
      if (holds("design")) camps.filter(c => c.stage === "design" && c.d.design && c.d.design.pendingApproval).forEach(c => add("Approve design", c, "tat_design_due"));
      if (holds("asset")) camps.filter(c => c.stage === "design" && c.d.design && c.d.design.assetReview).forEach(c => add("Approve full asset", c, "tat_design_due"));
      if (holds("final")) camps.filter(c => c.stage === "design" && c.d.design && c.d.design.finalReview).forEach(c => add("Final sign-off", c, "tat_design_due"));

      const seen = new Set();
      const uniq = tasks.filter(t => (seen.has(t.text) ? false : (seen.add(t.text), true))).sort((a, b) => a.rank - b.rank);
      if (!uniq.length) continue;
      const overdue = uniq.filter(t => t.rank === 0).length;
      const today = uniq.filter(t => t.rank === 1).length;
      const shown = uniq.slice(0, CAP).map(t => t.text);
      const extra = uniq.length - shown.length;
      const head = (overdue || today) ? ("You have " + (overdue ? overdue + " overdue" : "") + (overdue && today ? " and " : "") + (today ? today + " due today" : "") + ".\n\n") : "";
      const body = "Hi " + (u.name || "there") + ",\n\n" + head + "Here's what's waiting on you in the HUFT Creative Engine:\n\n• " + shown.join("\n• ") + (extra > 0 ? "\n• …and " + extra + " more" : "") + "\n\nOpen the CRM: " + APP + "\n\n— HUFT Creative Engine";
      try { await sendEmail(u.email, "[HUFT CRM] Your tasks today (" + uniq.length + (overdue ? ", " + overdue + " overdue" : "") + ")", body); sent++; }
      catch (e) { console.error("digest email failed for", u.email, e.message); }
    }
    res.json({ ok: true, users: users.length, sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─────────────────────────────────────────────────────────────
// GATED PIPELINE — design → full-asset → final sign-off
// Each gate checks the user holds the matching approval_slot (super_admin overrides).
// Gate state is tracked on campaigns.data.gates = {copy,design,asset,final}.
// ─────────────────────────────────────────────────────────────
async function userHoldsSlot(user, slot) {
  if (normRole(user.role) === "super_admin" || user.role === "admin") return true;
  const r = await db(`SELECT approval_slots FROM users WHERE id=$1`, [user.id]);
  const slots = (r[0] && r[0].approval_slots) || [];
  return slots.includes(slot);
}
function mergeGates(campaign, patch) {
  const data = campaign.data ? (typeof campaign.data === "string" ? JSON.parse(campaign.data) : campaign.data) : {};
  const gates = { ...(data.gates || {}), ...patch };
  return { data: { ...data, gates }, gates };
}
// Design gate — Anmol (design slot). design pendingApproval → asset review (Ilena).
app.post("/api/campaigns/:id/design-approve", authMiddleware, async (req, res) => {
  try {
    if (!(await userHoldsSlot(req.user, "design"))) return res.status(403).json({ error: "You don't hold the design-approval slot." });
    const cur = await db(`SELECT * FROM campaigns WHERE id=$1`, [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: "Not found" });
    const { data } = mergeGates(cur[0], { design: { by: req.user.name, at: new Date().toISOString() } });
    const d2 = { ...data, design: { ...(data.design || {}), pendingApproval: false, assetReview: true } };
    const rows = await db(`UPDATE campaigns SET data=$1, design_approver=$2, design_approved_at=NOW() WHERE id=$3 RETURNING *`,
      [JSON.stringify(d2), req.user.name, req.params.id]);
    const prod = cur[0].product || cur[0].name || "An asset";
    notify({ toRole: "brand_lead", campaignId: req.params.id, kind: "Full asset needs review",
      body: prod + " — design approved by " + req.user.name + ". Ready for full-asset sign-off." });
    notify({ toRole: "head_marketing", campaignId: req.params.id, kind: "Asset in approval (oversight)",
      body: prod + " — design approved by " + req.user.name + "; Ilena is finalising the full asset. For your oversight." });
    notify({ toRole: "cxo", campaignId: req.params.id, kind: "Asset in approval (oversight)",
      body: prod + " — design approved; full-asset sign-off in progress. For your oversight." });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Design gate send-back — Anmol returns the design to the design team with feedback (mirrors brand-reject for copy).
app.post("/api/campaigns/:id/design-reject", authMiddleware, async (req, res) => {
  try {
    if (!(await userHoldsSlot(req.user, "design"))) return res.status(403).json({ error: "You don't hold the design-approval slot." });
    const reason = (req.body.reason && req.body.reason.trim()) ? req.body.reason.trim() : "";
    const cur = await db(`SELECT * FROM campaigns WHERE id=$1`, [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: "Not found" });
    const data = (typeof cur[0].data === "string" ? safeJson(cur[0].data) : cur[0].data) || {};
    const d2 = { ...data, design: { ...(data.design || {}), pendingApproval: false, assetReview: false, sentBack: true, lastRejectReason: reason, sentBackBy: req.user.name || "", sentBackAt: new Date().toISOString() } };
    const rows = await db(`UPDATE campaigns SET data=$1, design_approver=NULL, design_approved_at=NULL WHERE id=$2 AND stage='design' RETURNING *`,
      [JSON.stringify(d2), req.params.id]);
    if (!rows.length) return res.status(409).json({ error: "Campaign is not in the design stage." });
    const prod = cur[0].product || cur[0].name || "An asset";
    notify({ toRole: "design_team", campaignId: req.params.id, kind: "Design sent back",
      body: prod + " — design sent back by " + (req.user.name || "the design lead") + (reason ? (": " + reason) : ". See the feedback on the design.") });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Full-asset gate — Ilena (asset slot). Her approval is the final gate → live. HoM/CXO are oversight only.
app.post("/api/campaigns/:id/asset-approve", authMiddleware, async (req, res) => {
  try {
    if (!(await userHoldsSlot(req.user, "asset"))) return res.status(403).json({ error: "You don't hold the full-asset-approval slot." });
    const cur = await db(`SELECT * FROM campaigns WHERE id=$1`, [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: "Not found" });
    const { data } = mergeGates(cur[0], { asset: { by: req.user.name, at: new Date().toISOString() } });
    const d2 = { ...data, design: { ...(data.design || {}), assetReview: false, finalReview: false } };
    const rows = await db(`UPDATE campaigns SET data=$1, stage='done', went_live_at=NOW() WHERE id=$2 RETURNING *`, [JSON.stringify(d2), req.params.id]);
    const prod = cur[0].product || cur[0].name || "An asset";
    notify({ toRole: "head_marketing", campaignId: req.params.id, kind: "Asset live (oversight)",
      body: prod + " — full asset approved by " + req.user.name + " and now live. For your oversight." });
    notify({ toRole: "cxo", campaignId: req.params.id, kind: "Asset live (oversight)",
      body: prod + " — approved by " + req.user.name + " and now live. For your oversight." });
    notify({ toRole: "business", campaignId: req.params.id, kind: "Asset finalized",
      body: prod + " — finalized and ready." });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Final gate — HoM / CXO (final slot). → done.
app.post("/api/campaigns/:id/final-approve", authMiddleware, async (req, res) => {
  try {
    if (!(await userHoldsSlot(req.user, "final"))) return res.status(403).json({ error: "You don't hold the final-sign-off slot." });
    const cur = await db(`SELECT * FROM campaigns WHERE id=$1`, [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: "Not found" });
    const { data } = mergeGates(cur[0], { final: { by: req.user.name, at: new Date().toISOString() } });
    const d2 = { ...data, design: { ...(data.design || {}), finalReview: false } };
    const rows = await db(`UPDATE campaigns SET data=$1, stage='done', went_live_at=NOW() WHERE id=$2 RETURNING *`,
      [JSON.stringify(d2), req.params.id]);
    const prod = cur[0].product || cur[0].name || "An asset";
    notify({ toRole: "brand_lead", campaignId: req.params.id, kind: "Asset finalized",
      body: prod + " — final sign-off by " + req.user.name + ". Now live/finalized." });
    notify({ toRole: "business", campaignId: req.params.id, kind: "Asset finalized",
      body: prod + " — finalized and ready." });
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
app.post("/api/image-library", authMiddleware, roles("admin", "brand", "design", "business"), async (req, res) => {
  const { file_name, file_data, file_type, notes, product, category, tags, description, dimensions_cm, kind, finish, light_direction, height_cm, width_cm, content_bbox, dominant_colors } = req.body;
  if (!file_data) return res.status(400).json({ error: "file_data required" });
  // Strip a data: URL prefix if present, to get raw base64 for the vision call
  const b64 = String(file_data).includes(",") ? String(file_data).split(",")[1] : String(file_data);
  const mime = file_type || (String(file_data).match(/^data:(.*?);/)?.[1]) || "image/jpeg";
  const k = ["product","asset","logo","mockup"].includes(kind) ? kind : null;
  const fin = ["matte","gloss","foil","plastic"].includes(finish) ? finish : null;
  const lightDir = ["left","right","front","top"].includes(light_direction) ? light_direction : null;
  const hCm = (height_cm != null && height_cm !== "" && !isNaN(Number(height_cm))) ? Number(height_cm) : null;
  const wCm = (width_cm != null && width_cm !== "" && !isNaN(Number(width_cm))) ? Number(width_cm) : null;
  const bbox = content_bbox ? (typeof content_bbox === "string" ? content_bbox : JSON.stringify(content_bbox)) : null;
  const colors = dominant_colors ? (typeof dominant_colors === "string" ? dominant_colors : JSON.stringify(dominant_colors)) : null;

  // 1) SAVE THE IMAGE FIRST — the upload must always land, even if AI tagging is slow/unavailable.
  let row;
  try {
    const rows = await db(
      `INSERT INTO image_library (file_name, file_data, file_type, product, category, tags, description, notes, dimensions_cm, kind, uploaded_by, finish, light_direction, height_cm, width_cm, content_bbox, dominant_colors)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id, file_name, file_type, product, category, tags, description, notes, dimensions_cm, kind, uploaded_by, uploaded_at, finish, light_direction, height_cm, width_cm, content_bbox, dominant_colors`,
      [file_name || null, file_data, mime, product || "", category || "",
       JSON.stringify(Array.isArray(tags) ? tags : []), description || "", notes || null,
       dimensions_cm || null, k, req.user.id, fin, lightDir, hCm, wCm, bbox, colors]
    );
    row = rows[0];
  } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json(row); // respond now — fast, no timeout risk

  // 2) BEST-EFFORT auto-tagging in the background (never blocks or fails the upload).
  if (!product) {
    (async () => {
      try {
        const sys = `You are an image cataloguer for HUFT, a premium Indian pet care brand with sub-brands like Sara's Wholesome Food, Hearty, Meowsi, NutriWag, NutriMeow, Yakies, HUFT Spa, HUFT Originals, DashDog and more. Look at the image and identify what it shows for a marketing image library. Return ONLY JSON: {"product":"best-guess product or sub-brand, or '' if unclear","category":"one of: dry food, wet food, treats, chews, grooming, accessories, apparel, toys, supplements, lifestyle, packshot, other","tags":["6-12 short descriptive tags: subject, setting, colours, mood, pet type, composition"],"description":"one sentence describing what the image shows and how it could be used","finish":"if this is a product pack, its surface finish: matte | gloss | foil | plastic — else ''","light_direction":"dominant key-light direction on the subject: left | right | front | top"}`;
        const out = await generateVision(sys, "Catalogue this image for our marketing library.", b64, mime);
        const parsed = JSON.parse(out.replace(/```json|```/g, "").trim().replace(/^[^[{]*/, ""));
        const pf = ["matte","gloss","foil","plastic"].includes(parsed.finish) ? parsed.finish : null;
        const pl = ["left","right","front","top"].includes(parsed.light_direction) ? parsed.light_direction : null;
        // Fill kind only if not already set: lifestyle scene → asset, transparent PNG → product packshot.
        const kindGuess = String(parsed.category || "").toLowerCase() === "lifestyle" ? "asset"
                        : String(mime || "").toLowerCase().includes("png") ? "product" : "asset";
        await db(
          `UPDATE image_library SET product=$1, category=$2, tags=$3, description=$4, finish=COALESCE(finish,$5), light_direction=COALESCE(light_direction,$6), kind=COALESCE(NULLIF(kind,''),$7) WHERE id=$8`,
          [parsed.product || "", parsed.category || "other",
           JSON.stringify(Array.isArray(parsed.tags) ? parsed.tags : []), parsed.description || "", pf, pl, kindGuess, row.id]
        );
      } catch (e) { console.error("Image analysis failed (image already saved):", e.message); }
    })();
  }
});

// Generate a background/scene image from a text prompt (Composer "Generate image").
// body: { prompt, negativePrompt?, aspectRatio? }  →  { image: dataURL }
app.post("/api/generate-image", authMiddleware, roles("admin", "brand", "design", "business"), async (req, res) => {
  const { prompt, negativePrompt, aspectRatio, productImages, textZone, productZone } = req.body || {};
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: "prompt required" });
  const imgs = Array.isArray(productImages) ? productImages.filter(Boolean) : [];
  const n = imgs.length;
  const tZone = (textZone && String(textZone).trim()) || "the upper or left part of the frame";
  const pZone = (productZone && String(productZone).trim()) || "the lower part of the frame";
  const textSpace = `Composition for a marketing creative: the headline, sub-headline and a button will be overlaid on ${tZone} — keep THAT area clean, calm and low-detail so overlaid text stays highly legible. Do NOT render any text, words, numbers, logos, badges or watermarks as part of the scene itself.`;
  const integrate = n
    ? `You are given ${n>1?`${n} product images`:"a product image"} as the FIRST input${n>1?"s":""}. Generate a single photograph that CLEARLY FEATURES ${n>1?"these exact products":"this exact product"} as the hero. ${n>1?"Each is a real retail package":"It is a real retail package"} (pouch / box / pack) — render the physical packaging itself standing in ${pZone}, not just its contents and not an empty bowl. REQUIRED: the ${n>1?"packs":"pack"} must be visibly present in the final image. Reproduce ${n>1?"each pack's":"the pack's"} design, layout, colours, sub-brand name and front artwork faithfully and UNCHANGED from the reference — do not redesign, relabel or distort. Integrate photorealistically: match the scene's lighting direction, colour temperature, shadows, reflections and perspective so it looks genuinely photographed in place, grounded with a soft natural contact shadow and correctly proportioned. Keep ${n>1?"the packs":"the pack"} crisp and unobstructed.`
    : "";
  let full = [integrate, n?"SCENE / BACKGROUND:":"", String(prompt), textSpace].filter(Boolean).join("\n\n");
  if (negativePrompt) full += `\n\nAvoid: ${negativePrompt}`;
  try {
    const image = await generateImageFromPrompt(full, aspectRatio || "1:1", imgs);
    res.json({ image, productsReceived: n });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Generative expand / smart-fill (outpaint): extend an image to fill a target aspect ratio.
app.post("/api/expand-image", authMiddleware, roles("admin", "brand", "design", "business"), async (req, res) => {
  const { image, aspectRatio, prompt, mode } = req.body || {};
  if (!image || !String(image).startsWith("data:")) return res.status(400).json({ error: "image (data URL) required" });
  const ar = aspectRatio || "1:1";
  const full = mode === "refine"
    ? `You are given ONE image that already fills a ${ar} frame. Part of it is a CRISP, in-focus photograph; the area around it is a BLURRY, stretched seed fill. Repaint ONLY the blurry/soft areas into a clean, photorealistic continuation of the crisp photo — extend the same background, surface, surroundings and textures outward so the entire frame reads as one seamless photograph. Keep every crisp, in-focus pixel EXACTLY as-is: do not move, crop, recolour, restyle or regenerate the sharp subject, and keep it in the SAME position. Seamlessly match lighting direction, colour temperature, grain, depth of field and perspective at the seams. Photorealistic. No added text, words, logos, badges, frames or watermarks.${prompt ? "\nScene note: " + String(prompt) : ""}`
    : `You are given ONE photograph as input. Extend it to completely fill a ${ar} frame using generative outpainting.
HARD RULES: keep the original photo's existing content EXACTLY as-is — do not move, crop, recolour, restyle, or regenerate any part that already exists; place it unchanged and centred. Paint MORE of the same scene outward into the new empty areas (continue the background, surface, surroundings, textures) so nothing looks cut off or bordered. Seamlessly match the lighting direction, colour temperature, grain, depth of field and perspective at the seams. Photorealistic. No added text, words, logos, badges, frames or watermarks.${prompt ? "\nScene note: " + String(prompt) : ""}`;
  try {
    const out = await generateImageFromPrompt(full, ar, [image]);
    res.json({ image: out });
  } catch (e) { res.status(502).json({ error: e.message }); }
});


// List / search the library. ?q= free-text across product/category/tags/description.
// Metadata only by default (no base64) for speed; ?withData=1 to include image data.
app.get("/api/image-library", authMiddleware, async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  const withData = req.query.withData === "1";
  const base = withData
    ? "id, file_name, file_data, file_type, product, category, tags, description, notes, dimensions_cm, kind, uploaded_at, last_used_at"
    : "id, file_name, file_type, product, category, tags, description, notes, dimensions_cm, kind, uploaded_at, last_used_at";
  const ext = base + ", finish, light_direction, height_cm, width_cm, content_bbox, dominant_colors";
  const run = (cols) => q
    ? db(`SELECT ${cols} FROM image_library
           WHERE lower(coalesce(product,'')) LIKE $1
              OR lower(coalesce(category,'')) LIKE $1
              OR lower(coalesce(description,'')) LIKE $1
              OR lower(tags::text) LIKE $1
           ORDER BY uploaded_at DESC LIMIT 2000`, [`%${q}%`])
    : db(`SELECT ${cols} FROM image_library ORDER BY uploaded_at DESC LIMIT 2000`);
  try {
    let rows;
    try { rows = await run(ext); }
    catch (e) { rows = await run(base); } // product-aware columns not migrated yet → still serve the library
    res.json(rows.map(r => ({ ...r, tags: typeof r.tags === "string" ? (() => { try { return JSON.parse(r.tags); } catch { return []; } })() : (r.tags || []) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stamp images as just-used so they rest (hidden from pickers) for a cooldown window
// Scene-aware placement: look at a generated EMPTY scene and report where N products naturally sit.
app.post("/api/scene-placement", authMiddleware, async (req, res) => {
  const { image, count } = req.body || {};
  if (!image) return res.status(400).json({ error: "image required" });
  const n = Math.min(3, Math.max(1, Math.round(Number(count) || 1)));
  const b64 = String(image).includes(",") ? String(image).split(",")[1] : String(image);
  const mime = (String(image).match(/^data:(.*?);/) || [])[1] || "image/png";
  const sys = "You are a product-photography compositor. The image is an EMPTY scene with NO product in it yet. Work in three steps before you answer. "
    + "STEP 1 — READ THE SCENE: find the main flat FOREGROUND surface a product can physically stand on (floor, rug, table, counter, ledge) and the GROUNDLINE — the y height in the lower part of the frame where that surface sits at standing distance from the camera. Note the camera perspective. "
    + "STEP 2 — FIND THE BUSY REGION: locate the main subject and clutter that must stay UNCOVERED (pet, person, plant, window, focal décor). Products must NOT sit on top of or in front of the main subject. "
    + "STEP 3 — PLACE " + n + " hero product" + (n>1?"s":"") + " standing ON that surface, base resting on the groundline you found, in the CLEAREST open part of the foreground, away from the busy region, at believable product eye-level scale (a pack is roughly knee-to-shin height in the scene, not tiny, not floor-to-ceiling). "
    + (n>1 ? "Spread them left-to-right along the SAME groundline with a small gap between each (they may touch slightly in depth but must not fully cover one another); give gentle depth so one can read a touch smaller/further. Larger packs read bigger. " : "")
    + "Return ONLY minified JSON: {\"items\":[{\"cx\":n,\"baseY\":n,\"w\":n}]} with EXACTLY " + n + " entries ordered left-to-right. cx = horizontal centre 0..1, baseY = where the product BASE meets the surface 0..1 (this MUST equal the real groundline you found — usually 0.74..0.95, never floating in mid-air), w = product WIDTH as a fraction of image width (about " + (n>1 ? "0.16..0.30 each" : "0.22..0.40") + "). No prose, JSON only.";
  const prompt = "Read this empty scene, find the foreground surface and the area to keep clear, then place " + n + " product" + (n>1?"s":"") + " grounded on that surface. JSON only.";
  try {
    const text = await generateVision(sys, prompt, b64, mime);
    const clean = String(text).replace(/```json|```/g, "").trim();
    const k = clean.search(/[{[]/);
    let parsed = JSON.parse(k >= 0 ? clean.slice(k) : clean);
    let items = Array.isArray(parsed) ? parsed : (parsed.items || [parsed]);
    items = items.slice(0, n).map(it => ({
      cx: Math.min(0.92, Math.max(0.08, Number(it.cx) || 0.5)),
      baseY: Math.min(0.97, Math.max(0.5, Number(it.baseY) || 0.86)),
      w: Math.min(0.55, Math.max(0.1, Number(it.w) || 0.3)),
    }));
    while (items.length < n) items.push({ cx: 0.3 + 0.4 * (items.length / Math.max(1, n)), baseY: 0.86, w: 0.28 });
    res.json({ items });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post("/api/image-library/mark-used", authMiddleware, async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(Boolean) : [];
  if (!ids.length) return res.json({ ok: true, updated: 0 });
  try {
    const rows = await db(`UPDATE image_library SET last_used_at=NOW() WHERE id::text = ANY($1::text[]) RETURNING id`, [ids]);
    res.json({ ok: true, updated: rows.length });
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
  for (const k of ["product", "category", "description", "notes", "finish", "light_direction", "height_cm", "width_cm", "dimensions_cm", "kind"]) {
    if (req.body[k] !== undefined) { sets.push(`${k}=$${i++}`); vals.push(req.body[k]); }
  }
  if (req.body.tags !== undefined) { sets.push(`tags=$${i++}`); vals.push(JSON.stringify(req.body.tags)); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  try { await db(`UPDATE image_library SET ${sets.join(",")} WHERE id=$${i}`, vals); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// One-time re-tag: re-derive `kind` for the whole library from reliable signals.
// Packshots are clean transparent PNGs; lifestyle/scene shots (cataloguer category "lifestyle") are JPEGs.
// Fixes bulk uploads that left kind null or mis-tagged scenes as products. Logos/mockups preserved.
app.post("/api/image-library/retag", authMiddleware, roles("admin"), async (req, res) => {
  try {
    const rows = await db(`UPDATE image_library SET kind = CASE
        WHEN lower(coalesce(kind,'')) = 'logo' THEN 'logo'
        WHEN lower(coalesce(kind,'')) = 'mockup' THEN 'mockup'
        WHEN lower(coalesce(category,'')) = 'logo' THEN 'logo'
        WHEN lower(coalesce(category,'')) = 'lifestyle' THEN 'asset'
        WHEN lower(coalesce(file_type,'')) LIKE '%png%' THEN 'product'
        ELSE 'asset'
      END RETURNING kind`);
    const counts = {};
    (rows || []).forEach(r => { const k = r.kind || "untagged"; counts[k] = (counts[k] || 0) + 1; });
    res.json({ ok: true, total: (rows || []).length, counts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reliable re-classify using vision — looks at each image and sets kind = product (clean packshot) /
// asset (lifestyle/scene) / logo. Batched: client calls repeatedly with offset until done=true.
app.post("/api/image-library/reclassify", authMiddleware, roles("admin"), async (req, res) => {
  const limit = Math.min(8, Math.max(1, parseInt(req.body && req.body.limit) || 6));
  const offset = Math.max(0, parseInt(req.body && req.body.offset) || 0);
  try {
    const total = (await db("SELECT count(*)::int AS n FROM image_library"))[0].n;
    const rows = await db("SELECT id, file_data, file_type FROM image_library ORDER BY uploaded_at DESC LIMIT $1 OFFSET $2", [limit, offset]);
    let changed = 0;
    const sys = "You classify a marketing image into exactly one kind. A 'packshot' is a clean product/packaging shot — just the pack (pouch, box, tin, bottle) on a plain or empty studio background, with NO pet, NO person, and NO real-world scene. A 'lifestyle' image shows a pet, a person/hand, or any real setting/scene (home, floor, outdoors, a bowl being eaten from, etc.) even if a product is also visible. A 'logo' is a brand logo or wordmark. Return ONLY JSON: {\"kind\":\"packshot\"|\"lifestyle\"|\"logo\"}.";
    for (const r of rows) {
      try {
        const m = /^data:([^;]+);base64,(.*)$/.exec(String(r.file_data) || "");
        if (!m) continue;
        const out = await generateVision(sys, "Classify this image.", m[2], m[1]);
        let parsed = {}; try { parsed = JSON.parse(out.replace(/```json|```/g, "").trim().replace(/^[^{]*/, "")); } catch (_) {}
        const w = String(parsed.kind || "").toLowerCase();
        const kind = w.includes("logo") ? "logo" : (w.includes("life") || w.includes("scene")) ? "asset" : w.includes("pack") ? "product" : null;
        if (kind) { await db("UPDATE image_library SET kind=$1 WHERE id=$2", [kind, r.id]); changed++; }
      } catch (e) { /* skip a bad image, keep going */ }
    }
    res.json({ ok: true, processed: rows.length, changed, offset, total, done: offset + rows.length >= total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/image-library/:id", authMiddleware, roles("admin", "brand"), async (req, res) => {
  try { await db("DELETE FROM image_library WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Smart suggest for the design prompt: given a campaign's product/brief, return relevant images.
// ===== Brand styles (per sub-brand: fonts per role + palette + logo) =====
app.get("/api/brand-styles", authMiddleware, async (req, res) => {
  try { res.json(await db("SELECT * FROM brand_styles ORDER BY sub_brand ASC")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/api/brand-styles/:subBrand", authMiddleware, async (req, res) => {
  if (!["super_admin","brand_lead","design_lead","admin","brand","design"].includes(normRole(req.user.role)) && !["super_admin","brand_lead","design_lead","admin","brand","design"].includes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const sb = req.params.subBrand;
  const { headline_font, subhead_font, cta_font, bg, text_color, cta_color, logo_id, notes } = req.body;
  try {
    const rows = await db(
      `INSERT INTO brand_styles (sub_brand, headline_font, subhead_font, cta_font, bg, text_color, cta_color, logo_id, notes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (sub_brand) DO UPDATE SET
         headline_font=$2, subhead_font=$3, cta_font=$4, bg=$5, text_color=$6, cta_color=$7, logo_id=$8, notes=$9, updated_at=NOW()
       RETURNING *`,
      [sb, headline_font||null, subhead_font||null, cta_font||null, bg||null, text_color||null, cta_color||null, logo_id||null, notes||null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/brand-styles/:subBrand", authMiddleware, async (req, res) => {
  if (!["super_admin","brand_lead","design_lead","admin","brand","design"].includes(normRole(req.user.role)) && !["super_admin","brand_lead","design_lead","admin","brand","design"].includes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  try { await pool.query("DELETE FROM brand_styles WHERE sub_brand=$1", [req.params.subBrand]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Creative requests: business/content escalate "needs a generation" to the design team ----
app.post("/api/creative-requests", authMiddleware, async (req, res) => {
  const { campaign_id, title, details, comment, size, payload } = req.body || {};
  try {
    const id = uid();
    const rows = await db(
      `INSERT INTO creative_requests (id,campaign_id,title,details,comment,size,payload,requested_by,requester_name,requester_role,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open') RETURNING *`,
      [id, campaign_id || null, (title || "Creative help").slice(0, 200), details || null,
       comment || null, size || null, payload ? JSON.stringify(payload) : null,
       req.user.id, req.user.name, req.user.role]
    );
    // in-app notification: drop a note into the campaign's design thread (best-effort)
    if (campaign_id) {
      try {
        await db(
          `INSERT INTO comments (campaign_id, context, body, author_id, author_name, author_role)
           VALUES ($1,'design',$2,$3,$4,$5)`,
          [campaign_id, `🎨 Design generation requested by ${req.user.name}${comment ? ' — "' + comment.trim() + '"' : ""}`,
           req.user.id, req.user.name, req.user.role]
        );
      } catch (e) { /* notification is best-effort; never fail the request */ }
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/creative-requests/stats", authMiddleware, roles("admin","design","brand"), async (req, res) => {
  try { const rows = await db("SELECT COUNT(*)::int AS open FROM creative_requests WHERE status='open'");
    res.json({ open: rows[0] ? rows[0].open : 0 }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/creative-requests", authMiddleware, roles("admin","design","brand"), async (req, res) => {
  try {
    const status = req.query.status;
    const rows = status
      ? await db("SELECT * FROM creative_requests WHERE status=$1 ORDER BY created_at DESC", [status])
      : await db("SELECT * FROM creative_requests ORDER BY (status='open') DESC, created_at DESC");
    res.json(rows.map(r => ({ ...r, payload: typeof r.payload === "string" ? safeJson(r.payload) : r.payload })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/creative-requests/:id", authMiddleware, roles("admin","design","brand"), async (req, res) => {
  const { status, claim } = req.body || {};
  const valid = ["open", "in_progress", "done", "declined"];
  const sets = ["updated_at=NOW()"], vals = []; let i = 1;
  if (claim) { sets.push(`assignee_id=$${i++}`); vals.push(req.user.id); sets.push(`assignee_name=$${i++}`); vals.push(req.user.name); if (!status) sets.push("status='in_progress'"); }
  if (status && valid.includes(status)) { sets.push(`status=$${i++}`); vals.push(status); }
  vals.push(req.params.id);
  try { const rows = await db(`UPDATE creative_requests SET ${sets.join(",")} WHERE id=$${i} RETURNING *`, vals);
    res.json(rows[0] || { ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/image-library-suggest/:campaignId", authMiddleware, async (req, res) => {
  try {
    const crows = await db("SELECT product, objective, audience_label, data FROM campaigns WHERE id=$1", [req.params.campaignId]);
    if (!crows.length) return res.json([]);
    const c = crows[0];
    const product = (c.product || "").toLowerCase();
    // Pull candidate images: same product first, then broaden
    const all = await db("SELECT id, file_name, product, category, tags, description, kind, uploaded_at FROM image_library WHERE coalesce(kind,'') NOT IN ('product','logo') AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '45 days') ORDER BY uploaded_at DESC LIMIT 300");
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
  const { system = "", prompt = "", kind = "", limits = null } = req.body;
  // Per-content-type routing: copy → Anthropic (Claude), brief → Gemini, everything else → env default.
  const want = kind === "copy" ? "claude" : kind === "brief" ? "gemini" : undefined;
  // HARDEST RULES injected into the system prompt (belt) — and enforced on the way out (suspenders).
  const HARD_RULES = " NON-NEGOTIABLE HARD RULES (never break): "
    + "(1) Never output \"M-hash\" in any form (M-hash, M hash, mhash, M#, #M) or any unfilled merge/template placeholder ({{1}}, {name}, #VAR#, [VARIABLE], <NAME>) — these are system artifacts, not words; if you have no real value, write natural words with no placeholder. "
    + "(2) British English only — colour not color, favourite not favorite, personalise not personalize, centre not center. "
    + "(3) Say \"pet parents\", never \"consumers\". Use \"furry family\", never \"furry friend\" or \"fur baby\". "
    + "(4) Never use: premium, luxury, cutting-edge, state-of-the-art, revolutionary, game-changing. "
    + "(5) No fear-based messaging, no medical/cure claims, never shame pet parents. "
    + "(6) Respect the length limits for the channel exactly (push title and body are hard character caps). "
    + "(7) ACTION-LED ALWAYS: every piece of copy must drive a clear action (tap, switch, try, shop, book, learn, save); even awareness copy moves the reader to act, never just informs. "
    + "(8) Push notifications: the action MUST be in the FIRST line (the title) — every push, even awareness ones, drives an action. Push has NO image, so never write image/overlay copy or image RTBs for a push. "
    + "(9) No opt-out / unsubscribe / 'reply STOP' lines or any channel/system boilerplate — the platform adds those, not the copy.";
  const sys0 = kind === "copy" ? (system + HARD_RULES) : system;
  // No-leak guarantee: the server fetches the active copy rulebook from the DB and injects it itself,
  // so the rules apply even if a client omits them, and any newly added rule takes effect immediately.
  let sys = sys0;
  let ruleText = "";
  if (kind === "copy") {
    try {
      const rules = await db("SELECT text FROM rules WHERE type='copy' AND active=true ORDER BY id");
      if (rules && rules.length) { ruleText = rules.map(r => "- " + r.text).join("\n"); sys = sys0 + "\n\nACTIVE RULEBOOK (authoritative — always apply every rule, never ignore):\n" + ruleText; }
    } catch (e) {}
  }
  try {
    let text = await generate(sys, prompt, want);
    if (kind === "copy") {
      text = await reviewCopy(text, ruleText);   // FLAGS possible language errors as _warn (rulebook-aware) — never edits the copy
      text = enforceCopyHardRules(text, limits); // mechanical strip + length clamp stays LAST (final guard)
    }
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
    // idempotent column adds (image library: packaging dimensions + product/asset kind)
    await pool.query("ALTER TABLE image_library ADD COLUMN IF NOT EXISTS dimensions_cm TEXT");
    await pool.query("ALTER TABLE image_library ADD COLUMN IF NOT EXISTS kind TEXT");
    await pool.query("ALTER TABLE image_library ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ");
    await pool.query("ALTER TABLE image_library ADD COLUMN IF NOT EXISTS finish TEXT");
    await pool.query("ALTER TABLE image_library ADD COLUMN IF NOT EXISTS light_direction TEXT");
    await pool.query("ALTER TABLE image_library ADD COLUMN IF NOT EXISTS height_cm NUMERIC");
    await pool.query("ALTER TABLE image_library ADD COLUMN IF NOT EXISTS width_cm NUMERIC");
    await pool.query("ALTER TABLE image_library ADD COLUMN IF NOT EXISTS content_bbox TEXT");
    await pool.query("ALTER TABLE image_library ADD COLUMN IF NOT EXISTS dominant_colors TEXT");
    // Approval slots: which approval gates a user can clear (copy / asset / final). A user may hold several.
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_slots TEXT[] DEFAULT '{}'");
    // Sub-brands a user is scoped to (empty = all). Used to split what each brand person sees.
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_brands TEXT[] DEFAULT '{}'");
    // v29 role rename — idempotent (no rows match once migrated). business stays business.
    await pool.query("UPDATE users SET role='super_admin' WHERE role='admin'");
    await pool.query("UPDATE users SET role='brand_lead'  WHERE role='brand'");
    await pool.query("UPDATE users SET role='brand_team'  WHERE role='content'");
    await pool.query("UPDATE users SET role='design_team' WHERE role='design'");
    await pool.query(`CREATE TABLE IF NOT EXISTS brand_styles (
      sub_brand TEXT PRIMARY KEY,
      headline_font TEXT, subhead_font TEXT, cta_font TEXT,
      bg TEXT, text_color TEXT, cta_color TEXT,
      logo_id TEXT, notes TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS creative_requests (
      id TEXT PRIMARY KEY,
      campaign_id TEXT,
      title TEXT,
      details TEXT,
      comment TEXT,
      size TEXT,
      payload JSONB,
      requested_by TEXT,
      requester_name TEXT,
      requester_role TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      assignee_id TEXT,
      assignee_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Migrate pre-existing creative_requests tables that predate these columns —
    // CREATE TABLE IF NOT EXISTS never alters an existing table, so bring older ones up to schema.
    for (const c of [
      "campaign_id TEXT","title TEXT","details TEXT","comment TEXT","size TEXT","payload JSONB",
      "requested_by TEXT","requester_name TEXT","requester_role TEXT","status TEXT NOT NULL DEFAULT 'open'",
      "assignee_id TEXT","assignee_name TEXT",
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()","updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
    ]) { await pool.query(`ALTER TABLE creative_requests ADD COLUMN IF NOT EXISTS ${c}`); }
    await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      to_user_id TEXT,
      to_role TEXT,
      campaign_id TEXT,
      kind TEXT,
      body TEXT,
      url TEXT,
      read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(to_user_id, read)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_notif_role ON notifications(to_role, read)");
    // Category routing rules: which writer owns which category (hard route).
    await pool.query(`CREATE TABLE IF NOT EXISTS category_rules (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      user_id TEXT,
      user_email TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // per-asset category override lives on campaigns
    await pool.query("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS category TEXT");
    await pool.query("ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS copy_author TEXT");
    // Refresh the role CHECK constraint to allow the 8-role model on a fresh DB too.
    try {
      await pool.query("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check");
      await pool.query("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','cxo','head_marketing','brand_lead','brand_team','design_lead','design_team','business','admin','brand','content','design'))");
    } catch (ce) { console.error("role constraint refresh:", ce.message); }
    console.log("✓ image_library schema ensured (dimensions_cm, kind); brand_styles + creative_requests + notifications + category_rules ready");
  } catch (e) {
    console.error("✗ Database connection failed:", e.message);
    console.error("  Check DATABASE_URL in your .env file");
  }
  await seedRules();
  await seedBestPractices();
  await seedAudiences();
  console.log(`\n  HUFT CRM Creative Engine`);
  console.log(`  ${SERVER_BUILD}`);
  console.log(`  Running:  http://localhost:${PORT}`);
  console.log(`  Database: Supabase / PostgreSQL`);
  console.log(`  LLM:      ${PROVIDER === "gemini" ? "Gemini " + GEMINI_MODEL : PROVIDER === "claude" ? "Claude " + CLAUDE_MODEL : "MOCKED (add API key)"}\n`);
});
