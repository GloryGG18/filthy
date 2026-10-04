import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { db, get, all, run, tx, now } from './db.js';
import { displayName } from './auth.js';

// Bot subscribes to these to message guests and admins.
export const bus = new EventEmitter();

export class AppError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const PAYABLE = ['approved', 'awaiting_payment', 'expired'];
const VALID = ['paid', 'used'];

// ---------- codes & QR ----------

function newCode() {
  for (;;) {
    const code = String(crypto.randomInt(10_000_000, 100_000_000));
    if (!get('SELECT 1 FROM tickets WHERE code = ?', code)) return code;
  }
}

const sign = (code) => crypto.createHmac('sha256', config.qrSecret).update(code).digest('base64url').slice(0, 12);

export const qrPayload = (code) => `FLT:${code}:${sign(code)}`;

// Accepts the full signed QR payload, or a bare 8-digit code typed in by a controller.
export function parseQr(text) {
  const s = String(text || '').trim();
  const m = s.match(/^FLT:(\d{8}):([\w-]{12})$/);
  if (m) {
    const a = Buffer.from(sign(m[1]));
    const b = Buffer.from(m[2]);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? m[1] : null;
  }
  return /^\d{8}$/.test(s) ? s : null;
}

// ---------- capacity ----------

export function takenSeats(eventId) {
  return get(
    `SELECT COUNT(*) n FROM tickets WHERE event_id = ?
       AND (status IN ('paid','used') OR (status = 'awaiting_payment' AND reserved_until > ?))`,
    eventId, now(),
  ).n;
}

function assertSeat(event) {
  if (event.capacity != null && takenSeats(event.id) >= event.capacity) throw new AppError('sold_out');
}

function loadOpenEvent(eventId) {
  const ev = get('SELECT * FROM events WHERE id = ?', eventId);
  if (!ev || ev.status !== 'published') throw new AppError('event_not_available', 404);
  return ev;
}

// ---------- guest purchase ----------

