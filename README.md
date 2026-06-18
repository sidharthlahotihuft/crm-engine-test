# HUFT CRM Creative Engine — Supabase Build

## Stack
- **Server:** Node.js + Express
- **Database:** Supabase (PostgreSQL) — free tier, no credit card
- **Auth:** JWT (email + password, bcrypt)
- **LLM:** Gemini 2.5 Flash (or Claude fallback)
- **Frontend:** Single HTML file (React via CDN, no build step)

---

## Setup in 15 minutes

### Step 1 — Create a Supabase project
1. Go to **supabase.com** → Sign up free (GitHub login works)
2. Click **New project**
3. Pick a name (e.g. `huft-crm`), set a strong database password, choose a region closest to India (Singapore)
4. Wait ~2 minutes for it to spin up

### Step 2 — Run the schema
1. In Supabase dashboard → **SQL Editor** → **New query**
2. Paste the entire contents of `schema.sql`
3. Click **Run**
4. You should see "Success" — all tables are created with a default admin user

### Step 3 — Get your connection string
1. Supabase dashboard → **Settings** (gear icon) → **Database**
2. Scroll to **Connection string** → select **URI** tab
3. Copy the string — it looks like:
   `postgresql://postgres:[YOUR-PASSWORD]@db.xxxx.supabase.co:5432/postgres`
4. Replace `[YOUR-PASSWORD]` with the password you set in Step 1

### Step 4 — Set up your .env
```bash
cp .env.example .env
```
Open `.env` and fill in:
```
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.YOUR_REF.supabase.co:5432/postgres
JWT_SECRET=any_long_random_string_like_this_one_here_make_it_long
GEMINI_API_KEY=your_gemini_key
```

### Step 5 — Run locally
```bash
npm install
node server.js
```
Open **http://localhost:8080**

Log in with:
- Email: `admin@headsupfortails.com`
- Password: `huft@admin123`

**Change this password immediately** via Team drawer → your user.

---

## Deploy on Railway (free hosting + auto-deploy)

1. Push this folder to a GitHub repo
2. Go to **railway.app** → New Project → Deploy from GitHub
3. Select your repo
4. In Railway → your service → **Variables** tab, add:
   ```
   DATABASE_URL=your_supabase_connection_string
   JWT_SECRET=your_secret
   GEMINI_API_KEY=your_key
   ```
5. Railway auto-deploys and gives you a live URL like `https://your-app.up.railway.app`

That's it. Supabase handles the database, Railway handles the server.

---

## Roles
| Role | Default tab | Can create campaigns |
|------|-------------|----------------------|
| admin | Dashboard | Yes |
| business | Brief | Yes |
| content | Content | No |
| design | Design | No |

Admin creates all users via the **Team** drawer in-app.

---

## Default admin
- Email: `admin@headsupfortails.com`
- Password: `huft@admin123`
- **Change immediately after first login**
