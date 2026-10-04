import { config } from '../config.js';
import { recordPayment } from '../tickets.js';

const API = 'https://api.monobank.ua';
let rateCache = { rate: null, at: 0 };

// EUR -> UAH sell rate from monobank's public API (rate-limited, so cached for an hour).
export async function eurUahRate() {
  if (rateCache.rate && Date.now() - rateCache.at < 3600_000) return rateCache.rate;
  try {
    const res = await fetch(`${API}/bank/currency`, { signal: AbortSignal.timeout(5000) });
    const row = (await res.json()).find((r) => r.currencyCodeA === 978 && r.currencyCodeB === 980);
    const rate = row?.rateSell || row?.rateCross;
    if (rate) rateCache = { rate, at: Date.now() };
  } catch (e) {
    console.warn('monobank rate unavailable:', e.message);
  }
  return rateCache.rate || config.monobank.fallbackRate;
}

function ingest(item, account) {
  if (config.monobank.jarId && account !== config.monobank.jarId) return null;
  if (!(item.amount > 0)) return null; // only incoming money
  return recordPayment({
    source: 'monobank',
    externalId: item.id,
    amount: item.amount, // kopecks
    currency: 'UAH',
    reference: [item.comment, item.description].filter(Boolean).join(' '),
    payer: item.description,
    raw: item,
    receivedAt: item.time * 1000,
  });
}

// Body of monobank's personal-API webhook: { type: 'StatementItem', data: { account, statementItem } }
export function handleMonoWebhook(body) {
  if (body?.type !== 'StatementItem') return null;
  return ingest(body.data.statementItem, body.data.account);
}

export async function registerMonoWebhook(url) {
  if (!config.monobank.token) return;
  const res = await fetch(`${API}/personal/webhook`, {
    method: 'POST',
    headers: { 'X-Token': config.monobank.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ webHookUrl: url }),
  });
  console.log('monobank webhook:', res.status, await res.text());
}

// Backup in case a webhook is missed: re-read the jar statement for the last few hours.
// monobank allows one statement call per 60 s, so this runs rarely.
export async function pollMonoStatement(hours = 6) {
  const { token, jarId } = config.monobank;
  if (!token || !jarId) return;
  const from = Math.floor(Date.now() / 1000) - hours * 3600;
  const res = await fetch(`${API}/personal/statement/${jarId}/${from}`, { headers: { 'X-Token': token } });
  if (!res.ok) return console.warn('monobank statement:', res.status);
  for (const item of await res.json()) ingest(item, jarId);
}

export function monoInfo(ticket, rate) {
  return {
    jar_url: config.monobank.jarUrl || null,
    uah: ticket.uah_expected,
    rate,
    comment: ticket.code,
  };
}

// Lists the token owner's jars so the admin can pick one instead of hunting for its ID.
export async function listMonoJars(token = config.monobank.token) {
  if (!token) return [];
  const res = await fetch(`${API}/personal/client-info`, { headers: { 'X-Token': token }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`monobank ${res.status}`);
  return ((await res.json()).jars ?? []).map((j) => ({
    id: j.id, title: j.title, url: j.sendId ? `https://send.monobank.ua/${j.sendId.startsWith('jar/') ? j.sendId : 'jar/' + j.sendId}` : null, balance: j.balance,
  }));
}
