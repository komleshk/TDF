# AGM Wealth Portfolio Review

A working full-stack mutual fund CAS review application for an Indian Mutual Fund Distributor. It includes secure authentication, persistent client records, password-protected PDF processing, modular CAS adapters, analytics, editable recommendations, model portfolios, an SWP planner, audit history, and PDF/Excel exports.

## Quick start

Requirements: Node.js 22 or newer.

```bash
cp .env.example .env
npm ci
npm run check
npm run seed
npm start
```

Open `http://127.0.0.1:3000`.

Default development login:

- Email: `kamlesh@agmwealth.com`
- Password: `ChangeMeNow!123`

Change both values in `.env` before the first production start. If the database already exists, changing the environment variable does not change the existing account password.

`npm run seed` is optional and intended for local testing. Do not seed a production database.

The seed command creates:

- a synthetic client and portfolio review;
- `samples/sample-protected-cas.pdf`;
- sample PDF password: `ABCDE1234F`.

## What is implemented

- Admin and staff authentication with scrypt password hashing, database-backed sessions, HttpOnly/SameSite cookies, CSRF and origin checks
- Client creation, search, history, update and admin deletion APIs
- CAMS, KFintech, MF Central and generic CAS parser adapters
- Password-protected PDF support; the password is never persisted
- Temporary upload deletion after every success or failure
- Structured holdings, allocation analytics, gains, XIRR when cash flows are available, SIP/STP/SWP lists and portfolio exceptions
- Editable fund-wise recommendations and separate internal notes
- Reusable model portfolios and SWP projections
- Client-ready PDF and multi-sheet Excel downloads
- Company settings, staff APIs, logo upload endpoint and audit log
- Responsive desktop, tablet and mobile interface
- Unit and end-to-end integration tests

## CAS parser design

The adapters live in `src/cas/adapters`:

- `cams.js`
- `kfintech.js`
- `mfcentral.js`
- `generic.js`

Provider detection is separate from normalization. Every adapter returns the same holding structure through `normalize.js`. Real CAS layouts change, and scanned/image-only statements require OCR; add provider-specific layout rules inside the matching adapter without changing analytics, recommendations or reports. The application deliberately displays extraction warnings and expects distributor verification before circulation.

## Commands

```bash
npm run dev     # restart server on source changes
npm start       # production-style start
npm run check   # validate files, environment, writable storage and database
npm test        # unit and end-to-end tests
npm run seed    # sample database record and protected PDF
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | Platform dependent | HTTP port; defaults to `3000` |
| `HOST` | Recommended | Bind address; use `0.0.0.0` for deployment |
| `NODE_ENV` | Production | Set to `production` online |
| `APP_ORIGIN` | Production | Exact public HTTPS origin, without a trailing path |
| `DATABASE_PATH` | Production | SQLite file on a persistent disk |
| `STORAGE_PATH` | Production | Persistent directory for uploaded branding |
| `UPLOAD_TMP_PATH` | Optional | Temporary CAS processing directory |
| `SESSION_TTL_HOURS` | Optional | Session lifetime; default `12`, maximum `168` |
| `ADMIN_EMAIL` | First startup | Initial administrator email |
| `ADMIN_PASSWORD` | First startup | Initial password, at least 12 characters and not the example default |
| `MAX_UPLOAD_MB` | Optional | CAS file limit; default `15` |
| `MAX_CAS_PAGES` | Optional | PDF page-processing limit; default `500` |

Production startup intentionally fails when `APP_ORIGIN` is not HTTPS or the example admin password is still configured.

## Data and security

- The SQLite database defaults to `data/agm-wealth.sqlite`.
- Company branding is stored under `STORAGE_PATH`; put this directory on persistent storage.
- Original PDFs are never retained. Uploads use `UPLOAD_TMP_PATH`, parsing runs, and the temporary file is removed in a `finally` block.
- CAS passwords are accepted only as an upload form field and are not logged or written to the database.
- Client-facing reports exclude internal notes by default.
- Protect the application with HTTPS in production.
- Put the database on encrypted storage and restrict operating-system access to the service account.
- Set `NODE_ENV=production`, use a strong initial admin password, and set `APP_ORIGIN` to the exact HTTPS origin.

Privacy note: CAS data contains confidential financial and identity information. Obtain client authorization, define a retention policy, restrict staff access, and follow applicable Indian privacy and record-keeping requirements.

## Backups

For the embedded database, take a consistent backup with:

Stop writes briefly or use SQLite's online backup command:

```bash
sqlite3 data/agm-wealth.sqlite ".backup '/secure-backups/agm-wealth-$(date +%F).sqlite'"
```

Store encrypted backups outside the application server, test restoration quarterly, and define retention and deletion schedules. Managed PostgreSQL deployments should enable point-in-time recovery and automated daily backups.

## Deployment

### Railway or Render — current working build

1. Push this directory to a private Git repository.
2. Create a Node service using `npm ci` as the build command and `npm start` as the start command.
3. Attach a persistent disk/volume and set `DATABASE_PATH` to a file on that volume, for example `/data/agm-wealth.sqlite`.
4. Set `STORAGE_PATH` to the same persistent volume, for example `/data`.
5. Set `HOST=0.0.0.0`, the platform-provided `PORT`, `NODE_ENV=production`, the exact HTTPS `APP_ORIGIN`, and strong admin credentials.
6. Use `/healthz` for liveness and `/readyz` for database readiness.
7. Keep one application instance when using SQLite. Configure HTTPS, health monitoring and encrypted volume backups.

This repository includes [render.yaml](render.yaml) for Render Blueprint deployment.

Render persistent disks permit only one service instance and cause brief downtime during deploys. For SQLite recovery, use SQLite's online backup command rather than restoring a raw disk snapshot while the database is active.

### Docker

```bash
docker build -t agm-wealth .
docker run --rm -p 3000:3000 \
  -v agm-wealth-data:/data \
  -e APP_ORIGIN=https://your-domain.example \
  -e ADMIN_EMAIL=admin@your-domain.example \
  -e ADMIN_PASSWORD='replace-with-a-strong-password' \
  agm-wealth