export function createTicket(user, eventId, tier) {
  if (!['online', 'repost'].includes(tier)) throw new AppError('bad_tier');
  return tx(() => {
    const ev = loadOpenEvent(eventId);
    if (ev.starts_at < now()) throw new AppError('sales_closed');
    const open = get(
      `SELECT * FROM tickets WHERE event_id = ? AND user_id = ? AND tier = ?
         AND status IN ('pending_approval','approved','awaiting_payment','expired')`,
      eventId, user.tg_id, tier,
    );
    if (open) return open; // resume an unfinished purchase instead of creating duplicates
    if (tier === 'online') assertSeat(ev);
    const price = tier === 'online' ? ev.price_online : ev.price_repost;
    const status = tier === 'online' ? 'awaiting_payment' : 'pending_approval';
    const reserved = tier === 'online' ? now() + config.reservationMinutes * 60_000 : null;
    const { lastInsertRowid } = run(
      `INSERT INTO tickets (code, event_id, user_id, guest_name, tier, price, status, reserved_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newCode(), eventId, user.tg_id, displayName(user), tier, price, status, reserved, now(),
    );
    return get('SELECT * FROM tickets WHERE id = ?', lastInsertRowid);
  });
}

// (Re)opens the 30-minute payment window. For monobank also fixes the UAH amount at today's rate.
export function startPayment(ticket, method, uahRate) {
  if (!PAYABLE.includes(ticket.status)) throw new AppError('not_payable');
  return tx(() => {
    const ev = get('SELECT * FROM events WHERE id = ?', ticket.event_id);
    if (ticket.status !== 'awaiting_payment' || ticket.reserved_until < now()) assertSeat(ev);
    const uah = method === 'monobank' ? uahAmount(ticket, uahRate) : ticket.uah_expected;
    run(
      `UPDATE tickets SET status = 'awaiting_payment', reserved_until = ?, uah_expected = ? WHERE id = ?`,
      now() + config.reservationMinutes * 60_000, uah, ticket.id,
    );
    return get('SELECT * FROM tickets WHERE id = ?', ticket.id);
  });
}

// Unpaid tickets that may still receive a transfer; card payments are matched against these by exact amount.
const OPEN_UAH = `status IN ('approved','awaiting_payment','expired') AND uah_expected IS NOT NULL AND reserved_until > ?`;
const openSince = () => now() - 7 * 86400_000;

// Whole hryvnias at today's rate. In card mode a transfer carries no reliable comment, so each open
// ticket also gets its own kopecks (487.01, 487.02 …) and the amount alone identifies it.
function uahAmount(ticket, rate) {
  const base = Math.ceil((ticket.price / 100) * rate) * 100;
  if (config.monobank.mode !== 'card') return base;
  if (ticket.uah_expected && ticket.uah_expected - (ticket.uah_expected % 100) === base && ticket.uah_expected % 100) return ticket.uah_expected;
  const taken = new Set(all(`SELECT uah_expected FROM tickets WHERE ${OPEN_UAH} AND id != ?`, openSince(), ticket.id).map((r) => r.uah_expected));
  for (let amount = base + 1; ; amount++) if (amount % 100 && !taken.has(amount)) return amount;
}

export function markPaid(ticketId, method, paidAt = now()) {
  const r = run(
    `UPDATE tickets SET status = 'paid', pay_method = ?, paid_at = ?
     WHERE id = ? AND status IN ('approved','awaiting_payment','expired','pending_approval')`,
    method, paidAt, ticketId,
  );
  if (r.changes) bus.emit('ticket_paid', get('SELECT * FROM tickets WHERE id = ?', ticketId));
  return r.changes > 0;
}

export function cancelTicket(ticket) {
  if (!['pending_approval', 'approved', 'awaiting_payment', 'expired'].includes(ticket.status)) throw new AppError('cannot_cancel');
  run(`UPDATE tickets SET status = 'cancelled' WHERE id = ?`, ticket.id);
}

// Unpaid online reservations lapse; approved repost tickets keep their approval and can pay again.
export function expireReservations() {
  const t = now();
  run(`UPDATE tickets SET status = 'expired' WHERE status = 'awaiting_payment' AND tier = 'online' AND reserved_until < ?`, t);
  run(`UPDATE tickets SET status = 'approved' WHERE status = 'awaiting_payment' AND tier = 'repost' AND reserved_until < ?`, t);
}

// ---------- incoming money ----------

// Records a bank/monobank transaction and activates the ticket it references when the amount is enough.
// `onlyIfMatched` skips money that matches no ticket (card mode reads a personal card's statement).
export function recordPayment({ source, externalId, amount, currency, reference, payer, raw, receivedAt = now(), onlyIfMatched = false }) {
  if (get('SELECT 1 FROM payments WHERE source = ? AND external_id = ?', source, externalId)) return null;
  const code = String(reference || '').match(/\b(\d{8})\b/)?.[1];
  let ticket = code ? get('SELECT * FROM tickets WHERE code = ?', code) : null;
  if (!ticket && currency === 'UAH' && config.monobank.mode === 'card') {
    const byAmount = all(`SELECT * FROM tickets WHERE ${OPEN_UAH} AND uah_expected = ?`, openSince(), amount);
    if (byAmount.length === 1) ticket = byAmount[0];
  }
  if (!ticket && onlyIfMatched) return null;
  let status = 'unmatched';
  if (ticket) {
    const enough =
      currency === 'UAH'
        ? amount >= Math.floor((ticket.uah_expected ?? Infinity) * config.monobank.tolerance)
        : amount >= ticket.price;
    if (!enough) status = 'underpaid';
    else if (VALID.includes(ticket.status)) status = 'unmatched'; // duplicate payment for a ticket already paid
    else status = 'matched';
  }
  const { lastInsertRowid } = run(
    `INSERT INTO payments (source, external_id, amount, currency, reference, payer, ticket_id, status, raw, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    source, String(externalId), amount, currency, reference ?? null, payer ?? null, ticket?.id ?? null, status,
    raw ? JSON.stringify(raw) : null, receivedAt,
  );
  if (status === 'matched') markPaid(ticket.id, source === 'monobank' ? 'monobank' : 'paybysquare', receivedAt);
  const payment = get('SELECT * FROM payments WHERE id = ?', lastInsertRowid);
  if (status !== 'matched') bus.emit('payment_review', payment);
  return payment;
}

// ---------- door ----------

export function scan(controller, eventId, text) {
  const t = now();
  const code = parseQr(text);
  const ticket = code ? get('SELECT * FROM tickets WHERE code = ?', code) : null;
  let result;
  let extra = {};
  if (!ticket) result = 'invalid';
  else if (ticket.event_id !== Number(eventId)) {
    result = 'wrong_event';
    extra.event = get('SELECT title, starts_at FROM events WHERE id = ?', ticket.event_id);
  } else if (ticket.status === 'used') {
    result = 'used';
    extra.used_at = ticket.used_at;
    extra.used_by = displayName(get('SELECT * FROM users WHERE tg_id = ?', ticket.used_by));
  } else if (ticket.status === 'paid') {
    // Conditional update so two controllers scanning the same QR at once cannot both let it in.
    const r = run(`UPDATE tickets SET status = 'used', used_at = ?, used_by = ? WHERE id = ? AND status = 'paid'`, t, controller.tg_id, ticket.id);
    result = r.changes ? 'ok' : 'used';
    if (!r.changes) extra.used_at = get('SELECT used_at FROM tickets WHERE id = ?', ticket.id).used_at;
  } else result = 'unpaid';
  run(
    'INSERT INTO scans (event_id, ticket_id, controller_id, result, created_at) VALUES (?, ?, ?, ?, ?)',
    eventId, ticket?.id ?? null, controller.tg_id, result, t,
  );
  return {
    result,
    ticket: ticket && { code: ticket.code, tier: ticket.tier, guest_name: ticket.guest_name, status: ticket.status, price: ticket.price },
    ...extra,
    entered: enteredCount(eventId),
  };
}

// One sale can cover a group: `count` tickets at `amount` each, all marked as entered.
export function doorSale(controller, eventId, { method, amount, name, count = 1 }) {
  if (!['cash', 'card'].includes(method)) throw new AppError('bad_method');
  const ev = get('SELECT * FROM events WHERE id = ?', eventId);
  if (!ev || ev.status === 'draft') throw new AppError('event_not_available', 404);
  const price = amount == null ? ev.price_door : Math.round(Number(amount) * 100);
  if (!Number.isFinite(price) || price < 0 || price > 100_000) throw new AppError('bad_amount');
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new AppError('bad_count');
  const t = now();
  const tickets = tx(() => Array.from({ length: n }, () => {
    const { lastInsertRowid } = run(
      `INSERT INTO tickets (code, event_id, guest_name, tier, price, status, pay_method, paid_at, used_at, used_by, sold_by, created_at)
       VALUES (?, ?, ?, 'door', ?, 'used', ?, ?, ?, ?, ?, ?)`,
      newCode(), eventId, name || null, price, method, t, t, controller.tg_id, controller.tg_id, t,
    );
    return get('SELECT * FROM tickets WHERE id = ?', lastInsertRowid);
  }));
  return { ticket: tickets[0], tickets, total: price * n, entered: enteredCount(eventId) };
}

// Undoes a mistaken door sale (a whole group at once). Controllers can undo their own sales for a short
// while; admins can undo any. Cancelled sales drop out of the entry count and the cash report.
export const DOOR_UNDO_MINUTES = 15;
export function cancelDoorSale(user, codes) {
  if (!Array.isArray(codes) || !codes.length || codes.length > 50) throw new AppError('bad_request');
  return tx(() => {
    const rows = codes.map((c) => get(`SELECT * FROM tickets WHERE code = ? AND tier = 'door'`, String(c)));
    if (rows.some((r) => !r)) throw new AppError('not_found', 404);
    if (rows.some((r) => r.status !== 'used')) throw new AppError('already_cancelled');
    if (user.role !== 'admin') {
      if (rows.some((r) => r.sold_by !== user.tg_id)) throw new AppError('forbidden', 403);
      if (rows.some((r) => r.created_at < now() - DOOR_UNDO_MINUTES * 60_000)) throw new AppError('undo_too_late');
    }
    for (const r of rows) run(`UPDATE tickets SET status = 'cancelled' WHERE id = ?`, r.id);
    return { cancelled: rows.length, entered: enteredCount(rows[0].event_id) };
  });
}

export const enteredCount = (eventId) => get(`SELECT COUNT(*) n FROM tickets WHERE event_id = ? AND status = 'used'`, eventId).n;

// ---------- report ----------

export function eventReport(eventId) {
  const ev = get('SELECT * FROM events WHERE id = ?', eventId);
  if (!ev) throw new AppError('not_found', 404);
  const sum = (where, ...p) =>
    get(`SELECT COUNT(*) n, COALESCE(SUM(price),0) total FROM tickets WHERE event_id = ? AND ${where}`, eventId, ...p);

  const online = {
    paybysquare: sum(`tier != 'door' AND status IN ('paid','used') AND pay_method = 'paybysquare'`),
    monobank: sum(`tier != 'door' AND status IN ('paid','used') AND pay_method = 'monobank'`),
    manual: sum(`tier != 'door' AND status IN ('paid','used') AND pay_method = 'manual'`),
    repost: sum(`tier = 'repost' AND status IN ('paid','used')`),
  };
  const door = { cash: sum(`tier = 'door' AND status = 'used' AND pay_method = 'cash'`), card: sum(`tier = 'door' AND status = 'used' AND pay_method = 'card'`) };

  const controllers = all(
    `SELECT u.tg_id, u.username, u.first_name, u.last_name,
       (SELECT COUNT(*) FROM tickets t WHERE t.event_id = ? AND t.tier != 'door' AND t.used_by = u.tg_id) scanned_in,
       (SELECT COUNT(*) FROM tickets t WHERE t.event_id = ? AND t.sold_by = u.tg_id AND t.status = 'used' AND t.pay_method = 'cash') cash_n,
       (SELECT COALESCE(SUM(price),0) FROM tickets t WHERE t.event_id = ? AND t.sold_by = u.tg_id AND t.status = 'used' AND t.pay_method = 'cash') cash_total,
       (SELECT COUNT(*) FROM tickets t WHERE t.event_id = ? AND t.sold_by = u.tg_id AND t.status = 'used' AND t.pay_method = 'card') card_n,
       (SELECT COALESCE(SUM(price),0) FROM tickets t WHERE t.event_id = ? AND t.sold_by = u.tg_id AND t.status = 'used' AND t.pay_method = 'card') card_total,
       c.counted, c.note
     FROM users u LEFT JOIN cash_counts c ON c.event_id = ? AND c.controller_id = u.tg_id
     WHERE u.tg_id IN (SELECT used_by FROM tickets WHERE event_id = ? AND used_by IS NOT NULL
                       UNION SELECT controller_id FROM cash_counts WHERE event_id = ?)`,
    eventId, eventId, eventId, eventId, eventId, eventId, eventId, eventId,
  ).map((c) => ({ ...c, name: displayName(c), cash_diff: c.counted == null ? null : c.counted - c.cash_total }));

  const doorSales = all(
    `SELECT t.code, t.price, t.pay_method, t.guest_name, t.created_at, t.sold_by
     FROM tickets t WHERE t.event_id = ? AND t.tier = 'door' AND t.status = 'used' ORDER BY t.created_at`,
    eventId,
  );

  return {
    event: ev,
    online,
    door,
    totals: {
      online: online.paybysquare.total + online.monobank.total + online.manual.total,
      door: door.cash.total + door.card.total,
      cash_expected: door.cash.total,
      cash_counted: controllers.some((c) => c.counted != null) ? controllers.reduce((s, c) => s + (c.counted ?? 0), 0) : null,
    },
    entered: enteredCount(eventId),
    paid_not_entered: sum(`tier != 'door' AND status = 'paid'`).n,
    pending_approval: sum(`status = 'pending_approval'`).n,
    awaiting_payment: sum(`status = 'awaiting_payment' AND reserved_until > ?`, now()).n,
    rejected_scans: get(`SELECT COUNT(*) n FROM scans WHERE event_id = ? AND result != 'ok'`, eventId).n,
    controllers,
    door_sales: doorSales,
  };
}

export function eventCsv(eventId) {
  const rows = all(
    `SELECT t.code, t.tier, t.status, t.price, t.pay_method, t.guest_name, u.username,
            t.created_at, t.paid_at, t.used_at, t.used_by, t.sold_by
     FROM tickets t LEFT JOIN users u ON u.tg_id = t.user_id
     WHERE t.event_id = ? AND t.status IN ('paid','used') ORDER BY t.created_at`,
    eventId,
  );
  const names = new Map(all('SELECT * FROM users WHERE role != ?', 'guest').map((u) => [u.tg_id, displayName(u)]));
  const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
  const esc = (v) => (/[",\n;]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const header = ['code', 'tier', 'status', 'price_eur', 'method', 'guest', 'telegram', 'created', 'paid', 'entered', 'scanned_by', 'sold_by'];
  const lines = rows.map((r) =>
    [r.code, r.tier, r.status, (r.price / 100).toFixed(2), r.pay_method, r.guest_name, r.username ? '@' + r.username : '',
      iso(r.created_at), iso(r.paid_at), iso(r.used_at), names.get(r.used_by) ?? r.used_by ?? '', names.get(r.sold_by) ?? r.sold_by ?? '']
      .map(esc).join(','),
  );
  return '﻿' + [header.join(','), ...lines].join('\n');
}

export { db };
