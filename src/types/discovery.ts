export interface DiscoverOptions {
  contains?: string;
  minSecondsToExpiry?: number;
}

export interface DiscoveredMarket {
  ticker: string;
  title?: string;
  expirationTime?: string;
  secondsToExpiry: number;
}
