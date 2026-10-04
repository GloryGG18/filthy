import crypto from 'node:crypto';
import { config, isAdminId } from './config.js';
import { get, run, now } from './db.js';

const MAX_AGE_MS = 24 * 3600 * 1000;

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyInitData(initData, botToken = config.botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  if (expected.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return null;
  if (now() - Number(params.get('auth_date')) * 1000 > MAX_AGE_MS) return null;
  try {
    return JSON.parse(params.get('user'));
  } catch {
    return null;
  }
}

export function upsertUser(tg, { botStarted = false } = {}) {
  const existing = get('SELECT * FROM users WHERE tg_id = ?', tg.id);
  if (!existing) {
    run(
      `INSERT INTO users (tg_id, username, first_name, last_name, lang, role, bot_started, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      tg.id, tg.username ?? null, tg.first_name ?? null, tg.last_name ?? null, tg.language_code ?? null,
      isAdminId(tg.id) ? 'admin' : 'guest', botStarted ? 1 : 0, now(),
    );
  } else {
    run(
      `UPDATE users SET username = ?, first_name = ?, last_name = ?, lang = COALESCE(?, lang),
       bot_started = MAX(bot_started, ?), role = CASE WHEN ? THEN 'admin' ELSE role END WHERE tg_id = ?`,
      tg.username ?? null, tg.first_name ?? null, tg.last_name ?? null, tg.language_code ?? null,
      botStarted ? 1 : 0, isAdminId(tg.id) ? 1 : 0, tg.id,
    );
  }
  return get('SELECT * FROM users WHERE tg_id = ?', tg.id);
}

export function authenticate(req) {
  let tg = verifyInitData(req.headers['x-telegram-init-data']);
  if (!tg && config.devAuth && req.headers['x-dev-user']) {
    const id = Number(req.headers['x-dev-user']);
    tg = { id, first_name: `Dev ${id}`, username: `dev${id}`, language_code: 'uk' };
  }
  return tg ? upsertUser(tg) : null;
}

export const displayName = (u) =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : String(u.tg_id)) : '';
