// End-to-end flow against an in-memory app: node --test test/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filthy-'));
Object.assign(process.env, {
  DATA_DIR: dir, DEV_AUTH: '1', ADMIN_IDS: '1', BOT_TOKEN: '', LOG_LEVEL: 'silent',
  PBS_IBAN: 'SK9611000000002918599669', PBS_BENEFICIARY: 'Filthy s.r.o.',
  MONO_JAR_URL: 'https://send.monobank.ua/jar/TEST', MONO_FALLBACK_RATE: '45', MONO_WEBHOOK_SECRET: 'hook',
});

const { buildServer } = await import('../src/server.js');
const { qrPayload, expireReservations } = await import('../src/tickets.js');
const { verifyInitData } = await import('../src/auth.js');
const { run } = await import('../src/db.js');

let app;
const call = async (user, method, url, body) => {
  const res = await app.inject({ method, url, headers: user ? { 'x-dev-user': String(user) } : {}, payload: body });
  return { status: res.statusCode, body: res.headers['content-type']?.includes('json') ? res.json() : res.body };
};
const ADMIN = 1, GUEST = 2, REPOSTER = 3, DOOR = 4;
let event;

before(async () => {
  app = await buildServer();
});

test('telegram initData signature is verified', () => {
  const token = '123:ABC';
  const user = JSON.stringify({ id: 42, first_name: 'Ann' });
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user, query_id: 'q' });
  const check = [...params.entries()].sort().map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  assert.equal(verifyInitData(params.toString(), token).id, 42);
  params.set('user', JSON.stringify({ id: 43 }));
  assert.equal(verifyInitData(params.toString(), token), null);
});

test('admin creates and publishes an event; guests cannot', async () => {
  assert.equal((await call(GUEST, 'POST', '/api/admin/events', { title: 'x', starts_at: Date.now() })).status, 403);
  const r = await call(ADMIN, 'POST', '/api/admin/events', {
    title: 'Filthy Halloween', club: 'Fuga', city: 'Bratislava', starts_at: Date.now() + 3 * 86400_000,
    price_online: 10, price_repost: 8, price_door: 12, status: 'published',
  });
  assert.equal(r.status, 200);
  event = r.body;
  assert.equal(event.price_online, 1000);
  const list = await call(GUEST, 'GET', '/api/events');
  assert.equal(list.body.length, 1);
});

let online;
test('online ticket: reserve, PAY by square QR, bank transfer activates it', async () => {
  online = (await call(GUEST, 'POST', '/api/tickets', { event_id: event.id, tier: 'online' })).body;
  assert.equal(online.status, 'awaiting_payment');
  assert.match(online.code, /^\d{8}$/);
  const again = (await call(GUEST, 'POST', '/api/tickets', { event_id: event.id, tier: 'online' })).body;
  assert.equal(again.id, online.id, 'unfinished purchase is resumed, not duplicated');

  const pay = (await call(GUEST, 'POST', `/api/tickets/${online.id}/pay`, { method: 'paybysquare' })).body;
  assert.match(pay.paybysquare.svg, /^<svg/);
  assert.equal(pay.paybysquare.variable_symbol, online.code);
  assert.equal(pay.ticket.qr, null, 'no QR before payment');

  // Someone else can't see the ticket.
  assert.equal((await call(REPOSTER, 'GET', `/api/tickets/${online.id}`)).status, 404);

  await call(null, 'POST', '/api/dev/payment', { source: 'fio', amount: 1000, currency: 'EUR', reference: online.code, payer: 'Ivan' });
  const paid = (await call(GUEST, 'GET', `/api/tickets/${online.id}`)).body;
  assert.equal(paid.status, 'paid');
  assert.equal(paid.pay_method, 'paybysquare');
  assert.match(paid.qr, /^<svg/);
});

