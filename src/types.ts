export type Side = 'buy' | 'sell';

export type DealStatus =
  | 'proposing'
  | 'proposed'
  | 'approved' // human signed the intent
  | 'executing'
  | 'executed'
  | 'verified' // auditor green
  | 'settled' // payment released
  | 'rejected'
  | 'cancelled'
  | 'failed';

export interface Positions {
  /** symbol -> balance in asset whole units (e.g. "0.5" BTC) */
  balances: { [symbol: string]: string };
  /** symbol -> USD notional */
  valuesUsd: { [symbol: string]: string };
  cashAtomic: string;
  baseCurrency: string;
  fetchedAt: string;
}

export interface Subaccount {
  id: string;
  positions(symbols: string[]): Promise<Positions>;
  execute(receipts: Receipt[]): Promise<Receipt[]>;
  cashReservedAtomic(): bigint;
}

export interface MarketQuote {
  symbol: string;
  /** reference price in USD, human decimals */
  price: string;
  /** bid in USD */
  bid: string;
  /** ask in USD */
  ask: string;
  /** 24h change percent */
  changePct: string;
  source: 'binance' | 'fixture';
  at: string;
}

export interface OrderSpec {
  symbol: string;
  side: Side;
  quantity: string;
  limitPriceMicro: string;
  maxSlippageBps: number;
  clientOrderId: string;
}

export interface Receipt {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  quantity: string;
  priceMicro: string;
  feeMicro: string;
  status: 'filled' | 'partial' | 'rejected';
  txRef: string;
  at: string;
}

export interface DealProposal {
  workerId: string;
  nonce: number;
  job: string;
  orders: OrderSpec[];
  maxNotionalAtomic: string;
  maxFeeAtomic: string;
  expectedFeeAtomic: string;
  maxSlippageBps: number;
  targetWeights: { [symbol: string]: string };
  beforeWeights: { [symbol: string]: string };
  feeAtomic: string; // price of this deal (worker fee, USDC atomic) -> paid via x402
  expiresAt: string;
  policyHash: string;
  summaryLines: string[];
}

export interface Deal extends DealProposal {
  id: string;
  status: DealStatus;
  intent?: DealIntent;
  signature?: string;
  signer?: string;
  receipts: Receipt[];
  audit?: AuditVerdict;
  payment?: PaymentRecord;
  createdAt: string;
  updatedAt: string;
}

export interface DealIntent {
  workerId: string;
  nonce: number;
  job: string;
  symbol: string;
  side: Side;
  quantity: string;
  limitPriceMicro: string;
  maxNotionalAtomic: string;
  maxSlippageBps: number;
  feeAtomic: string;
  deadline: number;
  policyHash: string;
}

export interface AuditVerdict {
  auditorId: string;
  passed: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
  signedBy: string;
  signature: string;
  at: string;
}

export interface PaymentRecord {
  rail: 'x402';
  scheme: 'upto' | 'exact';
  network: string;
  amountAtomic: string;
  payTo: string;
  signature: string;
  txHash: string;
  settledAt: string;
}
