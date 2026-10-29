# Website and live workspace

## App usability update (2026-10-29)

The original top-navigation labels, routes and visual style are retained at the user’s request. The app content now offers a connection/setup guide, live wallet balance cards with page-scoped totals, a simplified creation form, task-specific wallet tabs and readable USDC receipts/budgets. Only verified current-owner wallets contribute to totals; failed reads are shown as unavailable. Wallet creation records are not a complete ownership-transfer index, so address lookup remains available.

Funding, withdrawal, provider allowances, daily settlement limits, pause/key changes and refund actions use contract simulation and wallet confirmation. No additional transactions are sent automatically by this UI update. Private receipts use SIWE and wallet-scoped API reads; the refund form selects a stored receipt and saves its explanation privately. Planned organization/approval routes remain clearly unavailable. There is no hosted AI agent or invented activity data.

## Wallet connection (RainbowKit)

The workspace uses RainbowKit 2.2.11 with the existing Wagmi/Query providers, Arc Testnet chain and public-RPC fallback order. Connect opens RainbowKit’s wallet selector; a connected account opens its account modal, and an unsupported chain opens its chain-switch modal. Modal colors follow the app’s Light/Dark/System setting. This connection does not replace the separate SIWE login required for private receipts.

Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in ignored frontend/.env.local to a real Reown project ID, then rebuild/restart the frontend. QR/mobile connectors are included only for a configured 32-character hexadecimal ID. Without an ID, browser extensions remain supported through injected-wallet discovery and Rabby. No demo project ID, account or signing key is bundled. Validation: lint/typecheck, production build and all 54 route checks passed; the actual RainbowKit selector was opened in the app. The no-project-ID browser-wallet mode was verified. QR/mobile and wallet signing still require the user’s real project ID/wallet. Build emits upstream optional MetaMask React Native storage and WalletConnect pino-pretty warnings; they are not build failures.

## API discovery and agent labels

Explore APIs adds /app/explore and /app/explore/:provider/:slug. Providers save drafts or publish real endpoint/USDC price metadata via their SIWE session; active registration is checked on-chain. Directory cards do not imply live price, quality or domain verification. Detail pages show registry counters, allow on-demand domain proof checking, copy SDK configuration and link a selected wallet to its real provider-allowance form.

Current wallet owners can privately save an agent name/purpose in Supabase. Wallet cards use those names after unlocking the wallet session. Recent provider-signed receipts are shown independently of agent runtime: there is no heartbeat or hosted-agent claim. Migrated database tables use RLS and service-role-only grants; the backend authorizes every profile read/write against current on-chain ownership. No fake provider, agent runtime or activity is seeded. Validation: 38 backend tests (261 assertions), frontend lint/typecheck, production build and all 56 route checks pass. The real Supabase directory returns an empty list before any provider publishes; an authenticated current-owner profile read returns HTTP 200 and finds the existing testnet signed payment receipt while runtime status remains unknown. No production listing/profile was seeded by the tests.

## Scope and checkpoint

Updated 2026-10-29. The Next.js application retains the landing, routes, theme, Dark Veil motion and design system. App routes now connect to the Bun API and injected-wallet clients for real reads and simulated/confirmed transactions. Production/a11y certification and an independent contract audit are not claimed.

The coordinated V1/V2/V3 release is in the canonical manifest, including historical factories. Dashboard features include wallet creation/funding/budgets, identity/provider registration, receipt lists, held/releasable batch views, private evidence and dispute/deadline actions. SIWE tokens stay in memory and are revoked on account/network disconnect. Service-role/signing keys stay server-side. Organization/approval/subscription capabilities remain planned. The overview focuses on agent wallets; diagnostic statistic cards and the legacy-dashboard switch have been removed.

See ../../docs/PHASE3_DELIVERY.md for tests, real transaction hashes and the two pending three-day testnet deadlines. Public reference pages explain actual behavior; they use React content rather than an MDX search pipeline. The historical design notes below describe the earlier foundation checkpoint.

