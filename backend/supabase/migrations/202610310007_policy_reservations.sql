-- Server-issued, provider-verifiable reservations for off-chain spend policy.
-- The service-role backend is the only caller of the RPC below; clients receive
-- only a short-lived signed authorization and cannot alter reservation totals.
begin;

create table if not exists public.policy_daily_reservations (
  chain_id integer not null,
  wallet text not null,
  day bigint not null,
  reserved_usd_e6 numeric(78,0) not null default 0 check (reserved_usd_e6 >= 0),
  updated_at timestamptz not null default now(),
  primary key (chain_id, wallet, day)
);

create table if not exists public.policy_authorizations (
  voucher_hash text primary key check (voucher_hash ~ '^0x[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^0x[0-9a-f]{64}$'),
  chain_id integer not null,
  wallet text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  provider text not null check (provider ~ '^0x[0-9a-f]{40}$'),
  token text not null check (token ~ '^0x[0-9a-f]{40}$'),
  amount numeric(78,0) not null check (amount > 0),
  day bigint not null,
  expiry bigint not null,
  signature text check (signature is null or signature ~ '^0x[0-9a-f]{130}$'),
  amount_usd_e6 numeric(78,0) not null check (amount_usd_e6 >= 0),
  created_at timestamptz not null default now()
);
create index if not exists policy_authorizations_wallet_day_idx
  on public.policy_authorizations (chain_id, wallet, day);

alter table public.policy_daily_reservations enable row level security;
alter table public.policy_authorizations enable row level security;
revoke all on public.policy_daily_reservations, public.policy_authorizations from anon, authenticated;

create or replace function public.reserve_policy_authorization(
  voucher_hash text,
  request_hash text,
  chain_id integer,
  wallet text,
  provider text,
  token text,
  amount text,
  day bigint,
  expiry bigint,
  signature text,
  amount_usd_e6 text,
  daily_limit_usd_e6 text
) returns public.policy_authorizations
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.policy_authorizations;
  used_amount numeric(78,0);
  requested numeric(78,0) := amount_usd_e6::numeric;
  limit_amount numeric(78,0) := daily_limit_usd_e6::numeric;
  inserted public.policy_authorizations;
begin
  -- Replaying the exact authorization is idempotent. A different payload for
  -- the same voucher hash is always rejected instead of silently reused.
  select * into existing from public.policy_authorizations where policy_authorizations.voucher_hash = lower(reserve_policy_authorization.voucher_hash);
  if found then
    if existing.request_hash = lower(reserve_policy_authorization.request_hash)
       and existing.chain_id = reserve_policy_authorization.chain_id
       and existing.wallet = lower(reserve_policy_authorization.wallet)
       and existing.provider = lower(reserve_policy_authorization.provider)
       and existing.token = lower(reserve_policy_authorization.token)
       and existing.amount = reserve_policy_authorization.amount::numeric
       and existing.day = reserve_policy_authorization.day
       and existing.expiry = reserve_policy_authorization.expiry
    then return existing; end if;
    raise exception 'POLICY_AUTHORIZATION_CONFLICT';
  end if;

  -- Serialize every wallet/day reservation, including first insert.
  perform pg_advisory_xact_lock(hashtextextended(lower(reserve_policy_authorization.wallet) || ':' || reserve_policy_authorization.day::text || ':' || reserve_policy_authorization.chain_id::text, 0));
  insert into public.policy_daily_reservations(chain_id, wallet, day)
    values (reserve_policy_authorization.chain_id, lower(reserve_policy_authorization.wallet), reserve_policy_authorization.day)
    on conflict (chain_id, wallet, day) do nothing;
  select reserved_usd_e6 into used_amount from public.policy_daily_reservations
    where policy_daily_reservations.chain_id = reserve_policy_authorization.chain_id
      and policy_daily_reservations.wallet = lower(reserve_policy_authorization.wallet)
      and policy_daily_reservations.day = reserve_policy_authorization.day for update;
  if limit_amount > 0 and used_amount + requested > limit_amount then
    raise exception 'DAILY_POLICY_EXCEEDED';
  end if;
  update public.policy_daily_reservations
    set reserved_usd_e6 = reserved_usd_e6 + requested, updated_at = now()
    where policy_daily_reservations.chain_id = reserve_policy_authorization.chain_id
      and policy_daily_reservations.wallet = lower(reserve_policy_authorization.wallet)
      and policy_daily_reservations.day = reserve_policy_authorization.day;
  insert into public.policy_authorizations(
    voucher_hash, request_hash, chain_id, wallet, provider, token, amount, day,
    expiry, amount_usd_e6
  ) values (
    lower(reserve_policy_authorization.voucher_hash), lower(reserve_policy_authorization.request_hash),
    reserve_policy_authorization.chain_id, lower(reserve_policy_authorization.wallet),
    lower(reserve_policy_authorization.provider), lower(reserve_policy_authorization.token),
    reserve_policy_authorization.amount::numeric, reserve_policy_authorization.day,
    reserve_policy_authorization.expiry, requested
  ) returning * into inserted;
  return inserted;
end;
$$;

revoke all on function public.reserve_policy_authorization(text,text,integer,text,text,text,text,bigint,bigint,text,text,text) from public;
grant execute on function public.reserve_policy_authorization(text,text,integer,text,text,text,text,bigint,bigint,text,text,text) to service_role;
commit;
