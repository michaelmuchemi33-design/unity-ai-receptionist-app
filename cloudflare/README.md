# TWIGA Cloudflare storage service

This service is deliberately deployed as **`twiga-storage-api`**, separate from the existing `twiga-api.twiga-ke.workers.dev` billing/licence Worker. Do not rename it to `twiga-api` or deploy over the existing Worker.

## Architecture and boundaries

- **Supabase Auth** validates the signed-in user. Only verified email identities are accepted for workspace onboarding.
- **Supabase billing** remains authoritative: `twiga_customers`, `twiga_subscriptions`, `twiga_payments`, and `twiga_plans` remain unchanged.
- **Supabase workspace tables** hold stable business identity, owner and member roles, and a unique link to the existing `twiga_customers.id`.
- **Cloudflare D1** stores operational records, file metadata, usage counters and cleanup audit metadata.
- **Cloudflare R2** stores file bytes. Object keys are generated server-side and always scoped by business ID.
- **Cloudflare KV** is provisioned as a disposable cache binding only. It is not used as the source of truth and must never hold durable customer records.

## Limits and retention

- 500 MiB (524,288,000 bytes) per business, shared by every member.
- 25 MiB maximum upload by default.
- Every operational record and uploaded file gets its own 90-day expiry from creation.
- Expired records and R2 objects are removed by a daily scheduled Worker run at 02:17 UTC (05:17 East Africa Time).
- Identity, workspace membership, business configuration, subscription and payment records are not in the 90-day operational tables.
- Audit events contain actor ID, action and target ID only; avoid putting call transcripts, phone numbers or other customer content in audit metadata.

## Provision Cloudflare resources

Run from this directory with a Cloudflare account logged in using Wrangler:

```sh
npx wrangler login
npx wrangler d1 create twiga-business-data
npx wrangler r2 bucket create twiga-business-files
npx wrangler kv namespace create twiga-cache
```

Copy the D1 `database_id` and KV namespace `id` returned by Wrangler into `wrangler.toml`. Keep the resource names exactly as written. The Worker name is `twiga-storage-api`; this avoids touching the existing production billing Worker.

Apply the D1 schema:

```sh
npx wrangler d1 migrations apply twiga-business-data --remote
```

Set secrets interactively (never commit them):

```sh
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put WORKSPACE_PROVISIONING_KEY
```

Use the Supabase anon/publishable key for the first value and the Supabase service-role key for the second. Generate a long random provisioning key locally for the third. Do not paste any of these values into chat, GitHub, or frontend code. The provisioning key gates workspace creation; workspace onboarding also requires a verified Supabase email matching the email on an existing, active/trial TWIGA billing customer.

Deploy only after the Supabase migration below has been applied:

```sh
npx wrangler deploy
```

Wrangler will print the new `https://twiga-storage-api.<your-account>.workers.dev` URL. The app/dashboard must be explicitly configured to use that new URL for storage. Keep the existing `ledgerUrl` pointed at `https://twiga-api.twiga-ke.workers.dev` for billing/licence operations.

## Supabase migration

Apply `../backend/supabase/migrations/202611070002_twiga_storage_workspaces.sql` after the existing TWIGA billing migration `202611030001_twiga_billing.sql`. It creates workspace/member tables and a unique `legacy_customer_id` link. It does not create duplicate billing customers or modify payment history.

Workspace onboarding endpoint:

- `POST /v1/workspaces` with Supabase bearer token, `x-twiga-provisioning-key`, and JSON `{"name":"Business name","customerId":"existing-twiga-customer-uuid"}`.
- The Worker checks verified Supabase email against the existing billing customer's email and verifies an unexpired trial or paid subscription before linking.
- A customer can map to only one workspace; repeated requests by its owner return the existing workspace.

## API

All routes except `/health` require a Supabase access token. Workspace routes additionally verify membership and active workspace status server-side. Client-provided business IDs never grant access by themselves.

- `GET /health`
- `POST /v1/workspaces`
- `GET /v1/storage/usage?businessId=...`
- `POST /v1/records?businessId=...` JSON `{"type":"call_log","data":{...}}`
- `GET /v1/records?businessId=...&type=call_log&limit=50`
- `DELETE /v1/records?businessId=...&id=...`
- `POST /v1/files?businessId=...` multipart field `file`
- `GET /v1/files?businessId=...` lists files
- `GET /v1/files?businessId=...&id=...` downloads a file
- `DELETE /v1/files?businessId=...&id=...`

## Production checklist

- [ ] Confirm existing customer emails are present and match verified Google sign-in emails.
- [ ] Apply Supabase migration and verify RLS/revokes.
- [ ] Provision D1, R2 and KV; set real IDs in Wrangler config.
- [ ] Set all three Worker secrets.
- [ ] Apply D1 migration and deploy the separate Worker.
- [ ] Smoke-test auth, cross-business denial, workspace billing gate, 500 MiB quota, uploads/downloads, deletion and expiry cleanup using test accounts.
- [ ] Configure dashboard storage base URL only after the new Worker URL is confirmed.
- [ ] Review consent and privacy notices before saving call recordings, transcripts or personal data.

This repository change does not itself create Cloudflare resources, apply remote migrations or deploy a Worker. Those steps require access to the customer's Cloudflare and Supabase accounts. Never deploy this Worker over the existing billing Worker.
