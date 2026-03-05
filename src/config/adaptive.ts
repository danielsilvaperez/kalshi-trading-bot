export interface AdaptiveConfig {
  minEvCents: number;
  highPriceMinConfidence: number;
  maxSpendCents: number;
}

export const DEFAULT_ADAPTIVE: AdaptiveConfig = {
  minEvCents: 2,
  highPriceMinConfidence: 0.9,
  maxSpendCents: 100,
};
