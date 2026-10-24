# Voter Desk API

REST backend for the Voter Desk frontend: Node.js + TypeScript (Express 5) and PostgreSQL.
Every business rule is enforced here: roles (Super Admin → Corporator → BLO; Super Admins can add Super Admins), ward/booth scope, one successful
payment per voter, audit logging and the rest.

## Run it locally (no Docker)

```bash
cd Backend
npm install
cp .env.example .env          # already points at the local database below
npm run db:local              # terminal 1: real PostgreSQL from npm, data in Backend/.pgdata
SUPER_ADMIN_NAME="Super Admin" SUPER_ADMIN_MOBILE=9xxxxxxxxx SUPER_ADMIN_PASSWORD=... npm run create-super-admin   # once
npm run dev                   # terminal 2: API on http://localhost:4000/api (PORT in .env)
```

Then run the frontend: `npm run dev` in `Frontend/` (its `.env.development` points at http://localhost:4000/api).
Sign in with the Super Admin you created; add wards, accounts and voters (or import them) from the app.

## Checks

```bash
npm run typecheck
npm test        # starts its own throwaway PostgreSQL; 43 API tests
npm run build
```

## Deploy to AWS (Elastic Beanstalk + RDS PostgreSQL, frontend on Amplify)

1. **Database:** create an RDS PostgreSQL instance (version 16 or 17; `db.t4g.micro` is enough to start), in the same
   VPC as Elastic Beanstalk, not publicly accessible. Create a database named `voterdesk`. Allow port 5432 from the
   Elastic Beanstalk instances' security group.
2. **Package the API:** `powershell -ExecutionPolicy Bypass -File deploy/package-eb.ps1` creates
   `deploy/voter-desk-backend.zip` (build output, migrations, the RDS certificate bundle and `.ebextensions`).
3. **Elastic Beanstalk:** create a *Node.js* web-server environment with a load balancer and upload the zip.
   Add environment properties:
   - `DATABASE_URL=postgres://USER:PASSWORD@RDS-ENDPOINT:5432/voterdesk`
   - `CORS_ORIGINS=https://<your-amplify-domain>` (not needed if the frontend proxies `/api`)

   `NODE_ENV`, `TRUST_PROXY`, TLS to RDS and the `/api/health` health check come from `.ebextensions/voterdesk.config`.
   The API applies database migrations itself when it starts.
4. **First Super Admin** (once): run with the production `DATABASE_URL`, from a machine that can reach RDS:
   `SUPER_ADMIN_NAME="..." SUPER_ADMIN_MOBILE=... SUPER_ADMIN_PASSWORD=... INITIAL_PAYMENT_AMOUNT=2000 npm run create-super-admin`
5. **HTTPS:** browsers need HTTPS end to end. Either give the Elastic Beanstalk load balancer a domain and an ACM
   certificate (HTTPS listener on 443), or put CloudFront in front of it.
6. **Frontend (Amplify Hosting):** connect the repository; `amplify.yml` at the repo root builds `Frontend/`. Set the
   environment variable `VITE_API_BASE_URL=https://<api-domain>/api` and add the SPA rewrite
   `</^[^.]+$|\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>` → `/index.html` (200).

## Environment variables

See `.env.example`. Required: `DATABASE_URL`. Production on RDS also uses `DATABASE_SSL=true` and
`DATABASE_CA_FILE=certs/rds-global-bundle.pem` (both set by `.ebextensions`).

## Layout

- `src/routes/*`: one router per API area (auth, admins, wards, voters, imports, payments, settings, reports)
- `src/services/*`: shared voter and payment logic
- `src/lib/*`: validation, passwords (scrypt), scope rules, audit, IDs
- `migrations/*.sql`: schema; applied in order on start (`schema_migrations` records what ran)
- `test/fixtures.ts`: sample wards, accounts and voters used only by the automated tests