The public branding retains Sluice; AgentPay is identified as a working protocol name.

## Workspace layout

The web workspace now lives in `frontend/`. Run the commands below from that directory; the repository root forwards the same dev/build/lint/typecheck commands. Backend integration examples live in `backend/examples/`; Foundry sources and deployment records live in `contract/`.

## Run locally

Use Node >=20.9 and Bun, then:

~~~sh
bun install
bun run dev
# Production verification:
bun run lint
bun run typecheck
bun run build
bun run start
# In another terminal, while the production server is running:
bun run test:routes
~~~

The framework is Next.js 16.4.3 with React 19.3.1 and TypeScript. Vite files and the original entry point remain as migration references; they are not the active web build. The Next.js typecheck covers the web application and imported legacy dashboard. Existing contract deployment scripts retain their own runtime workflow and are not part of the web build/typecheck.

Copy .env.example only if overrides are needed. All pages render with the optional public configuration absent. Missing NEXT_PUBLIC_FACTORY_ADDRESS produces a readable configuration notice; it never enables transaction actions. NEXT_PUBLIC_* variables are public browser configuration and must not contain credentials.

## Architecture

- frontend/src/app/layout.tsx: common HTML, local fonts, pre-paint theme bootstrap and skip link. No wallet provider here.
- frontend/src/app/(marketing): statically prerendered public site with shared header/footer.
- frontend/src/app/(documentation)/docs: statically prerendered documentation foundation and responsive navigation.
- frontend/src/app/app/layout.tsx: persistent wallet/query providers and app shell, exclusive to /app.
- frontend/src/web/lib/site-config.ts: single web source for network, explorer, recorded addresses and optional overrides. It reads the actual contract/deployments/arc-testnet.json; deployments/testnet.json does not exist in this checkout.
- frontend/src/web/lib/routes.ts: typed RouteId, routeHref and dynamic route helpers. Each route has its own explicit page.tsx, metadata and loading/error/not-found files. There is no state-driven simulated router or catch-all page.
- frontend/src/web/lib/route-manifest.json: test fixture mirroring the typed route catalog.
- frontend/src/web/components: shared presentation, navigation, states, wallet UI and base primitives.

Do not wrap the root layout in WalletProviders or import wagmi/viem into public client components. Marketing and docs HTML are rendered at build time, and browser assets are checked for web3 leakage.

Canonical paths and per-page titles/descriptions are present. Production origin is NEXT_PUBLIC_SITE_URL. Generated Open Graph images, sitemap, robots and docs JSON-LD belong to step 5 and are not implemented yet.

## Design tokens

All active tokens live in frontend/src/app/globals.css, with matching Tailwind aliases in frontend/tailwind.config.js.

| Token family | Values / purpose |
| --- | --- |
| Background/surface | --bg, --surface, --surface-raised, --surface-hover |
| Typography | Geist Variable for UI, Geist Mono Variable for code/addresses; local @fontsource assets with font-display swap |
| Foreground | --text, --muted, --subtle |
| Accent | Periwinkle in dark mode, indigo in light mode; --accent, --accent-ink, --accent-soft |
| Semantics | --success, --warn, --danger |
| Layout | 8px spacing rhythm; --space-1 through --space-8; 1200px marketing maximum |
| Shape | --radius-sm 6px, --radius 12px, --radius-lg 20px; --shadow |
| Motion | 160ms fast / 240ms normal; shared --ease |
| Layers | --z-header 30, --z-dialog 80; native dialog top layer |

Theme options are system, dark and light. A small head script applies the saved choice before first paint, storage failures are handled, and controls synchronize through useSyncExternalStore. Both themes define their own semantic colors.

## Components

