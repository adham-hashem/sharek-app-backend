# SHARek API

Fastify + TypeScript API for the SHARek Expo client. Supabase remains the system of record for Auth, Postgres, Realtime and Storage; this service owns validation, rate limiting, business orchestration and secure mutation endpoints.

Fastify has low overhead and a small memory footprint, so it can run on low-cost services such as Render, Fly.io or Railway and scale horizontally later. Supabase Postgres provides transactional RPCs and indexes; Realtime remains a client subscription so chat/location updates do not require polling.

Run with `npm install`, copy `.env.example` to `.env`, then use `npm run typecheck` and `npm run dev`. Every `/v1/*` endpoint requires `Authorization: Bearer <Supabase access token>`.

Apply the SQL files in `../project/supabase/migrations` to the Supabase project before starting the client. In production set `CORS_ORIGINS` to the exact HTTPS origins used by the web client and set `EXPO_PUBLIC_API_URL` to the deployed HTTPS API URL. For a physical device, do not use `localhost` for the API URL; use a reachable LAN/HTTPS address.

Keep `TRUST_PROXY=false` unless the API is behind a trusted reverse proxy that sets the client IP headers correctly; enable it only for that deployment so rate limiting cannot be bypassed with a forged forwarded IP.

Set `SUPABASE_SERVICE_ROLE_KEY` only for separately deployed trusted jobs. It is intentionally not used by request handlers, so RLS remains active for user data. Set an admin claim (`app_metadata.is_admin=true`) through a trusted Supabase admin workflow before using `/v1/admin/*`.

Connect a real payment provider to the returned donation intent and a signed webhook before accepting money in production. Donation intents remain `pending` until the provider verifies the payment; the API never reports a pending payment as successful.
