import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Bot, InlineKeyboard, InputFile, InputMediaBuilder } from 'grammy';
import { config } from './config.js';
import { get, all, run, now } from './db.js';
import { upsertUser, displayName } from './auth.js';
import { bus, eventCsv } from './tickets.js';
import { reviewProof } from './repost.js';
import { attachReferral, reviewPromoter } from './promoters.js';

const T = {
  uk: {
    welcome: 'Привіт! Це квитки на вечірки Filthy 🖤\nОнлайн дешевше, ніж на вході, а QR-квиток завжди під рукою.',
    open: 'Відкрити',
    paid: (ev) => `✅ Квиток на «${ev}» оплачено. QR у розділі «Мої квитки».`,
    approved: (ev) => `✅ Репост схвалено! Тепер можна оплатити квиток на «${ev}» за знижкою.`,
    rejected: (ev) => `❌ Репост для «${ev}» не підтверджено. Можна надіслати інші скріншоти або купити звичайний онлайн-квиток.`,
    reminder: (ev, time) => `🔥 Сьогодні «${ev}», початок о ${time}. Твій QR у «Моїх квитках».`,
    buy: 'Купити квиток',
    p_approved: '🎉 Тебе схвалено як промоутера! Твоє посилання і баланс у застосунку: «Мої квитки» → «Промоутер».',
    p_rejected: 'На жаль, заявку в промоутери не схвалено.',
    p_credited: (b) => `💸 +1 €: новий гість купив квиток за твоїм посиланням. Баланс: ${b}`,
    p_paid: (a) => `✅ Виплату ${a} відправлено.`,
    p_payout_rejected: (a) => `❌ Виплату ${a} відхилено, гроші повернулися на баланс.`,
    p_open: 'Кабінет промоутера',
    a_promoter_app: (o) => `🤝 Заявка в промоутери\n${o.name}\n${o.note || ''}`,
    a_payout: (o) => `💸 Запит на виплату ${o.amount}\n${o.name}\nРеквізити: ${o.details}`,
    a_only_admins: 'Тільки для адмінів',
    a_approved: '✅ Схвалено',
    a_rejected: '❌ Відхилено',
    a_done: 'Вже розглянуто',
    a_proof: (o) => `📸 Репост на знижку ${o.price}\n${o.event}\nГість: ${o.guest}\nInstagram: ${o.instagram}\nКвиток ${o.code}\n\nПеревір: відмітка ${o.handle} у сторіс і ${o.min}+ підписників.`,
    a_approve: '✅ Схвалити',
    a_reject: '❌ Відхилити',
    a_underpaid: 'сума менша за ціну квитка',
    a_duplicate: 'квиток уже оплачено (дубль)',
    a_no_code: 'не знайдено номер квитка',
    a_payment: (o) => `⚠️ Платіж на ручну перевірку (${o.source}): ${o.amount}, «${o.reference}», ${o.payer}\nПричина: ${o.why}`,
    a_report: (ev) => `Звіт: ${ev}`,
  },
  ru: {
    welcome: 'Привет! Это билеты на вечеринки Filthy 🖤\nОнлайн дешевле, чем на входе, а QR-билет всегда под рукой.',
    open: 'Открыть',
    paid: (ev) => `✅ Билет на «${ev}» оплачен. QR в разделе «Мои билеты».`,
    approved: (ev) => `✅ Репост одобрен! Теперь можно оплатить билет на «${ev}» со скидкой.`,
    rejected: (ev) => `❌ Репост для «${ev}» не подтверждён. Можно отправить другие скриншоты или купить обычный онлайн-билет.`,
    reminder: (ev, time) => `🔥 Сегодня «${ev}», начало в ${time}. Твой QR в «Моих билетах».`,
    buy: 'Купить билет',
    p_approved: '🎉 Тебя одобрили как промоутера! Твоя ссылка и баланс в приложении: «Мои билеты» → «Промоутер».',
    p_rejected: 'К сожалению, заявку в промоутеры не одобрили.',
    p_credited: (b) => `💸 +1 €: новый гость купил билет по твоей ссылке. Баланс: ${b}`,
    p_paid: (a) => `✅ Выплата ${a} отправлена.`,
    p_payout_rejected: (a) => `❌ Выплату ${a} отклонили, деньги вернулись на баланс.`,
    p_open: 'Кабинет промоутера',
    a_promoter_app: (o) => `🤝 Заявка в промоутеры\n${o.name}\n${o.note || ''}`,
    a_payout: (o) => `💸 Запрос на выплату ${o.amount}\n${o.name}\nРеквизиты: ${o.details}`,
    a_only_admins: 'Только для админов',
    a_approved: '✅ Одобрено',
    a_rejected: '❌ Отклонено',
    a_done: 'Уже рассмотрено',
    a_proof: (o) => `📸 Репост на скидку ${o.price}\n${o.event}\nГость: ${o.guest}\nInstagram: ${o.instagram}\nБилет ${o.code}\n\nПроверь: отметка ${o.handle} в сторис и ${o.min}+ подписчиков.`,
    a_approve: '✅ Одобрить',
    a_reject: '❌ Отклонить',
    a_underpaid: 'сумма меньше цены билета',
    a_duplicate: 'билет уже оплачен (дубль)',
    a_no_code: 'не найден номер билета',
    a_payment: (o) => `⚠️ Платёж на ручную проверку (${o.source}): ${o.amount}, «${o.reference}», ${o.payer}\nПричина: ${o.why}`,
    a_report: (ev) => `Отчёт: ${ev}`,
  },
  en: {
    welcome: 'Hi! These are tickets for Filthy parties 🖤\nOnline is cheaper than at the door, and your QR ticket is always at hand.',
    open: 'Open',
    paid: (ev) => `✅ Your ticket for “${ev}” is paid. The QR is in “My tickets”.`,
    approved: (ev) => `✅ Repost approved! You can now pay the discounted ticket for “${ev}”.`,
    rejected: (ev) => `❌ Your repost for “${ev}” wasn't approved. Send other screenshots or buy a regular online ticket.`,
    reminder: (ev, time) => `🔥 “${ev}” is tonight, starting at ${time}. Your QR is in “My tickets”.`,
    buy: 'Buy a ticket',
    p_approved: '🎉 You’re approved as a promoter! Your link and balance are in the app: “My tickets” → “Promoter”.',
    p_rejected: 'Sorry, your promoter application wasn’t approved.',
    p_credited: (b) => `💸 +1 €: a new guest bought a ticket through your link. Balance: ${b}`,
    p_paid: (a) => `✅ Your payout of ${a} has been sent.`,
    p_payout_rejected: (a) => `❌ Your payout of ${a} was rejected; the money is back on your balance.`,
    p_open: 'Promoter dashboard',
    a_promoter_app: (o) => `🤝 Promoter application\n${o.name}\n${o.note || ''}`,
    a_payout: (o) => `💸 Payout request ${o.amount}\n${o.name}\nDetails: ${o.details}`,
    a_only_admins: 'Admins only',
    a_approved: '✅ Approved',
    a_rejected: '❌ Rejected',
    a_done: 'Already reviewed',
    a_proof: (o) => `📸 Repost discount ${o.price}\n${o.event}\nGuest: ${o.guest}\nInstagram: ${o.instagram}\nTicket ${o.code}\n\nCheck: ${o.handle} tagged in the story and ${o.min}+ followers.`,
    a_approve: '✅ Approve',
    a_reject: '❌ Reject',
    a_underpaid: 'amount is below the ticket price',
    a_duplicate: 'ticket already paid (duplicate)',
    a_no_code: 'ticket number not found',
    a_payment: (o) => `⚠️ Payment needs manual review (${o.source}): ${o.amount}, “${o.reference}”, ${o.payer}\nReason: ${o.why}`,
    a_report: (ev) => `Report: ${ev}`,
  },
  sk: {
    welcome: 'Ahoj! Tu sú lístky na párty Filthy 🖤\nOnline je lacnejšie ako pri vstupe a QR lístok máš vždy po ruke.',
    open: 'Otvoriť',
    paid: (ev) => `✅ Lístok na „${ev}“ je zaplatený. QR nájdeš v „Moje lístky“.`,
    approved: (ev) => `✅ Repost schválený! Teraz môžeš zaplatiť lístok na „${ev}“ so zľavou.`,
    rejected: (ev) => `❌ Repost pre „${ev}“ nebol schválený. Pošli iné screenshoty alebo kúp bežný online lístok.`,
    reminder: (ev, time) => `🔥 Dnes je „${ev}“, začiatok o ${time}. Tvoj QR je v „Moje lístky“.`,
    buy: 'Kúpiť lístok',
    p_approved: '🎉 Si schválený ako promotér! Tvoj odkaz a zostatok nájdeš v aplikácii: „Moje lístky“ → „Promotér“.',
    p_rejected: 'Žiaľ, tvoja žiadosť o promotéra nebola schválená.',
    p_credited: (b) => `💸 +1 €: nový hosť si kúpil lístok cez tvoj odkaz. Zostatok: ${b}`,
    p_paid: (a) => `✅ Výplata ${a} bola odoslaná.`,
    p_payout_rejected: (a) => `❌ Výplata ${a} bola zamietnutá, peniaze sa vrátili na zostatok.`,
    p_open: 'Panel promotéra',
    a_promoter_app: (o) => `🤝 Žiadosť o promotéra\n${o.name}\n${o.note || ''}`,
    a_payout: (o) => `💸 Žiadosť o výplatu ${o.amount}\n${o.name}\nÚdaje: ${o.details}`,
    a_only_admins: 'Len pre adminov',
    a_approved: '✅ Schválené',
    a_rejected: '❌ Zamietnuté',
    a_done: 'Už vybavené',
    a_proof: (o) => `📸 Zľava za repost ${o.price}\n${o.event}\nHosť: ${o.guest}\nInstagram: ${o.instagram}\nLístok ${o.code}\n\nSkontroluj: označenie ${o.handle} v story a ${o.min}+ sledovateľov.`,
    a_approve: '✅ Schváliť',
    a_reject: '❌ Zamietnuť',
    a_underpaid: 'suma je nižšia ako cena lístka',
    a_duplicate: 'lístok je už zaplatený (duplicita)',
    a_no_code: 'číslo lístka sa nenašlo',
    a_payment: (o) => `⚠️ Platba na ručnú kontrolu (${o.source}): ${o.amount}, „${o.reference}“, ${o.payer}\nDôvod: ${o.why}`,
    a_report: (ev) => `Prehľad: ${ev}`,
  },
};
// Russian is the default; a guest switches language in the app or with /lang.
export const LANGS = ['ru', 'uk', 'sk', 'en'];
const LANG_NAMES = { ru: '🇷🇺 Русский', uk: '🇺🇦 Українська', sk: '🇸🇰 Slovenčina', en: '🇬🇧 English' };
const tr = (user) => T[LANGS.includes(user?.ui_lang) ? user.ui_lang : 'ru'];
// Admin messages follow the admin's own language; a group chat gets the default.
const trChat = (chatId) => tr(get('SELECT ui_lang FROM users WHERE tg_id = ?', chatId));
// Two per row; the current choice is ticked.
const langKeyboard = (current) => LANGS.reduce((kb, l, i) => {
  kb.text(`${l === current ? '✓ ' : ''}${LANG_NAMES[l]}`, `lang:${l}`);
  return i % 2 ? kb.row() : kb;
}, new InlineKeyboard());

