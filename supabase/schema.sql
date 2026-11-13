-- =========================================================
-- 勤怠管理システム  Supabase スキーマ
-- Supabase ダッシュボード → SQL Editor にこのファイルを丸ごと貼り付けて Run
-- （何度実行しても大丈夫なように作っています）
-- =========================================================

-- ---------- テーブル ----------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  name          text not null default '',
  email         text not null,
  role          text not null default 'employee' check (role in ('employee', 'admin')),
  hourly_rate   integer not null default 1200 check (hourly_rate >= 0),
  leave_granted integer not null default 10 check (leave_granted >= 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists public.attendance (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  work_date  date not null,
  clock_in   timestamptz not null,
  clock_out  timestamptz,
  edited_by  uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, work_date),
  check (clock_out is null or clock_out > clock_in)
);

create table if not exists public.shifts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  work_date  date not null,
  start_time time not null,
  end_time   time not null,
  note       text not null default '',
  status     text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  comment    text not null default '',
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);
-- 却下以外の申請は1人1日1件まで
create unique index if not exists shifts_one_per_day on public.shifts (user_id, work_date) where status <> 'rejected';

create table if not exists public.leaves (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  start_date date not null,
  end_date   date not null,
  days       integer not null default 0,
  reason     text not null default '',
  status     text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  comment    text not null default '',
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

-- 打刻修正申請（打刻忘れ・打刻ミスを社員が申請 → 管理者が承認すると勤怠に反映）
create table if not exists public.attendance_requests (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  work_date  date not null,
  clock_in   timestamptz not null,
  clock_out  timestamptz not null,
  reason     text not null check (length(trim(reason)) > 0),
  status     text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  comment    text not null default '',
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (clock_out > clock_in)
);
-- 同じ日の申請中は1人1件まで
create unique index if not exists attendance_requests_one_pending
  on public.attendance_requests (user_id, work_date) where status = 'pending';

create table if not exists public.settings (
  id           integer primary key default 1 check (id = 1),
  company_name text not null default '株式会社サンプル'
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- 招待（登録できるのは、ここにあるメールアドレス＋招待コードを持つ人だけ）
create table if not exists public.invitations (
  email         text primary key check (email = lower(email)),
  code          text not null default upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
  name          text not null default '',
  role          text not null default 'employee' check (role in ('employee', 'admin')),
  hourly_rate   integer not null default 1200 check (hourly_rate >= 0),
  leave_granted integer not null default 10 check (leave_granted >= 0),
  invited_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  used_at       timestamptz,
  used_by       uuid
);

-- ---------- ヘルパー関数 ----------
-- ログイン中のユーザーが有効な管理者か
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and active);
$$;

-- ログイン中のユーザーが有効か（無効化された人は申請・打刻できない）
create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

-- 期間内の平日数（有給の消化日数）
create or replace function public.weekday_count(d1 date, d2 date)
returns integer language sql immutable as $$
  select count(*)::int from generate_series(d1, d2, interval '1 day') d where extract(isodow from d) < 6;
$$;

-- ---------- サインアップ時：招待をチェックしてプロフィールを作成 ----------
-- 未使用の招待があり、招待コードが一致する場合だけ登録できる（それ以外は登録自体を失敗させる）。
-- ロール・時給・有給日数は招待の内容が使われる。
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  inv public.invitations;
begin
  select * into inv from public.invitations
   where email = lower(new.email) and used_at is null
   for update;
  if not found or inv.code <> upper(trim(coalesce(new.raw_user_meta_data ->> 'invite_code', ''))) then
    raise exception 'INVITE_REQUIRED: 招待されていないメールアドレスか、招待コードが違います';
  end if;

  insert into public.profiles (id, email, name, role, hourly_rate, leave_granted)
  values (
    new.id,
    new.email,
    coalesce(nullif(inv.name, ''), nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    inv.role, inv.hourly_rate, inv.leave_granted
  )
  on conflict (id) do nothing;

  update public.invitations set used_at = now(), used_by = new.id where email = inv.email;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- プロフィール変更のガード ----------
-- 社員はロール・時給・有給・有効/無効を変更できない。最後の管理者は降格・無効化できない。
-- auth.uid() が null（SQL Editor など管理側からの直接操作）は制限しない。
create or replace function public.guard_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role is distinct from old.role
       or new.active is distinct from old.active
       or new.hourly_rate is distinct from old.hourly_rate
       or new.leave_granted is distinct from old.leave_granted then
      raise exception '権限がありません';
    end if;
  end if;
  new.email := old.email; -- メールアドレスはログイン情報と一致させるため変更不可
  if old.role = 'admin' and old.active and (new.role <> 'admin' or not new.active)
     and not exists (select 1 from public.profiles where role = 'admin' and active and id <> old.id) then
    raise exception '最後の管理者は社員に変更・無効化できません';
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile();

-- ---------- 打刻のガード ----------
-- 社員の打刻はサーバー時刻で記録（端末の時計をずらしても不正できない）。
-- 社員ができるのは「出勤」と「当日の退勤（1回だけ）」のみ。修正は管理者だけ。
create or replace function public.guard_attendance()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_admin() then
    if tg_op = 'UPDATE' and auth.uid() is not null and
       (new.clock_in is distinct from old.clock_in or new.clock_out is distinct from old.clock_out) and
       old.user_id <> auth.uid() then
      new.edited_by := auth.uid();
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.user_id   := auth.uid();
    new.work_date := (now() at time zone 'Asia/Tokyo')::date;
    new.clock_in  := now();
    new.clock_out := null;
    new.edited_by := null;
  else
    if old.clock_out is not null
       or new.clock_in is distinct from old.clock_in
       or new.work_date is distinct from old.work_date
       or new.user_id is distinct from old.user_id then
      raise exception '打刻の修正は管理者に依頼してください';
    end if;
    new.clock_out := now();
    new.edited_by := old.edited_by;
  end if;
  return new;
end $$;

drop trigger if exists attendance_guard on public.attendance;
create trigger attendance_guard before insert or update on public.attendance
  for each row execute function public.guard_attendance();

-- ---------- 申請（シフト・有給）の共通ガード ----------
-- 申請は必ず「申請中」で作成。承認/却下したら処理者と日時を自動記録。
create or replace function public.guard_request()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  granted int; used int; pending int;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and not public.is_admin() then
      new.user_id := auth.uid();
      new.status := 'pending';
      new.comment := '';
    end if;
    new.decided_by := null;
    new.decided_at := null;
  elsif new.status is distinct from old.status then
    if old.status <> 'pending' then
      raise exception 'この申請はすでに処理済みです';
    end if;
    new.decided_by := auth.uid();
    new.decided_at := now();
  end if;

  -- 有給：日数をサーバーで計算し、残日数をチェック
  if tg_table_name = 'leaves' then
    new.days := public.weekday_count(new.start_date, new.end_date);
    if new.days = 0 then
      raise exception '期間に平日が含まれていません';
    end if;
    select leave_granted into granted from public.profiles where id = new.user_id;
    select coalesce(sum(days) filter (where status = 'approved'), 0),
           coalesce(sum(days) filter (where status = 'pending'), 0)
      into used, pending
      from public.leaves where user_id = new.user_id and id <> new.id;
    if tg_op = 'INSERT' and used + pending + new.days > granted then
      raise exception '有給の残日数が足りません（申請可能：%日）', greatest(granted - used - pending, 0);
    end if;
    if tg_op = 'UPDATE' and new.status = 'approved' and old.status = 'pending' and used + new.days > granted then
      raise exception '残日数が不足しているため承認できません';
    end if;
    if tg_op = 'INSERT' and exists (
      select 1 from public.leaves
      where user_id = new.user_id and status <> 'rejected'
        and not (new.end_date < start_date or new.start_date > end_date)) then
      raise exception '期間が既存の有給申請と重複しています';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists shifts_guard on public.shifts;
create trigger shifts_guard before insert or update on public.shifts
  for each row execute function public.guard_request();

drop trigger if exists leaves_guard on public.leaves;
create trigger leaves_guard before insert or update on public.leaves
  for each row execute function public.guard_request();

-- ---------- 打刻修正申請 ----------
-- 申請時のチェック：未来の日付は不可、時刻はその日のもの（日本時間）であること
create or replace function public.guard_attendance_request()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.work_date > (now() at time zone 'Asia/Tokyo')::date then
      raise exception '未来の日付は申請できません';
    end if;
    if (new.clock_in at time zone 'Asia/Tokyo')::date <> new.work_date
       or (new.clock_out at time zone 'Asia/Tokyo')::date <> new.work_date then
      raise exception '出勤・退勤の時刻は申請日のものを指定してください';
    end if;
    if new.clock_out > now() then
      raise exception 'まだ来ていない時刻は申請できません';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists attendance_requests_check on public.attendance_requests;
create trigger attendance_requests_check before insert on public.attendance_requests
  for each row execute function public.guard_attendance_request();

-- 申請中で作成・処理者の記録は共通ガードを使う
drop trigger if exists attendance_requests_guard on public.attendance_requests;
create trigger attendance_requests_guard before insert or update on public.attendance_requests
  for each row execute function public.guard_request();

-- 承認されたら勤怠に反映（記録が無い日は新規作成、ある日は上書き）
create or replace function public.apply_attendance_request()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'approved' and old.status = 'pending' then
    insert into public.attendance (user_id, work_date, clock_in, clock_out, edited_by)
    values (new.user_id, new.work_date, new.clock_in, new.clock_out, new.decided_by)
    on conflict (user_id, work_date) do update
      set clock_in = excluded.clock_in, clock_out = excluded.clock_out, edited_by = excluded.edited_by;
  end if;
  return new;
end $$;

drop trigger if exists attendance_requests_apply on public.attendance_requests;
create trigger attendance_requests_apply after update on public.attendance_requests
  for each row execute function public.apply_attendance_request();

-- ---------- RLS（行レベルセキュリティ） ----------
alter table public.profiles   enable row level security;
alter table public.attendance enable row level security;
alter table public.shifts     enable row level security;
alter table public.leaves     enable row level security;
alter table public.settings   enable row level security;
alter table public.invitations enable row level security;
alter table public.attendance_requests enable row level security;

-- ※ 無効化されたユーザーは、ログインできても（API を直接叩いても）何も読み書きできない。
--   そのため全ポリシーに is_active_user() / is_admin()（＝有効な管理者）の条件を付けている。

-- profiles：有効なユーザーは全員の名前が見える（シフト一覧・カレンダー用）。更新は本人（名前のみ）か管理者。
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (public.is_active_user());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using ((id = auth.uid() and public.is_active_user()) or public.is_admin())
  with check ((id = auth.uid() and public.is_active_user()) or public.is_admin());

-- invitations：管理者だけが作成・閲覧・取消できる。
drop policy if exists invitations_admin on public.invitations;
create policy invitations_admin on public.invitations for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- attendance：自分の分だけ見える（管理者は全員分）。
drop policy if exists attendance_select on public.attendance;
create policy attendance_select on public.attendance for select to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());
drop policy if exists attendance_insert on public.attendance;
create policy attendance_insert on public.attendance for insert to authenticated
  with check ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());
