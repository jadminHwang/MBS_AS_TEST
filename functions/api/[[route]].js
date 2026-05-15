/**
 * MBS 빌딩자동제어 A/S 접수 시스템
 * Cloudflare Pages Function - API 핸들러
 * Route: /api/*
 */

// ─── 공통 유틸 ───────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function res(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function err(message, status = 400) {
  return res({ success: false, error: message }, status);
}

function nowKST() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T');
}

function nowKSTDisplay() {
  return new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function generateTicket() {
  const d = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `AS-${d}-${rand}`;
}

async function checkAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return false;
  try {
    const decoded = atob(token);
    const [username, ...pwParts] = decoded.split(':');
    const password = pwParts.join(':');
    if (!env.DB) {
      return username === (env.ADMIN_USERNAME || 'mbseng') && password === (env.ADMIN_PASSWORD || 'me4848');
    }
    const user = await env.DB.prepare(
      'SELECT id FROM admin_users WHERE username=? AND password=? AND active=1'
    ).bind(username, password).first();
    return !!user;
  } catch { return false; }
}

// ─── SMS (CoolSMS) ────────────────────────────────────────────

async function hmacSHA256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sendSMS(env, to, text) {
  const apiKey = env.COOLSMS_API_KEY;
  const apiSecret = env.COOLSMS_API_SECRET;
  const from = env.COOLSMS_FROM;

  if (!apiKey || apiKey === 'test') {
    console.log(`[SMS MOCK] to=${to} | ${text.substring(0, 30)}...`);
    return { success: true, mock: true };
  }

  const timestamp = Date.now().toString();
  const salt = Math.random().toString(36).substring(2, 14);
  const signature = await hmacSHA256(apiSecret, timestamp + salt);

  try {
    const r = await fetch('https://api.coolsms.co.kr/messages/v4/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `HMAC-SHA256 apiKey=${apiKey}, date=${timestamp}, salt=${salt}, signature=${signature}`,
      },
      body: JSON.stringify({
        message: {
          to: to.replace(/[^0-9]/g, ''),
          from: from.replace(/[^0-9]/g, ''),
          text,
          type: 'SMS',
        },
      }),
    });
    const data = await r.json();
    return { success: r.ok, data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function sendKakao(env, to, text) {
  const apiKey = env.COOLSMS_API_KEY;
  const apiSecret = env.COOLSMS_API_SECRET;
  const from = env.COOLSMS_FROM;
  const pfId = env.KAKAO_PFID;

  if (!apiKey || apiKey === 'test' || !pfId) {
    console.log(`[KAKAO MOCK] to=${to} | ${text.substring(0, 30)}...`);
    return { success: true, mock: true };
  }

  const timestamp = Date.now().toString();
  const salt = Math.random().toString(36).substring(2, 14);
  const signature = await hmacSHA256(apiSecret, timestamp + salt);

  try {
    const r = await fetch('https://api.coolsms.co.kr/messages/v4/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `HMAC-SHA256 apiKey=${apiKey}, date=${timestamp}, salt=${salt}, signature=${signature}`,
      },
      body: JSON.stringify({
        message: {
          to: to.replace(/[^0-9]/g, ''),
          from: from.replace(/[^0-9]/g, ''),
          text,
          type: 'ATA',
          kakaoOptions: { pfId },
        },
      }),
    });
    const data = await r.json();
    return { success: r.ok, data };
  } catch (e) {
    // 카카오 실패시 SMS 대체 발송
    return await sendSMS(env, to, text);
  }
}

// ─── 알림 발송 ────────────────────────────────────────────────