const eur = (c) => `${(c / 100).toFixed(c % 100 ? 2 : 0)} €`;
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: config.timezone });
const LOCALES = { ru: 'ru-RU', uk: 'uk-UA', sk: 'sk-SK', en: 'en-GB' };
const fmtDate = (ms, lang = 'ru') => new Date(ms).toLocaleString(LOCALES[lang] || 'ru-RU', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: config.timezone });
const appUrl = (hash = '') => `${config.publicUrl}/${hash ? '#' + hash : ''}`;
const isHttps = () => config.publicUrl.startsWith('https://');
const appButton = (user, hash) =>
  isHttps() ? new InlineKeyboard().webApp(tr(user).open, appUrl(hash)) : undefined;

export const tgWebhookSecret = crypto.createHash('sha256').update(config.qrSecret + ':tg').digest('hex').slice(0, 32);
export const bot = config.botToken ? new Bot(config.botToken) : null;
// grammY throws when botInfo is read before init (no network yet), so fall back to BOT_USERNAME.
export const botUsername = () => {
  try { return bot?.botInfo?.username || config.botUsername; } catch { return config.botUsername; }
};

const adminTargets = () =>
  config.adminChatId ? [config.adminChatId] : all(`SELECT tg_id FROM users WHERE role = 'admin' AND bot_started = 1`).map((u) => u.tg_id);

