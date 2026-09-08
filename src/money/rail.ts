import { createHash, randomUUID } from 'node:crypto';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { toDecimal } from '../domain/money.js';

/**
 * x402 — HTTP 402 "Payment Required" for agents (spec v2, x402-foundation).
 *
 * Wire shape implemented here:
 *   server  -> 402 + `PAYMENT-REQUIRED`   header (base64 PaymentRequired, accepts[])
 *   client  -> retry + `PAYMENT-SIGNATURE` header (base64 PaymentPayload, EIP-712 signed)
 *   server  -> 200 + `PAYMENT-RESPONSE`    header (base64 SettlementResponse)
 *
 * Scheme used: `upto` on eip155:84532 — the principal authorizes a maximum, the
 * broker is charged only what the verified work actually cost. Settlement here
 * is via the facilitator interface (/verify read-only, /settle) with a local
 * double for the demo; swapping in the public facilitator + a funded Base Sepolia
 * USDC account is a configuration change.
 */

export const BASE_SEPOLIA_NETWORK = 'eip155:84532';
/** USDC on Base (the canonical 0x8335…2913). Swap for the Sepolia test USDC token
 *  when settling against the public facilitator on testnet. */
export const USDC_TEST_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const CHAIN_ID = baseSepolia.id;

export interface PaymentRequirement {
  scheme: 'upto' | 'exact';
  network: string;
  /** MAX authorized amount, atomic units */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface ResourceInfo {
  protocol: string;
  resource: string;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirement[];
  extensions?: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirement & { amountActual: string };
  payload: {
    signedAt: number;
    expiresAt: number;
    authorization: string; // EIP-712 signature
    nonce: string;
  };
  extensions?: Record<string, unknown>;
}

export interface SettlementResponse {
  x402Version: number;
  status: 'verified' | 'settled' | 'failed';
  txHash?: string;
  details?: string;
}

const X402_DOMAIN = {
  name: 'x402',
  version: '2',
  chainId: CHAIN_ID,
  verifyingContract: USDC_TEST_ASSET,
} as const;

const x402Types = {
  Authorization: [
    { name: 'resource', type: 'string' },
    { name: 'scheme', type: 'string' },
    { name: 'network', type: 'string' },
    { name: 'asset', type: 'address' },
    { name: 'payTo', type: 'address' },
    { name: 'maxAmount', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const;

// ---------- server side: require and accept payment ----------

export function buildPaymentRequired(opts: {
  resource: string;
  payTo: string;
  maxAmountAtomic: bigint;
  scheme?: 'upto' | 'exact';
  network?: string;
  decimals?: number;
}): PaymentRequired {
  const scheme = opts.scheme ?? 'upto';
  return {
    x402Version: 2,
    resource: { protocol: 'x402', resource: opts.resource },
    accepts: [
      {
        scheme,
        network: opts.network ?? BASE_SEPOLIA_NETWORK,
        amount: opts.maxAmountAtomic.toString(),
        asset: USDC_TEST_ASSET,
        payTo: opts.payTo,
        maxTimeoutSeconds: 300,
        extra: {
          paymentFlow: 'authorization', // verify before handler, settle after delivery
          assetTransferMethod: 'eip3009',
          decimals: opts.decimals ?? 6,
        },
      },
    ],
  };
}

export function encodePaymentRequired(req: PaymentRequired): string {
  return Buffer.from(JSON.stringify(req), 'utf8').toString('base64');
}

export function decodePaymentRequired(header: string): PaymentRequired {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentRequired;
}

// ---------- client side: pay for a protected resource ----------

export function signAuthorization(params: {
  signerPrivateKey: `0x${string}`;
  req: PaymentRequired;
  amountAtomic: bigint;
  resource?: string;
}): Promise<{ payload: PaymentPayload; expiresAt: number }> {
  const account = privateKeyToAccount(params.signerPrivateKey);
  const accepted = params.req.accepts[0]!;
  const nonce = createHash('sha256').update(randomUUID()).digest('hex').slice(0, 8);
  const signedAt = Math.floor(Date.now() / 1000);
  const expiresAt = signedAt + accepted.maxTimeoutSeconds + 30;
  const message = {
    resource: params.resource ?? params.req.resource.resource,
    scheme: accepted.scheme,
    network: accepted.network,
    asset: accepted.asset as `0x${string}`,
    payTo: accepted.payTo as `0x${string}`,
    maxAmount: BigInt(accepted.amount),
    amount: params.amountAtomic,
    nonce: BigInt(`0x${nonce}`),
    expiresAt: BigInt(expiresAt),
  };
  return account
    .signTypedData({
      domain: X402_DOMAIN,
      types: x402Types,
      primaryType: 'Authorization',
      message,
    })
    .then((authorization) => {
      const payload: PaymentPayload = {
        x402Version: 2,
        resource: params.req.resource,
        accepted: { ...accepted, amountActual: params.amountAtomic.toString() },
        payload: { signedAt, expiresAt, authorization, nonce },
      };
      return { payload, expiresAt };
    });
}

export function encodePaymentPayload(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function decodePaymentPayload(header: string): PaymentPayload {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentPayload;
}

// ---------- facilitator: read-only verify + state-committing settle ----------

export interface Facilitator {
  verify(payload: PaymentPayload): Promise<{ ok: boolean; reason?: string }>;
  settle(payload: PaymentPayload): Promise<SettlementResponse>;
}

/**
 * Local facilitator double: validates the EIP-712 authorization off-chain,
 * then "settles" a demo USDC transfer. Mirrors the x402 facilitator contract
 * (/verify never commits, /settle commits) — swap this for a live facilitator
 * + on-chain USDC to go real.
 */
export class LocalFacilitator implements Facilitator {
  private readonly used = new Set<string>();
  private readonly settled: { txHash: string; amount: string; payTo: string; payer: string }[] = [];

  constructor(private readonly principal: `0x${string}`) {}

  async verify(payload: PaymentPayload): Promise<{ ok: boolean; reason?: string }> {
    const a = payload.accepted;
    const p = payload.payload;
    const actual = BigInt(a.amountActual ?? '0');
    const max = BigInt(a.amount);
    if (actual > max) return { ok: false, reason: 'amount exceeds authorized max' };
    if (p.expiresAt < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'authorization expired' };
    if (this.used.has(p.nonce)) return { ok: false, reason: 'replay: nonce already used' };
    const message = {
      resource: payload.resource?.resource ?? '',
      scheme: a.scheme,
      network: a.network,
      asset: a.asset as `0x${string}`,
      payTo: a.payTo as `0x${string}`,
      maxAmount: max,
      amount: actual,
      nonce: BigInt(`0x${p.nonce}`),
      expiresAt: BigInt(p.expiresAt),
    };
    const signer = await recoverTypedDataAddress({
      domain: X402_DOMAIN,
      types: x402Types,
      primaryType: 'Authorization',
      message,
      signature: p.authorization as `0x${string}`,
    });
    if (signer.toLowerCase() !== this.principal.toLowerCase()) {
      return { ok: false, reason: `authorization signed by unexpected party ${signer}` };
    }
    return { ok: true };
  }

  async settle(payload: PaymentPayload): Promise<SettlementResponse> {
    const check = await this.verify(payload);
    if (!check.ok) return { x402Version: 2, status: 'failed', details: check.reason };
    const actual = BigInt(payload.accepted.amountActual ?? '0');
    // deterministic testnet tx hash from the settlement intent
    const txHash = ('0x' +
      createHash('sha256')
        .update(
          JSON.stringify({
            nonce: payload.payload.nonce,
            amount: actual.toString(),
            payTo: payload.accepted.payTo,
          }),
        )
        .digest('hex')) as `0x${string}`;
    this.used.add(payload.payload.nonce);
    this.settled.push({
      txHash,
      amount: actual.toString(),
      payTo: payload.accepted.payTo,
      payer: this.principal,
    });
    return { x402Version: 2, status: 'settled', txHash };
  }

  settledCount(): number {
    return this.settled.length;
  }
}

export const x402Metrics = { toDecimal };
