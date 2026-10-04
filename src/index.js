import { config } from './config.js';
import { buildServer } from './server.js';
import { startBot, sendReminders } from './bot.js';
import { expireReservations } from './tickets.js';
import { pollBank } from './payments/bank.js';
import { pollMonoStatement, registerMonoWebhook } from './payments/monobank.js';

const app = await buildServer();
await app.listen({ port: config.port, host: '0.0.0.0' });

const https = config.publicUrl.startsWith('https://');
await startBot({ webhook: https && process.env.BOT_POLLING !== '1' }).catch((e) => console.error('bot start failed:', e.message));
if (https && config.monobank.token) {
  await registerMonoWebhook(`${config.publicUrl}/hooks/monobank/${config.monobank.webhookSecret}`).catch((e) => console.error(e.message));
}

const every = (sec, fn) => setInterval(() => Promise.resolve(fn()).catch((e) => console.error(e)), sec * 1000);
every(60, expireReservations);
every(Math.max(30, config.bank.pollSeconds), pollBank);
every(10 * 60, pollMonoStatement);
every(10 * 60, sendReminders);
