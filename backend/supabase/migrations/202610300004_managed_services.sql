-- Backend-only hosted services. Ciphertexts never reach browser clients.
create table if not exists public.api_managed_services (
 id uuid primary key,
 chain_id bigint not null check(chain_id > 0),
 owner text not null check(owner ~ '^0x[0-9a-f]{40}$'),
 provider text not null check(provider ~ '^0x[0-9a-f]{40}$'),
 slug text not null check(slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
 name text not null check(length(name) between 1 and 80),
 kind text not null check(kind in ('text-analysis','json-validation')),
 price text not null check(price ~ '^[1-9][0-9]{0,11}$'),
 signer_ciphertext text not null,
 state text not null default 'draft' check(state in ('draft','active','paused')),
 published boolean not null default false,
 registration_tx text,
 last_settlement_tx text,
 last_worker_at timestamptz,
 worker_error text,
 created_at timestamptz not null default now(),
 unique(chain_id,owner,slug),
 unique(chain_id,provider)
);
alter table public.api_managed_services enable row level security;
revoke all on public.api_managed_services from public, anon, authenticated;
grant select,insert,update on public.api_managed_services to service_role;

-- No lease stealing: a crashed process requires an operator to verify all
-- pending transactions before clearing its lease. Prefer safety over double signing.
create table if not exists public.api_managed_leases (
 service_id uuid primary key references public.api_managed_services(id),
 holder uuid not null,
 acquired_at timestamptz not null default now()
);
alter table public.api_managed_leases enable row level security;
revoke all on public.api_managed_leases from public,anon,authenticated;
grant select,insert,delete on public.api_managed_leases to service_role;
create or replace function public.api_managed_lock(p_id uuid,p_holder uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
begin
 insert into api_managed_leases(service_id,holder) values(p_id,p_holder)
 on conflict do nothing;
 return exists(select 1 from api_managed_leases where service_id=p_id and holder=p_holder);
end;$$;
create or replace function public.api_managed_unlock(p_id uuid,p_holder uuid)
returns void language sql security invoker set search_path=public as $$
 delete from api_managed_leases where service_id=p_id and holder=p_holder;
$$;
revoke all on function public.api_managed_lock(uuid,uuid) from public,anon,authenticated;
revoke all on function public.api_managed_unlock(uuid,uuid) from public,anon,authenticated;
grant execute on function public.api_managed_lock(uuid,uuid) to service_role;
grant execute on function public.api_managed_unlock(uuid,uuid) to service_role;
