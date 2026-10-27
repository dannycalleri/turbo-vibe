# Compatibility

Every week, and on demand, the kit's live tests (`live-tests.yml`) deploy each example under `examples/` that can run as a preview to real vendor accounts, smoke-test it, and remove it. The Go example's database is on Supabase's free plan, which cannot be branched, so it is dated by its latest staging build that passed. This table is generated from those runs: for each adapter, the tool and provider versions this release pins, and the last date an example using it passed. Beta adapters are supported, with less live history than the others.

| Adapter | Stability | Pinned versions | Last live pass |
|---|---|---|---|
| `cloudflare-container` | stable | wrangler 4.148.0, @cloudflare/containers 0.3.7, OpenTofu 1.13.1, cloudflare provider 5.27.0 | 2026-10-27 |
| `cloudflare-static` | stable | wrangler 4.148.0, OpenTofu 1.13.1, cloudflare provider 5.27.0 | 2026-10-12 |
| `supabase` | stable | Supabase CLI 2.120.0, OpenTofu 1.13.1, supabase provider 1.11.0, random provider 3.9.1 | 2026-10-12 |
| `workos` | stable | OpenTofu 1.13.1, workos provider 2.5.0 | 2026-10-12 |
| `vercel-static` | beta | Vercel CLI 63.1.0, OpenTofu 1.13.1, vercel provider 5.21.0, cloudflare provider 5.27.0 | 2026-10-27 |
| `vercel-nextjs` | beta | Vercel CLI 63.1.0, OpenTofu 1.13.1, vercel provider 5.21.0, cloudflare provider 5.27.0 | 2026-10-27 |

<!-- turbo-vibe-compatibility: {"cloudflare-container":"2026-10-27","cloudflare-static":"2026-10-12","supabase":"2026-10-12","vercel-nextjs":"2026-10-27","vercel-static":"2026-10-27","workos":"2026-10-12"} -->