```

For local Docker testing with production security enabled, use an HTTPS reverse proxy. Do not weaken the production HTTPS check for an internet deployment.

### Vercel frontend + Render/Railway backend

The current UI is framework-free and served by the Node backend. To split hosting, deploy the backend on Render/Railway and move `public/` to a Vercel static project. Then:

1. Change API calls in `public/app.js` to the backend HTTPS origin.
2. Configure strict CORS for only the Vercel domain.
3. Change the session cookie to `SameSite=None; Secure`, or use same-site custom domains.
4. Set `APP_ORIGIN` to the Vercel URL.

Same-origin deployment is recommended because it keeps secure cookie and CSRF handling simpler.

### Railway

1. Deploy the repository as a Node service using `npm ci` and `npm start`.
2. Attach a volume at `/data`.
3. Set `DATABASE_PATH=/data/agm-wealth.sqlite` and `STORAGE_PATH=/data`.
4. Set the production variables listed above and use Railway's generated HTTPS domain as `APP_ORIGIN`.
5. Keep one replica while using SQLite and enable volume backups.

### Supabase PostgreSQL migration

The reference PostgreSQL schema is in `database/schema.sql`. For a multi-instance deployment:

1. Create a private Supabase project and run the complete reference schema in `database/schema.sql`.
2. Replace the `node:sqlite` statements in `src/db.js` with parameterized calls through `postgres` or Supabase's server-side client.
3. Keep all database credentials on the backend only; never expose the service-role key to the browser.
4. Enable row-level security if any client-facing mode is added later.

The included application runs without Supabase; migration is only required for horizontal scaling or managed PostgreSQL operations.

## Admin and staff accounts

The first admin is created from `ADMIN_EMAIL` and `ADMIN_PASSWORD` on an empty database. Additional admin or staff accounts can be created from the Settings screen. Passwords must contain at least 12 characters.

## Tests

`npm test` covers:

- successful and failed login;
- client creation;
- encrypted PDF rejection without a password;
- encrypted PDF extraction with the correct password;
- portfolio analytics and XIRR;
- recommendation rules;
- SWP projection;
- full upload-to-review flow;
- PDF and Excel generation.
- clean database schema creation and foreign-key integrity;
- new-client creation directly from a CAS upload;
- health and readiness endpoints;
- environment safety validation.

## Production notes

- Use a reverse proxy with request limits, TLS, rate limiting and centralized logs.
- Run dependency and container scans in CI.
- Virus-scan uploads before parsing in higher-risk deployments.
- Add OCR for scanned CAS files.
- Add a formal fund-master/performance data feed before making performance-based system recommendations. The MVP does not invent underperformance data.
- Have disclaimer, privacy, ARN/EUIN and report language reviewed by your compliance process before client use.
