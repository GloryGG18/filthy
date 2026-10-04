import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

// Values copied verbatim from .env.example (Railway imports them as suggestions) count as unset.
const PLACEHOLDER = /example\.sk|change-me|from-BotFather|^111111111$|XXXXXX|^SK00 0000/;
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '' && !PLACEHOLDER.test(v)));
// A bare domain ("x.up.railway.app") means https.
const withScheme = (u) => (/^https?:\/\//.test(u) ? u : `https://${u}`).replace(/\/$/, '');
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const cents = (v, d) => Math.round(Number(v ?? d) * 100);

// Railway exposes the attached volume's mount path; prefer it so data always lands on the volume.
const dataDir = path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || './data');

// Without QR_SECRET, generate one once and keep it next to the database, so it survives restarts.
function loadQrSecret() {
  if (env.QR_SECRET) return env.QR_SECRET;
  const file = path.join(dataDir, '.qr-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}
const qrSecret = loadQrSecret();

export const config = {
  port: Number(env.PORT || 3000),
  // On Railway the generated domain arrives as RAILWAY_PUBLIC_DOMAIN, so PUBLIC_URL can be left out there.
  publicUrl: withScheme(env.PUBLIC_URL || env.RAILWAY_PUBLIC_DOMAIN || 'http://localhost:3000'),
  dataDir,

  botToken: env.BOT_TOKEN || '',
  // Telegram IDs that are always admins (others can be promoted from the app).
  adminIds: list(env.ADMIN_IDS).map(Number),
  // Chat where repost screenshots arrive for one-tap approval (a group or an admin's private chat).
  adminChatId: env.ADMIN_CHAT_ID ? Number(env.ADMIN_CHAT_ID) : null,
  // Signs QR codes. Must stay secret and stable, or issued QR codes stop working.
  qrSecret,
  // Local testing in a plain browser without Telegram (X-Dev-User header). Never enable in production.
  devAuth: env.DEV_AUTH === '1',

  prices: {
    door: cents(env.PRICE_DOOR, 12),
    online: cents(env.PRICE_ONLINE, 10),
    repost: cents(env.PRICE_REPOST, 8),
  },
  reservationMinutes: Number(env.RESERVATION_MINUTES || 30),
  promoter: {
    reward: cents(env.PROMOTER_REWARD, 1), // per new guest who buys a ticket through the link
    minPayout: cents(env.PROMOTER_MIN_PAYOUT, 5),
  },
  botUsername: env.BOT_USERNAME || '', // only needed when the bot can't be reached to ask Telegram
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
    // jar: guests pay into a monobank jar (its page shows the collected total to everyone);
    // card: guests transfer to a card number and each ticket gets a unique amount with kopecks.
    mode: env.MONO_MODE || (env.MONO_CARD ? 'card' : 'jar'),
    card: env.MONO_CARD || '',
    accountId: env.MONO_ACCOUNT_ID || '',
    token: env.MONO_TOKEN || '',
    jarId: env.MONO_JAR_ID || '',
    jarUrl: env.MONO_JAR_URL || '',
    // Payments at or above this share of the expected UAH amount count as paid; the rest go to manual review.
    tolerance: Number(env.MONO_TOLERANCE || 0.98),
    // Used when the monobank rate API is unreachable.
    fallbackRate: Number(env.MONO_FALLBACK_RATE || 48),
    // monobank webhooks are unsigned, so the secret URL path is what stops forged "payments".
    webhookSecret: env.MONO_WEBHOOK_SECRET || crypto.createHash('sha256').update(`${qrSecret}:mono`).digest('hex').slice(0, 24),
  },

  reminderHour: Number(env.REMINDER_HOUR || 12),
  timezone: env.TZ || 'Europe/Bratislava',
};

// Dev login lets anyone pose as any user, so it must never run on a public address.
if (config.publicUrl.startsWith('https://') && config.devAuth) throw new Error('DEV_AUTH must be off on a public deployment');

export const isAdminId = (id) => config.adminIds.includes(Number(id));
