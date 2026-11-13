'use strict';
/* =========================================================
 * 勤怠管理システム（バックエンド：Supabase）
 * - 認証：Supabase Auth（初回ログイン時に自動登録）
 * - 権限：RLS とトリガー（supabase/schema.sql）で DB 側でも制御
 * - ログイン状態は sessionStorage（タブごと）なので、
 *   タブ1=社員、タブ2=管理者 で同時に動作確認できる
 * - 他の端末・タブでの変更は Supabase Realtime で即時反映
 * ========================================================= */

/* ---------- utils ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const hm = (iso) => { if (!iso) return '—'; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDur = (m) => `${Math.floor(m / 60)}:${pad(m % 60)}`;
const fmtDateJa = (s) => { const d = parseYmd(s); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
const fmtDT = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const at = (dateStr, time) => { const [h, m] = time.split(':').map(Number); const d = parseYmd(dateStr); d.setHours(h, m, 0, 0); return d.toISOString(); };

/** 労基法ベースの自動休憩：6h超→45分、8h超→60分 */
const breakMin = (gross) => (gross > 480 ? 60 : gross > 360 ? 45 : 0);
const grossMin = (r) => (r.clockIn && r.clockOut ? Math.max(0, Math.round((new Date(r.clockOut) - new Date(r.clockIn)) / 60000)) : 0);
const workMin = (r) => { const g = grossMin(r); return g - breakMin(g); };

/** 期間内の平日数（有給の消化日数） */
function weekdayCount(start, end) {
  let n = 0;
  for (let d = parseYmd(start); d <= parseYmd(end); d = addDays(d, 1)) if (d.getDay() % 6 !== 0) n++;
  return n;
}

/* ---------- Supabase ---------- */
const CONFIGURED = !!(window.supabase && window.SUPABASE_URL && window.SUPABASE_ANON_KEY && !/YOUR-/.test(window.SUPABASE_URL + window.SUPABASE_ANON_KEY));
// ログイン状態をタブごとに保持（タブ1=社員、タブ2=管理者で同時に確認できる）
const sb = CONFIGURED
  ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, { auth: { storage: window.sessionStorage, persistSession: true } })
  : null;

/** 画面で使う形（camelCase）に変換 */
const mapUser = (r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, hourlyRate: r.hourly_rate, leaveGranted: r.leave_granted, active: r.active, createdAt: r.created_at });
const mapAtt = (r) => ({ id: r.id, userId: r.user_id, date: r.work_date, clockIn: r.clock_in, clockOut: r.clock_out, editedBy: r.edited_by });
const mapShift = (r) => ({ id: r.id, userId: r.user_id, date: r.work_date, start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5), note: r.note, status: r.status, comment: r.comment, decidedBy: r.decided_by, decidedAt: r.decided_at, createdAt: r.created_at });
const mapAttReq = (r) => ({ id: r.id, userId: r.user_id, date: r.work_date, clockIn: r.clock_in, clockOut: r.clock_out, reason: r.reason, status: r.status, comment: r.comment, decidedBy: r.decided_by, decidedAt: r.decided_at, createdAt: r.created_at });
const mapInvite = (r) => ({ email: r.email, code: r.code, name: r.name, role: r.role, hourlyRate: r.hourly_rate, leaveGranted: r.leave_granted, createdAt: r.created_at, usedAt: r.used_at });
const mapLeave = (r) => ({ id: r.id, userId: r.user_id, start: r.start_date, end: r.end_date, days: r.days, reason: r.reason, status: r.status, comment: r.comment, decidedBy: r.decided_by, decidedAt: r.decided_at, createdAt: r.created_at });

const emptyDb = () => ({ settings: { companyName: '' }, users: [], attendance: [], shifts: [], leaves: [], invitations: [], attReqs: [] });
let db = emptyDb();
let sessionUserId = null;

/** Supabase から最新データを読み込む（RLS により社員は自分の勤怠のみ取得される） */
async function refresh() {
  const [p, a, s, l, st, inv, ar] = await Promise.all([
    sb.from('profiles').select('*').order('created_at'),
    sb.from('attendance').select('*'),
    sb.from('shifts').select('*'),
    sb.from('leaves').select('*'),
    sb.from('settings').select('*').eq('id', 1).maybeSingle(),
    sb.from('invitations').select('*').is('used_at', null).order('created_at'), // 管理者以外は RLS で 0 件
    sb.from('attendance_requests').select('*'), // 社員は自分の分のみ
  ]);
  const err = [p, a, s, l, st, inv, ar].find((r) => r.error)?.error;
  if (err) { toast('データの読み込みに失敗しました：' + errMsg(err), true); return false; }
  db = {
    settings: { companyName: st.data?.company_name ?? '' },
    users: p.data.map(mapUser),
    attendance: a.data.map(mapAtt),
    shifts: s.data.map(mapShift),
    leaves: l.data.map(mapLeave),
    invitations: inv.data.map(mapInvite),
    attReqs: ar.data.map(mapAttReq),
  };
  return true;
}

/** Supabase / Postgres のエラーを日本語に */
function errMsg(e) {
  const m = e?.message ?? String(e);
  if (e?.code === '23505') return 'その日はすでに申請済み（または承認済み）です';
  if (e?.code === '42501' || /row-level security/i.test(m)) return '権限がありません';
  if (/Invalid login credentials/i.test(m)) return 'メールアドレスまたはパスワードが違います';
  if (/Email not confirmed/i.test(m)) return 'メールアドレスの確認が完了していません（届いたメールのリンクを開いてください）';
  if (/already registered/i.test(m)) return 'このメールアドレスはすでに登録されています';
  if (/INVITE_REQUIRED|Database error saving new user/i.test(m)) return '招待されていないメールアドレスか、招待コードが違います（管理者に確認してください）';
  if (/Password should be at least/i.test(m)) return 'パスワードは6文字以上にしてください';
  if (/rate limit/i.test(m)) return '短時間に操作が集中しました。しばらく待ってから再度お試しください';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'サーバーに接続できません。ネットワークを確認してください';
  return m;
}

/** 書き込み → 成功したら再読込して再描画。失敗時はトーストを出して false */
async function mutate(query, okMsg) {
  const { error } = await query;
  if (error) { toast(errMsg(error), true); return false; }
  await refresh();
  if (okMsg) toast(okMsg);
  render();
  return true;
}

/* ---------- session ---------- */
const currentUser = () => { const u = db.users.find((x) => x.id === sessionUserId); return u && u.active ? u : null; };

/** ログイン。招待コードがあれば、未登録の場合に同じメール・パスワードで登録する（DB 側で招待をチェック） */
async function login(email, password, code = '') {
  email = email.trim();
  code = code.trim().toUpperCase();
  let { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error && /Invalid login credentials/i.test(error.message)) {
    if (!code) return 'メールアドレスまたはパスワードが違います（はじめての方は招待コードも入力してください）';
    const r = await sb.auth.signUp({ email, password, options: { data: { name: email.split('@')[0], invite_code: code } } });
    if (r.error) return /already registered/i.test(r.error.message) ? 'このメールアドレスは登録済みです。パスワードが違います' : errMsg(r.error);
    if (!r.data.session) return '確認メールを送信しました。メール内のリンクを開いてからログインしてください';
    data = r.data;
  } else if (error) {
    return errMsg(error);
  }
  sessionUserId = data.user.id;
  await refresh();
  if (!currentUser()) {
    await sb.auth.signOut();
    sessionUserId = null; db = emptyDb();
    return 'このアカウントは無効化されています';
  }
  subscribeRealtime();
  return null;
}
async function logout() {
  await sb.auth.signOut();
  sessionUserId = null; db = emptyDb();
  unsubscribeRealtime();
  location.hash = ''; render();
}

