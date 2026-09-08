import type { Request, Response } from 'express';
import { createApp } from '../vercel-dist/app.js';

/** The app is async now (it pulls state from the durable store at boot). Build
 *  it once per warm instance, then run each request through it. */
let appPromise: Promise<ReturnType<typeof createApp>> | null = null;

export default async function handler(req: Request, res: Response) {
  appPromise ??= createApp();
  const app = await appPromise;
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    res.on('finish', done);
    res.on('close', done);
    app(req, res);
  });
}