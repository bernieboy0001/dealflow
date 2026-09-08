import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';

createApp().listen(port, host, () => {
  console.log(`[dealflow] The Broker — pay-per-outcome agent on Agent OS`);
  console.log(`[dealflow] dashboard: http://${host}:${port}`);
});
