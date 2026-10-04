import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Bot, InlineKeyboard, InputFile, InputMediaBuilder } from 'grammy';
import { config } from './config.js';
import { get, all, run, now } from './db.js';
import { upsertUser, displayName } from './auth.js';
import { bus, eventCsv } from './tickets.js';
import { reviewProof } from './repost.js';

const T = {
  uk: {
    welcome: 'Привіт! Це квитки на вечірки Filthy 🖤\nОнлайн дешевше, ніж на вході, а QR-квиток завжди під рукою.',
    open: 'Відкрити',
    paid: (ev) => `✅ Квиток на «${ev}» оплачено. QR у розділі «Мої квитки».`,
    approved: (ev) => `✅ Репост схвалено! Тепер можна оплатити квиток на «${ev}» за знижкою.`,
    rejected: (ev) => `❌ Репост для «${ev}» не підтверджено. Можна надіслати інші скріншоти або купити звичайний онлайн-квиток.`,
    reminder: (ev, time) => `🔥 Сьогодні «${ev}», початок о ${time}. Твій QR у «Моїх квитках».`,
    buy: 'Купити квиток',
  },
  ru: {
    welcome: 'Привет! Это билеты на вечеринки Filthy 🖤\nОнлайн дешевле, чем на входе, а QR-билет всегда под рукой.',
    open: 'Открыть',
    paid: (ev) => `✅ Билет на «${ev}» оплачен. QR в разделе «Мои билеты».`,
    approved: (ev) => `✅ Репост одобрен! Теперь можно оплатить билет на «${ev}» со скидкой.`,
    rejected: (ev) => `❌ Репост для «${ev}» не подтверждён. Можно отправить другие скриншоты или купить обычный онлайн-билет.`,
    reminder: (ev, time) => `🔥 Сегодня «${ev}», начало в ${time}. Твой QR в «Моих билетах».`,
    buy: 'Купить билет',
  },
  en: {
    welcome: 'Hi! These are tickets for Filthy parties 🖤\nOnline is cheaper than at the door, and your QR ticket is always at hand.',
    open: 'Open',
    paid: (ev) => `✅ Your ticket for “${ev}” is paid. The QR is in “My tickets”.`,
    approved: (ev) => `✅ Repost approved! You can now pay the discounted ticket for “${ev}”.`,
    rejected: (ev) => `❌ Your repost for “${ev}” wasn't approved. Send other screenshots or buy a regular online ticket.`,
    reminder: (ev, time) => `🔥 “${ev}” is tonight, starting at ${time}. Your QR is in “My tickets”.`,
    buy: 'Buy a ticket',
  },
};
// Russian is the default; a guest switches language in the app or with /lang.
export const LANGS = ['ru', 'uk', 'en'];
const LANG_NAMES = { ru: '🇷🇺 Русский', uk: '🇺🇦 Українська', en: '🇬🇧 English' };
const tr = (user) => T[LANGS.includes(user?.ui_lang) ? user.ui_lang : 'ru'];
const langKeyboard = () => LANGS.reduce((kb, l) => kb.text(LANG_NAMES[l], `lang:${l}`), new InlineKeyboard());

const eur = (c) => `${(c / 100).toFixed(c % 100 ? 2 : 0)} €`;
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: config.timezone });
const fmtDate = (ms) => new Date(ms).toLocaleString('uk-UA', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: config.timezone });
const appUrl = (hash = '') => `${config.publicUrl}/${hash ? '#' + hash : ''}`;
const isHttps = () => config.publicUrl.startsWith('https://');
const appButton = (user, hash) =>
  isHttps() ? new InlineKeyboard().webApp(tr(user).open, appUrl(hash)) : undefined;

export const tgWebhookSecret = crypto.createHash('sha256').update(config.qrSecret + ':tg').digest('hex').slice(0, 32);
export const bot = config.botToken ? new Bot(config.botToken) : null;

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
    await ctx.reply(tr(user).welcome, { reply_markup: appButton(user) });
    if (!user.ui_lang) await ctx.reply('🌐 Выбери язык · Обери мову · Choose language', { reply_markup: langKeyboard() });
  });

  bot.command('lang', (ctx) => ctx.reply('🌐 Выбери язык · Обери мову · Choose language', { reply_markup: langKeyboard() }));

  bot.callbackQuery(/^lang:(ru|uk|en)$/, async (ctx) => {
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
    if (admin?.role !== 'admin') return ctx.answerCallbackQuery({ text: 'Тільки для адмінів', show_alert: true });
    const approve = ctx.match[1] === 'ok';
    const r = reviewProof(Number(ctx.match[2]), admin.tg_id, approve);
    const verdict = r ? (approve ? '✅ Схвалено' : '❌ Відхилено') : 'Вже розглянуто';
    await ctx.answerCallbackQuery({ text: verdict });
    await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n${verdict} — ${displayName(admin)}`).catch(() => {});
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
    const text =
      `📸 Репост на знижку ${eur(ticket.price)}\n${ev.title}\n` +
      `Гість: ${displayName(user)}${user.username ? ' @' + user.username : ''}\n` +
      `Instagram: ${proof.instagram || '—'}\nКвиток ${ticket.code}\n\n` +
      `Перевір: відмітка ${config.instagramHandle} у сторіс і ${config.minFollowers}+ підписників.`;
    for (const chat of adminTargets()) {
      await safeSend(chat, async (id) => {
        await bot.api.sendMediaGroup(id, [InputMediaBuilder.photo(file(proof.story_file)), InputMediaBuilder.photo(file(proof.profile_file))]);
        await bot.api.sendMessage(id, text, {
          reply_markup: new InlineKeyboard().text('✅ Схвалити', `rp:ok:${proof.id}`).text('❌ Відхилити', `rp:no:${proof.id}`),
        });
      });
    }
  });

  bus.on('payment_review', (p) => {
    const amount = p.currency === 'UAH' ? `${(p.amount / 100).toFixed(2)} ₴` : eur(p.amount);
    const why = p.status === 'underpaid' ? 'сума менша за ціну квитка' : p.ticket_id ? 'квиток уже оплачено (дубль)' : 'не знайдено номер квитка';
    const text = `⚠️ Платіж на ручну перевірку (${p.source}): ${amount}, «${p.reference || '—'}», ${p.payer || ''}\nПричина: ${why}`;
    for (const chat of adminTargets()) safeSend(chat, (id) => bot.api.sendMessage(id, text, { reply_markup: isHttps() ? new InlineKeyboard().webApp('Відкрити', appUrl('admin/payments')) : undefined }));
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
      `📅 ${fmtDate(ev.starts_at)}`,
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
  await bot.api.sendDocument(chatId, new InputFile(Buffer.from(eventCsv(eventId)), name), { caption: `Звіт: ${ev.title}` });
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
