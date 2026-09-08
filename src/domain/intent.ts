import { hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { recoverTypedDataAddress } from 'viem/utils';
import type { DealIntent, Side } from '../types.js';

export const DEALFLOW_DOMAIN = {
  name: 'Dealflow Broker',
  version: '1',
  chainId: baseSepolia.id,
  verifyingContract: '0x0000000000000000000000000000000000Dea11f',
} as const;

const types = {
  DealIntent: [
    { name: 'workerId', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'job', type: 'string' },
    { name: 'symbol', type: 'string' },
    { name: 'side', type: 'string' },
    { name: 'quantity', type: 'string' },
    { name: 'limitPriceMicro', type: 'uint256' },
    { name: 'maxNotionalAtomic', type: 'uint256' },
    { name: 'maxSlippageBps', type: 'uint16' },
    { name: 'feeAtomic', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'policyHash', type: 'bytes32' },
  ],
} as const;

export type TypedDealIntentData = {
  workerId: string;
  nonce: bigint;
  job: string;
  symbol: string;
  side: Side;
  quantity: string;
  limitPriceMicro: bigint;
  maxNotionalAtomic: bigint;
  maxSlippageBps: number;
  feeAtomic: bigint;
  deadline: bigint;
  policyHash: `0x${string}`;
};

export function toTyped(i: DealIntent): TypedDealIntentData {
  return {
    workerId: i.workerId,
    nonce: BigInt(i.nonce),
    job: i.job,
    symbol: i.symbol,
    side: i.side,
    quantity: BigInt(i.quantity).toString(),
    limitPriceMicro: BigInt(i.limitPriceMicro),
    maxNotionalAtomic: BigInt(i.maxNotionalAtomic),
    maxSlippageBps: i.maxSlippageBps,
    feeAtomic: BigInt(i.feeAtomic),
    deadline: BigInt(i.deadline),
    policyHash: `0x${i.policyHash}`,
  };
}

export function intentDigest(i: DealIntent): `0x${string}` {
  return hashTypedData({ domain: DEALFLOW_DOMAIN, types, primaryType: 'DealIntent', message: toTyped(i) });
}

export async function signIntent(i: DealIntent, privateKey: `0x${string}`): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  return account.signTypedData({
    domain: DEALFLOW_DOMAIN,
    types,
    primaryType: 'DealIntent',
    message: toTyped(i),
  });
}

/** Pure ecrecover of the EIP-712 signer — no RPC required. */
export async function recoverSigner(i: DealIntent, signature: `0x${string}`): Promise<`0x${string}`> {
  return recoverTypedDataAddress({
    domain: DEALFLOW_DOMAIN,
    types,
    primaryType: 'DealIntent',
    message: toTyped(i),
    signature,
  });
}

export function nonceFor(existing: number): number {
  return existing + 1;
}

export { baseSepolia };