| Component | Foundation behavior |
| --- | --- |
| Brand, Button/ButtonLink, Badge, Card, Callout | Shared styling and semantic markup |
| PageHeading, EmptyState, Skeleton, PageLoading | Designed content/loading/empty states |
| RouteError, root/global error, NotFoundState | Retry and recovery paths |
| Stat, Progress, Stepper, Timeline | Presentation primitives; no invented data |
| Tabs, WalletTabs | URL-driven navigation; wallet sections have separate routes |
| Table | Sticky headers, URL sort links and empty state; no simulated rows |
| Tooltip, Dialog/Drawer | Focusable tooltip and native dialog semantics |
| CopyButton, CodeBlock, AddressChip, TxStatus | Clipboard feedback and explorer links; code blocks support filename/language labels and line highlighting |
| CommandPalette | Ctrl/Cmd+K page navigation; this is not the planned full-text MDX search |
| ThemeToggle | System preference plus persisted manual choice |
| WalletControl | Injected-wallet connection, wrong-network switching and disconnect |
| AddressLookup, UrlFilters | Wallet-address navigation and GET query filters |
| Toaster | App-only notifications using Sonner |

Syntax highlighting, language tabs, animated charts, full document search/scroll-spy and complete transaction flows are future-stage work. The base table's sort links are primitive hooks; integrated pagination/CSV exports arrive with actual event readers.

## URL state

Wallet sections use real sub-route paths. Audit filter forms write type, sort, from and to into URL search parameters. They are keyed to the query string so browser history restores form values. No live audit events or export output is fabricated.

Dynamic wallet URLs validate address syntax; this is not a claim that the selected address is a deployed agent wallet. Other record routes validate safe URL identifiers and show integration placeholders.

