export interface LiveOrderRequest {
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  count: number;
  price: number;
  type?: 'limit';
  time_in_force?: 'ioc' | 'gtc';
}

export interface LiveOrderResponse {
  ok: boolean;
  orderId?: string;
  raw?: unknown;
  error?: string;
}
