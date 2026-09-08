import type { MarketQuote } from './types.js';

/**
 * Market data adapter. Live source = Binance public REST (no keys). Falls back
 * to a seeded fixture so the demo runs offline or without network access.
 */
export interface MarketSource {
  quote(symbol: string): Promise<MarketQuote>;
  quotes(symbols: string[]): Promise<MarketQuote[]>;
}

const FIXTURE: Record<string, MarketQuote> = {
  BTC: {
    symbol: 'BTC',
    price: '84120.5',
    bid: '84118.2',
    ask: '84123.1',
    changePct: '1.42',
    source: 'binance',
    at: '',
  },
  ETH: {
    symbol: 'ETH',
    price: '3152.44',
    bid: '3151.9',
    ask: '3153.0',
    changePct: '-0.31',
    source: 'binance',
    at: '',
  },
  SOL: {
    symbol: 'SOL',
    price: '186.73',
    bid: '186.6',
    ask: '186.88',
    changePct: '2.05',
    source: 'binance',
    at: '',
  },
};

export class BinanceMarket implements MarketSource {
  private readonly base = 'https://api.binance.com';
  private readonly useLive: boolean;

  constructor(opts: { useLive?: boolean } = {}) {
    this.useLive = opts.useLive ?? false;
  }

  async quote(symbol: string): Promise<MarketQuote> {
    if (!this.useLive) return fixtureQuote(symbol);
    try {
      const ticker = (await fetch(`${this.base}/api/v3/ticker/bookTicker?symbol=${symbol}USDT`).then((r) =>
        r.json(),
      )) as {
        bidPrice: string;
        askPrice: string;
      };
      const change = (await fetch(`${this.base}/api/v3/ticker/24hr?symbol=${symbol}USDT`).then((r) =>
        r.json(),
      )) as {
        priceChangePercent: string;
      };
      return {
        symbol,
        price: mid(ticker.bidPrice, ticker.askPrice),
        bid: ticker.bidPrice,
        ask: ticker.askPrice,
        changePct: change.priceChangePercent,
        source: 'binance',
        at: new Date().toISOString(),
      };
    } catch {
      return fixtureQuote(symbol);
    }
  }

  async quotes(symbols: string[]): Promise<MarketQuote[]> {
    return Promise.all(symbols.map((s) => this.quote(s)));
  }
}

function mid(bid: string, ask: string): string {
  return String((Number(bid) + Number(ask)) / 2);
}

export function fixtureQuote(symbol: string): MarketQuote {
  const q = FIXTURE[symbol];
  if (!q) throw new Error(`no market fixture for ${symbol}`);
  return { ...q, at: new Date().toISOString() };
}
