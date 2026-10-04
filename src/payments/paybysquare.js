import { encode, PaymentOptions, CurrencyCode } from 'bysquare/pay';
import QRCode from 'qrcode';
import { config } from '../config.js';

// PAY by square: the guest scans this in any Slovak banking app; IBAN, amount and
// variable symbol (= ticket code) are pre-filled, so the bank statement tells us which ticket was paid.
export async function payBySquare(ticket, eventTitle) {
  const { iban, bic, beneficiary } = config.payBySquare;
  if (!iban) return null;
  const qr = encode({
    payments: [
      {
        type: PaymentOptions.PaymentOrder,
        amount: ticket.price / 100,
        currencyCode: CurrencyCode.EUR,
        variableSymbol: ticket.code,
        paymentNote: `Filthy ${ticket.code} ${eventTitle}`.slice(0, 140),
        beneficiary: { name: beneficiary },
        bankAccounts: [{ iban: iban.replace(/\s/g, ''), ...(bic ? { bic } : {}) }],
      },
    ],
  });
  return {
    svg: await QRCode.toString(qr, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
    iban,
    beneficiary,
    amount: ticket.price,
    variable_symbol: ticket.code,
  };
}
