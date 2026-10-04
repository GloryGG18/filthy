import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });

export const db = new DatabaseSync(process.env.DB_FILE || path.join(config.dataDir, 'filthy.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// All timestamps are unix milliseconds; all money is integer cents (EUR) or kopecks (UAH).
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id        INTEGER PRIMARY KEY,
  username     TEXT,
  first_name   TEXT,
  last_name    TEXT,
  lang         TEXT,
  role         TEXT NOT NULL DEFAULT 'guest',      -- guest | controller | admin
  bot_started  INTEGER NOT NULL DEFAULT 0,          -- can receive bot messages
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  club          TEXT NOT NULL DEFAULT '',
  city          TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  lineup        TEXT NOT NULL DEFAULT '',
  poster        TEXT,
  starts_at     INTEGER NOT NULL,
  price_door    INTEGER NOT NULL,
  price_online  INTEGER NOT NULL,
  price_repost  INTEGER NOT NULL,
  capacity      INTEGER,                            -- NULL = unlimited
  age_limit     INTEGER NOT NULL DEFAULT 18,
  status        TEXT NOT NULL DEFAULT 'draft',      -- draft | published | closed
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,             -- 8 digits; PAY by square variable symbol and monobank comment
  event_id        INTEGER NOT NULL REFERENCES events(id),
  user_id         INTEGER REFERENCES users(tg_id),  -- NULL for door sales
  guest_name      TEXT,
  tier            TEXT NOT NULL,                    -- online | repost | door
  price           INTEGER NOT NULL,
  status          TEXT NOT NULL,                    -- pending_approval | approved | awaiting_payment | paid | used | expired | rejected | cancelled
  pay_method      TEXT,                             -- paybysquare | monobank | cash | card | manual
  uah_expected    INTEGER,                          -- kopecks, fixed when the guest opens monobank payment
  reserved_until  INTEGER,
  paid_at         INTEGER,
  used_at         INTEGER,
  used_by         INTEGER REFERENCES users(tg_id),
  sold_by         INTEGER REFERENCES users(tg_id),  -- controller who sold at the door
  reminder_sent   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_event ON tickets(event_id, status);
CREATE INDEX IF NOT EXISTS tickets_user ON tickets(user_id);

CREATE TABLE IF NOT EXISTS repost_proofs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  story_file    TEXT NOT NULL,
  profile_file  TEXT NOT NULL,
  instagram     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected
  reviewed_by   INTEGER,
  reviewed_at   INTEGER,
  created_at    INTEGER NOT NULL
);

-- Every incoming bank / monobank transaction, matched or not, so nothing is lost.
CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,                      -- tatra | fio | monobank | manual
  external_id   TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  reference     TEXT,                               -- variable symbol / comment
  payer         TEXT,
  ticket_id     INTEGER REFERENCES tickets(id),
  status        TEXT NOT NULL,                      -- matched | unmatched | underpaid | resolved
  raw           TEXT,
  received_at   INTEGER NOT NULL,
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS scans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      INTEGER,
  ticket_id     INTEGER,
  controller_id INTEGER NOT NULL,
  result        TEXT NOT NULL,                      -- ok | used | unpaid | invalid | wrong_event
  created_at    INTEGER NOT NULL
);

-- Cash physically counted per controller after the night, compared with what the system recorded.
CREATE TABLE IF NOT EXISTS cash_counts (
  event_id      INTEGER NOT NULL REFERENCES events(id),
  controller_id INTEGER NOT NULL,
  counted       INTEGER NOT NULL,
  note          TEXT,
  counted_by    INTEGER NOT NULL,
  counted_at    INTEGER NOT NULL,
  PRIMARY KEY (event_id, controller_id)
);
`);

// Migrations for databases created by earlier versions.
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('ui_lang')) db.exec('ALTER TABLE users ADD COLUMN ui_lang TEXT'); // language the user picked; NULL = default (ru)
// Promoters: users apply, an admin approves, then they get a referral code and earn per new buyer.
for (const [col, type] of [['promoter_status', 'TEXT'], ['promoter_note', 'TEXT'], ['ref_code', 'TEXT'], ['referred_by', 'INTEGER']]) {
  if (!userCols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`); // promoter_status: pending | approved | rejected
}
const ticketCols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
if (!ticketCols.includes('discount')) db.exec('ALTER TABLE tickets ADD COLUMN discount INTEGER NOT NULL DEFAULT 0'); // promoter balance spent on it
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS users_ref_code ON users(ref_code) WHERE ref_code IS NOT NULL;

-- Every change to a promoter's balance; the balance is the sum. Payout requests are reserved here at once.
CREATE TABLE IF NOT EXISTS promoter_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  promoter_id  INTEGER NOT NULL REFERENCES users(tg_id),
  amount       INTEGER NOT NULL,                    -- cents, + earned / - spent
  kind         TEXT NOT NULL,                       -- referral | discount | discount_refund | payout | payout_reverted
  referred_id  INTEGER,                             -- the new guest, for referral rewards
  ticket_id    INTEGER,
  payout_id    INTEGER,
  created_at   INTEGER NOT NULL
);
-- One reward per invited person, however many tickets they buy.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_one_reward ON promoter_ledger(referred_id) WHERE kind = 'referral';

CREATE TABLE IF NOT EXISTS payouts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  promoter_id  INTEGER NOT NULL REFERENCES users(tg_id),
  amount       INTEGER NOT NULL,
  details      TEXT NOT NULL,                       -- IBAN or card number, as the promoter typed it
  status       TEXT NOT NULL DEFAULT 'pending',     -- pending | paid | rejected
  handled_by   INTEGER,
  handled_at   INTEGER,
  created_at   INTEGER NOT NULL
);
`);

export const now = () => Date.now();

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const stmtCache = new Map();
const prep = (sql) => {
  let s = stmtCache.get(sql);
  if (!s) stmtCache.set(sql, (s = db.prepare(sql)));
  return s;
};
// node:sqlite returns null-prototype objects; spread them so they serialize like normal objects.
export const get = (sql, ...p) => {
  const r = prep(sql).get(...p);
  return r ? { ...r } : undefined;
};
export const all = (sql, ...p) => prep(sql).all(...p).map((r) => ({ ...r }));
export const run = (sql, ...p) => prep(sql).run(...p);
