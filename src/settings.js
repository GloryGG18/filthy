import { config } from './config.js';
import { db, all, run, now } from './db.js';
import { AppError } from './tickets.js';

// Payment settings an admin can change from the app. Values saved here override .env and are
// applied to `config` in place, so every payment module picks them up without a restart.
db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  INTEGER,
  updated_at  INTEGER NOT NULL
)`);

// key -> [config section, field, kind]. Secrets are never sent back to the browser in full.
export const FIELDS = {
  pbs_iban: ['payBySquare', 'iban', 'text'],
  pbs_bic: ['payBySquare', 'bic', 'text'],
  pbs_beneficiary: ['payBySquare', 'beneficiary', 'text'],
  bank_provider: ['bank', 'provider', 'choice'],
  fio_token: ['bank', 'fioToken', 'secret'],
  tatra_client_id: ['bank.tatra', 'clientId', 'text'],
  tatra_client_secret: ['bank.tatra', 'clientSecret', 'secret'],
  tatra_account_id: ['bank.tatra', 'accountId', 'text'],
  mono_mode: ['monobank', 'mode', 'choice'],
  mono_card: ['monobank', 'card', 'text'],
  mono_account_id: ['monobank', 'accountId', 'text'],
  mono_token: ['monobank', 'token', 'secret'],
  mono_jar_id: ['monobank', 'jarId', 'text'],
  mono_jar_url: ['monobank', 'jarUrl', 'text'],
  mono_tolerance: ['monobank', 'tolerance', 'number'],
};
export const BANK_PROVIDERS = ['none', 'fio', 'tatra'];
export const MONO_MODES = ['jar', 'card'];
const CHOICES = { bank_provider: BANK_PROVIDERS, mono_mode: MONO_MODES };

const section = (path) => path.split('.').reduce((o, k) => o[k], config);

export function applySettings() {
  for (const { key, value } of all('SELECT key, value FROM settings')) {
    const f = FIELDS[key];
    if (f) section(f[0])[f[1]] = f[2] === 'number' ? Number(value) : value;
  }
}

const mask = (v) => (!v ? '' : v.length <= 8 ? '••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`);

export function readSettings() {
  return Object.fromEntries(Object.entries(FIELDS).map(([key, [sec, field, kind]]) => {
    const v = section(sec)[field];
    return [key, kind === 'secret' ? { set: !!v, masked: mask(v) } : v ?? ''];
  }));
}

// Empty secret fields mean "keep the current value"; `clear` lists secrets to erase explicitly.
export function saveSettings(input, adminId, clear = []) {
  const changed = [];
  for (const [key, [, , kind]] of Object.entries(FIELDS)) {
    let v = input[key];
    if (clear.includes(key) && kind === 'secret') v = '';
    else if (v === undefined || (kind === 'secret' && v === '')) continue;
    v = String(v).trim();
    if (kind === 'choice' && !CHOICES[key].includes(v)) throw new AppError('bad_choice');
    if (key === 'mono_card') {
      v = v.replace(/\D/g, '');
      if (v && v.length !== 16) throw new AppError('bad_card');
    }
    if (kind === 'number' && !(Number(v) > 0 && Number(v) <= 1)) throw new AppError('bad_tolerance');
    if (key === 'pbs_iban' && v && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v.replace(/\s/g, '').toUpperCase())) throw new AppError('bad_iban');
    if (key === 'mono_jar_url' && v && !/^https:\/\//.test(v)) throw new AppError('bad_url');
    run(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      key, v, adminId, now(),
    );
    changed.push(key);
  }
  applySettings();
  return changed;
}

applySettings();
