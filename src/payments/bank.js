import { config } from '../config.js';
import { recordPayment } from '../tickets.js';

// Reads incoming transfers from the organizer's account and matches them to tickets by variable symbol.
// Each provider returns normalized transactions: { id, amount (cents), currency, vs, message, payer, date }.

const providers = {
  // Fio banka (also operates in Slovakia): a read-only token from internet banking is all that's needed.
  // API docs: https://www.fio.sk/docs/cz/API_Bankovnictvi.pdf. Limit: one call per 30 seconds per token.
  async fio() {
    const res = await fetch(`https://fioapi.fio.cz/v1/rest/last/${config.bank.fioToken}/transactions.json`);
    if (!res.ok) throw new Error(`fio ${res.status}`);
    const list = (await res.json()).accountStatement?.transactionList?.transaction ?? [];
    return list.map((t) => ({
      id: t.column22?.value,
      amount: Math.round((t.column1?.value ?? 0) * 100),
      currency: t.column14?.value,
      vs: t.column5?.value,
      message: t.column16?.value,
      payer: t.column10?.value,
      date: Date.parse(t.column0?.value) || Date.now(),
    }));
  },

  // Tatra banka Premium API (account information). Access requires registering an application at
  // https://developer.tatrabanka.sk and an OAuth consent from the account owner; the exact endpoints
  // and token flow get wired here once that access exists. Until then use BANK_PROVIDER=none and
  // confirm transfers from the admin screen (or use Fio).
  async tatra() {
    throw new Error('Tatra banka adapter is not connected yet (needs Premium API credentials)');
  },
};

export async function pollBank() {
  const fetchTx = providers[config.bank.provider];
  if (!fetchTx) return;
  try {
    for (const t of await fetchTx()) {
      if (!t.id || t.amount <= 0 || t.currency !== 'EUR') continue;
      recordPayment({
        source: config.bank.provider,
        externalId: t.id,
        amount: t.amount,
        currency: 'EUR',
        reference: [t.vs, t.message].filter(Boolean).join(' '),
        payer: t.payer,
        raw: t,
        receivedAt: t.date,
      });
    }
  } catch (e) {
    console.warn('bank poll failed:', e.message);
  }
}
