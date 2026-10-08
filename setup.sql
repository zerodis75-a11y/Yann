-- Run once in the Supabase SQL Editor, AFTER the SQL at the top of kwik-rewards.html.

create table orders(
 id text primary key,
 user_id uuid not null references profiles on delete cascade,
 amount int not null check(amount>0),
 delivered_at timestamptz not null default now());
alter table orders enable row level security;
revoke all on orders from anon, authenticated;

create function order_delivered(p_order text,p_user uuid,p_amount int) returns jsonb language plpgsql security definer set search_path=public as $f$
declare pr profiles; rf profiles; is_first boolean; pts int;
begin
 insert into orders(id,user_id,amount) values(p_order,p_user,p_amount) on conflict do nothing;
 if not found then return jsonb_build_object('duplicate',true); end if;
 select * into pr from profiles where id=p_user for update;
 if not found then raise exception 'Unknown user'; end if;
 is_first:=pr.spent=0;
 pts:=floor(p_amount/1000.0*case when pr.spent>=200000 then 3 when pr.spent>=75000 then 2 when pr.spent>=20000 then 1.5 else 1 end)::int;
 update profiles set spent=spent+p_amount,points=points+pts where id=p_user;
 insert into ledger(user_id,note,pts) values(p_user,'Order '||p_order||' delivered',pts);
 if is_first and pr.ref_by is not null then
  select * into rf from profiles where code=pr.ref_by and id<>p_user;
  if found then
   update profiles set points=points+100 where id in (p_user,rf.id);
   insert into ledger(user_id,note,pts) values(p_user,'Invite bonus',100),(rf.id,'Referral: '||pr.name||' placed first order',100);
  end if;
 end if;
 return jsonb_build_object('pts',pts,'first_order',is_first);
end $f$;

create function finish_cashout(p_id bigint,p_ok boolean) returns void language plpgsql security definer set search_path=public as $f$
declare c cashouts;
begin
 select * into c from cashouts where id=p_id and status='processing' for update;
 if not found then return; end if;
 if p_ok then
  update cashouts set status='paid' where id=p_id;
 else
  update cashouts set status='failed' where id=p_id;
  update profiles set points=points+c.pts where id=c.user_id;
  insert into ledger(user_id,note,pts) values(c.user_id,'Cash out failed, points returned',c.pts);
 end if;
end $f$;

revoke execute on function order_delivered(text,uuid,int), finish_cashout(bigint,boolean) from public, anon, authenticated;
grant execute on function order_delivered(text,uuid,int), finish_cashout(bigint,boolean) to service_role;

-- PIN lockout: 5 wrong PINs lock cash-outs for 30 minutes.
alter table profiles add column pin_fails int not null default 0, add column locked_until timestamptz;
drop function request_cashout(text,text,int);
create function request_cashout(p_phone text,p_pin text,p_n int) returns jsonb language plpgsql security definer set search_path=public as $f$
declare p profiles;
begin
 select * into p from profiles where id=auth.uid() for update;
 if not p.has_pin then raise exception 'Set a withdrawal PIN first'; end if;
 if p.locked_until>now() then raise exception 'Too many wrong PINs. Try again in 30 minutes'; end if;
 if p.pin_hash<>extensions.crypt(p_pin,p.pin_hash) then
  update profiles set pin_fails=case when pin_fails+1>=5 then 0 else pin_fails+1 end,
   locked_until=case when pin_fails+1>=5 then now()+interval '30 minutes' else locked_until end where id=p.id;
  return jsonb_build_object('error','Wrong PIN');
 end if;
 if p_phone !~ '^6[0-9]{8}$' then raise exception 'Enter a valid 9-digit number starting with 6'; end if;
 if p_n<2000 then raise exception 'Minimum cash out is 2,000 points'; end if;
 if p_n>p.points then raise exception 'Not enough points'; end if;
 update profiles set points=points-p_n,pin_fails=0 where id=p.id;
 insert into cashouts(user_id,phone,pts) values(p.id,p_phone,p_n);
 insert into ledger(user_id,note,pts) values(p.id,'Cash out to '||p_phone,-p_n);
 return jsonb_build_object('ok',true);
end $f$;
revoke execute on function request_cashout(text,text,int) from public, anon;
grant execute on function request_cashout(text,text,int) to authenticated;