/* ---------- realtime ---------- */
let channel = null, rtTimer = null, deferredRender = false;
const isEditing = () => { const a = document.activeElement; return a && $('#main').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName); };
/** 他端末の変更を受けたら再読込。入力中・モーダル表示中は描画を後回しにする */
function scheduleRefresh() {
  clearTimeout(rtTimer);
  rtTimer = setTimeout(async () => {
    if (!sessionUserId) return;
    await refresh();
    if (!currentUser()) { toast('アカウントが無効化されたためログアウトしました', true); return logout(); }
    if ($('#modal-root').innerHTML || isEditing()) deferredRender = true;
    else render();
  }, 300);
}
let subscribing = false;
async function subscribeRealtime() {
  if (channel || subscribing) return;
  subscribing = true;
  // ログアウト→ログイン直後は Realtime がまだ前の（または未ログインの）トークンを持っていることがあり、
  // そのまま購読すると RLS で全イベントが弾かれる。購読前に現在のトークンを明示的に渡す。
  const { data } = await sb.auth.getSession();
  if (!data.session) { subscribing = false; return; }
  sb.realtime.setAuth(data.session.access_token);
  // 解除中の古いチャンネルと名前が重ならないよう、毎回新しい名前にする
  channel = sb.channel('kintai-changes-' + Date.now());
  ['profiles', 'attendance', 'shifts', 'leaves', 'settings', 'invitations', 'attendance_requests'].forEach((table) =>
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleRefresh));
  channel.subscribe();
  subscribing = false;
}
function unsubscribeRealtime() {
  if (channel) sb.removeChannel(channel);
  channel = null;
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (deferredRender && !isEditing() && !$('#modal-root').innerHTML) { deferredRender = false; render(); }
}, 0));

/* ---------- domain helpers ---------- */
const userName = (id) => db.users.find((u) => u.id === id)?.name ?? '(削除済み)';
const todayRec = (userId) => db.attendance.find((a) => a.userId === userId && a.date === ymd(new Date()));
const leaveUsed = (userId) => db.leaves.filter((l) => l.userId === userId && l.status === 'approved').reduce((s, l) => s + l.days, 0);
const leavePending = (userId) => db.leaves.filter((l) => l.userId === userId && l.status === 'pending').reduce((s, l) => s + l.days, 0);
const leaveRemain = (u) => u.leaveGranted - leaveUsed(u.id);
const pendingCount = () => [db.shifts, db.leaves, db.attReqs].reduce((n, list) => n + list.filter((x) => x.status === 'pending').length, 0);
const statusBadge = (s) => `<span class="badge ${s}">${{ pending: '申請中', approved: '承認', rejected: '却下' }[s]}</span>`;
const roleBadge = (r) => `<span class="badge ${r}">${r === 'admin' ? '管理者' : '社員'}</span>`;

