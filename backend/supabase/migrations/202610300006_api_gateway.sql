begin;
alter table public.api_managed_services drop constraint if exists api_managed_services_kind_check;
alter table public.api_managed_services add constraint api_managed_services_kind_check
 check (kind in ('text-analysis','json-validation','http-proxy'));
alter table public.api_managed_services add column if not exists upstream_ciphertext text;
alter table public.api_managed_services add column if not exists upstream_tested_at timestamptz;
alter table public.api_managed_services add constraint api_managed_upstream_required
 check (kind <> 'http-proxy' or upstream_ciphertext is not null);
-- Existing service-role-only RLS and grants cover these columns too.
commit;
