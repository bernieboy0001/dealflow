import { createApp } from './app.js';

async function main() {
  const port = Number(process.env.PORT ?? 4173);
  const host = process.env.HOST ?? '127.0.0.1';
  const app = await createApp();
  app.listen(port, host, () => {
    console.log(`[dealflow] The Broker — pay-per-outcome agent on Agent OS`);
    console.log(`[dealflow] dashboard: http://${host}:${port}`);
  });
}

void main();
