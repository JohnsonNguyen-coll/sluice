-- Include on-chain daily spend in the atomic off-chain reservation check.
begin;

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
  daily_limit_usd_e6 text,
  chain_spend_usd_e6 text default '0'
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
  chain_spend numeric(78,0) := chain_spend_usd_e6::numeric;
  inserted public.policy_authorizations;
begin
  select * into existing from public.policy_authorizations
    where policy_authorizations.voucher_hash = lower(reserve_policy_authorization.voucher_hash);
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

  perform pg_advisory_xact_lock(hashtextextended(
    lower(reserve_policy_authorization.wallet) || ':' ||
    reserve_policy_authorization.day::text || ':' ||
    reserve_policy_authorization.chain_id::text, 0));
  insert into public.policy_daily_reservations(chain_id, wallet, day)
    values (reserve_policy_authorization.chain_id,
            lower(reserve_policy_authorization.wallet),
            reserve_policy_authorization.day)
    on conflict (chain_id, wallet, day) do nothing;
  select reserved_usd_e6 into used_amount
    from public.policy_daily_reservations
    where policy_daily_reservations.chain_id = reserve_policy_authorization.chain_id
      and policy_daily_reservations.wallet = lower(reserve_policy_authorization.wallet)
      and policy_daily_reservations.day = reserve_policy_authorization.day
    for update;
  -- A zero configured limit means unlimited. Otherwise compare both already
  -- settled spend and pending provider-call reservations against the same cap.
  if limit_amount > 0 and chain_spend + used_amount + requested > limit_amount then
    raise exception 'DAILY_POLICY_EXCEEDED';
  end if;
  update public.policy_daily_reservations
    set reserved_usd_e6 = reserved_usd_e6 + requested, updated_at = now()
    where policy_daily_reservations.chain_id = reserve_policy_authorization.chain_id
      and policy_daily_reservations.wallet = lower(reserve_policy_authorization.wallet)
      and policy_daily_reservations.day = reserve_policy_authorization.day;
  insert into public.policy_authorizations(
    voucher_hash, request_hash, chain_id, wallet, provider, token, amount, day,
    expiry, signature, amount_usd_e6
  ) values (
    lower(reserve_policy_authorization.voucher_hash),
    lower(reserve_policy_authorization.request_hash),
    reserve_policy_authorization.chain_id,
    lower(reserve_policy_authorization.wallet),
    lower(reserve_policy_authorization.provider),
    lower(reserve_policy_authorization.token),
    reserve_policy_authorization.amount::numeric,
    reserve_policy_authorization.day,
    reserve_policy_authorization.expiry,
    null,
    requested
  ) returning * into inserted;
  return inserted;
end;
$$;

revoke all on function public.reserve_policy_authorization(text,text,integer,text,text,text,text,bigint,bigint,text,text,text,text) from public;
grant execute on function public.reserve_policy_authorization(text,text,integer,text,text,text,text,bigint,bigint,text,text,text,text) to service_role;
commit;