let repost;
test('repost ticket: screenshots, admin approval, monobank payment in UAH', async () => {
  repost = (await call(REPOSTER, 'POST', '/api/tickets', { event_id: event.id, tier: 'repost' })).body;
  assert.equal(repost.status, 'pending_approval');
  assert.equal(repost.price, 800);
  assert.equal((await call(REPOSTER, 'POST', `/api/tickets/${repost.id}/pay`, { method: 'monobank' })).status, 400, 'cannot pay before approval');

  const boundary = 'XBOUNDARY';
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const part = (name, file) =>
    Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file ? `; filename="${name}.png"\r\nContent-Type: image/png` : ''}\r\n\r\n`), file || Buffer.from('@ann_ig'), Buffer.from('\r\n')]);
  const payload = Buffer.concat([part('instagram'), part('story', png), part('profile', png), Buffer.from(`--${boundary}--\r\n`)]);
  const up = await app.inject({
    method: 'POST', url: `/api/tickets/${repost.id}/proofs`, payload,
    headers: { 'x-dev-user': String(REPOSTER), 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(up.statusCode, 200, up.body);
  assert.equal(up.json().proof.status, 'pending');

  const queue = (await call(ADMIN, 'GET', '/api/admin/approvals')).body;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].instagram, '@ann_ig');
  const img = await app.inject({ method: 'GET', url: queue[0].story_url });
  assert.equal(img.statusCode, 200, 'signed link serves the screenshot');
  assert.equal((await app.inject({ method: 'GET', url: queue[0].story_url.replace(/sig=[^&]+/, 'sig=bad') })).statusCode, 403);

  await call(ADMIN, 'POST', `/api/admin/approvals/${queue[0].id}`, { approve: true });
  assert.equal((await call(REPOSTER, 'GET', `/api/tickets/${repost.id}`)).body.status, 'approved');

  const pay = (await call(REPOSTER, 'POST', `/api/tickets/${repost.id}/pay`, { method: 'monobank' })).body;
  assert.equal(pay.monobank.comment, repost.code);
  const expected = pay.monobank.uah;
  assert.ok(expected >= 8 * 40 * 100, `UAH amount looks wrong: ${expected}`);

  const hook = await call(null, 'POST', '/hooks/monobank/hook', {
    type: 'StatementItem',
    data: { account: 'jar', statementItem: { id: 'mono-1', time: Math.floor(Date.now() / 1000), amount: expected, comment: `квиток ${repost.code}`, description: 'Від: Анна' } },
  });
  assert.equal(hook.status, 200);
  assert.equal((await call(REPOSTER, 'GET', `/api/tickets/${repost.id}`)).body.status, 'paid');
  assert.equal((await call(null, 'POST', '/hooks/monobank/wrong', {})).status, 403);
});

test('underpaid and unknown transfers go to manual review; admin can attach them', async () => {
  const t = (await call(5, 'POST', '/api/tickets', { event_id: event.id, tier: 'online' })).body;
  await call(null, 'POST', '/api/dev/payment', { source: 'fio', amount: 800, currency: 'EUR', reference: t.code });
  await call(null, 'POST', '/api/dev/payment', { source: 'fio', amount: 1000, currency: 'EUR', reference: 'for party' });
  const review = (await call(ADMIN, 'GET', '/api/admin/payments')).body;
  assert.deepEqual(review.map((p) => p.status).sort(), ['underpaid', 'unmatched']);
  assert.equal((await call(5, 'GET', `/api/tickets/${t.id}`)).body.status, 'awaiting_payment');
  const unknown = review.find((p) => p.status === 'unmatched');
  const r = (await call(ADMIN, 'POST', `/api/admin/payments/${unknown.id}/resolve`, { ticket_code: t.code })).body;
  assert.equal(r.activated, true);
  assert.equal((await call(5, 'GET', `/api/tickets/${t.id}`)).body.status, 'paid');
});

test('door: controller role, scan results, door sales', async () => {
  await call(DOOR, 'GET', '/api/me');
  assert.equal((await call(DOOR, 'POST', '/api/door/scan', { event_id: event.id, text: 'x' })).status, 403);
  await call(ADMIN, 'POST', '/api/admin/staff', { user: '@dev4', role: 'controller' });

  const ok = (await call(DOOR, 'POST', '/api/door/scan', { event_id: event.id, text: qrPayload(online.code) })).body;
  assert.equal(ok.result, 'ok');
  assert.equal(ok.entered, 1);
  const twice = (await call(DOOR, 'POST', '/api/door/scan', { event_id: event.id, text: qrPayload(online.code) })).body;
  assert.equal(twice.result, 'used');
  assert.ok(twice.used_at);
  const forged = (await call(DOOR, 'POST', '/api/door/scan', { event_id: event.id, text: `FLT:${repost.code}:AAAAAAAAAAAA` })).body;
  assert.equal(forged.result, 'invalid');
  const manual = (await call(DOOR, 'POST', '/api/door/scan', { event_id: event.id, text: repost.code })).body;
  assert.equal(manual.result, 'ok', 'controller can type the code');

  const unpaid = (await call(6, 'POST', '/api/tickets', { event_id: event.id, tier: 'online' })).body;
  assert.equal((await call(DOOR, 'POST', '/api/door/scan', { event_id: event.id, text: qrPayload(unpaid.code) })).body.result, 'unpaid');

  await call(DOOR, 'POST', '/api/door/sale', { event_id: event.id, method: 'cash', amount: 12 });
  await call(DOOR, 'POST', '/api/door/sale', { event_id: event.id, method: 'cash', amount: 12, name: 'Oleh' });
  await call(DOOR, 'POST', '/api/door/sale', { event_id: event.id, method: 'card', amount: 12 });
  const stats = (await call(DOOR, 'GET', `/api/door/stats?event_id=${event.id}`)).body;
  assert.equal(stats.entered, 5);
  assert.equal(stats.my_sales.cash.total, 2400);
});

test('cash report shows totals per controller and the counted-cash difference', async () => {
  const r = (await call(ADMIN, 'POST', `/api/admin/events/${event.id}/cash`, { controller_id: DOOR, counted: 22 })).body;
  assert.equal(r.online.paybysquare.total, 2000);
  assert.equal(r.online.monobank.total, 800);
  assert.equal(r.online.repost.n, 1);
  assert.equal(r.door.cash.total, 2400);
  assert.equal(r.door.card.total, 1200);
  assert.equal(r.entered, 5);
  assert.equal(r.paid_not_entered, 1);
  const c = r.controllers.find((x) => x.tg_id === DOOR);
  assert.equal(c.scanned_in, 2);
  assert.equal(c.cash_diff, -200);
  const csv = await app.inject({ method: 'POST', url: `/api/admin/events/${event.id}/csv?download=1`, headers: { 'x-dev-user': '1' } });
  assert.equal(csv.body.trim().split('\n').length, 1 + 6);
});

test('capacity and reservation expiry', async () => {
  const small = (await call(ADMIN, 'POST', '/api/admin/events', { title: 'Small', starts_at: Date.now() + 86400_000, capacity: 1, status: 'published' })).body;
  const a = (await call(7, 'POST', '/api/tickets', { event_id: small.id, tier: 'online' })).body;
  assert.equal((await call(8, 'POST', '/api/tickets', { event_id: small.id, tier: 'online' })).body.error, 'sold_out');
  run('UPDATE tickets SET reserved_until = ? WHERE id = ?', Date.now() - 1, a.id);
  expireReservations();
  assert.equal((await call(7, 'GET', `/api/tickets/${a.id}`)).body.status, 'expired');
  const b = (await call(8, 'POST', '/api/tickets', { event_id: small.id, tier: 'online' })).body;
  assert.equal(b.status, 'awaiting_payment', 'seat freed after expiry');
  // A late transfer for the expired ticket is still honoured rather than lost.
  await call(null, 'POST', '/api/dev/payment', { source: 'fio', amount: 1000, currency: 'EUR', reference: a.code });
  assert.equal((await call(7, 'GET', `/api/tickets/${a.id}`)).body.status, 'paid');
});

test('admin changes payment settings at runtime; secrets stay hidden', async () => {
  assert.equal((await call(GUEST, 'GET', '/api/admin/settings')).status, 403);
  const bad = await call(ADMIN, 'PUT', '/api/admin/settings', { values: { pbs_iban: 'nope' } });
  assert.equal(bad.body.error, 'bad_iban');
  const r = (await call(ADMIN, 'PUT', '/api/admin/settings', {
    values: { pbs_iban: 'SK3112000000198742637541', pbs_beneficiary: 'Filthy Club', fio_token: 'secret-token-123456', bank_provider: 'fio' },
  })).body;
  assert.equal(r.values.pbs_iban, 'SK3112000000198742637541');
  assert.equal(r.values.fio_token.set, true);
  assert.ok(!JSON.stringify(r).includes('secret-token-123456'), 'secret never returned');
  // Empty secret keeps the saved value; the new IBAN is used for the next payment QR right away.
  await call(ADMIN, 'PUT', '/api/admin/settings', { values: { fio_token: '' } });
  assert.equal((await call(ADMIN, 'GET', '/api/admin/settings')).body.values.fio_token.set, true);
  const t = (await call(9, 'POST', '/api/tickets', { event_id: event.id, tier: 'online' })).body;
  const pay = (await call(9, 'POST', `/api/tickets/${t.id}/pay`, { method: 'paybysquare' })).body;
  assert.equal(pay.paybysquare.iban, 'SK3112000000198742637541');
  assert.equal(pay.paybysquare.beneficiary, 'Filthy Club');
  await call(ADMIN, 'PUT', '/api/admin/settings', { values: { bank_provider: 'none' }, clear: ['fio_token'] });
  assert.equal((await call(ADMIN, 'GET', '/api/admin/settings')).body.values.fio_token.set, false);
});

test('placeholders from .env.example are ignored and a QR secret is generated once', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'filthy-cfg-'));
  const read = () => execFileSync(process.execPath, ['--no-warnings', '-e',
    "import('./src/config.js').then(({config:c})=>console.log(JSON.stringify([c.publicUrl,c.botToken,c.adminIds,c.qrSecret,c.dataDir])))"],
  { env: { PATH: process.env.PATH, PUBLIC_URL: 'https://tickets.example.sk', RAILWAY_PUBLIC_DOMAIN: 'filthy.up.railway.app', BOT_TOKEN: '123456:ABC-from-BotFather',
    ADMIN_IDS: '111111111', QR_SECRET: 'change-me-to-a-long-random-string', DATA_DIR: './data', RAILWAY_VOLUME_MOUNT_PATH: dir2 } }).toString();
  const [url, token, admins, secret, data] = JSON.parse(read());
  assert.equal(url, 'https://filthy.up.railway.app');
  assert.equal(token, '');
  assert.deepEqual(admins, []);
  assert.equal(data, dir2);
  assert.ok(secret.length >= 32);
  assert.equal(JSON.parse(read())[3], secret, 'generated secret is stable across restarts');
  const bare = execFileSync(process.execPath, ['--no-warnings', '-e', "import('./src/config.js').then(({config:c})=>console.log(c.publicUrl))"],
    { env: { PATH: process.env.PATH, PUBLIC_URL: 'filthy-production-c5e2.up.railway.app', DATA_DIR: dir2 } }).toString().trim();
  assert.equal(bare, 'https://filthy-production-c5e2.up.railway.app');
});

test('Russian is the default language and a guest can switch it', async () => {
  const me = (await call(20, 'GET', '/api/me')).body;
  assert.equal(me.user.lang, 'ru');
  assert.equal(me.user.lang_chosen, false);
  assert.equal((await call(20, 'PUT', '/api/me/lang', { lang: 'de' })).status, 400);
  await call(20, 'PUT', '/api/me/lang', { lang: 'uk' });
  const after = (await call(20, 'GET', '/api/me')).body;
  assert.equal(after.user.lang, 'uk');
  assert.equal(after.user.lang_chosen, true);
});

test('admin removes a poster and deletes an event only while nothing is paid', async () => {
  const ev = (await call(ADMIN, 'POST', '/api/admin/events', { title: 'Temp', starts_at: Date.now() + 86400_000, status: 'published' })).body;
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const boundary = 'b0undary';
  const form = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="poster"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`),
    png, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await app.inject({ method: 'POST', url: `/api/admin/events/${ev.id}/poster`, headers: { 'x-dev-user': '1', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: form });
  assert.equal(up.statusCode, 200);
  const file = path.join(dir, 'uploads', path.basename(up.json().poster));
  assert.ok(fs.existsSync(file));

  assert.equal((await call(GUEST, 'DELETE', `/api/admin/events/${ev.id}/poster`)).status, 403);
  assert.equal((await call(ADMIN, 'DELETE', `/api/admin/events/${ev.id}/poster`)).status, 200);
  assert.equal((await call(GUEST, 'GET', `/api/events/${ev.id}`)).body.poster, null);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(file));

  // An unpaid reservation does not block deletion; a paid ticket does.
  await call(GUEST, 'POST', '/api/tickets', { event_id: ev.id, tier: 'online' });
  assert.equal((await call(ADMIN, 'DELETE', `/api/admin/events/${ev.id}`)).status, 200);
  assert.equal((await call(GUEST, 'GET', `/api/events/${ev.id}`)).status, 404);
  const del = await call(ADMIN, 'DELETE', `/api/admin/events/${event.id}`);
  assert.equal(del.status, 409);
  assert.equal(del.body.error, 'event_has_sales');
});

