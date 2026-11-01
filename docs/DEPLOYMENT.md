# Deployment

Deploy the frontend as one Vercel project from the repository root. The
included `vercel.json` builds `frontend/` while retaining workspace access to
the SDK package.

Set these Vercel production variables:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | Public Railway backend URL, for example `https://api.example.up.railway.app` |
| `NEXT_PUBLIC_SITE_URL` | Public Vercel frontend URL |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Reown project ID |
| `NEXT_PUBLIC_FACTORY_ADDRESS` | Active factory address for new wallet creation (current Arc Testnet V3 release) |
| `NEXT_PUBLIC_RPC_URL` | Optional public Arc RPC URL |

Deploy the backend as one Railway service from the repository root. Railway
uses `backend/Dockerfile` through `railway.toml`; configure its generated
domain before setting the variables below.

| Variable | Value |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `AUTH_ORIGIN` | Exact Vercel production origin, without a trailing slash |
| `MANAGED_API_BASE_URL` | Exact public Railway backend origin, without a trailing slash |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `POLICY_AUTHORITY_PRIVATE_KEY` | Dedicated authority key kept only on Railway |
| `MANAGED_PROVIDER_ENCRYPTION_KEY` | Stable 32-byte encryption key; back it up securely. Changing it locks existing hosted provider keys. |
| `X402_STORAGE_DIR` | Absolute path on a Railway persistent volume, for example `/data/x402` |
| `CHAIN_ID` | `5042002` for Arc Testnet; use the target mainnet value when deploying mainnet contracts |
| `RPC_URLS` / `ALCHEMY_RPC_URL` | Optional ordered Arc RPCs and paid fallback |

Do not set any `SUPABASE_SERVICE_ROLE_KEY` or `POLICY_AUTHORITY_PRIVATE_KEY`
variable in Vercel. After both deployments, open `https://<railway-domain>/health`.
It must return `"status":"ready"` before publishing or activating an API.
The health route returns HTTP 503 when Supabase or all configured RPC endpoints
are unavailable, so Railway does not mark a degraded backend ready.

Create a Railway volume mounted at `/data` before starting the backend, set
`X402_STORAGE_DIR=/data/x402`, and run **one backend replica**. Both x402
channel records and pending deposit transaction hashes live there. Keep the
volume when redeploying. Before restoring from a backup or moving the service,
reconcile pending deposits, claims and provider leases against Arc; never
delete a lock file or Supabase lease just to restart settlement. The backend
refuses to start in production without `X402_STORAGE_DIR`.

The payment worker uses the same process as the API. Railway health alone does
not prove a paid call, settlement or refund has completed. Check worker errors
and a real paid call before publishing an endpoint.
