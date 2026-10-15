begin;

create table public.cn_owners (email text primary key check (email = lower(email)));
alter table public.cn_owners enable row level security;
revoke all on public.cn_owners from anon, authenticated;

create function public.cn_is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.cn_owners where email = lower(auth.jwt()->>'email'))
    and auth.uid() is not null;
$$;
revoke all on function public.cn_is_owner() from public;
grant execute on function public.cn_is_owner() to authenticated;

create table public.cn_courses (
  id uuid primary key, owner_id uuid not null default auth.uid() references auth.users(id),
  name text not null, color text not null, description text not null default '', archived integer not null default 0,
  "createdAt" timestamptz not null default now(), unique(id, owner_id)
);
create table public.cn_lessons (
  id uuid primary key, owner_id uuid not null default auth.uid() references auth.users(id),
  "courseId" uuid not null, title text not null, date text not null, content jsonb not null default '[]',
  revision integer not null default 0, search_text text not null default '', "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(), "visitedAt" timestamptz,
  foreign key ("courseId", owner_id) references public.cn_courses(id, owner_id) on delete cascade,
  unique(id, owner_id)
);
create table public.cn_attachments (
  id uuid primary key, owner_id uuid not null default auth.uid() references auth.users(id),
  "lessonId" uuid not null, name text not null, kind text not null check(kind in ('image','audio')),
  mime text not null, size bigint not null check(size > 0), filename text not null,
  sha256 text not null default '', position double precision not null default 0,
  "createdAt" timestamptz not null default now(), ready boolean not null default false,
  part_size integer not null check(part_size > 0),
  foreign key ("lessonId", owner_id) references public.cn_lessons(id, owner_id) on delete cascade,
  unique(id, owner_id)
);
create table public.cn_file_parts (
  attachment_id uuid not null, owner_id uuid not null default auth.uid(),
  part_no integer not null check(part_no >= 0), size integer not null check(size > 0), sha256 text not null,
  path text not null unique, primary key(attachment_id, part_no),
  foreign key (attachment_id, owner_id) references public.cn_attachments(id, owner_id) on delete cascade
);
create table public.cn_settings (
  owner_id uuid primary key default auth.uid() references auth.users(id), value jsonb not null default '{}'
);
create index cn_courses_owner on public.cn_courses(owner_id);
create index cn_lessons_course on public.cn_lessons(owner_id, "courseId", date desc);
create index cn_attachments_lesson on public.cn_attachments(owner_id, "lessonId");
create index cn_file_parts_owner on public.cn_file_parts(owner_id);

do $$ declare t text; begin
  foreach t in array array['cn_courses','cn_lessons','cn_attachments','cn_file_parts','cn_settings'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select, insert, update, delete on public.%I to authenticated',t);
    execute format('create policy owner_select on public.%I for select to authenticated using (owner_id=(select auth.uid()) and (select public.cn_is_owner()))',t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check (owner_id=(select auth.uid()) and (select public.cn_is_owner()))',t);
    execute format('create policy owner_update on public.%I for update to authenticated using (owner_id=(select auth.uid()) and (select public.cn_is_owner())) with check (owner_id=(select auth.uid()) and (select public.cn_is_owner()))',t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using (owner_id=(select auth.uid()) and (select public.cn_is_owner()))',t);
  end loop;
end $$;

create function public.cn_begin_upload(file_id uuid, lesson_id uuid, file_name text, file_kind text,
  file_mime text, file_size bigint, stored_name text, chunk_size integer)
returns public.cn_attachments language plpgsql security invoker set search_path='' as $$
declare result public.cn_attachments; used bigint; begin
  if not public.cn_is_owner() then raise exception 'forbidden'; end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  select coalesce(sum(size),0) into used from public.cn_attachments where owner_id=auth.uid();
  if used + file_size > 1073741824 then raise exception 'storage_quota_exceeded'; end if;
  insert into public.cn_attachments(id,"lessonId",name,kind,mime,size,filename,part_size)
  values(file_id,lesson_id,file_name,file_kind,file_mime,file_size,stored_name,chunk_size) returning * into result;
  return result;
end $$;
create function public.cn_finish_upload(file_id uuid, file_hash text) returns public.cn_attachments
language plpgsql security invoker set search_path='' as $$
declare item public.cn_attachments; count_parts bigint; total bigint; begin
  select * into item from public.cn_attachments where id=file_id for update;
  if item.id is null then raise exception 'file_missing'; end if;
  select count(*),coalesce(sum(size),0) into count_parts,total from public.cn_file_parts where attachment_id=file_id;
  if total<>item.size or count_parts<>ceil(item.size::numeric/item.part_size) then raise exception 'upload_incomplete'; end if;
  if exists(select 1 from public.cn_file_parts where attachment_id=file_id and
    (part_no>=count_parts or size<>least(item.part_size,item.size-part_no::bigint*item.part_size))) then raise exception 'upload_incomplete'; end if;
  update public.cn_attachments set ready=true,sha256=file_hash where id=file_id returning * into item;
  return item;
end $$;
create function public.cn_patch_settings(patch jsonb) returns void
language sql security invoker set search_path='' as $$
  insert into public.cn_settings(owner_id,value) values(auth.uid(),patch)
  on conflict(owner_id) do update set value=public.cn_settings.value || excluded.value;
$$;
create function public.cn_search_lessons(needle text) returns setof uuid
language sql stable security invoker set search_path='' as $$
  select l.id from public.cn_lessons l join public.cn_courses c on c.id=l."courseId"
  where position(lower(left(needle,200)) in lower(l.title||' '||l.search_text||' '||c.name))>0
  order by l.date desc limit 500;
$$;
revoke all on function public.cn_begin_upload(uuid,uuid,text,text,text,bigint,text,integer) from public;
revoke all on function public.cn_finish_upload(uuid,text) from public;
revoke all on function public.cn_patch_settings(jsonb) from public;
revoke all on function public.cn_search_lessons(text) from public;
grant execute on function public.cn_begin_upload(uuid,uuid,text,text,text,bigint,text,integer) to authenticated;
grant execute on function public.cn_finish_upload(uuid,text) to authenticated;
grant execute on function public.cn_patch_settings(jsonb) to authenticated;
grant execute on function public.cn_search_lessons(text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit) values('classnote-private','classnote-private',false,52428800);
create policy cn_private_read on storage.objects for select to authenticated
  using(bucket_id='classnote-private' and (storage.foldername(name))[1]=(select auth.uid())::text and (select public.cn_is_owner()));
create policy cn_private_insert on storage.objects for insert to authenticated
  with check(bucket_id='classnote-private' and (storage.foldername(name))[1]=(select auth.uid())::text and (select public.cn_is_owner()));
create policy cn_private_delete on storage.objects for delete to authenticated
  using(bucket_id='classnote-private' and (storage.foldername(name))[1]=(select auth.uid())::text and (select public.cn_is_owner()));

-- Set the verified owner email in the dashboard SQL editor after this migration.
-- insert into public.cn_owners(email) values ('your-verified-email@example.com');
commit;
