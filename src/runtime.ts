import { privateKeyToAccount } from 'viem/accounts';
import { type Seed, VirtualSubaccount } from './account.js';
import { Auditor } from './agent/auditor.js';
import { Broker } from './agent/broker.js';
import { signIntent } from './domain/intent.js';
import { Ledger, localPath } from './ledger.js';
import { BinanceMarket } from './market.js';
import { Orchestrator } from './orchestrator.js';
import { durableStoreFromEnv, STATE_KEYS } from './storage.js';

export const DEMO_PRINCIPAL_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const; // hardhat/anvil #1 — demo ONLY
export const DEMO_WORKER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const; // anvil #2 — demo ONLY, worker fee destination

export interface Runtime {
  market: BinanceMarket;
  subaccount: VirtualSubaccount;
  broker: Broker;
  auditor: Auditor;
  orchestrator: Orchestrator;
  ledger: Ledger;
}

export async function buildRuntime(opts: { seed?: Seed } = {}): Promise<Runtime> {
  const store = durableStoreFromEnv();
  const market = new BinanceMarket({ useLive: process.env.DEALFLOW_LIVE_MARKET === '1' });
  const subaccount = await VirtualSubaccount.create({
    market,
    seed: opts.seed,
    stateFile: localPath('dealflow', 'account.json'),
    store,
    storeKey: STATE_KEYS.account,
  });
  const workerKey = (process.env.DEALFLOW_WORKER_KEY as `0x${string}`) ?? DEMO_WORKER_KEY;
  const principalKey = (process.env.DEALFLOW_PRINCIPAL_KEY as `0x${string}`) ?? DEMO_PRINCIPAL_KEY;

  const ledger = await Ledger.loadDurable(store, localPath('dealflow', 'ledger.json'), STATE_KEYS.ledger);
  const broker = new Broker(subaccount, {
    workerId: 'broker-1',
    market,
    feeUsdc: process.env.DEALFLOW_FEE_USDC ?? '12.50',
  });
  const auditor = new Auditor({ auditorId: 'auditor-1', privateKey: workerKey });
  const orchestrator = await Orchestrator.create({
    broker,
    auditor,
    subaccount,
    principalPrivateKey: principalKey,
    workerPayTo: (process.env.DEALFLOW_WORKER_PAY_TO as string) ?? addressOf(workerKey),
    ledger,
    dealsFile: localPath('dealflow', 'deals.json'),
    store,
  });
  return { market, subaccount, broker, auditor, orchestrator, ledger };
}

export function addressOf(privateKey: `0x${string}`): string {
  return privateKeyToAccount(privateKey).address;
}

export function signDeal(dealId: string, runtime: Runtime): Promise<string> {
  const deal = runtime.orchestrator.get(dealId);
  if (!deal) throw new Error('unknown deal');
  const intent = runtime.orchestrator.intentFor(deal, 0);
  return signIntent(intent, (process.env.DEALFLOW_PRINCIPAL_KEY as `0x${string}`) ?? DEMO_PRINCIPAL_KEY);
}
