import crypto from 'node:crypto';
import { config } from './config.js';
import { get, all, run, tx, now } from './db.js';
import { AppError, bus, markPaid } from './tickets.js';
import { displayName } from './auth.js';

// Promoter programme: a guest applies, an admin approves, the promoter shares a personal bot link and
// earns config.promoter.reward for every new person who buys a ticket through it. The balance can pay
// for their own tickets or be withdrawn on request.

export const balanceOf = (userId) => get('SELECT COALESCE(SUM(amount), 0) b FROM promoter_ledger WHERE promoter_id = ?', userId).b;
const ledger = (promoterId, amount, kind, extra = {}) =>
  run(
    `INSERT OR IGNORE INTO promoter_ledger (promoter_id, amount, kind, referred_id, ticket_id, payout_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    promoterId, amount, kind, extra.referred ?? null, extra.ticket ?? null, extra.payout ?? null, now(),
  );
const user = (id) => get('SELECT * FROM users WHERE tg_id = ?', id);

export function applyPromoter(u, { instagram, note } = {}) {
  if (u.promoter_status === 'approved') throw new AppError('already_promoter');
  if (u.promoter_status === 'pending') throw new AppError('already_applied');
  const text = [instagram && `Instagram: ${String(instagram).trim().slice(0, 60)}`, note && String(note).trim().slice(0, 500)].filter(Boolean).join('\n');
  run(`UPDATE users SET promoter_status = 'pending', promoter_note = ? WHERE tg_id = ?`, text || null, u.tg_id);
  bus.emit('promoter_applied', user(u.tg_id));
  return { status: 'pending' };
}

const newRefCode = () => {
  for (;;) {
    const code = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, '').slice(0, 6).toLowerCase();
    if (code.length === 6 && !get('SELECT 1 FROM users WHERE ref_code = ?', code)) return code;
  }
};

// Approving keeps an earlier code, so links already shared start working again after a re-approval.
export function reviewPromoter(userId, approve) {
  const u = user(userId);
  if (!u || !u.promoter_status) throw new AppError('not_found', 404);
  const status = approve ? 'approved' : 'rejected';
  if (u.promoter_status === status) return u;
  run('UPDATE users SET promoter_status = ?, ref_code = COALESCE(ref_code, ?) WHERE tg_id = ?', status, approve ? newRefCode() : null, userId);
  const updated = user(userId);
  bus.emit('promoter_reviewed', updated, approve);
  return updated;
}

// Links a guest to the promoter whose link they opened. Only people new to Filthy count: no referrer yet
// and no ticket bought before. A promoter can't invite themselves.
export function attachReferral(u, code) {
  if (!u || !code || u.referred_by) return false;
  const promoter = get(`SELECT * FROM users WHERE ref_code = ? AND promoter_status = 'approved'`, String(code).toLowerCase());
  if (!promoter || promoter.tg_id === u.tg_id) return false;
  if (get(`SELECT 1 FROM tickets WHERE user_id = ? AND status IN ('paid', 'used')`, u.tg_id)) return false;
  run('UPDATE users SET referred_by = ? WHERE tg_id = ? AND referred_by IS NULL', promoter.tg_id, u.tg_id);
  return true;
}

// First paid ticket of an invited guest earns the promoter the reward (once per guest, enforced by an index).
bus.on('ticket_paid', (ticket) => {
  if (!ticket.user_id) return;
  const guest = user(ticket.user_id);
  if (!guest?.referred_by) return;
  const promoter = user(guest.referred_by);
  if (promoter?.promoter_status !== 'approved') return;
  const r = ledger(promoter.tg_id, config.promoter.reward, 'referral', { referred: guest.tg_id, ticket: ticket.id });
  if (r.changes) bus.emit('promoter_credited', promoter, guest, balanceOf(promoter.tg_id));
});

// Spends the promoter's balance on one of their unpaid tickets; a fully covered ticket is paid at once.
export function useBalance(u, ticket) {
  if (!['approved', 'awaiting_payment', 'expired'].includes(ticket.status)) throw new AppError('not_payable');
  if (ticket.discount > 0) throw new AppError('balance_used');
  return tx(() => {
    const amount = Math.min(balanceOf(u.tg_id), ticket.price);
    if (amount <= 0) throw new AppError('no_balance');
    ledger(u.tg_id, -amount, 'discount', { ticket: ticket.id });
    // The UAH amount was fixed for the old price; clear it so the next payment screen recalculates.
    run('UPDATE tickets SET price = price - ?, discount = ?, uah_expected = NULL WHERE id = ?', amount, amount, ticket.id);
    if (amount === ticket.price) markPaid(ticket.id, 'balance');
    return { used: amount, balance: balanceOf(u.tg_id), ticket: get('SELECT * FROM tickets WHERE id = ?', ticket.id) };
  });
}

export function requestPayout(u, { amount, details } = {}) {
  if (u.promoter_status !== 'approved') throw new AppError('forbidden', 403);
  const cents = Math.round(Number(String(amount).replace(',', '.')) * 100);
  const text = String(details || '').trim().slice(0, 200);
  if (!text) throw new AppError('payout_details');
  if (!Number.isFinite(cents) || cents < config.promoter.minPayout) throw new AppError('payout_min');
  return tx(() => {
    if (cents > balanceOf(u.tg_id)) throw new AppError('no_balance');
    const { lastInsertRowid } = run('INSERT INTO payouts (promoter_id, amount, details, created_at) VALUES (?, ?, ?, ?)', u.tg_id, cents, text, now());
    ledger(u.tg_id, -cents, 'payout', { payout: Number(lastInsertRowid) });
    const payout = get('SELECT * FROM payouts WHERE id = ?', lastInsertRowid);
    bus.emit('payout_requested', payout, user(u.tg_id));
    return payout;
  });
}

// Paid: the admin has sent the money. Rejected: the reserved amount returns to the balance.
export function handlePayout(adminId, id, paid) {
  return tx(() => {
    const p = get('SELECT * FROM payouts WHERE id = ?', id);
    if (!p) throw new AppError('not_found', 404);
    if (p.status !== 'pending') throw new AppError('already_handled');
    run('UPDATE payouts SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?', paid ? 'paid' : 'rejected', adminId, now(), id);
    if (!paid) ledger(p.promoter_id, p.amount, 'payout_reverted', { payout: p.id });
    const done = get('SELECT * FROM payouts WHERE id = ?', id);
    bus.emit('payout_handled', done, user(p.promoter_id));
    return done;
  });
}

const stats = (id) => ({
  invited: get('SELECT COUNT(*) n FROM users WHERE referred_by = ?', id).n,
  buyers: get(`SELECT COUNT(*) n FROM promoter_ledger WHERE promoter_id = ? AND kind = 'referral'`, id).n,
  earned: get(`SELECT COALESCE(SUM(amount), 0) s FROM promoter_ledger WHERE promoter_id = ? AND kind = 'referral'`, id).s,
  balance: balanceOf(id),
});

export function promoterView(u, link) {
  return {
    status: u.promoter_status || null,
    reward: config.promoter.reward,
    min_payout: config.promoter.minPayout,
    ...(u.promoter_status === 'approved' ? {
      link: link(u.ref_code),
      code: u.ref_code,
      ...stats(u.tg_id),
      payouts: all('SELECT id, amount, details, status, created_at FROM payouts WHERE promoter_id = ? ORDER BY id DESC LIMIT 20', u.tg_id),
    } : { balance: balanceOf(u.tg_id) }),
  };
}

export function adminPromoters() {
  const row = (u) => ({ id: u.tg_id, name: displayName(u), username: u.username, note: u.promoter_note, ref_code: u.ref_code, status: u.promoter_status, ...stats(u.tg_id) });
  return {
    applications: all(`SELECT * FROM users WHERE promoter_status = 'pending' ORDER BY tg_id`).map(row),
    promoters: all(`SELECT * FROM users WHERE promoter_status = 'approved'`).map(row).sort((a, b) => b.buyers - a.buyers),
    payouts: all(`SELECT p.*, u.username, u.first_name, u.last_name FROM payouts p JOIN users u ON u.tg_id = p.promoter_id
                  WHERE p.status = 'pending' ORDER BY p.id`).map((p) => ({ ...p, name: displayName(p) })),
  };
}
