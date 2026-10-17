begin;

-- Existing recordings retain their provider and IDs. No objects are moved or deleted.
alter table public.cn_attachments add column storage_provider text not null default 'supabase'
  check (storage_provider in ('supabase','r2'));

create table public.cn_storage_limits (
  provider text primary key check (provider in ('supabase','r2')),
  limit_bytes bigint not null check (limit_bytes > 0)
);
insert into public.cn_storage_limits values ('supabase',1073741824),('r2',10000000000);
alter table public.cn_storage_limits enable row level security;
revoke all on public.cn_storage_limits from anon, authenticated;
grant select on public.cn_storage_limits to authenticated;
create policy owner_read_limits on public.cn_storage_limits for select to authenticated
  using ((select public.cn_is_owner()));

create or replace function public.cn_begin_upload(file_id uuid, lesson_id uuid, file_name text, file_kind text,
  file_mime text, file_size bigint, stored_name text, chunk_size integer)
returns public.cn_attachments language plpgsql security invoker set search_path='' as $$
declare result public.cn_attachments; used bigint; capacity bigint; begin
  if not public.cn_is_owner() then raise exception 'forbidden'; end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  select limit_bytes into strict capacity from public.cn_storage_limits where provider='supabase';
  select coalesce(sum(size),0) into used from public.cn_attachments where owner_id=auth.uid() and storage_provider='supabase';
  if used + file_size > capacity then raise exception 'storage_quota_exceeded'; end if;
  insert into public.cn_attachments(id,"lessonId",name,kind,mime,size,filename,part_size,storage_provider)
  values(file_id,lesson_id,file_name,file_kind,file_mime,file_size,stored_name,chunk_size,'supabase') returning * into result;
  return result;
end $$;

create function public.cn_begin_r2_upload(file_id uuid, lesson_id uuid, file_name text, file_kind text,
  file_mime text, file_size bigint, stored_name text, chunk_size integer)
returns public.cn_attachments language plpgsql security invoker set search_path='' as $$
declare result public.cn_attachments; used bigint; capacity bigint; begin
  if not public.cn_is_owner() then raise exception 'forbidden'; end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  select limit_bytes into strict capacity from public.cn_storage_limits where provider='r2';
  select coalesce(sum(size),0) into used from public.cn_attachments where owner_id=auth.uid() and storage_provider='r2';
  if used + file_size > capacity then raise exception 'r2_storage_quota_exceeded'; end if;
  insert into public.cn_attachments(id,"lessonId",name,kind,mime,size,filename,part_size,storage_provider)
  values(file_id,lesson_id,file_name,file_kind,file_mime,file_size,stored_name,chunk_size,'r2') returning * into result;
  return result;
end $$;
revoke all on function public.cn_begin_r2_upload(uuid,uuid,text,text,text,bigint,text,integer) from public;
grant execute on function public.cn_begin_r2_upload(uuid,uuid,text,text,text,bigint,text,integer) to authenticated;

commit;
