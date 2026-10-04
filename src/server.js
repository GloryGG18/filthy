import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { webhookCallback } from 'grammy';
import QRCode from 'qrcode';
import { config } from './config.js';
import { get, all, run, now, tx } from './db.js';
import { authenticate, displayName } from './auth.js';
import {
  AppError, createTicket, startPayment, cancelTicket, markPaid, qrPayload, takenSeats, scan, doorSale, cancelDoorSale, DOOR_UNDO_MINUTES,
  enteredCount, eventReport, eventCsv,
} from './tickets.js';
import { submitProof, reviewProof } from './repost.js';
import { payBySquare } from './payments/paybysquare.js';
import { eurUahRate, monoInfo, monoEnabled, handleMonoWebhook, registerMonoWebhook, listMonoAccounts } from './payments/monobank.js';
import { readSettings, saveSettings, BANK_PROVIDERS, MONO_MODES } from './settings.js';
import { bot, broadcastEvent, sendCsv, tgWebhookSecret, LANGS } from './bot.js';

const UPLOADS = path.join(config.dataDir, 'uploads');
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' };

// Guest screenshots are private: served only through short-lived signed links handed to admins.
const fileSig = (name, exp) => crypto.createHmac('sha256', config.qrSecret).update(`${name}:${exp}`).digest('base64url').slice(0, 16);
const privateUrl = (name) => {
  const exp = now() + 3600_000;
  return `/files/${name}?exp=${exp}&sig=${fileSig(name, exp)}`;
};

const publicEvent = (e) => ({
  id: e.id, title: e.title, description: e.description, club: e.club, city: e.city, address: e.address,
  lineup: e.lineup, poster: e.poster ? `/posters/${e.poster}` : null, starts_at: e.starts_at,
  price_door: e.price_door, price_online: e.price_online, price_repost: e.price_repost, age_limit: e.age_limit,
  status: e.status, seats_left: e.capacity == null ? null : Math.max(0, e.capacity - takenSeats(e.id)),
});

async function ticketView(t, withQr = true) {
  const ev = get('SELECT * FROM events WHERE id = ?', t.event_id);
  const proof = t.tier === 'repost' ? get('SELECT status, created_at FROM repost_proofs WHERE ticket_id = ? ORDER BY id DESC LIMIT 1', t.id) : null;
  const valid = ['paid', 'used'].includes(t.status);
  return {
    id: t.id, code: t.code, tier: t.tier, price: t.price, status: t.status, pay_method: t.pay_method,
    reserved_until: t.reserved_until, paid_at: t.paid_at, used_at: t.used_at, created_at: t.created_at,
    uah_expected: t.uah_expected, proof, event: publicEvent(ev),
    qr: valid && withQr ? await QRCode.toString(qrPayload(t.code), { type: 'svg', margin: 1, errorCorrectionLevel: 'Q' }) : null,
  };
}

function removeUpload(name) {
  if (name) fs.rm(path.join(UPLOADS, path.basename(name)), { force: true }, () => {});
}

