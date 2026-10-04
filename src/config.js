import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const cents = (v, d) => Math.round(Number(v ?? d) * 100);

export const config = {
  port: Number(env.PORT || 3000),
  publicUrl: (env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  dataDir: path.resolve(env.DATA_DIR || './data'),

  botToken: env.BOT_TOKEN || '',
  // Telegram IDs that are always admins (others can be promoted from the app).
  adminIds: list(env.ADMIN_IDS).map(Number),
  // Chat where repost screenshots arrive for one-tap approval (a group or an admin's private chat).
  adminChatId: env.ADMIN_CHAT_ID ? Number(env.ADMIN_CHAT_ID) : null,
  // Signs QR codes. Must stay secret and stable, or issued QR codes stop working.
  qrSecret: env.QR_SECRET || 'dev-secret-change-me',
  // Local testing in a plain browser without Telegram (X-Dev-User header). Never enable in production.
  devAuth: env.DEV_AUTH === '1',

  prices: {
    door: cents(env.PRICE_DOOR, 12),
    online: cents(env.PRICE_ONLINE, 10),
    repost: cents(env.PRICE_REPOST, 8),
  },
  reservationMinutes: Number(env.RESERVATION_MINUTES || 30),
  instagramHandle: env.INSTAGRAM_HANDLE || '@filthy.sk',
  minFollowers: Number(env.MIN_FOLLOWERS || 100),

  payBySquare: {
    iban: env.PBS_IBAN || '',
    bic: env.PBS_BIC || '',
    beneficiary: env.PBS_BENEFICIARY || 'Filthy',
  },

  // Bank statement source used to auto-confirm PAY by square transfers: tatra | fio | none
  bank: {
    provider: env.BANK_PROVIDER || 'none',
    pollSeconds: Number(env.BANK_POLL_SECONDS || 30),
    fioToken: env.FIO_TOKEN || '',
    tatra: {
      clientId: env.TATRA_CLIENT_ID || '',
      clientSecret: env.TATRA_CLIENT_SECRET || '',
      accountId: env.TATRA_ACCOUNT_ID || '',
      baseUrl: env.TATRA_BASE_URL || 'https://api.tatrabanka.sk/premium/production',
    },
  },

  monobank: {
    token: env.MONO_TOKEN || '',
    jarId: env.MONO_JAR_ID || '',
    jarUrl: env.MONO_JAR_URL || '',
    // Payments at or above this share of the expected UAH amount count as paid; the rest go to manual review.
    tolerance: Number(env.MONO_TOLERANCE || 0.98),
    // Used when the monobank rate API is unreachable.
    fallbackRate: Number(env.MONO_FALLBACK_RATE || 48),
    // monobank webhooks are unsigned, so the secret URL path is what stops forged "payments".
    webhookSecret: env.MONO_WEBHOOK_SECRET || crypto.createHash('sha256').update(`${env.QR_SECRET || 'dev'}:mono`).digest('hex').slice(0, 24),
  },

  reminderHour: Number(env.REMINDER_HOUR || 12),
  timezone: env.TZ || 'Europe/Bratislava',
};

// A public deployment must not run with the default QR secret (anyone could forge tickets)
// or with dev login enabled (anyone could pose as any user).
if (config.publicUrl.startsWith('https://')) {
  if (!env.QR_SECRET || env.QR_SECRET.length < 16 || /change-me/.test(env.QR_SECRET)) throw new Error('Set QR_SECRET to a random string of 16+ characters');
  if (config.devAuth) throw new Error('DEV_AUTH must be off on a public deployment');
}

export const isAdminId = (id) => config.adminIds.includes(Number(id));
