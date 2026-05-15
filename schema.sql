-- ============================================
-- MBS 빌딩자동제어 A/S 접수 시스템 DB 스키마
-- ============================================

-- A/S 접수 테이블
CREATE TABLE IF NOT EXISTS as_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no        TEXT NOT NULL UNIQUE,
  customer_name    TEXT NOT NULL,
  customer_phone   TEXT NOT NULL,
  building_name    TEXT NOT NULL,
  address          TEXT,
  as_type          TEXT NOT NULL,
  priority         TEXT NOT NULL DEFAULT '일반',
  description      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT '접수대기',
  assigned_to      TEXT,
  admin_note       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT,
  completed_at     TEXT,
  customer_notified INTEGER DEFAULT 0,
  staff_notified   INTEGER DEFAULT 0
);

-- 직원 테이블
CREATE TABLE IF NOT EXISTS employees (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  phone          TEXT NOT NULL,
  role           TEXT DEFAULT '기술자',
  department     TEXT,
  receive_sms    INTEGER DEFAULT 1,
  receive_kakao  INTEGER DEFAULT 1,
  active         INTEGER DEFAULT 1,
  created_at     TEXT NOT NULL
);

-- 알림 발송 로그
CREATE TABLE IF NOT EXISTS notification_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id      INTEGER,
  recipient_name  TEXT,
  recipient_phone TEXT,
  type            TEXT NOT NULL,
  channel         TEXT NOT NULL,
  message         TEXT,
  status          TEXT NOT NULL DEFAULT '전송됨',
  error_message   TEXT,
  sent_at         TEXT NOT NULL
);

-- 시스템 설정
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT
);

-- 기본 설정 삽입
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('company_name',   'MBS 빌딩자동제어',  datetime('now')),
  ('company_phone',  '02-0000-0000',      datetime('now')),
  ('sms_enabled',    '1',                 datetime('now')),
  ('kakao_enabled',  '1',                 datetime('now'));

-- 관리자 계정 테이블
CREATE TABLE IF NOT EXISTS admin_users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'admin',
  active     INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login TEXT
);

-- 기본 최고 관리자 계정 (초기 접속용)
INSERT OR IGNORE INTO admin_users (username, password, name, role, active, created_at)
VALUES ('mbseng', 'me4848', 'MBS 최고관리자', 'superadmin', 1, datetime('now'));

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_requests_status   ON as_requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_created  ON as_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_ticket   ON as_requests(ticket_no);
CREATE INDEX IF NOT EXISTS idx_notif_request     ON notification_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_admin_username    ON admin_users(username);