async function saveUpload(part, prefix) {
  const ext = IMAGE_TYPES[part.mimetype];
  if (!ext) throw new AppError('bad_file_type');
  const name = `${prefix}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  await pipeline(part.file, fs.createWriteStream(path.join(UPLOADS, name)));
  if (part.file.truncated) throw new AppError('file_too_large');
  return name;
}

const eventFields = (b) => {
  const money = (v) => (v === undefined || v === '' || v === null ? undefined : Math.round(Number(v) * 100));
  const f = {
    title: b.title, description: b.description, club: b.club, city: b.city, address: b.address, lineup: b.lineup,
    starts_at: b.starts_at ? Number(b.starts_at) : undefined,
    price_door: money(b.price_door), price_online: money(b.price_online), price_repost: money(b.price_repost),
    capacity: b.capacity === '' || b.capacity === null ? null : b.capacity === undefined ? undefined : Number(b.capacity),
    age_limit: b.age_limit === undefined ? undefined : Number(b.age_limit),
    status: ['draft', 'published', 'closed'].includes(b.status) ? b.status : undefined,
  };
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
};

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, trustProxy: true });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 2 } });
  await app.register(fastifyStatic, { root: path.resolve('public'), prefix: '/' });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code || err.message });
    req.log.error(err);
    reply.code(500).send({ error: 'server_error' });
  });

  // ----- auth hooks -----
  const auth = (roles) => async (req) => {
    req.user = authenticate(req);
    if (!req.user) throw new AppError('unauthorized', 401);
    if (roles && !roles.includes(req.user.role)) throw new AppError('forbidden', 403);
  };
  const guest = { preHandler: auth() };
  const staff = { preHandler: auth(['controller', 'admin']) };
  const admin = { preHandler: auth(['admin']) };

  const myTicket = (req) => {
    const t = get('SELECT * FROM tickets WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.tg_id);
    if (!t) throw new AppError('not_found', 404);
    return t;
  };

  // ----- files -----
  app.get('/posters/:name', (req, reply) => {
    const name = path.basename(req.params.name);
    if (!name.startsWith('poster-')) throw new AppError('not_found', 404);
    return reply.header('cache-control', 'public, max-age=86400').sendFile(name, UPLOADS);
  });
  app.get('/files/:name', (req, reply) => {
    const name = path.basename(req.params.name);
    const { exp, sig } = req.query;
    if (!sig || Number(exp) < now() || sig !== fileSig(name, Number(exp))) throw new AppError('forbidden', 403);
    return reply.sendFile(name, UPLOADS);
  });

  // ----- guest -----
  app.get('/api/me', guest, async (req) => ({
    user: { id: req.user.tg_id, name: displayName(req.user), username: req.user.username, lang: req.user.ui_lang || 'ru', lang_chosen: !!req.user.ui_lang, role: req.user.role },
    settings: {
      instagram: config.instagramHandle,
      min_followers: config.minFollowers,
      reservation_minutes: config.reservationMinutes,
      methods: { paybysquare: !!config.payBySquare.iban, monobank: monoEnabled() },
      mono_mode: config.monobank.mode,
    },
  }));

  app.put('/api/me/lang', guest, async (req) => {
    const lang = req.body?.lang;
    if (!LANGS.includes(lang)) throw new AppError('bad_lang');
    run('UPDATE users SET ui_lang = ? WHERE tg_id = ?', lang, req.user.tg_id);
    return { lang };
  });

  app.get('/api/events', guest, async () =>
    all(`SELECT * FROM events WHERE status = 'published' AND starts_at > ? ORDER BY starts_at`, now() - 12 * 3600_000).map(publicEvent));

  app.get('/api/events/:id', guest, async (req) => {
    const e = get(`SELECT * FROM events WHERE id = ? AND status != 'draft'`, Number(req.params.id));
    if (!e) throw new AppError('not_found', 404);
    return publicEvent(e);
  });

  app.get('/api/tickets', guest, async (req) => {
    const rows = all(
      `SELECT t.* FROM tickets t JOIN events e ON e.id = t.event_id
       WHERE t.user_id = ? AND t.status NOT IN ('cancelled') ORDER BY e.starts_at DESC, t.id DESC`,
      req.user.tg_id,
    );
    return Promise.all(rows.map((t) => ticketView(t, false)));
  });

  app.get('/api/tickets/:id', guest, async (req) => ticketView(myTicket(req)));

  app.post('/api/tickets', guest, async (req) => ticketView(createTicket(req.user, Number(req.body?.event_id), req.body?.tier)));

  app.post('/api/tickets/:id/cancel', guest, async (req) => {
    cancelTicket(myTicket(req));
    return { ok: true };
  });

  // Two screenshots (story with the tag, profile with follower count) + Instagram handle.
  app.post('/api/tickets/:id/proofs', guest, async (req) => {
    const ticket = myTicket(req);
    const files = {};
    let instagram = null;
    for await (const part of req.parts()) {
      if (part.type === 'file' && ['story', 'profile'].includes(part.fieldname)) files[part.fieldname] = await saveUpload(part, part.fieldname);
      else if (part.type === 'file') part.file.resume();
      else if (part.fieldname === 'instagram') instagram = String(part.value).slice(0, 64);
    }
    if (!files.story || !files.profile) throw new AppError('screenshots_required');
    submitProof(ticket, { storyFile: files.story, profileFile: files.profile, instagram });
    return ticketView(get('SELECT * FROM tickets WHERE id = ?', ticket.id));
  });

  app.post('/api/tickets/:id/pay', guest, async (req) => {
    const method = req.body?.method;
    if (!['paybysquare', 'monobank'].includes(method)) throw new AppError('bad_method');
    let ticket = myTicket(req);
    const rate = method === 'monobank' ? await eurUahRate() : null;
    ticket = startPayment(ticket, method, rate);
    const ev = get('SELECT title FROM events WHERE id = ?', ticket.event_id);
    return {
      ticket: await ticketView(ticket),
      paybysquare: method === 'paybysquare' ? await payBySquare(ticket, ev.title) : null,
      monobank: method === 'monobank' ? monoInfo(ticket, rate) : null,
    };
  });

  // ----- door staff -----
  app.get('/api/door/events', staff, async () =>
    all(`SELECT * FROM events WHERE status != 'draft' AND starts_at BETWEEN ? AND ? ORDER BY starts_at`,
      now() - 36 * 3600_000, now() + 7 * 24 * 3600_000).map((e) => ({ ...publicEvent(e), entered: enteredCount(e.id) })));

  app.post('/api/door/scan', staff, async (req) => scan(req.user, Number(req.body?.event_id), req.body?.text));

  app.post('/api/door/sale', staff, async (req) => doorSale(req.user, Number(req.body?.event_id), req.body || {}));
  app.post('/api/door/sale/cancel', staff, async (req) => cancelDoorSale(req.user, req.body?.codes));

  app.get('/api/door/stats', staff, async (req) => {
    const id = Number(req.query.event_id);
    const mine = all(
      `SELECT pay_method, COUNT(*) n, SUM(price) total FROM tickets WHERE event_id = ? AND sold_by = ? AND tier = 'door' AND status = 'used' GROUP BY pay_method`,
      id, req.user.tg_id,
    );
    // One row per sale (a group sale shares its timestamp), still within the undo window.
    const recent = all(
      `SELECT created_at, pay_method, COUNT(*) n, SUM(price) total, GROUP_CONCAT(code) codes, MAX(guest_name) guest_name
       FROM tickets WHERE event_id = ? AND sold_by = ? AND tier = 'door' AND status = 'used' AND created_at > ?
       GROUP BY created_at, pay_method ORDER BY created_at DESC LIMIT 5`,
      id, req.user.tg_id, now() - DOOR_UNDO_MINUTES * 60_000,
    ).map((r) => ({ ...r, codes: r.codes.split(',') }));
    return {
      entered: enteredCount(id),
      expected: get(`SELECT COUNT(*) n FROM tickets WHERE event_id = ? AND status IN ('paid','used') AND tier != 'door'`, id).n,
      my_sales: Object.fromEntries(mine.map((r) => [r.pay_method, { n: r.n, total: r.total }])),
      recent_sales: recent,
      my_scans: get(`SELECT COUNT(*) n FROM scans WHERE event_id = ? AND controller_id = ? AND result = 'ok'`, id, req.user.tg_id).n,
    };
  });

  // ----- admin -----
  app.get('/api/admin/events', admin, async () =>
    all('SELECT * FROM events ORDER BY starts_at DESC').map((e) => ({ ...publicEvent(e), capacity: e.capacity, entered: enteredCount(e.id) })));

  app.post('/api/admin/events', admin, async (req) => {
    const f = eventFields(req.body || {});
    if (!f.title || !f.starts_at) throw new AppError('title_and_date_required');
    const { lastInsertRowid } = run(
      `INSERT INTO events (title, description, club, city, address, lineup, starts_at, price_door, price_online, price_repost, capacity, age_limit, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      f.title, f.description ?? '', f.club ?? '', f.city ?? '', f.address ?? '', f.lineup ?? '', f.starts_at,
      f.price_door ?? config.prices.door, f.price_online ?? config.prices.online, f.price_repost ?? config.prices.repost,
      f.capacity ?? null, f.age_limit ?? 18, f.status ?? 'draft', now(),
    );
    return publicEvent(get('SELECT * FROM events WHERE id = ?', lastInsertRowid));
  });

  app.put('/api/admin/events/:id', admin, async (req) => {
    const id = Number(req.params.id);
    if (!get('SELECT 1 FROM events WHERE id = ?', id)) throw new AppError('not_found', 404);
    const f = eventFields(req.body || {});
    const keys = Object.keys(f);
    if (keys.length) run(`UPDATE events SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => f[k]), id);
    const e = get('SELECT * FROM events WHERE id = ?', id);
    return { ...publicEvent(e), capacity: e.capacity };
  });

  app.post('/api/admin/events/:id/poster', admin, async (req) => {
    const part = await req.file();
    if (!part) throw new AppError('file_required');
    const name = await saveUpload(part, 'poster');
    const old = get('SELECT poster FROM events WHERE id = ?', Number(req.params.id))?.poster;
    run('UPDATE events SET poster = ? WHERE id = ?', name, Number(req.params.id));
    removeUpload(old);
    return { poster: `/posters/${name}` };
  });

  app.delete('/api/admin/events/:id/poster', admin, async (req) => {
    const e = get('SELECT poster FROM events WHERE id = ?', Number(req.params.id));
    if (!e) throw new AppError('not_found', 404);
    run('UPDATE events SET poster = NULL WHERE id = ?', Number(req.params.id));
    removeUpload(e.poster);
    return { ok: true };
  });

  // Only events nobody has paid for can be deleted; otherwise money and the cash report would lose their event.
  app.delete('/api/admin/events/:id', admin, async (req) => {
    const id = Number(req.params.id);
    const e = get('SELECT * FROM events WHERE id = ?', id);
    if (!e) throw new AppError('not_found', 404);
    const money = get(
      `SELECT COUNT(*) AS n FROM tickets t WHERE t.event_id = ?
         AND (t.status IN ('paid', 'used') OR EXISTS (SELECT 1 FROM payments p WHERE p.ticket_id = t.id))`, id).n;
    if (money) throw new AppError('event_has_sales', 409);
    const proofs = all('SELECT p.story_file, p.profile_file FROM repost_proofs p JOIN tickets t ON t.id = p.ticket_id WHERE t.event_id = ?', id);
    tx(() => {
      run('DELETE FROM repost_proofs WHERE ticket_id IN (SELECT id FROM tickets WHERE event_id = ?)', id);
      run('DELETE FROM scans WHERE event_id = ?', id);
      run('DELETE FROM cash_counts WHERE event_id = ?', id);
      run('DELETE FROM tickets WHERE event_id = ?', id);
      run('DELETE FROM events WHERE id = ?', id);
    });
    for (const f of [e.poster, ...proofs.flatMap((p) => [p.story_file, p.profile_file])]) removeUpload(f);
    return { ok: true };
  });

  app.post('/api/admin/events/:id/broadcast', admin, async (req) => {
    const id = Number(req.params.id);
    if (get('SELECT status FROM events WHERE id = ?', id)?.status !== 'published') throw new AppError('publish_first');
    const total = get('SELECT COUNT(*) n FROM users WHERE bot_started = 1').n;
    broadcastEvent(id, req.body?.text || '').then((r) => req.log.info({ broadcast: r }, 'broadcast done'));
    return { queued: total };
  });

  app.get('/api/admin/events/:id/report', admin, async (req) => eventReport(Number(req.params.id)));

  app.post('/api/admin/events/:id/cash', admin, async (req) => {
    const { controller_id, counted, note } = req.body || {};
    run(
      `INSERT INTO cash_counts (event_id, controller_id, counted, note, counted_by, counted_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id, controller_id) DO UPDATE SET counted = excluded.counted, note = excluded.note,
         counted_by = excluded.counted_by, counted_at = excluded.counted_at`,
      Number(req.params.id), Number(controller_id), Math.round(Number(counted) * 100), note || null, req.user.tg_id, now(),
    );
    return eventReport(Number(req.params.id));
  });

  // In Telegram the CSV is sent to the admin as a bot message; ?download=1 returns it directly (browser/dev).
  app.post('/api/admin/events/:id/csv', admin, async (req, reply) => {
    const id = Number(req.params.id);
    if (req.query.download || !bot) {
      return reply.header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="filthy-event-${id}.csv"`).send(eventCsv(id));
    }
    await sendCsv(req.user.tg_id, id);
    return { sent: true };
  });

  app.get('/api/admin/approvals', admin, async () =>
    all(
      `SELECT p.*, t.code, t.price, t.event_id, t.user_id, e.title event_title, u.username, u.first_name, u.last_name
       FROM repost_proofs p JOIN tickets t ON t.id = p.ticket_id JOIN events e ON e.id = t.event_id
       LEFT JOIN users u ON u.tg_id = t.user_id
       WHERE p.status = 'pending' ORDER BY p.created_at`,
    ).map((p) => ({ ...p, guest: displayName(p), story_url: privateUrl(p.story_file), profile_url: privateUrl(p.profile_file) })));

  app.post('/api/admin/approvals/:id', admin, async (req) => {
    const r = reviewProof(Number(req.params.id), req.user.tg_id, !!req.body?.approve);
    return { ok: !!r, already_reviewed: !r };
  });

  app.get('/api/admin/payments', admin, async () =>
    all(
      `SELECT p.id, p.source, p.amount, p.currency, p.reference, p.payer, p.status, p.received_at, t.code ticket_code, t.price ticket_price, t.status ticket_status, t.uah_expected
       FROM payments p LEFT JOIN tickets t ON t.id = p.ticket_id
       WHERE p.status IN ('unmatched','underpaid') ORDER BY p.received_at DESC LIMIT 200`,
    ));

  // Admin decides what an odd payment was: activate a ticket with it, or just mark it handled (refunded etc).
  app.post('/api/admin/payments/:id/resolve', admin, async (req) => {
    const p = get('SELECT * FROM payments WHERE id = ?', Number(req.params.id));
    if (!p) throw new AppError('not_found', 404);
    let activated = false;
    if (req.body?.ticket_code) {
      const t = get('SELECT * FROM tickets WHERE code = ?', String(req.body.ticket_code));
      if (!t) throw new AppError('ticket_not_found', 404);
      activated = markPaid(t.id, p.source === 'monobank' ? 'monobank' : 'paybysquare', p.received_at);
      run('UPDATE payments SET ticket_id = ? WHERE id = ?', t.id, p.id);
    }
    run(`UPDATE payments SET status = 'resolved' WHERE id = ?`, p.id);
    return { ok: true, activated };
  });

  // For a transfer the bank feed hasn't picked up (or before the bank API is connected).
  app.post('/api/admin/tickets/:code/mark-paid', admin, async (req) => {
    const t = get('SELECT * FROM tickets WHERE code = ?', req.params.code);
    if (!t) throw new AppError('not_found', 404);
    const ok = markPaid(t.id, 'manual');
    if (ok) {
      run(
        `INSERT INTO payments (source, external_id, amount, currency, reference, payer, ticket_id, status, received_at)
         VALUES ('manual', ?, ?, 'EUR', ?, ?, ?, 'resolved', ?)`,
        `manual-${t.id}-${now()}`, t.price, t.code, displayName(req.user), t.id, now(),
      );
    }
    return { ok, status: get('SELECT status FROM tickets WHERE id = ?', t.id).status };
  });

  app.get('/api/admin/tickets', admin, async (req) => {
    const q = String(req.query.q || '').trim();
    if (!q) return [];
    return all(
      `SELECT t.id, t.code, t.tier, t.status, t.price, t.pay_method, t.guest_name, u.username, e.title event_title
       FROM tickets t JOIN events e ON e.id = t.event_id LEFT JOIN users u ON u.tg_id = t.user_id
       WHERE t.code LIKE ? OR u.username LIKE ? OR t.guest_name LIKE ? ORDER BY t.id DESC LIMIT 30`,
      `${q}%`, `%${q.replace(/^@/, '')}%`, `%${q}%`,
    );
  });

  app.get('/api/admin/staff', admin, async () =>
    all(`SELECT tg_id, username, first_name, last_name, role FROM users WHERE role != 'guest' ORDER BY role, first_name`)
      .map((u) => ({ ...u, name: displayName(u) })));

  // Staff are found by @username or numeric Telegram ID; they must have opened the bot once.
  app.post('/api/admin/staff', admin, async (req) => {
    const who = String(req.body?.user || '').trim().replace(/^@/, '');
    const role = req.body?.role;
    if (!['guest', 'controller', 'admin'].includes(role)) throw new AppError('bad_role');
    const u = /^\d+$/.test(who) ? get('SELECT * FROM users WHERE tg_id = ?', Number(who)) : get('SELECT * FROM users WHERE lower(username) = lower(?)', who);
    if (!u) throw new AppError('user_not_found', 404);
    if (u.tg_id === req.user.tg_id && role !== 'admin') throw new AppError('cannot_demote_self');
    run('UPDATE users SET role = ? WHERE tg_id = ?', role, u.tg_id);
    return { ok: true };
  });

  // ----- payment settings (override .env, applied without restart) -----
  app.get('/api/admin/settings', admin, async () => ({ values: readSettings(), bank_providers: BANK_PROVIDERS, mono_modes: MONO_MODES }));

  app.put('/api/admin/settings', admin, async (req) => {
    const changed = saveSettings(req.body?.values || {}, req.user.tg_id, req.body?.clear || []);
    req.log.info({ admin: req.user.tg_id, changed }, 'payment settings changed');
    if (changed.includes('mono_token') && config.monobank.token && config.publicUrl.startsWith('https://')) {
      await registerMonoWebhook(`${config.publicUrl}/hooks/monobank/${config.monobank.webhookSecret}`).catch((e) => req.log.warn(e.message));
    }
    return { values: readSettings(), changed };
  });

  app.get('/api/admin/settings/mono-jars', admin, async () => {
    try {
      return await listMonoAccounts();
    } catch (e) {
      throw new AppError('monobank_unreachable', 502);
    }
  });

  // ----- webhooks -----
  app.get('/hooks/monobank/:secret', async () => ({ ok: true })); // monobank checks the URL with a GET first
  app.post('/hooks/monobank/:secret', async (req) => {
    if (req.params.secret !== config.monobank.webhookSecret) throw new AppError('forbidden', 403);
    handleMonoWebhook(req.body);
    return { ok: true };
  });

  if (bot) app.post('/hooks/telegram', webhookCallback(bot, 'fastify', { secretToken: tgWebhookSecret }));

  // Dev only: pretend a bank transfer or monobank payment arrived.
  if (config.devAuth) {
    const { recordPayment } = await import('./tickets.js');
    app.post('/api/dev/payment', async (req) => recordPayment({ externalId: `dev-${now()}-${Math.random()}`, ...req.body }));
  }

  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
