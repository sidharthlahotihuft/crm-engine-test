-- HUFT CRM Rules Seed
-- Run this in Supabase SQL Editor to pre-populate the Rulebook.
-- Safe to re-run — uses INSERT ... ON CONFLICT DO NOTHING via unique text check.
-- Generated from: Brand Architecture, Communication Playbook, Brand Intelligence Brief

-- ============================================================
-- COPY RULES
-- ============================================================
INSERT INTO rules (type, text, active) VALUES

-- Language & voice
('copy', 'British English only — colour not color, favour not favor, realise not realize.', true),
('copy', 'Write like a human. Natural sentences, clear language, emotion where appropriate. Not a corporate marketer.', true),
('copy', 'Clarity first, warmth second, cleverness only if clarity stays intact.', true),
('copy', 'Short sentences convert better. Simplicity wins — one clear takeaway per asset.', true),

-- Vocabulary rules
('copy', 'Say "pet parents" never "consumers" or "customers" in copy body.', true),
('copy', 'Use "furry family" not "furry friend". Never "fur baby".', true),
('copy', 'Words to use: thoughtful, gentle, trusted, honest, real, care, comfort, love, joy, family, better.', true),
('copy', 'Words to avoid: premium, luxury, cutting-edge, state-of-the-art, revolutionary, game-changing.', true),

-- Tone guardrails
('copy', 'Never shame pet parents for feeding choices or care mistakes. Always guide kindly.', true),
('copy', 'No fear-based messaging. No exaggerated or dramatic claims. Trust matters more than hype.', true),
('copy', 'No medical or cure claims. Use "supportive", "gentle", "vet-aware" instead.', true),
('copy', 'Never invent prices, discounts, or stock status. Write "Rs.XX [confirm]" as placeholder.', true),

-- WhatsApp format
('copy', 'WhatsApp header (image overlay): 2–3 very short punchy lines. Lead with emotion or truth, NOT product name.', true),
('copy', 'WhatsApp body: 1 warm opener → 3–5 scannable ✓ bullets → short sign-off → one CTA.', true),
('copy', 'Emoji: max 1–2 per asset. Preferred: 🐾 💛 👀 ✓. Never decorative emoji strings.', true),

-- Push notification format
('copy', 'Push title: MAX 50 characters. Push body: MAX 90 characters, one sentence. Max 1 emoji total.', true),

-- Email format
('copy', 'Email subject: curiosity or benefit-led, under 50 chars. Preheader should extend the subject, not repeat it.', true),

-- Channel rules
('copy', 'Retail CRM: NO website or app deep links. Lead with store experience or NSO context.', true),
('copy', 'D2C CRM: app deep links and website URLs are fine.', true),

-- Headline styles
('copy', 'Pet benefit headline structure: [Benefit] + [Pet]. e.g. "Better meals for happier dogs".', true),
('copy', 'Curiosity headline structure: Unexpected insight. e.g. "Why dogs struggle with most kibble".', true),
('copy', 'Emotional headline structure: Love + responsibility. e.g. "Because pets are family".', true),
('copy', 'Never use rhetorical questions that could make pet parents feel judged. e.g. avoid "Are you feeding your dog wrong?"', true),

-- Sub-brand voice
('copy', 'Sara''s Wholesome Food tone: nurturing, expert, warm, reassuring. Speaks of tradition, trust, family. Taglines: "Real Food. Real Love." / "Inspired by Home. Backed by Science."', true),
('copy', 'Hearty tone: reliable, accessible, clear. Oven-baked, real ingredients, no fillers. Tagline: "Made with all our heart for complete nutrition."', true),
('copy', 'Meowsi tone: witty, sophisticated, feline-first. Curious, clever. e.g. "Cats Ki Asli Diet."', true),
('copy', 'HUFT Spa tone: reassuring, gentle, care-focused. Expert groomers, stress-free. e.g. "Grooming that feels like care."', true),
('copy', 'HUFT Stores tone: welcoming, inclusive, personal. e.g. "Love for every pet, prices for every pocket."', true),

-- CTA library
('copy', 'Rotate CTAs — avoid repetition. Pool: Shop now / Explore / Discover more / Try it today / Find your nearest store / Upgrade your pet''s routine / Give your pet better care.', true),

-- Copy self-check
('copy', 'Before approving copy, ask: Does this sound human? Does this reflect love for pets? Would a pet parent trust this? Is the message simple and clear?', true)

ON CONFLICT DO NOTHING;


-- ============================================================
-- DESIGN / PROMPT RULES
-- ============================================================
INSERT INTO rules (type, text, active) VALUES

-- Pet photography
('prompt', 'Always feature real Indian dog or cat breeds where possible — Indie, Labrador, Golden Retriever, Persian, Notification cat etc. No generic stock-photo breed composites.', true),
('prompt', 'Pet must be the emotional hero of the frame. Product supports, never dominates.', true),
('prompt', 'Real pet moments — genuine expressions of joy, curiosity, comfort, play. No posed or stiff stock-photo scenarios.', true),
('prompt', 'Avoid anthropomorphising pets unnaturally (no pets in human clothes unless brand-brief specific).', true),

-- Product representation
('prompt', 'Show correct pack proportions and label orientation. No distorted, blurred, or AI-hallucinated packaging.', true),
('prompt', 'No added text overlaid on product pack in the generated image — text is added in post.', true),
('prompt', 'For food brands: show real ingredients (fresh meat, vegetables, grains) alongside or within the visual where relevant.', true),

-- Lighting & mood
('prompt', 'Use realistic, warm, natural lighting. Avoid harsh studio strobes or overly clinical white backgrounds unless brief specifies.', true),
('prompt', 'Mood should feel: warm, inviting, home-like, joyful, or gently expert depending on sub-brand. Never cold, corporate, or clinical.', true),
('prompt', 'Indian home or lifestyle context preferred — warm interiors, natural textures, familiar domestic settings.', true),

-- Brand colour sensibility
('prompt', 'Avoid overly saturated or neon colour palettes. HUFT aesthetic is warm, grounded, and natural.', true),
('prompt', 'For Sara''s: earthy, warm, home-kitchen tones. Wooden surfaces, natural light, soft greens.', true),
('prompt', 'For Hearty: slightly brighter, energetic but still warm. Fresh ingredients hero.', true),
('prompt', 'For Meowsi: playful, slightly quirky, feline-appropriate. Jewel tones work.', true),
('prompt', 'For HUFT Spa: clean, calm, minimal. Soft whites, sage, warm neutrals.', true),
('prompt', 'For HUFT Stores: vibrant, welcoming, community feel. Warm retail environment.', true),

-- Composition
('prompt', 'Rule of thirds — pet or hero element should not be dead-centre unless intentional. Give breathing room.', true),
('prompt', 'Leave visual negative space on one side for text/headline overlay in post-production.', true),
('prompt', 'For WhatsApp assets: portrait orientation (4:5 or 9:16). For push: landscape or square.', true),

-- Negative prompts (always include)
('prompt', 'Negative prompt always include: distorted faces, extra limbs, blurry text, watermark, logo, signature, oversaturated, plastic-looking, CGI render feel.', true),
('prompt', 'No human faces shown prominently — keep focus on pets. If humans present, show hands or partial body only (pet parent bond).', true),

-- Tool guidance
('prompt', 'For FLUX: photorealistic style, natural depth of field, f/2.8 equivalent. Specify "Indian breed dog/cat" explicitly.', true),
('prompt', 'For Gemini Imagen: describe mood and context first, then subject, then product detail. Avoid prompt stuffing.', true)

ON CONFLICT DO NOTHING;