/* ---------- ui helpers ---------- */
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
/** 簡易モーダル。onOk(form) が文字列を返したら（async 可）エラー表示して閉じない */
function modal(title, bodyHtml, onOk, okLabel = 'OK', okClass = 'primary') {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-back"><form class="modal"><h3>${esc(title)}</h3>${bodyHtml}
    <p class="error" hidden></p>
    <div class="modal-actions"><button type="button" class="btn" data-x>キャンセル</button><button class="btn ${okClass}" data-ok>${esc(okLabel)}</button></div></form></div>`;
  const form = $('form', root);
  const close = () => {
    root.innerHTML = '';
    if (deferredRender) { deferredRender = false; render(); }
  };
  $('[data-x]', root).onclick = close;
  $('.modal-back', root).onclick = (e) => { if (e.target.classList.contains('modal-back')) close(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const ok = $('[data-ok]', form);
    ok.disabled = true;
    const err = await onOk(form);
    ok.disabled = false;
    if (err) { const p = $('.error', form); p.textContent = err; p.hidden = false; return; }
    close();
  };
  $('input,select,textarea', form)?.focus();
}

/* ---------- routing ---------- */
const NAV = {
  employee: [
    ['clock', '出勤・退勤'],
    ['shift-req', 'シフト申請'],
    ['leave-req', '有給申請'],
    ['shifts', 'みんなのシフト'],
    ['invoice', '請求書PDF'],
  ],
  admin: [
    ['logs', '勤怠ログ'],
    ['approvals', '申請の承認'],
    ['users', 'ユーザー・ロール管理'],
    ['shifts', 'みんなのシフト'],
  ],
};
const VIEWS = {};
let tickTimer = null;
const viewState = { weekOffset: 0, approvalsTab: 'shift', logsUser: '', logsMonth: ym(new Date()), invMonth: ym(new Date()) };

function showOnly(id) {
  ['#loading-view', '#login-view', '#setup-view', '#app-view'].forEach((s) => ($(s).hidden = s !== id));
}

function render() {
  clearInterval(tickTimer);
  deferredRender = false;
  if (!CONFIGURED) return showOnly('#setup-view');
  const me = currentUser();
  if (!me) return showOnly('#login-view');
  showOnly('#app-view');

  const items = NAV[me.role];
  let route = location.hash.replace(/^#\/?/, '');
  if (!items.some(([k]) => k === route)) { route = items[0][0]; history.replaceState(null, '', '#/' + route); }

  $('#role-label').innerHTML = `<span class="${me.role}">${me.role === 'admin' ? '管理者画面' : '社員画面'}</span>`;
  $('#me-name').textContent = `${me.name} さん`;
  const pc = pendingCount();
  $('#nav').innerHTML = items.map(([k, label]) =>
    `<a href="#/${k}" class="${k === route ? 'active' : ''}"><span>${label}</span>${k === 'approvals' && pc ? `<span class="count">${pc}</span>` : ''}</a>`).join('');

  VIEWS[route](me, $('#main'));
}

/* =========================================================
 * 社員：出勤・退勤
 * ========================================================= */
VIEWS.clock = (me, el) => {
  const rec = todayRec(me.id);
  const month = ym(new Date());
  const list = db.attendance.filter((a) => a.userId === me.id && a.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date));
  const total = list.reduce((s, r) => s + workMin(r), 0);
  const todayShift = db.shifts.find((s) => s.userId === me.id && s.date === ymd(new Date()) && s.status === 'approved');

  let status = '未出勤';
  if (rec?.clockIn && !rec.clockOut) status = `出勤中（${hm(rec.clockIn)} 出勤）`;
  if (rec?.clockOut) status = `退勤済み（${hm(rec.clockIn)} 〜 ${hm(rec.clockOut)}）`;

  el.innerHTML = `
    <div class="page-head"><h2>出勤・退勤</h2></div>
    <div class="card clock-card">
      <div class="clock-now" id="now">--:--:--</div>
      <div class="clock-date" id="today"></div>
      <div class="clock-buttons">
        <button class="btn primary big" id="in-btn" ${rec ? 'disabled' : ''}>出勤</button>
        <button class="btn ok big" id="out-btn" ${!rec || rec.clockOut ? 'disabled' : ''}>退勤</button>
      </div>
      <p class="clock-status"><strong>${status}</strong>
      <br><span class="muted small">本日のシフト：${todayShift ? `${todayShift.start}〜${todayShift.end}` : 'なし'}</span></p>
    </div>
    <div class="stats">
      <div class="stat"><div class="label">今月の出勤日数</div><div class="value">${list.filter((r) => r.clockOut).length} 日</div></div>
      <div class="stat"><div class="label">今月の実働時間</div><div class="value">${fmtDur(total)}</div></div>
      <div class="stat"><div class="label">有給残日数</div><div class="value">${leaveRemain(me)} 日</div></div>
    </div>
    <div class="card">
      <h3>今月の勤怠</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>日付</th><th>出勤</th><th>退勤</th><th class="num">休憩</th><th class="num">実働</th><th>備考</th><th></th></tr></thead>
        <tbody>${list.length ? list.map((r) => `<tr><td>${fmtDateJa(r.date)}</td><td>${hm(r.clockIn)}</td><td>${r.clockOut ? hm(r.clockOut) : (r.date < ymd(new Date()) ? '<span class="badge rejected">退勤なし</span>' : '—')}</td>
          <td class="num">${r.clockOut ? breakMin(grossMin(r)) + '分' : '—'}</td><td class="num">${r.clockOut ? fmtDur(workMin(r)) : '—'}</td>
          <td class="muted small">${pendingFix(me.id, r.date) ? '<span class="badge pending">修正申請中</span>' : r.editedBy ? '修正済み' : ''}</td>
          <td>${pendingFix(me.id, r.date) ? '' : `<button class="btn small" data-fix="${r.date}">修正を申請</button>`}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">記録がありません</td></tr>'}</tbody>
      </table></div>
    </div>
    ${fixRequestHtml(me)}`;

  const tick = () => {
    const n = new Date();
    $('#now').textContent = `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
    $('#today').textContent = `${n.getFullYear()}年${n.getMonth() + 1}月${n.getDate()}日（${WD[n.getDay()]}）`;
  };
  tick(); tickTimer = setInterval(tick, 1000);

  // 時刻はサーバー側（トリガー）で現在時刻に置き換えられる
  $('#in-btn').onclick = (e) => {
    if (todayRec(me.id)) return;
    e.target.disabled = true;
    mutate(sb.from('attendance').insert({ user_id: me.id, work_date: ymd(new Date()), clock_in: new Date().toISOString() }), '出勤しました');
  };
  $('#out-btn').onclick = (e) => {
    const r = todayRec(me.id);
    if (!r || r.clockOut) return;
    e.target.disabled = true;
    mutate(sb.from('attendance').update({ clock_out: new Date().toISOString() }).eq('id', r.id), '退勤しました。お疲れさまでした');
  };
  bindFixRequest(me, el);
};

/* ---------- 打刻修正申請（社員） ---------- */
const pendingFix = (userId, date) => db.attReqs.find((q) => q.userId === userId && q.date === date && q.status === 'pending');

function fixRequestHtml(me) {
  const d = viewState.fixDraft ?? (viewState.fixDraft = { date: ymd(addDays(new Date(), -1)), in: '09:00', out: '18:00', reason: '' });
  const mine = db.attReqs.filter((q) => q.userId === me.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  const cur = db.attendance.find((a) => a.userId === me.id && a.date === d.date);
  return `
    <div class="card" id="fix-card">
      <h3>打刻修正の申請</h3>
      <p class="muted small" style="margin:0 0 12px">打刻を忘れた・押し間違えたときに、正しい時刻を申請してください。管理者が承認すると勤怠に反映されます。</p>
      <form id="fix-form" class="form-grid">
        <label>日付<input type="date" name="date" required max="${ymd(new Date())}" value="${d.date}" /></label>
        <label>出勤<input type="time" name="in" required value="${d.in}" /></label>
        <label>退勤<input type="time" name="out" required value="${d.out}" /></label>
        <label style="grid-column: span 2">理由<input name="reason" required placeholder="例：退勤の打刻を忘れたため" value="${esc(d.reason)}" /></label>
        <button class="btn primary">修正を申請</button>
      </form>
      <p class="muted small" style="margin:10px 0 0">現在の記録（${fmtDateJa(d.date)}）：${cur ? `${hm(cur.clockIn)} 〜 ${cur.clockOut ? hm(cur.clockOut) : '退勤なし'}` : '記録なし'}</p>
      <h3 style="margin-top:18px">自分の修正申請</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>日付</th><th>申請した時刻</th><th>理由</th><th>状態</th><th>コメント</th><th></th></tr></thead>
        <tbody>${mine.length ? mine.map((q) => `<tr><td>${fmtDateJa(q.date)}</td><td>${hm(q.clockIn)} 〜 ${hm(q.clockOut)}</td><td>${esc(q.reason)}</td>
          <td>${statusBadge(q.status)}</td><td class="muted small">${esc(q.comment)}</td>
          <td>${q.status === 'pending' ? `<button class="btn small ng" data-cancel-fix="${q.id}">取消</button>` : ''}</td></tr>`).join('')
          : '<tr><td colspan="6" class="empty">申請はまだありません</td></tr>'}</tbody>
      </table></div>
    </div>`;
}

function bindFixRequest(me, el) {
  const form = $('#fix-form', el);
  const draft = viewState.fixDraft;
  const sync = () => Object.assign(draft, { date: form.date.value, in: form.in.value, out: form.out.value, reason: form.reason.value });
  ['in', 'out', 'reason'].forEach((n) => (form[n].oninput = sync));
  form.date.onchange = () => { sync(); render(); }; // 現在の記録を表示し直す
  // 勤怠の行の「修正を申請」→ フォームにその日の記録を入れてスクロール
  $$('[data-fix]', el).forEach((b) => (b.onclick = () => {
    const r = db.attendance.find((a) => a.userId === me.id && a.date === b.dataset.fix);
    Object.assign(draft, { date: b.dataset.fix, in: r?.clockIn ? hm(r.clockIn) : '09:00', out: r?.clockOut ? hm(r.clockOut) : '18:00', reason: '' });
    render();
    $('#fix-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#fix-form [name=reason]')?.focus();
  }));
  form.onsubmit = async (e) => {
    e.preventDefault();
    sync();
    const { date, in: i, out: o, reason } = draft;
    if (date > ymd(new Date())) return toast('未来の日付は申請できません', true);
    if (o <= i) return toast('退勤は出勤より後の時刻にしてください', true);
    if (date === ymd(new Date()) && new Date(at(date, o)) > new Date()) return toast('まだ来ていない時刻は申請できません', true);
    if (!reason.trim()) return toast('理由を入力してください', true);
    if (pendingFix(me.id, date)) return toast('その日はすでに修正を申請中です', true);
    const ok = await mutate(sb.from('attendance_requests').insert({ user_id: me.id, work_date: date, clock_in: at(date, i), clock_out: at(date, o), reason: reason.trim() }),
      '打刻の修正を申請しました');
    if (ok) { draft.reason = ''; render(); }
  };
  $$('[data-cancel-fix]', el).forEach((b) => (b.onclick = () => {
    if (!confirm('この修正申請を取り消しますか？')) return;
    mutate(sb.from('attendance_requests').delete().eq('id', b.dataset.cancelFix), '取り消しました');
  }));
}

/* =========================================================
 * 共通：みんなの申請カレンダー（シフト・有給 / 承認済み＋申請中）
 *   selStart / selEnd … フォームで選択中の日付（ハイライト用）
 * ========================================================= */
const MAX_EV = 3;
// カレンダー用の短い時刻表記（09:00→9, 13:30→13:30）
const shortT = (t) => (t.endsWith(":00") ? String(Number(t.slice(0, 2))) : t.replace(/^0/, ""));
const monthOffsetOf = (ds) => { const d = parseYmd(ds), n = new Date(); return (d.getFullYear() - n.getFullYear()) * 12 + d.getMonth() - n.getMonth(); };
function teamCalendarHtml(me, selStart, selEnd = selStart) {
  const base = new Date();
  const first = new Date(base.getFullYear(), base.getMonth() + (viewState.calOffset || 0), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7)); // 月曜始まり
  const todayS = ymd(new Date());
  const activeIds = new Set(db.users.filter((u) => u.active).map((u) => u.id));
  const shifts = db.shifts.filter((s) => s.status !== 'rejected' && activeIds.has(s.userId));
  const leaves = db.leaves.filter((l) => l.status !== 'rejected' && activeIds.has(l.userId));

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i >= 35 && d.getMonth() !== first.getMonth()) break;
    const ds = ymd(d);
    const evs = [];
    shifts.filter((s) => s.date === ds).forEach((s) => evs.push({ type: 'shift', s, label: `${userName(s.userId)} ${shortT(s.start)}-${shortT(s.end)}`, full: `${userName(s.userId)} ${s.start}〜${s.end}` }));
    if (d.getDay() % 6 !== 0)
      leaves.filter((l) => ds >= l.start && ds <= l.end).forEach((l) => evs.push({ type: 'leave', s: l, label: `${userName(l.userId)} 有給` }));
    // 自分→承認済み→名前順
    evs.sort((a, b) => (b.s.userId === me.id) - (a.s.userId === me.id) || (a.s.status === 'pending') - (b.s.status === 'pending') || a.label.localeCompare(b.label));
    const tip = evs.map((e) => `${e.full ?? e.label}（${e.s.status === 'pending' ? '申請中' : '承認済み'}）`).join('\n');
    const cls = [
      'cal-d',
      d.getMonth() !== first.getMonth() && 'other',
      ds < todayS && 'past',
      ds === todayS && 'today',
      selStart && ds >= selStart && ds <= selEnd && 'sel',
      d.getDay() === 6 && 'sat', d.getDay() === 0 && 'sun',
    ].filter(Boolean).join(' ');
    cells.push(`<div class="${cls}" data-date="${ds}" title="${esc(tip)}">
      <div class="cal-num">${d.getDate()}${evs.length ? `<span class="cal-cnt">${evs.length}人</span>` : ''}</div>
      ${evs.slice(0, MAX_EV).map((e) => `<div class="ev ${e.type} ${e.s.status}${e.s.userId === me.id ? ' mine' : ''}">${esc(e.label)}</div>`).join('')}
      ${evs.length > MAX_EV ? `<div class="ev-more">他 ${evs.length - MAX_EV} 件</div>` : ''}
    </div>`);
  }

  return `
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <h3 style="margin:0">みんなの申請カレンダー</h3>
        <div class="spacer"></div>
        <button class="btn small" data-cal="-1">←</button>
        <strong style="min-width:90px;text-align:center">${first.getFullYear()}年${first.getMonth() + 1}月</strong>
        <button class="btn small" data-cal="1">→</button>
        <button class="btn small" data-cal="0">今月</button>
      </div>
      <div class="cal">
        ${['月', '火', '水', '木', '金', '土', '日'].map((w, i) => `<div class="cal-h ${i === 5 ? 'sat' : i === 6 ? 'sun' : ''}">${w}</div>`).join('')}
        ${cells.join('')}
      </div>
      <p class="muted small cal-legend">
        <span class="ev shift approved">シフト（承認済み）</span>
        <span class="ev shift pending">シフト（申請中）</span>
        <span class="ev leave approved">有給（承認済み）</span>
        <span class="ev leave pending">有給（申請中）</span>
        <span>太字＝自分　／　日付をクリックで申請日を選択</span>
      </p>
    </div>`;
}
/** カレンダーの月送り・日付クリックを設定。onPick(date) は選択範囲 [start,end] を返す */
function bindTeamCalendar(el, onPick) {
  $$('[data-cal]', el).forEach((b) => (b.onclick = () => {
    const v = Number(b.dataset.cal);
    viewState.calOffset = v === 0 ? 0 : (viewState.calOffset || 0) + v;
    render();
  }));
  $$('.cal-d', el).forEach((c) => (c.onclick = () => {
    const [s, e] = onPick(c.dataset.date);
    $$('.cal-d', el).forEach((x) => x.classList.toggle('sel', x.dataset.date >= s && x.dataset.date <= e));
  }));
}

/* =========================================================
 * 社員：シフト申請
 * ========================================================= */
VIEWS['shift-req'] = (me, el) => {
  const mine = db.shifts.filter((s) => s.userId === me.id).sort((a, b) => b.date.localeCompare(a.date));
  const draft = viewState.shiftDraft ?? (viewState.shiftDraft = ymd(addDays(new Date(), 1)));
  el.innerHTML = `
    <div class="page-head"><h2>シフト申請</h2></div>
    <div class="card">
      <form id="shift-form" class="form-grid">
        <label>日付<input type="date" name="date" required value="${draft}" /></label>
        <label>開始<input type="time" name="start" required value="09:00" /></label>
        <label>終了<input type="time" name="end" required value="18:00" /></label>
        <label>メモ<input name="note" placeholder="任意" /></label>
        <button class="btn primary">申請する</button>
      </form>
    </div>
    ${teamCalendarHtml(me, draft)}
    <div class="card">
      <h3>自分の申請</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>日付</th><th>時間</th><th>メモ</th><th>状態</th><th>コメント</th><th></th></tr></thead>
        <tbody>${mine.length ? mine.map((s) => `<tr><td>${fmtDateJa(s.date)}</td><td>${s.start}〜${s.end}</td><td>${esc(s.note)}</td>
          <td>${statusBadge(s.status)}</td><td class="muted small">${esc(s.comment)}</td>
          <td>${s.status === 'pending' ? `<button class="btn small ng" data-cancel="${s.id}">取消</button>` : ''}</td></tr>`).join('')
          : '<tr><td colspan="6" class="empty">申請はまだありません</td></tr>'}</tbody>
      </table></div>
    </div>`;

  $('#shift-form').onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (f.end <= f.start) return toast('終了時刻は開始時刻より後にしてください', true);
    if (db.shifts.some((s) => s.userId === me.id && s.date === f.date && s.status !== 'rejected'))
      return toast('その日はすでに申請済み（または承認済み）です', true);
    mutate(sb.from('shifts').insert({ user_id: me.id, work_date: f.date, start_time: f.start, end_time: f.end, note: f.note.trim() }), 'シフトを申請しました');
  };
  const dateInput = $('#shift-form').date;
  dateInput.onchange = () => { if (!dateInput.value) return; viewState.shiftDraft = dateInput.value; viewState.calOffset = monthOffsetOf(dateInput.value); render(); };
  bindTeamCalendar(el, (ds) => {
    dateInput.value = ds; viewState.shiftDraft = ds;
    return [ds, ds];
  });
  $$('[data-cancel]', el).forEach((b) => (b.onclick = () => {
    if (!confirm('この申請を取り消しますか？')) return;
    mutate(sb.from('shifts').delete().eq('id', b.dataset.cancel), '取り消しました');
  }));
};

/* =========================================================
 * 社員：有給申請
 * ========================================================= */
VIEWS['leave-req'] = (me, el) => {
  const mine = db.leaves.filter((l) => l.userId === me.id).sort((a, b) => b.start.localeCompare(a.start));
  const remain = leaveRemain(me), pend = leavePending(me.id);
  const tmr = ymd(addDays(new Date(), 1));
  const draft = viewState.leaveDraft ?? (viewState.leaveDraft = { start: tmr, end: tmr, picking: false });
  el.innerHTML = `
    <div class="page-head"><h2>有給申請</h2></div>
    <div class="stats">
      <div class="stat"><div class="label">付与日数</div><div class="value">${me.leaveGranted} 日</div></div>
      <div class="stat"><div class="label">取得済み</div><div class="value">${leaveUsed(me.id)} 日</div></div>
      <div class="stat"><div class="label">申請中</div><div class="value">${pend} 日</div></div>
      <div class="stat"><div class="label">残日数</div><div class="value">${remain} 日</div></div>
    </div>
    <div class="card">
      <form id="leave-form" class="form-grid">
        <label>開始日<input type="date" name="start" required value="${draft.start}" /></label>
        <label>終了日<input type="date" name="end" required value="${draft.end}" /></label>
        <label>理由<input name="reason" placeholder="私用など" /></label>
        <button class="btn primary">申請する</button>
      </form>
      <p class="muted small" style="margin:10px 0 0">※ 土日は日数に含めません　／　カレンダーで開始日→終了日の順にクリックすると期間を選べます</p>
    </div>
    ${teamCalendarHtml(me, draft.start, draft.end)}
    <div class="card">
      <h3>自分の申請</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>期間</th><th class="num">日数</th><th>理由</th><th>状態</th><th>コメント</th><th></th></tr></thead>
        <tbody>${mine.length ? mine.map((l) => `<tr><td>${fmtDateJa(l.start)}${l.end !== l.start ? ' 〜 ' + fmtDateJa(l.end) : ''}</td>
          <td class="num">${l.days}日</td><td>${esc(l.reason)}</td><td>${statusBadge(l.status)}</td><td class="muted small">${esc(l.comment)}</td>
          <td>${l.status === 'pending' ? `<button class="btn small ng" data-cancel="${l.id}">取消</button>` : ''}</td></tr>`).join('')
          : '<tr><td colspan="6" class="empty">申請はまだありません</td></tr>'}</tbody>
      </table></div>
    </div>`;

  $('#leave-form').onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (f.end < f.start) return toast('終了日は開始日以降にしてください', true);
    const days = weekdayCount(f.start, f.end);
    if (days === 0) return toast('期間に平日が含まれていません', true);
    if (days > remain - pend) return toast(`残日数が足りません（申請可能：${remain - pend}日）`, true);
    const overlap = db.leaves.some((l) => l.userId === me.id && l.status !== 'rejected' && !(f.end < l.start || f.start > l.end));
    if (overlap) return toast('期間が既存の申請と重複しています', true);
    mutate(sb.from('leaves').insert({ user_id: me.id, start_date: f.start, end_date: f.end, days, reason: f.reason.trim() }), `有給を申請しました（${days}日）`);
  };
  const lf = $('#leave-form');
  const syncDraft = () => {
    draft.start = lf.start.value; draft.end = lf.end.value < lf.start.value ? lf.start.value : lf.end.value;
    draft.picking = false; if (draft.start) viewState.calOffset = monthOffsetOf(draft.start); render();
  };
  lf.start.onchange = syncDraft;
  lf.end.onchange = syncDraft;
  // 1回目のクリック＝開始日、2回目（開始日以降）＝終了日
  bindTeamCalendar(el, (ds) => {
    if (draft.picking && ds >= draft.start) { draft.end = ds; draft.picking = false; }
    else { draft.start = ds; draft.end = ds; draft.picking = true; }
    lf.start.value = draft.start; lf.end.value = draft.end;
    return [draft.start, draft.end];
  });
  $$('[data-cancel]', el).forEach((b) => (b.onclick = () => {
    if (!confirm('この申請を取り消しますか？')) return;
    mutate(sb.from('leaves').delete().eq('id', b.dataset.cancel), '取り消しました');
  }));
};

/* =========================================================
 * 共通：みんなのシフト（承認済みのみ反映）
 * ========================================================= */
VIEWS.shifts = (me, el) => {
  const base = new Date();
  const monday = addDays(base, -((base.getDay() + 6) % 7) + viewState.weekOffset * 7);
  const days = [...Array(7)].map((_, i) => addDays(monday, i));
  const todayS = ymd(new Date());
  const users = db.users.filter((u) => u.active);
  const showPending = !!viewState.showPending;

  const cell = (u, d) => {
    const ds = ymd(d);
    const out = [];
    db.shifts.filter((s) => s.userId === u.id && s.date === ds && (s.status === 'approved' || (showPending && s.status === 'pending')))
      .forEach((s) => out.push(`<span class="chip ${s.status === 'approved' ? 'shift' : 'pending'}">${s.start}-${s.end}</span>`));
    db.leaves.filter((l) => l.userId === u.id && ds >= l.start && ds <= l.end && d.getDay() % 6 !== 0 && (l.status === 'approved' || (showPending && l.status === 'pending')))
      .forEach((l) => out.push(`<span class="chip ${l.status === 'approved' ? 'leave' : 'pending'}">有給</span>`));
    return out.join(' ') || '<span class="muted">—</span>';
  };

  el.innerHTML = `
    <div class="page-head">
      <h2>みんなのシフト</h2><div class="spacer"></div>
      <button class="btn small" id="prev">← 前週</button>
      <button class="btn small" id="this">今週</button>
      <button class="btn small" id="next">翌週 →</button>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:12px">
        <strong>${monday.getFullYear()}年 ${fmtDateJa(ymd(days[0]))} 〜 ${fmtDateJa(ymd(days[6]))}</strong>
        <div class="spacer"></div>
        <label class="row" style="flex-direction:row"><input type="checkbox" id="show-pending" ${showPending ? 'checked' : ''}/> 申請中も表示</label>
      </div>
      <div class="table-wrap"><table class="shift-grid">
        <thead><tr><th>名前</th>${days.map((d) => `<th class="${ymd(d) === todayS ? 'today' : ''} ${d.getDay() === 6 ? 'sat' : d.getDay() === 0 ? 'sun' : ''}">${fmtDateJa(ymd(d))}</th>`).join('')}</tr></thead>
        <tbody>${users.map((u) => `<tr><td>${esc(u.name)}${u.id === me.id ? ' <span class="muted small">(自分)</span>' : ''}</td>
          ${days.map((d) => `<td class="${ymd(d) === todayS ? 'today' : ''}">${cell(u, d)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small" style="margin:12px 0 0">
        <span class="chip shift">09:00-18:00</span> 承認済みシフト
        <span class="chip leave">有給</span> 承認済み有給
        <span class="chip pending">申請中</span> 承認待ち（チェック時のみ表示）</p>
    </div>`;
  $('#prev').onclick = () => { viewState.weekOffset--; render(); };
  $('#next').onclick = () => { viewState.weekOffset++; render(); };
  $('#this').onclick = () => { viewState.weekOffset = 0; render(); };
  $('#show-pending').onchange = (e) => { viewState.showPending = e.target.checked; render(); };
};

/* =========================================================
 * 社員：請求書PDF
 * ========================================================= */
VIEWS.invoice = (me, el) => {
  const month = viewState.invMonth;
  const [y, m] = month.split('-').map(Number);
  const recs = db.attendance.filter((a) => a.userId === me.id && a.date.startsWith(month) && a.clockOut).sort((a, b) => a.date.localeCompare(b.date));
  const minutes = recs.reduce((s, r) => s + workMin(r), 0);
  const hours = Math.round((minutes / 60) * 100) / 100;
  const inv = viewState.inv ?? (viewState.inv = { to: db.settings.companyName, transport: 0, note: 'お振込手数料は貴社にてご負担をお願いいたします。' });
  const fee = Math.round(hours * me.hourlyRate);
  const tax = Math.floor(fee * 0.1);
  const transport = Number(inv.transport) || 0;
  const total = fee + tax + transport;
  const issued = new Date();
  const due = new Date(y, m + 1, 0); // 翌月末
  const no = `INV-${month.replace('-', '')}-${me.id.slice(-4).toUpperCase()}`;

  el.innerHTML = `
    <div class="page-head"><h2>請求書PDF</h2></div>
    <div class="card">
      <form id="inv-form" class="form-grid">
        <label>対象月<input type="month" name="month" value="${month}" /></label>
        <label>宛先<input name="to" value="${esc(inv.to)}" /></label>
        <label>交通費（円・非課税）<input type="number" min="0" name="transport" value="${transport}" /></label>
        <label>時給（管理者が設定）<input value="${yen(me.hourlyRate)}" disabled /></label>
      </form>
      <label style="margin-top:12px">備考<textarea name="note" form="inv-form" rows="2">${esc(inv.note)}</textarea></label>
      <div class="row" style="margin-top:14px">
        <button class="btn primary" id="pdf-btn" ${recs.length ? '' : 'disabled'}>PDFをダウンロード</button>
        <span class="muted small">${recs.length ? `${recs.length}日分の勤怠から自動計算` : 'この月の勤怠記録がありません'}</span>
      </div>
    </div>

    <div class="table-wrap">
    <div class="invoice-sheet" id="invoice-sheet">
      <h1>請求書</h1>
      <div class="inv-top">
        <div style="flex:1">
          <div class="inv-to">${esc(inv.to)} 御中</div>
          <div>件名：${y}年${m}月分 業務委託費</div>
        </div>
        <div class="inv-meta">
          <div>請求書番号：${no}</div>
          <div>発行日：${issued.getFullYear()}年${issued.getMonth() + 1}月${issued.getDate()}日</div>
          <div style="margin-top:14px; font-size:14px"><strong>${esc(me.name)}</strong></div>
          <div>${esc(me.email)}</div>
        </div>
      </div>
      <p>下記のとおりご請求申し上げます。</p>
      <div class="inv-total"><span>ご請求金額（税込）</span><strong>${yen(total)}</strong></div>
      <table>
        <thead><tr><th>品目</th><th class="num">数量</th><th class="num">単価</th><th class="num">金額</th></tr></thead>
        <tbody>
          <tr><td>${y}年${m}月 業務委託（稼働 ${recs.length}日）</td><td class="num">${hours} h</td><td class="num">${yen(me.hourlyRate)}</td><td class="num">${yen(fee)}</td></tr>
          ${transport ? `<tr><td>交通費（実費・非課税）</td><td class="num">1</td><td class="num">${yen(transport)}</td><td class="num">${yen(transport)}</td></tr>` : ''}
        </tbody>
      </table>
      <table class="inv-sum">
        <tr><th>小計（課税対象）</th><td class="num">${yen(fee)}</td></tr>
        <tr><th>消費税（10%）</th><td class="num">${yen(tax)}</td></tr>
        ${transport ? `<tr><th>非課税（交通費）</th><td class="num">${yen(transport)}</td></tr>` : ''}
        <tr><th>合計</th><td class="num"><strong>${yen(total)}</strong></td></tr>
      </table>
      <p style="margin-top:18px">お支払期限：${due.getFullYear()}年${due.getMonth() + 1}月${due.getDate()}日</p>
      ${inv.note ? `<div class="inv-note">備考：${esc(inv.note)}</div>` : ''}
      <table class="inv-detail">
        <thead><tr><th>稼働日</th><th>出勤</th><th>退勤</th><th class="num">休憩</th><th class="num">実働</th></tr></thead>
        <tbody>${recs.map((r) => `<tr><td>${fmtDateJa(r.date)}</td><td>${hm(r.clockIn)}</td><td>${hm(r.clockOut)}</td><td class="num">${breakMin(grossMin(r))}分</td><td class="num">${fmtDur(workMin(r))}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">記録なし</td></tr>'}
        <tr><th colspan="4">合計実働</th><th class="num">${fmtDur(minutes)}</th></tr></tbody>
      </table>
    </div></div>`;

  const form = $('#inv-form');
  form.onchange = () => {
    const f = new FormData(form);
    viewState.invMonth = f.get('month') || month;
    Object.assign(inv, { to: f.get('to'), transport: f.get('transport'), note: f.get('note') });
    render();
  };
  $('textarea[name=note]').onchange = form.onchange;
  form.onsubmit = (e) => e.preventDefault();

  $('#pdf-btn').onclick = () => {
    const sheet = $('#invoice-sheet');
    const filename = `請求書_${y}年${m}月_${me.name.replace(/\s/g, '')}.pdf`;
    if (window.html2pdf) {
      toast('PDFを作成しています…');
      window.html2pdf().set({
        margin: 0, filename, image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      }).from(sheet).save().then(() => toast('PDFをダウンロードしました'));
    } else {
      toast('印刷ダイアログで「PDFとして保存」を選んでください');
      window.print();
    }
  };
};

/* =========================================================
 * 管理者：勤怠ログ
 * ========================================================= */
VIEWS.logs = (me, el) => {
  const { logsUser, logsMonth } = viewState;
  const list = db.attendance
    .filter((a) => (!logsUser || a.userId === logsUser) && a.date.startsWith(logsMonth))
    .sort((a, b) => b.date.localeCompare(a.date) || userName(a.userId).localeCompare(userName(b.userId)));
  const total = list.reduce((s, r) => s + workMin(r), 0);
  const working = db.attendance.filter((a) => a.date === ymd(new Date()) && !a.clockOut);

  el.innerHTML = `
    <div class="page-head"><h2>勤怠ログ</h2><div class="spacer"></div><button class="btn small" id="csv">CSV出力</button></div>
    <div class="stats">
      <div class="stat"><div class="label">現在出勤中</div><div class="value">${working.length} 人</div></div>
      <div class="stat"><div class="label">表示件数</div><div class="value">${list.length} 件</div></div>
      <div class="stat"><div class="label">実働合計</div><div class="value">${fmtDur(total)}</div></div>
      <div class="stat"><div class="label">承認待ち申請</div><div class="value">${pendingCount()} 件</div></div>
    </div>
    <div class="card">
      <div class="form-grid" style="margin-bottom:14px">
        <label>社員<select id="f-user"><option value="">全員</option>${db.users.map((u) => `<option value="${u.id}" ${u.id === logsUser ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
        <label>月<input type="month" id="f-month" value="${logsMonth}" /></label>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>日付</th><th>社員</th><th>出勤</th><th>退勤</th><th class="num">休憩</th><th class="num">実働</th><th>備考</th><th></th></tr></thead>
        <tbody>${list.length ? list.map((r) => `<tr><td>${fmtDateJa(r.date)}</td><td>${esc(userName(r.userId))}</td><td>${hm(r.clockIn)}</td>
          <td>${r.clockOut ? hm(r.clockOut) : '<span class="badge pending">勤務中</span>'}</td>
          <td class="num">${r.clockOut ? breakMin(grossMin(r)) + '分' : '—'}</td><td class="num">${r.clockOut ? fmtDur(workMin(r)) : '—'}</td>
          <td class="muted small">${r.editedBy ? '修正済' : ''}</td>
          <td><button class="btn small" data-edit="${r.id}">修正</button> <button class="btn small ng" data-del="${r.id}">削除</button></td></tr>`).join('')
          : '<tr><td colspan="8" class="empty">記録がありません</td></tr>'}</tbody>
      </table></div>
    </div>`;

  $('#f-user').onchange = (e) => { viewState.logsUser = e.target.value; render(); };
  $('#f-month').onchange = (e) => { viewState.logsMonth = e.target.value || ym(new Date()); render(); };
  $$('[data-edit]', el).forEach((b) => (b.onclick = () => {
    const r = db.attendance.find((a) => a.id === b.dataset.edit);
    modal(`勤怠の修正：${userName(r.userId)} ${fmtDateJa(r.date)}`, `
      <label>出勤<input type="time" name="in" required value="${r.clockIn ? hm(r.clockIn) : ''}" /></label>
      <label>退勤<input type="time" name="out" value="${r.clockOut ? hm(r.clockOut) : ''}" /></label>`, (f) => {
      const i = f.in.value, o = f.out.value;
      if (o && o <= i) return '退勤は出勤より後にしてください';
      return mutate(sb.from('attendance').update({ clock_in: at(r.date, i), clock_out: o ? at(r.date, o) : null, edited_by: me.id }).eq('id', r.id), '勤怠を修正しました')
        .then((ok) => (ok ? null : '保存に失敗しました'));
    }, '保存');
  }));
  $$('[data-del]', el).forEach((b) => (b.onclick = () => {
    if (!confirm('この勤怠記録を削除しますか？')) return;
    mutate(sb.from('attendance').delete().eq('id', b.dataset.del), '削除しました');
  }));
  $('#csv').onclick = () => {
    const rows = [['日付', '社員', '出勤', '退勤', '休憩(分)', '実働(分)'], ...list.map((r) => [r.date, userName(r.userId), hm(r.clockIn), r.clockOut ? hm(r.clockOut) : '', r.clockOut ? breakMin(grossMin(r)) : '', r.clockOut ? workMin(r) : ''])];
    const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `勤怠ログ_${logsMonth}.csv`; a.click();
  };
};

/* =========================================================
 * 管理者：申請の承認・却下
 * ========================================================= */
VIEWS.approvals = (me, el) => {
  const TABS = {
    shift: { label: 'シフト申請', table: 'shifts', src: db.shifts, okMsg: '承認しました（シフト一覧に反映済み）' },
    leave: { label: '有給申請', table: 'leaves', src: db.leaves, okMsg: '承認しました（シフト一覧に反映済み）' },
    fix: { label: '打刻修正', table: 'attendance_requests', src: db.attReqs, okMsg: '承認しました（勤怠に反映済み）' },
  };
  const tab = TABS[viewState.approvalsTab] ? viewState.approvalsTab : 'shift';
  const isShift = tab === 'shift';
  const { src } = TABS[tab];
  const sortKey = (x) => x.date ?? x.start;
  const pending = src.filter((x) => x.status === 'pending').sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const done = src.filter((x) => x.status !== 'pending').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '')).slice(0, 30);
  const countOf = (k) => TABS[k].src.filter((x) => x.status === 'pending').length;

  // 打刻修正：現在の記録と申請内容を並べて表示
  const curAtt = (x) => db.attendance.find((a) => a.userId === x.userId && a.date === x.date);
  const fixDetail = (x) => {
    const c = curAtt(x);
    const now = c ? `${hm(c.clockIn)} 〜 ${c.clockOut ? hm(c.clockOut) : '退勤なし'}` : '記録なし';
    return `<td>${fmtDateJa(x.date)}</td><td class="muted">${now}</td><td><strong>${hm(x.clockIn)} 〜 ${hm(x.clockOut)}</strong></td><td>${esc(x.reason)}</td>`;
  };
  const detail = (x) => tab === 'shift'
    ? `<td>${fmtDateJa(x.date)}</td><td>${x.start}〜${x.end}</td><td>${esc(x.note)}</td>`
    : tab === 'leave'
      ? `<td>${fmtDateJa(x.start)}${x.end !== x.start ? ' 〜 ' + fmtDateJa(x.end) : ''}</td><td class="num">${x.days}日（残${leaveRemain(db.users.find((u) => u.id === x.userId) ?? { leaveGranted: 0, id: '' })}日）</td><td>${esc(x.reason)}</td>`
      : fixDetail(x);
  const head = { shift: '<th>日付</th><th>時間</th><th>メモ</th>', leave: '<th>期間</th><th class="num">日数</th><th>理由</th>', fix: '<th>日付</th><th>現在の記録</th><th>修正後</th><th>理由</th>' }[tab];
  const cols = tab === 'fix' ? 7 : 6;

  el.innerHTML = `
    <div class="page-head"><h2>申請の承認</h2></div>
    <div class="tabs">
      ${Object.entries(TABS).map(([k, t]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${t.label}${countOf(k) ? `（${countOf(k)}）` : ''}</button>`).join('')}
    </div>
    <div class="card">
      <h3>承認待ち</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>申請者</th>${head}<th>申請日時</th><th></th></tr></thead>
        <tbody>${pending.length ? pending.map((x) => `<tr><td>${esc(userName(x.userId))}</td>${detail(x)}<td class="muted small">${fmtDT(x.createdAt)}</td>
          <td><button class="btn small ok" data-approve="${x.id}">承認</button> <button class="btn small ng" data-reject="${x.id}">却下</button></td></tr>`).join('')
          : `<tr><td colspan="${cols}" class="empty">承認待ちの申請はありません</td></tr>`}</tbody>
      </table></div>
    </div>
    <div class="card">
      <h3>処理済み（直近30件）</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>申請者</th>${head}<th>結果</th><th>処理者</th><th>コメント</th></tr></thead>
        <tbody>${done.length ? done.map((x) => `<tr><td>${esc(userName(x.userId))}</td>${detail(x)}<td>${statusBadge(x.status)}</td>
          <td class="small">${esc(userName(x.decidedBy))} <span class="muted">${fmtDT(x.decidedAt)}</span></td><td class="muted small">${esc(x.comment)}</td></tr>`).join('')
          : `<tr><td colspan="${cols + 1}" class="empty">まだありません</td></tr>`}</tbody>
      </table></div>
    </div>`;

  $$('[data-tab]', el).forEach((b) => (b.onclick = () => { viewState.approvalsTab = b.dataset.tab; render(); }));
  // 処理者・処理日時はサーバー側（トリガー）で記録。残日数チェックも DB 側で行う
  const decide = async (id, status, comment = '') => {
    const x = src.find((s) => s.id === id);
    if (!x || x.status !== 'pending') return null;
    if (status === 'approved' && tab === 'leave') {
      const u = db.users.find((u) => u.id === x.userId);
      if (u && x.days > leaveRemain(u)) { toast('残日数が不足しているため承認できません', true); return null; }
    }
    // 打刻修正の承認時、勤怠への反映は DB のトリガーが同じトランザクション内で行う
    await mutate(sb.from(TABS[tab].table).update({ status, comment }).eq('id', id).eq('status', 'pending'),
      status === 'approved' ? TABS[tab].okMsg : '却下しました');
    return null;
  };
  $$('[data-approve]', el).forEach((b) => (b.onclick = () => { b.disabled = true; decide(b.dataset.approve, 'approved'); }));
  $$('[data-reject]', el).forEach((b) => (b.onclick = () =>
    modal('申請を却下', '<label>却下理由（任意・申請者に表示されます）<textarea name="c" rows="3"></textarea></label>',
      (f) => decide(b.dataset.reject, 'rejected', f.c.value.trim()), '却下する', 'ng')));
};

/* =========================================================
 * 管理者：ユーザー・ロール管理
 * ========================================================= */
VIEWS.users = (me, el) => {
  const admins = db.users.filter((u) => u.role === 'admin' && u.active).length;
  el.innerHTML = `
    <div class="page-head"><h2>ユーザー・ロール管理</h2><div class="spacer"></div><button class="btn primary" id="add-user">＋ ユーザーを招待</button></div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>名前</th><th>メール</th><th>ロール</th><th class="num">時給</th><th class="num">有給（残/付与）</th><th>状態</th><th></th></tr></thead>
        <tbody>${db.users.map((u) => `<tr>
          <td>${esc(u.name)}${u.id === me.id ? ' <span class="muted small">(自分)</span>' : ''}</td>
          <td>${esc(u.email)}</td>
          <td><select data-role="${u.id}">
            <option value="employee" ${u.role === 'employee' ? 'selected' : ''}>社員</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理者</option></select></td>
          <td class="num">${yen(u.hourlyRate)}</td>
          <td class="num">${leaveRemain(u)} / ${u.leaveGranted} 日</td>
          <td>${u.active ? '<span class="badge approved">有効</span>' : '<span class="badge off">無効</span>'}</td>
          <td><button class="btn small" data-edit="${u.id}">編集</button>
            ${u.id !== me.id ? `<button class="btn small ${u.active ? 'ng' : ''}" data-toggle="${u.id}">${u.active ? '無効化' : '有効化'}</button>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small" style="margin:12px 0 0">ロールはプルダウンを変更すると即時に切り替わります。最後の管理者は社員に変更できません。</p>
    </div>
    <div class="card">
      <h3>招待中（まだ登録していない人）</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>メール</th><th>名前</th><th>ロール</th><th class="num">時給</th><th>招待コード</th><th>招待日</th><th></th></tr></thead>
        <tbody>${db.invitations.length ? db.invitations.map((i) => `<tr>
          <td>${esc(i.email)}</td><td>${esc(i.name)}</td><td>${roleBadge(i.role)}</td><td class="num">${yen(i.hourlyRate)}</td>
          <td><span class="code">${esc(i.code)}</span> <button class="btn small" data-copy="${esc(i.email)}">案内文をコピー</button></td>
          <td class="muted small">${fmtDT(i.createdAt)}</td>
          <td><button class="btn small ng" data-uninvite="${esc(i.email)}">取消</button></td></tr>`).join('')
          : '<tr><td colspan="7" class="empty">招待中の人はいません</td></tr>'}</tbody>
      </table></div>
      <p class="muted small" style="margin:12px 0 0">招待された人は、ログイン画面の「はじめての方」に招待コードを入れて、招待されたメールアドレスと自分で決めたパスワードでログインすると登録されます。</p>
    </div>
    <div class="card">
      <h3>設定</h3>
      <form id="settings" class="form-grid">
        <label>会社名（請求書の宛先の初期値）<input name="companyName" value="${esc(db.settings.companyName)}" /></label>
        <button class="btn">保存</button>
      </form>
    </div>`;

  const userForm = (u = {}) => `
    <label>名前<input name="name" required value="${esc(u.name ?? '')}" /></label>
    ${u.id
      ? `<label>メールアドレス（変更不可）<input value="${esc(u.email)}" disabled /></label>`
      : `<label>メールアドレス<input name="email" type="email" required /></label>`}
    <label>ロール<select name="role"><option value="employee" ${u.role !== 'admin' ? 'selected' : ''}>社員</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理者</option></select></label>
    <label>時給（円）<input name="hourlyRate" type="number" min="0" value="${u.hourlyRate ?? 1200}" /></label>
    <label>有給付与日数<input name="leaveGranted" type="number" min="0" value="${u.leaveGranted ?? 10}" /></label>`;

  const profilePatch = (f) => ({ name: f.name.value.trim(), role: f.role.value, hourly_rate: Number(f.hourlyRate.value) || 0, leave_granted: Number(f.leaveGranted.value) || 0 });

  const appUrl = location.href.split('#')[0];
  const inviteText = (i) => `勤怠管理システムに招待されました。\n\nURL: ${appUrl}\nメールアドレス: ${i.email}\n招待コード: ${i.code}\n\nログイン画面の「はじめての方」を開いて招待コードを入力し、上のメールアドレスと自分で決めたパスワード（6文字以上）でログインしてください。`;
  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); toast('案内文をコピーしました'); }
    catch { setTimeout(() => modal('案内文', `<textarea rows="8" readonly>${esc(text)}</textarea>`, () => null, '閉じる'), 0); }
  };

  // 招待：メールアドレス・ロール・時給などを登録し、招待コードを発行（本人が登録した時点でこの内容が反映される）
  $('#add-user').onclick = () => modal('ユーザーを招待', userForm(), async (f) => {
    const email = f.email.value.trim().toLowerCase();
    if (db.users.some((x) => x.email.toLowerCase() === email)) return 'このメールアドレスは登録済みです';
    if (db.invitations.some((x) => x.email === email)) return 'このメールアドレスはすでに招待中です';
    const { data, error } = await sb.from('invitations')
      .insert({ email, ...profilePatch(f), invited_by: me.id }).select().single();
    if (error) return errMsg(error);
    await refresh(); render();
    const inv = mapInvite(data);
    // 元のモーダルが閉じた後に案内を表示
    setTimeout(() => modal('招待しました', `
      <p>次の内容を本人に伝えてください。</p>
      <textarea rows="8" readonly>${esc(inviteText(inv))}</textarea>
      <p class="muted small">招待コード：<span class="code">${esc(inv.code)}</span>（「招待中」の一覧からいつでも確認できます）</p>`,
      () => { copyText(inviteText(inv)); return null; }, 'コピーして閉じる'), 0);
    return null;
  }, '招待する');

  $$('[data-copy]', el).forEach((b) => (b.onclick = () => copyText(inviteText(db.invitations.find((i) => i.email === b.dataset.copy)))));
  $$('[data-uninvite]', el).forEach((b) => (b.onclick = () => {
    if (!confirm(`${b.dataset.uninvite} への招待を取り消しますか？（招待コードが使えなくなります）`)) return;
    mutate(sb.from('invitations').delete().eq('email', b.dataset.uninvite), '招待を取り消しました');
  }));

  $$('[data-edit]', el).forEach((b) => (b.onclick = () => {
    const u = db.users.find((x) => x.id === b.dataset.edit);
    modal('ユーザー編集', userForm(u), async (f) => {
      if (u.role === 'admin' && f.role.value !== 'admin' && admins <= 1) return '最後の管理者は社員に変更できません';
      const ok = await mutate(sb.from('profiles').update(profilePatch(f)).eq('id', u.id), '保存しました');
      return ok ? null : '保存に失敗しました';
    }, '保存');
  }));

  $$('[data-role]', el).forEach((s) => (s.onchange = () => {
    const u = db.users.find((x) => x.id === s.dataset.role);
    const to = s.value;
    if (u.role === 'admin' && to !== 'admin' && admins <= 1) { toast('最後の管理者は社員に変更できません', true); return render(); }
    const label = to === 'admin' ? '管理者' : '社員';
    const selfMsg = u.id === me.id ? '\n※ 自分のロールを変更すると社員画面に切り替わります。' : '';
    if (!confirm(`${u.name} さんのロールを「${label}」に変更しますか？${selfMsg}`)) return render();
    mutate(sb.from('profiles').update({ role: to }).eq('id', u.id), `${u.name} さんを${label}に変更しました`).then((ok) => ok || render());
  }));

  $$('[data-toggle]', el).forEach((b) => (b.onclick = () => {
    const u = db.users.find((x) => x.id === b.dataset.toggle);
    if (u.active && u.role === 'admin' && admins <= 1) return toast('最後の管理者は無効化できません', true);
    if (!confirm(`${u.name} さんを${u.active ? '無効化' : '有効化'}しますか？`)) return;
    mutate(sb.from('profiles').update({ active: !u.active }).eq('id', u.id), u.active ? '無効化しました（ログイン不可になります）' : '有効化しました');
  }));

  $('#settings').onsubmit = (e) => {
    e.preventDefault();
    const name = e.target.companyName.value.trim();
    if (!name) return toast('会社名を入力してください', true);
    viewState.inv = null;
    mutate(sb.from('settings').update({ company_name: name }).eq('id', 1), '設定を保存しました');
  };
};

/* ---------- boot ---------- */
$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = $('button[type=submit]', f);
  const p = $('#login-error');
  btn.disabled = true; btn.textContent = 'ログイン中…';
  const err = await login(f.email.value, f.password.value, f.code.value);
  btn.disabled = false; btn.textContent = 'ログイン';
  if (err) { p.textContent = err; p.hidden = false; return; }
  p.hidden = true; f.reset(); location.hash = ''; render();
};
$('#logout-btn').onclick = logout;
window.addEventListener('hashchange', render);
// タブに戻ったときも最新化（Realtime の取りこぼし対策）
window.addEventListener('focus', () => { if (sessionUserId) scheduleRefresh(); });

(async function boot() {
  if (!CONFIGURED) return render();
  const { data } = await sb.auth.getSession();
  if (data.session) {
    sessionUserId = data.session.user.id;
    await refresh();
    if (currentUser()) subscribeRealtime();
    else { await sb.auth.signOut(); sessionUserId = null; db = emptyDb(); }
  }
  render();
})();