async function safeSend(chatId, fn) {
  try {
    return await fn(chatId);
  } catch (e) {
    if (e.error_code === 403) run('UPDATE users SET bot_started = 0 WHERE tg_id = ?', chatId); // user blocked the bot
    else console.warn('bot send failed:', chatId, e.description || e.message);
  }
}

if (bot) {
  bot.command('start', async (ctx) => {
    const user = upsertUser(ctx.from, { botStarted: true });
    const ref = String(ctx.match || '').match(/^ref_(\w+)$/)?.[1];
    if (ref) attachReferral(user, ref);
    // Language first on every /start; the welcome follows in the chosen language.
    await ctx.reply('🌐 Выбери язык · Обери мову · Vyber jazyk · Choose language', { reply_markup: langKeyboard(user.ui_lang) });
  });

  bot.command('lang', (ctx) => ctx.reply('🌐 Выбери язык · Обери мову · Vyber jazyk · Choose language', { reply_markup: langKeyboard(get('SELECT ui_lang FROM users WHERE tg_id = ?', ctx.from.id)?.ui_lang) }));

  bot.callbackQuery(/^lang:(ru|uk|sk|en)$/, async (ctx) => {
    upsertUser(ctx.from, { botStarted: true });
    run('UPDATE users SET ui_lang = ? WHERE tg_id = ?', ctx.match[1], ctx.from.id);
    const user = get('SELECT * FROM users WHERE tg_id = ?', ctx.from.id);
    await ctx.answerCallbackQuery({ text: LANG_NAMES[ctx.match[1]] });
    await ctx.editMessageText(`🌐 ${LANG_NAMES[ctx.match[1]]}`).catch(() => {});
    await ctx.reply(tr(user).welcome, { reply_markup: appButton(user) });
  });

  bot.command('id', (ctx) => ctx.reply(`user: ${ctx.from.id}\nchat: ${ctx.chat.id}`));

  // One-tap approval of repost screenshots in the admin chat.
  bot.callbackQuery(/^rp:(ok|no):(\d+)$/, async (ctx) => {
    const admin = get('SELECT * FROM users WHERE tg_id = ?', ctx.from.id);
    const a = tr(admin);
    if (admin?.role !== 'admin') return ctx.answerCallbackQuery({ text: a.a_only_admins, show_alert: true });
    const approve = ctx.match[1] === 'ok';
    const r = reviewProof(Number(ctx.match[2]), admin.tg_id, approve);
    const verdict = r ? (approve ? a.a_approved : a.a_rejected) : a.a_done;
    await ctx.answerCallbackQuery({ text: verdict });
    await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n${verdict} — ${displayName(admin)}`).catch(() => {});
  });

  // One-tap approval of promoter applications.
  bot.callbackQuery(/^pr:(ok|no):(\d+)$/, async (ctx) => {
    const admin = get('SELECT * FROM users WHERE tg_id = ?', ctx.from.id);
    const a = tr(admin);
    if (admin?.role !== 'admin') return ctx.answerCallbackQuery({ text: a.a_only_admins, show_alert: true });
    const approve = ctx.match[1] === 'ok';
    let verdict;
    try {
      const before = get('SELECT promoter_status FROM users WHERE tg_id = ?', Number(ctx.match[2]))?.promoter_status;
      reviewPromoter(Number(ctx.match[2]), approve);
      verdict = before === 'pending' ? (approve ? a.a_approved : a.a_rejected) : a.a_done;
    } catch { verdict = a.a_done; }
    await ctx.answerCallbackQuery({ text: verdict });
    await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n${verdict} — ${displayName(admin)}`).catch(() => {});
  });

  bus.on('promoter_applied', (u) => {
    for (const chat of adminTargets()) {
      const a = trChat(chat);
      const text = a.a_promoter_app({ name: displayName(u) + (u.username ? ' @' + u.username : ''), note: u.promoter_note });
      safeSend(chat, (id) => bot.api.sendMessage(id, text, { reply_markup: new InlineKeyboard().text(a.a_approve, `pr:ok:${u.tg_id}`).text(a.a_reject, `pr:no:${u.tg_id}`) }));
    }
  });

  bus.on('promoter_reviewed', (u, approved) => {
    const text = approved ? tr(u).p_approved : tr(u).p_rejected;
    safeSend(u.tg_id, (id) => bot.api.sendMessage(id, text, { reply_markup: approved && isHttps() ? new InlineKeyboard().webApp(tr(u).p_open, appUrl('promoter')) : undefined }));
  });

  bus.on('promoter_credited', (promoter, _guest, balance) => {
    safeSend(promoter.tg_id, (id) => bot.api.sendMessage(id, tr(promoter).p_credited(eur(balance))));
  });

  bus.on('payout_requested', (p, u) => {
    for (const chat of adminTargets()) {
      const a = trChat(chat);
      const text = a.a_payout({ amount: eur(p.amount), name: displayName(u) + (u.username ? ' @' + u.username : ''), details: p.details });
      safeSend(chat, (id) => bot.api.sendMessage(id, text, { reply_markup: isHttps() ? new InlineKeyboard().webApp(a.open, appUrl('admin/promoters')) : undefined }));
    }
  });

  bus.on('payout_handled', (p, u) => {
    const text = p.status === 'paid' ? tr(u).p_paid(eur(p.amount)) : tr(u).p_payout_rejected(eur(p.amount));
    safeSend(u.tg_id, (id) => bot.api.sendMessage(id, text));
  });

  bot.catch((err) => console.error('bot error:', err.error?.message || err));

  bus.on('ticket_paid', (ticket) => {
    if (!ticket.user_id) return;
    const user = get('SELECT * FROM users WHERE tg_id = ?', ticket.user_id);
    const ev = get('SELECT title FROM events WHERE id = ?', ticket.event_id);
    safeSend(user.tg_id, (id) => bot.api.sendMessage(id, tr(user).paid(ev.title), { reply_markup: appButton(user, `ticket/${ticket.id}`) }));
  });

  bus.on('repost_reviewed', (ticket, approved) => {
    const user = get('SELECT * FROM users WHERE tg_id = ?', ticket.user_id);
    const ev = get('SELECT title FROM events WHERE id = ?', ticket.event_id);
    const text = approved ? tr(user).approved(ev.title) : tr(user).rejected(ev.title);
    safeSend(user.tg_id, (id) => bot.api.sendMessage(id, text, { reply_markup: appButton(user, `ticket/${ticket.id}`) }));
  });

  bus.on('proof_submitted', async (proof, ticket) => {
    const user = get('SELECT * FROM users WHERE tg_id = ?', ticket.user_id);
    const ev = get('SELECT title FROM events WHERE id = ?', ticket.event_id);
    const file = (f) => new InputFile(path.join(config.dataDir, 'uploads', f));
    const info = {
      price: eur(ticket.price), event: ev.title, code: ticket.code, handle: config.instagramHandle, min: config.minFollowers,
      guest: displayName(user) + (user.username ? ' @' + user.username : ''), instagram: proof.instagram || '—',
    };
    for (const chat of adminTargets()) {
      const a = trChat(chat);
      await safeSend(chat, async (id) => {
        await bot.api.sendMediaGroup(id, [InputMediaBuilder.photo(file(proof.story_file)), InputMediaBuilder.photo(file(proof.profile_file))]);
        await bot.api.sendMessage(id, a.a_proof(info), {
          reply_markup: new InlineKeyboard().text(a.a_approve, `rp:ok:${proof.id}`).text(a.a_reject, `rp:no:${proof.id}`),
        });
      });
    }
  });

  bus.on('payment_review', (p) => {
    const amount = p.currency === 'UAH' ? `${(p.amount / 100).toFixed(2)} ₴` : eur(p.amount);
    const why = p.status === 'underpaid' ? 'a_underpaid' : p.ticket_id ? 'a_duplicate' : 'a_no_code';
    for (const chat of adminTargets()) {
      const a = trChat(chat);
      const text = a.a_payment({ source: p.source, amount, reference: p.reference || '—', payer: p.payer || '', why: a[why] });
      safeSend(chat, (id) => bot.api.sendMessage(id, text, { reply_markup: isHttps() ? new InlineKeyboard().webApp(a.open, appUrl('admin/payments')) : undefined }));
    }
  });
}

