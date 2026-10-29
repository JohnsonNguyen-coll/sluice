-- Backend-only storage. Run with Supabase migrations or the SQL editor.
-- Wallet sessions here are opaque API tokens, not Supabase Auth JWTs.
begin;
create table public.api_challenges (
 id uuid primary key,
 address text not null check (address ~ '^0x[0-9a-f]{40}$'),
 message text not null check (length(message) between 1 and 4096),
 expires_at timestamptz not null,
 consumed_at timestamptz,
 created_at timestamptz not null default now()
);
create index api_challenges_expiry on public.api_challenges(expires_at);
create table public.api_sessions (
 token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
 address text not null check (address ~ '^0x[0-9a-f]{40}$'),
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
create index api_sessions_expiry on public.api_sessions(expires_at);
create table public.api_voucher_channels (
 channel text primary key,
 nonce numeric(78,0) not null default 0,
 cumulative_amount numeric(78,0) not null default 0
);
create table public.api_vouchers (
 id text primary key check (id ~ '^0x[0-9a-f]{64}$'),
 channel text not null references public.api_voucher_channels(channel),
 chain_id bigint not null check (chain_id > 0),
 wallet text not null check(wallet ~ '^0x[0-9a-f]{40}$'),
 provider text not null check(provider ~ '^0x[0-9a-f]{40}$'),
 token text not null check(token ~ '^0x[0-9a-f]{40}$'),
 nonce text not null check(nonce ~ '^(0|[1-9][0-9]{0,77})$'),
 cumulative_amount text not null check(cumulative_amount ~ '^(0|[1-9][0-9]{0,77})$'),
 payload jsonb not null,
 signature text not null check(signature ~ '^0x[0-9a-fA-F]{130}$'),
 received_at timestamptz not null default now()
);
create index api_vouchers_provider on public.api_vouchers(provider,received_at desc,id desc);
create table public.api_evidence (
 id text not null check(id ~ '^0x[0-9a-f]{64}$'),
 settlement_id text not null check(settlement_id ~ '^0x[0-9a-f]{64}$'),
 author text not null check(author ~ '^0x[0-9a-f]{40}$'),
 content text not null check(octet_length(content) between 1 and 16384),
 created_at timestamptz not null default now(),
 primary key(id,settlement_id,author)
);
create index api_evidence_settlement on public.api_evidence(settlement_id,created_at);
alter table public.api_challenges enable row level security;
alter table public.api_sessions enable row level security;
alter table public.api_voucher_channels enable row level security;
alter table public.api_vouchers enable row level security;
alter table public.api_evidence enable row level security;
revoke all on public.api_challenges,public.api_sessions,public.api_voucher_channels,public.api_vouchers,public.api_evidence from public,anon,authenticated;
grant select,insert,update,delete on public.api_challenges,public.api_sessions,public.api_voucher_channels,public.api_vouchers,public.api_evidence to service_role;

create function public.api_issue_session(p_challenge uuid,p_token_hash text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare who text;
begin
 update public.api_challenges set consumed_at=now()
 where id=p_challenge and consumed_at is null and expires_at>now()
 returning address into who;
 if who is null then return false; end if;
 insert into public.api_sessions(token_hash,address,expires_at) values(p_token_hash,who,now()+interval '1 hour');
 return true;
end;
$$;
create function public.api_session_address(p_token_hash text) returns text
language sql security invoker set search_path='' as $$
 select address from public.api_sessions where token_hash=p_token_hash and expires_at>now();
$$;
create function public.api_accept_voucher(p_record jsonb) returns text
language plpgsql security invoker set search_path='' as $$
declare
 head public.api_voucher_channels%rowtype;
 next_nonce numeric; next_amount numeric;
 expected_channel text;
begin
 expected_channel=(p_record->>'chain_id')||':'||(p_record->>'wallet')||':'||(p_record->>'provider')||':'||(p_record->>'token');
 if p_record->>'channel' is distinct from expected_channel then raise exception 'Invalid voucher channel'; end if;
 next_nonce=(p_record->>'nonce')::numeric;
 next_amount=(p_record->>'cumulative_amount')::numeric;
 if next_nonce<=0 or next_amount<=0 or next_nonce>=power(2::numeric,256) or next_amount>=power(2::numeric,256) then raise exception 'Invalid voucher integer'; end if;
 insert into public.api_voucher_channels(channel) values(expected_channel) on conflict do nothing;
 select * into head from public.api_voucher_channels where channel=expected_channel for update;
 if exists(select 1 from public.api_vouchers where id=p_record->>'id') then return 'duplicate'; end if;
 if next_nonce<=head.nonce or next_amount<=head.cumulative_amount then return 'stale'; end if;
 insert into public.api_vouchers(id,channel,chain_id,wallet,provider,token,nonce,cumulative_amount,payload,signature,received_at)
 values(p_record->>'id',expected_channel,(p_record->>'chain_id')::bigint,p_record->>'wallet',p_record->>'provider',p_record->>'token',p_record->>'nonce',p_record->>'cumulative_amount',p_record->'payload',p_record->>'signature',now());
 update public.api_voucher_channels set nonce=next_nonce,cumulative_amount=next_amount where channel=expected_channel;
 return 'created';
end;
$$;
create function public.api_prune_expired() returns void
language plpgsql security invoker set search_path='' as $$
begin
 delete from public.api_sessions where expires_at<now();
 delete from public.api_challenges where expires_at<now()-interval '1 day';
end;
$$;
revoke all on function public.api_issue_session(uuid,text),public.api_session_address(text),public.api_accept_voucher(jsonb),public.api_prune_expired() from public,anon,authenticated;
grant execute on function public.api_issue_session(uuid,text),public.api_session_address(text),public.api_accept_voucher(jsonb),public.api_prune_expired() to service_role;
commit;
