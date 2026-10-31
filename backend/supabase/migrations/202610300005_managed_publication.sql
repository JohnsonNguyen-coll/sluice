-- Safe for setups that applied migration 004 before publication support landed.
alter table public.api_managed_services
 add column if not exists published boolean not null default false;