// Sends the event announcement to everyone who started the bot. ~20 msgs/s stays under Telegram's limits.
export async function broadcastEvent(eventId, extraText = '') {
  if (!bot) return { sent: 0, failed: 0 };
  const ev = get('SELECT * FROM events WHERE id = ?', eventId);
  const users = all('SELECT * FROM users WHERE bot_started = 1');
  let sent = 0;
  for (const user of users) {
    const caption = [
      `🖤 ${ev.title}`,
      `📅 ${fmtDate(ev.starts_at, user.ui_lang)}`,
      `📍 ${[ev.club, ev.city].filter(Boolean).join(', ')}`,
      ev.lineup && `🎧 ${ev.lineup}`,
      `🎟 ${eur(ev.price_online)} online · ${eur(ev.price_door)} door`,
      extraText,
    ].filter(Boolean).join('\n');
    const kb = isHttps() ? new InlineKeyboard().webApp(tr(user).buy, appUrl(`event/${ev.id}`)) : undefined;
    const poster = ev.poster && path.join(config.dataDir, 'uploads', ev.poster);
    const ok = await safeSend(user.tg_id, (id) =>
      poster && fs.existsSync(poster)
        ? bot.api.sendPhoto(id, new InputFile(poster), { caption, reply_markup: kb })
        : bot.api.sendMessage(id, caption, { reply_markup: kb }),
    );
    if (ok) sent++;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { sent, failed: users.length - sent };
}

export async function sendCsv(chatId, eventId) {
  if (!bot) throw new Error('bot not configured');
  const ev = get('SELECT * FROM events WHERE id = ?', eventId);
  const name = `filthy-${new Date(ev.starts_at).toISOString().slice(0, 10)}-${ev.id}.csv`;
  await bot.api.sendDocument(chatId, new InputFile(Buffer.from(eventCsv(eventId)), name), { caption: trChat(chatId).a_report(ev.title) });
}

// Day-of reminder for paid tickets, once, after REMINDER_HOUR local time.
export async function sendReminders() {
  if (!bot) return;
  const hour = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: config.timezone }));
  if (hour < config.reminderHour) return;
  const rows = all(
    `SELECT t.id, t.user_id, e.title, e.starts_at FROM tickets t JOIN events e ON e.id = t.event_id
     WHERE t.status = 'paid' AND t.reminder_sent = 0 AND t.user_id IS NOT NULL AND e.starts_at BETWEEN ? AND ?`,
    now(), now() + 16 * 3600_000,
  );
  for (const r of rows) {
    run('UPDATE tickets SET reminder_sent = 1 WHERE id = ?', r.id);
    const user = get('SELECT * FROM users WHERE tg_id = ?', r.user_id);
    await safeSend(user.tg_id, (id) => bot.api.sendMessage(id, tr(user).reminder(r.title, fmtTime(r.starts_at)), { reply_markup: appButton(user, `ticket/${r.id}`) }));
  }
}

export async function startBot({ webhook } = {}) {
  if (!bot) return console.warn('BOT_TOKEN not set: bot disabled');
  await bot.init();
  if (isHttps()) {
    await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Filthy', web_app: { url: appUrl() } } }).catch((e) => console.warn(e.message));
  }
  if (webhook) {
    await bot.api.setWebhook(`${config.publicUrl}/hooks/telegram`, { secret_token: tgWebhookSecret });
  } else {
    await bot.api.deleteWebhook();
    bot.start({ drop_pending_updates: false });
  }
  console.log(`bot @${bot.botInfo.username} running (${webhook ? 'webhook' : 'polling'})`);
}