test('card mode: unique UAH amounts identify transfers without a comment; other income is ignored', async () => {
  const set = (values) => call(ADMIN, 'PUT', '/api/admin/settings', { values });
  assert.equal((await set({ mono_mode: 'card', mono_card: '5375 4141 2222 3333', mono_account_id: 'card-acc' })).status, 200);
  assert.equal((await set({ mono_card: '1234' })).body.error, 'bad_card');
  const me = (await call(GUEST, 'GET', '/api/me')).body;
  assert.equal(me.settings.mono_mode, 'card');
  assert.ok(me.settings.methods.monobank);

  const ev = (await call(ADMIN, 'POST', '/api/admin/events', { title: 'Card night', starts_at: Date.now() + 86400_000, status: 'published' })).body;
  const buy = async (user) => {
    const tk = (await call(user, 'POST', '/api/tickets', { event_id: ev.id, tier: 'online' })).body;
    return { tk, pay: (await call(user, 'POST', `/api/tickets/${tk.id}/pay`, { method: 'monobank' })).body.monobank };
  };
  const a = await buy(GUEST), b = await buy(DOOR);
  assert.equal(a.pay.mode, 'card');
  assert.equal(a.pay.card, '5375 4141 2222 3333');
  assert.equal(a.pay.jar_url, null);
  assert.notEqual(a.pay.uah, b.pay.uah, 'each open ticket gets its own amount');
  assert.ok(a.pay.uah % 100 && b.pay.uah % 100, 'amounts carry kopecks');
  // Re-opening payment keeps the same amount, so a transfer already sent still matches.
  assert.equal((await call(GUEST, 'POST', `/api/tickets/${a.tk.id}/pay`, { method: 'monobank' })).body.monobank.uah, a.pay.uah);

  const before = (await call(ADMIN, 'GET', '/api/admin/payments')).body.length;
  const hook = (id, account, amount) => call(null, 'POST', '/hooks/monobank/hook', {
    type: 'StatementItem', data: { account, statementItem: { id, time: Math.floor(Date.now() / 1000), amount, description: 'Від: Олег' } },
  });
  await hook('c-0', 'other-acc', b.pay.uah);
  assert.equal((await call(DOOR, 'GET', `/api/tickets/${b.tk.id}`)).body.status, 'awaiting_payment', 'other accounts are ignored');
  await hook('c-1', 'card-acc', 123456);
  await hook('c-2', 'card-acc', b.pay.uah);
  assert.equal((await call(DOOR, 'GET', `/api/tickets/${b.tk.id}`)).body.status, 'paid');
  assert.equal((await call(GUEST, 'GET', `/api/tickets/${a.tk.id}`)).body.status, 'awaiting_payment');
  assert.equal((await call(ADMIN, 'GET', '/api/admin/payments')).body.length, before, 'unrelated card income is not flagged');
  assert.equal(a.pay.comment, a.tk.code, 'card mode asks for the ticket number in the comment');
  await call(null, 'POST', '/hooks/monobank/hook', {
    type: 'StatementItem', data: { account: 'card-acc', statementItem: { id: 'c-3', time: Math.floor(Date.now() / 1000), amount: a.pay.uah - (a.pay.uah % 100) + 100, comment: a.tk.code } },
  });
  assert.equal((await call(GUEST, 'GET', `/api/tickets/${a.tk.id}`)).body.status, 'paid', 'the comment matches even when kopecks are dropped');

  await set({ mono_mode: 'jar' });
});
