-- Ticket signatures are added after the atomic reservation insert. Once an
-- associated voucher settles, remove its pending reservation so on-chain spend
-- and pending spend are never counted twice.
begin;

alter table public.policy_authorizations
  alter column signature drop not null,
  add column if not exists released_at timestamptz;

create or replace function public.release_policy_authorizations(
  p_voucher_hashes text[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item public.policy_authorizations;
begin
  for item in
    update public.policy_authorizations
      set released_at = now()
      where voucher_hash = any(select lower(value) from unnest(p_voucher_hashes) as value)
        and released_at is null
      returning *
  loop
    update public.policy_daily_reservations
      set reserved_usd_e6 = greatest(0, reserved_usd_e6 - item.amount_usd_e6),
          updated_at = now()
      where chain_id = item.chain_id and wallet = item.wallet and day = item.day;
  end loop;
end;
$$;

revoke all on function public.release_policy_authorizations(text[]) from public;
grant execute on function public.release_policy_authorizations(text[]) to service_role;
commit;