drop policy if exists attendance_update on public.attendance;
create policy attendance_update on public.attendance for update to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());
drop policy if exists attendance_delete on public.attendance;
create policy attendance_delete on public.attendance for delete to authenticated using (public.is_admin());

-- shifts / leaves：全員分見える（カレンダー用）。申請は本人、承認・却下は管理者、取消は本人の申請中のみ。
drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts for select to authenticated using (public.is_active_user());
drop policy if exists shifts_insert on public.shifts;
create policy shifts_insert on public.shifts for insert to authenticated
  with check (user_id = auth.uid() and public.is_active_user());
drop policy if exists shifts_update on public.shifts;
create policy shifts_update on public.shifts for update to authenticated using (public.is_admin());
drop policy if exists shifts_delete on public.shifts;
create policy shifts_delete on public.shifts for delete to authenticated
  using ((user_id = auth.uid() and status = 'pending' and public.is_active_user()) or public.is_admin());

drop policy if exists leaves_select on public.leaves;
create policy leaves_select on public.leaves for select to authenticated using (public.is_active_user());
drop policy if exists leaves_insert on public.leaves;
create policy leaves_insert on public.leaves for insert to authenticated
  with check (user_id = auth.uid() and public.is_active_user());
drop policy if exists leaves_update on public.leaves;
create policy leaves_update on public.leaves for update to authenticated using (public.is_admin());
drop policy if exists leaves_delete on public.leaves;
create policy leaves_delete on public.leaves for delete to authenticated
  using ((user_id = auth.uid() and status = 'pending' and public.is_active_user()) or public.is_admin());

