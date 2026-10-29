begin;
create table if not exists public.api_agent_profiles (
 chain_id bigint not null, wallet text not null check(wallet ~ '^0x[0-9a-f]{40}$'),
 owner text not null check(owner ~ '^0x[0-9a-f]{40}$'),
 name text not null check(char_length(name) between 1 and 80),
 purpose text not null default '' check(char_length(purpose)<=500),
 updated_at timestamptz not null default now(), primary key(chain_id,wallet)
);
create table if not exists public.api_api_listings (
 chain_id bigint not null, provider text not null check(provider ~ '^0x[0-9a-f]{40}$'),
 slug text not null check(slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
 name text not null check(char_length(name) between 1 and 80),
 description text not null check(char_length(description) between 1 and 1000),
 category text not null check(category in ('Data','AI','Search','Tools','Other')),
 endpoint text not null check(char_length(endpoint)<=2048), method text not null check(method in ('GET','POST')),
 docs_url text not null default '' check(char_length(docs_url)<=2048),
 price text not null check(price ~ '^[1-9][0-9]{0,77}$'),
 published boolean not null default false, updated_at timestamptz not null default now(),
 primary key(chain_id,provider,slug)
);
create index if not exists api_api_listings_browse on public.api_api_listings(chain_id,published,category,updated_at desc);
alter table public.api_agent_profiles enable row level security;
alter table public.api_api_listings enable row level security;
revoke all on public.api_agent_profiles,public.api_api_listings from public,anon,authenticated;
grant select,insert,update,delete on public.api_agent_profiles,public.api_api_listings to service_role;
comment on table public.api_api_listings is 'Provider-authored catalog. Prices are declarations, not verified live API quotes. All browser access goes through authenticated/validated backend routes.';
comment on table public.api_agent_profiles is 'Private wallet labels. Backend rechecks current on-chain ownership before reading or writing.';
commit;