Unmatched top-level routes return 404. As documented by [Next.js](https://nextjs.org/docs/app/api-reference/file-conventions/not-found), a notFound() result after streaming begins may retain HTTP 200 while rendering the designed fallback and injecting noindex. The invalid-wallet test checks both the fallback and noindex.

## Motion and accessibility

Foundation motion uses transform/opacity for hover and opacity for loading skeletons. All animations/transitions and smooth scrolling are disabled under prefers-reduced-motion. The full payment animation and pinned scroll story are step 2.

Navigation has semantic landmarks, active URL states, skip links and visible focus rings. Menus collapse on narrow viewports, dialogs use the native focus trap/Escape behavior, and icon controls have accessible labels. Formal axe, WCAG contrast measurements and mobile Lighthouse >=90 verification are scheduled for step 5; they have not been claimed as complete.

## Add a route / documentation page

1. Add an explicit page.tsx under the relevant route group. Documentation lives under frontend/src/app/(documentation)/docs/<group>/<slug>.
2. Add its route entry to both frontend/src/web/lib/routes.ts and route-manifest.json. Use pageMetadata(routeId) for title, description and canonical path.
3. Add loading.tsx, client error.tsx and not-found.tsx using the shared designed states.
4. Use routeHref or the centralized dynamic helpers for links; do not invent state-based navigation.
5. Add a relevant sidebar group if needed. Parent group labels without actual pages must not become broken links.
6. Run lint, typecheck, production build and route smoke checks.

The MDX content source content/docs/** and compilation/search pipeline are deliberately deferred to step 3. That step should replace the clearly marked previews with source-verified documentation and tested examples.

## Verification at this checkpoint

- Production build: all 54 requested routes render; 36 marketing/docs pages are statically prerendered.
- HTTP smoke checks: route headings, unique page titles, descriptions, main landmarks, no-env configuration states, internal-link targets and designed not-found handling.
- Public bundle check: landing/docs script assets contain no wagmi/ConnectKit markers.
- Browser checks: narrow viewport landing/docs/app; dark and light themes; page search; wallet lookup; wallet budgets refresh; Back/Forward. No wallet was connected or transaction submitted.
- The test suite uses syntactically valid fixture addresses/identifiers only as URL parameters; it does not represent them as real registered records.
- Local build/test output is in .tools/website-build.log and .tools/website-routes.log (ignored).
- Full landing motion, MDX content, real dashboard reads/writes, generated SEO assets, formal axe checks and Lighthouse remain for steps 2–5.

## Route map


### Marketing (7)

| URL | Page |
| --- | --- |
| / | Payment infrastructure for AI agents |
| /how-it-works | How it works |
| /security | Security by design |
| /pricing | Transparent protocol fees |
| /roadmap | A protocol built in stages |
| /changelog | Changelog |
| /status | Network & deployments |

### Docs (29)

| URL | Page |
| --- | --- |
| /docs | Documentation |
| /docs/quickstart/provider | Provider quickstart |
| /docs/quickstart/agent | Agent quickstart |
| /docs/concepts/wallets | Agent wallets |
| /docs/concepts/vouchers | Payment vouchers |
| /docs/concepts/policies | Spending policies |
| /docs/concepts/settlement | Batch settlement |
| /docs/concepts/receipts | Call receipts |
| /docs/concepts/disputes | Disputes & refunds |
| /docs/concepts/reputation | Identity & reputation |
| /docs/concepts/organizations | Organizations |
| /docs/sdk/client | AgentPay client |
| /docs/sdk/errors | SDK errors |
| /docs/sdk/stores | Receipt stores |
| /docs/sdk/signers | Signers |
| /docs/middleware/express | Express middleware |
| /docs/middleware/config | Middleware configuration |
| /docs/middleware/settler | The settler |
| /docs/contracts/addresses | Contract addresses |
| /docs/contracts/agent-wallet | AgentWallet |
| /docs/contracts/factory | Wallet factory |
| /docs/contracts/dispute-vault | DisputeVault |
| /docs/contracts/registries | Registries |
| /docs/guides/multi-token | Multi-token payments |
| /docs/guides/subscriptions | Subscriptions |
| /docs/guides/approvals | Approvals |
| /docs/guides/auditing | Auditing |
| /docs/security/threat-model | Threat model |
| /docs/faq | Frequently asked questions |

### App (18)

| URL | Page |
| --- | --- |
| /app | Overview |
| /app/wallets | Agent wallets |
| /app/wallets/new | Create an agent wallet |
| /app/wallets/[address] | Wallet overview |
| /app/wallets/[address]/budgets | Provider budgets |
| /app/wallets/[address]/activity | Wallet activity |
| /app/wallets/[address]/settings | Wallet settings |
| /app/provider | Provider overview |
| /app/provider/settlements | Settlements |
| /app/provider/integration | Provider integration |
| /app/disputes | Disputes |
| /app/disputes/[id] | Dispute details |
| /app/approvals | Approvals |
| /app/approvals/[id] | Approval details |
| /app/org | Organization |
| /app/org/teams/[teamId] | Team details |
| /app/audit | Audit activity |
| /app/profile/[id] | Public profile |

## Dark Veil and editorial landing layout

The landing now uses the React Bits Dark Veil component (native WebGL2) with the upstream MIT + Commons Clause license retained in frontend/src/web/components/backgrounds/REACT_BITS_LICENSE.md. Only the required component is included; no extra graphics package is installed.

The landing retains its centered hero. An open, animated Agent → Provider → Arc sequence sits below it, with the section heading above and no enclosing card. The sequence is horizontal on desktop and vertical below 760px, followed by the provider-budget demo, integration/code section and compact release strip. Contract code uses theme-aware syntax colors. Shared marketing/docs footers use grouped navigation. All app routes and wallet behavior remain unchanged.

The hero background is lazy-loaded, confined to the top of the landing and paused outside the viewport or when the document is hidden. Animation runs automatically at speed 2 (four times the upstream default), without a pause control or custom frame-rate cap. Local changes include live reduced-motion support, safe WebGL fallback, resizable texture allocation and Strict Mode-safe cleanup. The site palette remains graphite/periwinkle in dark mode and cool-white/indigo in light mode.

The voucher sample is copied from contract/src/AgentWalletV3.sol; SDK/middleware integrations are explicitly marked in progress. No usage metrics, customer claims or balances are invented.

CodeBlock renders safe React spans for syntax tokens with theme-specific colors. Copy uses the original source, including whitespace. Unknown language labels use plain text.
