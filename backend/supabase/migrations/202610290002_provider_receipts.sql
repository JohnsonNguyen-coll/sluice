begin;
create table public.api_provider_channels(
 channel text primary key, nonce numeric(78,0) not null default 0,
 cumulative_amount numeric(78,0) not null default 0
);
create table public.api_provider_records(
 id text primary key check(id ~ '^0x[0-9a-f]{64}$'),
 channel text not null references public.api_provider_channels(channel),
 payload jsonb not null, completed boolean not null default false,
 settled_tx text, created_at timestamptz not null default now()
);
create index api_provider_pending on public.api_provider_records(channel,created_at) where settled_tx is null;
alter table public.api_provider_channels enable row level security;
alter table public.api_provider_records enable row level security;
revoke all on public.api_provider_channels,public.api_provider_records from public,anon,authenticated;
grant select,insert,update,delete on public.api_provider_channels,public.api_provider_records to service_role;

create function public.api_provider_accept(p_record jsonb,p_base_nonce text,p_base_amount text,p_price text) returns text
language plpgsql security invoker set search_path='' as $$
declare head public.api_provider_channels%rowtype; expected text;
 next_nonce numeric;next_amount numeric;price numeric;base_nonce numeric;base_amount numeric;
begin
 expected=p_record->>'channel';
 if expected is null or expected='' then raise exception 'Missing channel';end if;
 next_nonce=(p_record#>>'{voucher,nonce}')::numeric;
 next_amount=(p_record#>>'{voucher,cumulativeAmount}')::numeric;
 price=p_price::numeric;base_nonce=p_base_nonce::numeric;base_amount=p_base_amount::numeric;
 if next_nonce<=0 or next_amount<=0 or price<=0 or base_nonce<0 or base_amount<0 or
    next_nonce>=power(2::numeric,256) or next_amount>=power(2::numeric,256) then raise exception 'Invalid channel amount';end if;
 insert into public.api_provider_channels(channel,nonce,cumulative_amount) values(expected,base_nonce,base_amount) on conflict do nothing;
 select * into head from public.api_provider_channels where channel=expected for update;
 if exists(select 1 from public.api_provider_records where id=p_record->>'id') then return 'duplicate';end if;
 if head.cumulative_amount<base_amount then head.cumulative_amount=base_amount;head.nonce=base_nonce;end if;
 if next_nonce<=head.nonce or next_amount<>head.cumulative_amount+price then return 'stale';end if;
 insert into public.api_provider_records(id,channel,payload) values(p_record->>'id',expected,p_record);
 update public.api_provider_channels set nonce=next_nonce,cumulative_amount=next_amount where channel=expected;
 return 'created';
end; $$;

create function public.api_provider_complete(p_id text,p_receipt jsonb,p_response jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if octet_length(p_response::text)>1500000 then raise exception 'Response too large';end if;
 update public.api_provider_records set completed=true,payload=payload||jsonb_build_object('receipt',p_receipt,'response',p_response)
 where id=p_id and not completed;
 if not found then raise exception 'Record missing or already completed';end if;
end; $$;

create function public.api_provider_settled(p_ids text[],p_tx text,p_commitments jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if p_tx !~ '^0x[0-9a-fA-F]{64}$' then raise exception 'Invalid transaction hash';end if;
 update public.api_provider_records set settled_tx=p_tx,
 payload=payload||jsonb_build_object('settledTx',p_tx,'commitment',p_commitments->id)
 where id=any(p_ids) and completed and settled_tx is null;
end; $$;
revoke all on function public.api_provider_accept(jsonb,text,text,text),public.api_provider_complete(text,jsonb,jsonb),public.api_provider_settled(text[],text,jsonb) from public,anon,authenticated;
grant execute on function public.api_provider_accept(jsonb,text,text,text),public.api_provider_complete(text,jsonb,jsonb),public.api_provider_settled(text[],text,jsonb) to service_role;
commit;
