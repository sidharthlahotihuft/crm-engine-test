# What changed in this version (v2)

This repo already has all v2 changes applied. Deploy as usual (git push → Vercel),
then do the two one-time setup steps below.

## Files changed
- public/index.html ....... grammar check, Excel import, RTBs/refs, email sections,
                            collapsible rows, brand-review flow, comment threads
- server.js ............... full campaign payload on create, rtbs/references columns,
                            comments API, brand-approve/reject, Google Sheets sync + cron
- vercel.json ............. added 6-hour cron for /api/cron/sheet-sync
- migration_v2.sql ....... NEW — run this in Supabase once
- HUFT_Brief_Upload_Template.xlsx ... NEW — give to the team for bulk brief upload

## One-time setup

### 1. Run the database migration
Supabase → SQL Editor → paste all of migration_v2.sql → Run.
Adds: brand role, brand_review stage, brand_approver columns, rtbs/references
columns, comments table, sheet_sync table. Seeds Ilena.
- Ilena logs in: ilena@headsupfortails.com / huft@brand123 (reset after first login)

### 2. Set environment variables (Vercel → Settings → Environment Variables)
- CRON_SECRET = <any long random string>     (protects the cron endpoint)
Vercel Cron automatically sends this as a Bearer token to the cron route.

> Vercel Cron needs a Pro plan. On Hobby, instead use an external scheduler
> (e.g. cron-job.org) hitting https://YOUR_DOMAIN/api/cron/sheet-sync every 6h
> with header  Authorization: Bearer <CRON_SECRET>

### 3. (Optional) Connect a Google Sheet
- Make a sheet with the template's columns; name the tab "Briefs".
- File → Share → Publish to web → the Briefs sheet → CSV → Publish.
- Copy the Sheet ID from the URL and PUT it to /api/sheet-sync
  { "sheet_id": "...", "enabled": true }   (admin/business)
- New rows import automatically every 6h. Already-imported rows are skipped (hashed).

## New copy approval flow
content → (copy selected) → BRAND REVIEW (Ilena) → design → done
Push notifications: content → brand review → done (no design).
Only Ilena (brand) or admin can release from brand review — enforced server-side.

## Comments
Every copy (and design) card has a comment thread. Anyone can comment and reply.
Ilena/admin can resolve threads. Available in the Brand review tab and can be
extended to the Copy/Design cards.