async function notifyStaff(env, db, req) {
  const { results: employees } = await db
    .prepare('SELECT * FROM employees WHERE active = 1')
    .all();

  if (!employees || employees.length === 0) return [];

  const msg =
    `[MBS 빌딩자동제어] A/S 신규접수\n` +
    `━━━━━━━━━━━━━━━\n` +
    `📋 ${req.ticket_no}\n` +
    `👤 ${req.customer_name} / ${req.customer_phone}\n` +
    `🏢 ${req.building_name}\n` +
    `🔧 ${req.as_type} [${req.priority}]\n` +
    `📝 ${req.description.length > 40 ? req.description.substring(0, 40) + '...' : req.description}\n` +
    `🕐 ${nowKSTDisplay()}`;

  const results = [];
  for (const emp of employees) {
    if (emp.receive_sms) {
      const r = await sendSMS(env, emp.phone, msg);
      await db.prepare(
        `INSERT INTO notification_logs (request_id,recipient_name,recipient_phone,type,channel,message,status,sent_at)
         VALUES (?,?,?,'직원알림','SMS',?,?,?)`
      ).bind(req.id, emp.name, emp.phone, msg, r.success ? '성공' : '실패', nowKST()).run();
      results.push({ name: emp.name, channel: 'SMS', ok: r.success });
    }
    if (emp.receive_kakao) {
      const r = await sendKakao(env, emp.phone, msg);
      await db.prepare(
        `INSERT INTO notification_logs (request_id,recipient_name,recipient_phone,type,channel,message,status,sent_at)
         VALUES (?,?,?,'직원알림','KAKAO',?,?,?)`
      ).bind(req.id, emp.name, emp.phone, msg, r.success ? '성공' : '실패', nowKST()).run();
      results.push({ name: emp.name, channel: 'KAKAO', ok: r.success });
    }
  }

  await db.prepare('UPDATE as_requests SET staff_notified=1 WHERE id=?').bind(req.id).run();
  return results;
}

async function notifyCustomer(env, db, req) {
  const msg =
    `[MBS 빌딩자동제어] A/S 접수완료\n` +
    `━━━━━━━━━━━━━━━\n` +
    `안녕하세요, ${req.customer_name}님!\n` +
    `A/S 접수가 완료되었습니다.\n\n` +
    `📋 접수번호: ${req.ticket_no}\n` +
    `🏢 건물명: ${req.building_name}\n` +
    `🔧 분류: ${req.as_type}\n` +
    `🕐 접수일시: ${nowKSTDisplay()}\n\n` +
    `담당 기술자가 확인 후 연락드리겠습니다.\n` +
    `📞 문의: ${env.COMPANY_PHONE || '02-0000-0000'}`;

  const r = await sendSMS(env, req.customer_phone, msg);
  await db.prepare(
    `INSERT INTO notification_logs (request_id,recipient_name,recipient_phone,type,channel,message,status,sent_at)
     VALUES (?,?,?,'고객알림','SMS',?,?,?)`
  ).bind(req.id, req.customer_name, req.customer_phone, msg, r.success ? '성공' : '실패', nowKST()).run();

  await db.prepare('UPDATE as_requests SET customer_notified=1 WHERE id=?').bind(req.id).run();
  return r;
}

// ─── 라우터 ───────────────────────────────────────────────────

