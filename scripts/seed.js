// Demo data (times are roughly Bratislava local) for local testing: npm run seed (uses DATA_DIR / DB_FILE like the app).
import { run, get } from '../src/db.js';
import { config } from '../src/config.js';

const day = 86400_000;
const at = (days, hour) => { const d = new Date(Date.now() + days * day); d.setUTCHours(hour - 2, 0, 0, 0); return d.getTime(); };
const ins = (e) => run(
  `INSERT INTO events (title, description, club, city, address, lineup, starts_at, price_door, price_online, price_repost, capacity, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`,
  e.title, e.description, e.club, e.city, e.address, e.lineup, e.starts_at,
  config.prices.door, config.prices.online, config.prices.repost, e.capacity ?? null, Date.now(),
);

if (!get('SELECT 1 FROM events')) {
  ins({ title: 'Filthy Halloween', description: 'Костюми обовʼязкові. Найкращий костюм отримує VIP на наступну вечірку.\nDress code: dark.',
    club: 'Fuga', city: 'Bratislava', address: 'Trnavské mýto 1', lineup: 'DJ Volna · Morok · b2b Sasha K', starts_at: at(6, 23), capacity: 300 });
  ins({ title: 'Filthy Techno Night', description: 'Ніч жорсткого техно до ранку.', club: 'Club Subclub', city: 'Bratislava',
    address: 'Nábrežie arm. gen. L. Svobodu', lineup: 'Kyiv Underground crew', starts_at: at(20, 23) });
  console.log('seeded 2 events');
} else console.log('events already exist, nothing to seed');
