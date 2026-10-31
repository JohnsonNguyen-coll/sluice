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
| `CHAIN_ID` | `5042002` for Arc Testnet; use the target mainnet value when deploying mainnet contracts |
| `RPC_URLS` / `ALCHEMY_RPC_URL` | Optional ordered Arc RPCs and paid fallback |

Do not set any `SUPABASE_SERVICE_ROLE_KEY` or `POLICY_AUTHORITY_PRIVATE_KEY`
variable in Vercel. After both deployments, open `https://<railway-domain>/health`.
It must return `"status":"ready"` before publishing or activating an API.