-- attendance_requests：自分の申請だけ見える（管理者は全員分）。申請は本人、承認・却下は管理者、取消は本人の申請中のみ。
drop policy if exists attendance_requests_select on public.attendance_requests;
create policy attendance_requests_select on public.attendance_requests for select to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());
drop policy if exists attendance_requests_insert on public.attendance_requests;
create policy attendance_requests_insert on public.attendance_requests for insert to authenticated
  with check (user_id = auth.uid() and public.is_active_user());
drop policy if exists attendance_requests_update on public.attendance_requests;
create policy attendance_requests_update on public.attendance_requests for update to authenticated using (public.is_admin());
drop policy if exists attendance_requests_delete on public.attendance_requests;
create policy attendance_requests_delete on public.attendance_requests for delete to authenticated
  using ((user_id = auth.uid() and status = 'pending' and public.is_active_user()) or public.is_admin());

-- settings：有効なユーザーは読める、管理者だけ更新。
drop policy if exists settings_select on public.settings;
create policy settings_select on public.settings for select to authenticated using (public.is_active_user());
drop policy if exists settings_update on public.settings;
create policy settings_update on public.settings for update to authenticated using (public.is_admin());

-- ---------- Realtime（承認などを他の端末に即時反映） ----------
do $$
declare t text;
begin
  foreach t in array array['profiles', 'attendance', 'shifts', 'leaves', 'settings', 'invitations', 'attendance_requests'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