async function router(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
  const method = request.method;
  const db = env.DB;

  // CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  // ── POST /api/requests ── 새 A/S 접수
  if (method === 'POST' && path === '/requests') {
    let body;
    try { body = await request.json(); } catch { return err('잘못된 요청 형식'); }

    const { customer_name, customer_phone, building_name, address, as_type, priority, description } = body;
    if (!customer_name || !customer_phone || !building_name || !as_type || !description) {
      return err('필수 항목이 누락되었습니다.');
    }

    const ticket_no = generateTicket();
    const now = nowKST();

    await db.prepare(
      `INSERT INTO as_requests (ticket_no,customer_name,customer_phone,building_name,address,as_type,priority,description,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,'접수대기',?)`
    ).bind(ticket_no, customer_name, customer_phone, building_name, address || '', as_type, priority || '일반', description, now).run();

    const { results } = await db.prepare('SELECT * FROM as_requests WHERE ticket_no=?').bind(ticket_no).all();
    const newReq = results[0];

    // 비동기 알림 발송
    const staffResult = await notifyStaff(env, db, newReq);
    await notifyCustomer(env, db, newReq);

    return res({ success: true, ticket_no, id: newReq.id, staff_notified: staffResult.length }, 201);
  }

  // ── GET /api/requests ── 목록 조회 (관리자)
  if (method === 'GET' && path === '/requests') {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);

    const status = url.searchParams.get('status') || '';
    const search = url.searchParams.get('search') || '';
    const limit  = Math.min(parseInt(url.searchParams.get('limit') || '100'), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    let q = 'SELECT * FROM as_requests';
    const params = [];
    const conds = [];

    if (status && status !== '전체') { conds.push('status=?'); params.push(status); }
    if (search) {
      conds.push('(customer_name LIKE ? OR building_name LIKE ? OR ticket_no LIKE ? OR customer_phone LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const { results } = await db.prepare(q).bind(...params).all();

    // 통계
    const stats = await db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='접수대기' THEN 1 ELSE 0 END) as waiting,
        SUM(CASE WHEN status='처리중'   THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status='완료'     THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN priority='긴급'   THEN 1 ELSE 0 END) as urgent
      FROM as_requests`
    ).first();

    return res({ success: true, data: results, stats, count: results.length });
  }

  // ── GET /api/requests/:id ── 단건 조회
  if (method === 'GET' && path.match(/^\/requests\/\d+$/)) {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    const id = path.split('/').pop();
    const row = await db.prepare('SELECT * FROM as_requests WHERE id=?').bind(id).first();
    if (!row) return err('접수 건을 찾을 수 없습니다.', 404);

    const { results: logs } = await db.prepare(
      'SELECT * FROM notification_logs WHERE request_id=? ORDER BY sent_at DESC'
    ).bind(id).all();

    return res({ success: true, data: row, logs });
  }

  // ── PATCH /api/requests/:id ── 상태 변경
  if (method === 'PATCH' && path.match(/^\/requests\/\d+$/)) {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    const id = path.split('/').pop();
    let body;
    try { body = await request.json(); } catch { return err('잘못된 요청 형식'); }

    const { status, assigned_to, admin_note } = body;
    const now = nowKST();
    const completedAt = status === '완료' ? now : null;

    await db.prepare(
      `UPDATE as_requests SET
        status=COALESCE(?,status),
        assigned_to=COALESCE(?,assigned_to),
        admin_note=COALESCE(?,admin_note),
        updated_at=?,
        completed_at=COALESCE(?,completed_at)
       WHERE id=?`
    ).bind(status || null, assigned_to || null, admin_note || null, now, completedAt, id).run();

    // 완료 시 고객에게 SMS 발송
    if (status === '완료') {
      const req = await db.prepare('SELECT * FROM as_requests WHERE id=?').bind(id).first();
      if (req) {
        const completeMsg =
          `[MBS 빌딩자동제어] A/S 처리완료\n` +
          `━━━━━━━━━━━━━━━\n` +
          `${req.customer_name}님, A/S가 완료되었습니다.\n` +
          `📋 ${req.ticket_no}\n` +
          `🏢 ${req.building_name}\n` +
          `✅ 처리완료: ${nowKSTDisplay()}\n\n` +
          `이용해 주셔서 감사합니다.\n` +
          `📞 ${env.COMPANY_PHONE || '02-0000-0000'}`;
        await sendSMS(env, req.customer_phone, completeMsg);
      }
    }

    const updated = await db.prepare('SELECT * FROM as_requests WHERE id=?').bind(id).first();
    return res({ success: true, data: updated });
  }

  // ── GET /api/employees ── 직원 목록
  if (method === 'GET' && path === '/employees') {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    const { results } = await db.prepare('SELECT * FROM employees ORDER BY name').all();
    return res({ success: true, data: results });
  }

  // ── POST /api/employees ── 직원 추가
  if (method === 'POST' && path === '/employees') {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    let body;
    try { body = await request.json(); } catch { return err('잘못된 요청 형식'); }

    const { name, phone, role, department, receive_sms, receive_kakao } = body;
    if (!name || !phone) return err('이름과 전화번호는 필수입니다.');

    await db.prepare(
      `INSERT INTO employees (name,phone,role,department,receive_sms,receive_kakao,active,created_at)
       VALUES (?,?,?,?,?,?,1,?)`
    ).bind(name, phone, role || '기술자', department || '', receive_sms ? 1 : 0, receive_kakao ? 1 : 0, nowKST()).run();

    return res({ success: true, message: `${name} 직원이 등록되었습니다.` }, 201);
  }

  // ── PATCH /api/employees/:id ── 직원 수정
  if (method === 'PATCH' && path.match(/^\/employees\/\d+$/)) {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    const id = path.split('/').pop();
    let body;
    try { body = await request.json(); } catch { return err('잘못된 요청 형식'); }

    const { name, phone, role, department, receive_sms, receive_kakao, active } = body;
    await db.prepare(
      `UPDATE employees SET
        name=COALESCE(?,name), phone=COALESCE(?,phone),
        role=COALESCE(?,role), department=COALESCE(?,department),
        receive_sms=COALESCE(?,receive_sms), receive_kakao=COALESCE(?,receive_kakao),
        active=COALESCE(?,active)
       WHERE id=?`
    ).bind(
      name||null, phone||null, role||null, department||null,
      receive_sms!=null?receive_sms:null, receive_kakao!=null?receive_kakao:null,
      active!=null?active:null, id
    ).run();

    return res({ success: true, message: '직원 정보가 수정되었습니다.' });
  }

  // ── DELETE /api/employees/:id ── 직원 삭제
  if (method === 'DELETE' && path.match(/^\/employees\/\d+$/)) {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    const id = path.split('/').pop();
    await db.prepare('DELETE FROM employees WHERE id=?').bind(id).run();
    return res({ success: true, message: '직원이 삭제되었습니다.' });
  }

  // ── GET /api/logs ── 알림 로그
  if (method === 'GET' && path === '/logs') {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    const { results } = await db.prepare(
      'SELECT * FROM notification_logs ORDER BY sent_at DESC LIMIT 200'
    ).all();
    return res({ success: true, data: results });
  }

  // ── POST /api/test-notify ── 테스트 알림
  if (method === 'POST' && path === '/test-notify') {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    let body;
    try { body = await request.json(); } catch { return err('잘못된 요청 형식'); }

    const { phone, channel } = body;
    if (!phone) return err('전화번호를 입력하세요.');

    const testMsg = `[MBS 빌딩자동제어] 테스트 알림\n시스템 정상 동작 확인 메시지입니다.\n${nowKSTDisplay()}`;

    let r;
    if (channel === 'kakao') {
      r = await sendKakao(env, phone, testMsg);
    } else {
      r = await sendSMS(env, phone, testMsg);
    }

    return res({ success: r.success, mock: r.mock || false, result: r });
  }

  // ── GET /api/stats ── 대시보드 통계
  if (method === 'GET' && path === '/stats') {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);

    const today = nowKST().slice(0, 10);

    const overall = await db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='접수대기' THEN 1 ELSE 0 END) as waiting,
        SUM(CASE WHEN status='처리중'   THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status='완료'     THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN priority='긴급'   THEN 1 ELSE 0 END) as urgent
      FROM as_requests`
    ).first();

    const todayStats = await db.prepare(
      `SELECT COUNT(*) as count FROM as_requests WHERE created_at LIKE ?`
    ).bind(`${today}%`).first();

    const byType = await db.prepare(
      `SELECT as_type, COUNT(*) as count FROM as_requests GROUP BY as_type ORDER BY count DESC`
    ).all();

    const recentRequests = await db.prepare(
      `SELECT id, ticket_no, customer_name, building_name, as_type, priority, status, created_at
       FROM as_requests ORDER BY created_at DESC LIMIT 10`
    ).all();

    return res({
      success: true,
      overall,
      today: todayStats.count,
      byType: byType.results,
      recent: recentRequests.results,
    });
  }

  // ── POST /api/auth/login ── 로그인 (아이디+비밀번호)
  if (method === 'POST' && (path === '/auth/login' || path === '/auth/verify')) {
    let body;
    try { body = await request.json(); } catch { return err('잘못된 요청 형식'); }

    const { username, password } = body;
    if (!username || !password) return err('아이디와 비밀번호를 입력하세요.');

    let user = null;
    if (env.DB) {
      user = await env.DB.prepare(
        'SELECT * FROM admin_users WHERE username=? AND password=? AND active=1'
      ).bind(username, password).first();
      if (user) {
        await env.DB.prepare('UPDATE admin_users SET last_login=? WHERE id=?').bind(nowKST(), user.id).run();
      }
    } else {
      if (username === (env.ADMIN_USERNAME || 'mbseng') && password === (env.ADMIN_PASSWORD || 'me4848')) {
        user = { username, name: 'MBS 관리자', role: 'superadmin' };
      }
    }

    if (!user) return res({ success: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);

    const token = btoa(`${username}:${password}`);
    return res({ success: true, token, name: user.name, role: user.role });
  }

  // ── GET /api/admin-users ── 관리자 목록
  if (method === 'GET' && path === '/admin-users') {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    const { results } = await db.prepare(
      'SELECT id, username, name, role, active, created_at, last_login FROM admin_users ORDER BY id'
    ).all();
    return res({ success: true, data: results });
  }

  // ── POST /api/admin-users ── 관리자 추가
  if (method === 'POST' && path === '/admin-users') {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    let body;
    try { body = await request.json(); } catch { return err('잘못된 요청 형식'); }
    const { username, password: pw, name, role } = body;
    if (!username || !pw || !name) return err('아이디, 비밀번호, 이름은 필수입니다.');
    const exists = await db.prepare('SELECT id FROM admin_users WHERE username=?').bind(username).first();
    if (exists) return err('이미 사용 중인 아이디입니다.');
    await db.prepare(
      'INSERT INTO admin_users (username,password,name,role,active,created_at) VALUES (?,?,?,?,1,?)'
    ).bind(username, pw, name, role || 'admin', nowKST()).run();
    return res({ success: true, message: `관리자 '${name}' 계정이 생성되었습니다.` }, 201);
  }

  // ── PATCH /api/admin-users/:id ── 관리자 수정
  if (method === 'PATCH' && path.match(/^\/admin-users\/\d+$/)) {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    const id = path.split('/').pop();
    let body;
    try { body = await request.json(); } catch { return err('잘못된 요청 형식'); }
    const { password: pw, name, role, active } = body;
    await db.prepare(
      `UPDATE admin_users SET
        password=COALESCE(?,password), name=COALESCE(?,name),
        role=COALESCE(?,role), active=COALESCE(?,active)
       WHERE id=?`
    ).bind(pw||null, name||null, role||null, active!=null?active:null, id).run();
    return res({ success: true, message: '관리자 정보가 수정되었습니다.' });
  }

  // ── DELETE /api/admin-users/:id ── 관리자 삭제
  if (method === 'DELETE' && path.match(/^\/admin-users\/\d+$/)) {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    const id = path.split('/').pop();
    const target = await db.prepare('SELECT username FROM admin_users WHERE id=?').bind(id).first();
    if (target?.username === 'mbseng') return err('기본 관리자 계정은 삭제할 수 없습니다.');
    await db.prepare('DELETE FROM admin_users WHERE id=?').bind(id).run();
    return res({ success: true, message: '관리자 계정이 삭제되었습니다.' });
  }

  // ── GET /api/sites ── 현장 목록
  if (method === 'GET' && path === '/sites') {
    const { results } = await db.prepare('SELECT * FROM sites ORDER BY name').all();
    return res(results);
  }

  // ── POST /api/sites ── 현장 추가
  if (method === 'POST' && path === '/sites') {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    let body;
    try { body = await request.json(); } catch { return err('잘못된 요청 형식'); }
    const { name, address, contact_person, contact_phone } = body;
    if (!name) return err('현장명은 필수입니다.');
    await db.prepare(
      'INSERT INTO sites (name, address, contact_person, contact_phone) VALUES (?, ?, ?, ?)'
    ).bind(name, address || '', contact_person || '', contact_phone || '').run();
    return res({ success: true }, 201);
  }

  // ── DELETE /api/sites/:id ── 현장 삭제
  if (method === 'DELETE' && path.match(/^\/sites\/\d+$/)) {
    if (!await checkAuth(request, env)) return err('인증이 필요합니다.', 401);
    const id = path.split('/').pop();
    await db.prepare('DELETE FROM sites WHERE id=?').bind(id).run();
    return res({ success: true });
  }

  return err('존재하지 않는 API 경로입니다.', 404);
}

// ─── 진입점 ───────────────────────────────────────────────────

export async function onRequest(context) {
  try {
    return await router(context.request, context.env);
  } catch (e) {
    console.error('API Error:', e);
    return new Response(JSON.stringify({ success: false, error: '서버 오류가 발생했습니다.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }
}
