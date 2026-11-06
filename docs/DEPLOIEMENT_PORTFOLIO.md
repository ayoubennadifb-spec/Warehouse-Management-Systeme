# Portfolio demo — Render Free + Supabase Free

This deployment uses the **current Node.js/TypeScript application** under
`projet_portique_ contenaire_claude/`, **not** the legacy Python Dockerfile.

## Provisioning

1. Create a **new, dedicated Supabase Free** project (do not use a real robot's
   inventory). In Supabase, click **Connect → Session pooler**, not Transaction
   pooler: the Fastify SSE backend uses PostgreSQL `LISTEN/NOTIFY`.
2. In Render, deploy the repository's root `render.yaml` Blueprint to a
   **Free Web Service**, choose the intended workspace, and fill in
   `DATABASE_URL` using the Supabase **Session pooler** connection string.
   The password stays in Render's secret environment configuration.
3. On the first start, `src/server/index.ts` applies the four database
   migrations and the access-control migration, then seeds a fictitious 3D
   warehouse dataset if the database is empty.
4. Validate `/api/sante`, `/api/etat`, the Three.js interface, an example
   simulation mission and the SSE connection at `/api/flux`.

## Security and limitations

- `PORTFOLIO_DEMO=true` forces **SIMULATION** mode and rejects camera,
  external-hardware, and hardware-confirmation endpoints.
- The database credentials must **never** go into client JavaScript, GitHub
  or the public README. Supabase Data API roles have no access to the
  application's `public` tables.
- This version uses **one shared simulated warehouse**. Different visitors
  can affect each other's demo state; do **not** claim isolated sessions.
  Per-visitor state requires extra development before a broad public launch.
- Free Render services sleep when inactive; free Supabase projects may pause.
  This is a portfolio demonstration, not a 24/7 production service.
- Camera-based vision/YOLO inference and local device integration are
  intentionally unavailable on the public demo.
- Use the **Supabase session pooler on port 5432** to retain `LISTEN/NOTIFY`
  functionality. Transaction pooling (usually port 6543) is not suitable.
