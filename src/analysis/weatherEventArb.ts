import axios from 'axios';

const OPENWEATHER_KEY = process.env.OPENWEATHER_API_KEY || '';

interface WeatherEvent {
  type: 'storm' | 'flood' | 'cold' | 'heat';
  location: string;
  severity: 'minor' | 'moderate' | 'severe';
  miningImpact: number; // 0-1 likelihood of hashrate drop
}

/**
 * Check for extreme weather in major mining regions
 * Could affect BTC hashrate and thus price
 */
export async function checkMiningWeather(): Promise<WeatherEvent[]> {
  const miningRegions = [
    { name: 'Texas', lat: 31.0, lon: -100.0, hashrateShare: 0.15 },
    { name: 'Kazakhstan', lat: 48.0, lon: 68.0, hashrateShare: 0.18 },
    { name: 'Inner Mongolia', lat: 44.0, lon: 113.0, hashrateShare: 0.10 },
  ];

  const events: WeatherEvent[] = [];

  if (!OPENWEATHER_KEY) {
    // Return empty if no API key
    return events;
  }

  for (const region of miningRegions) {
    try {
      const r = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
        params: {
          lat: region.lat,
          lon: region.lon,
          appid: OPENWEATHER_KEY,
        },
        timeout: 5000,
      });

      const weather = r.data?.weather?.[0]?.main || '';
      const temp = r.data?.main?.temp || 273; // Kelvin

      // Check for extreme conditions
      if (weather.includes('Storm') || weather.includes('Thunder')) {
        events.push({
          type: 'storm',
          location: region.name,
          severity: 'moderate',
          miningImpact: region.hashrateShare * 0.3,
        });
      }

      // Extreme cold can affect mining operations
      if (temp < 243) { // -30C
        events.push({
          type: 'cold',
          location: region.name,
          severity: 'severe',
          miningImpact: region.hashrateShare * 0.2,
        });
      }
    } catch {
      continue;
    }
  }

  return events;
}

/**
 * Check for major events that could affect hashrate
 * Kazakhstan political unrest, China bans, etc.
 */
export async function checkHashrateEvents(): Promise<{
  riskDetected: boolean;
  events: string[];
  estimatedHashrateDrop: number;
} > {
  // This would connect to news APIs in production
  // Simplified for now

  const events: string[] = [];
  let drop = 0;

  // Hardcoded examples (would be dynamic)
  // if (isKazakhstanUnrest()) {
  //   events.push('Kazakhstan political unrest');
  //   drop += 0.15;
  // }

  return {
    riskDetected: events.length > 0,
    events,
    estimatedHashrateDrop: drop,
  };
}

/**
 * Calculate hashrate arbitrage signal
 * If hashrate likely to drop = BTC may pump (supply shock)
 */
export function hashrateToSignal(
  weatherEvents: WeatherEvent[],
  hashrateEvents: { riskDetected: boolean; estimatedHashrateDrop: number },
): { signal: 'up' | 'down' | 'neutral'; confidence: number; reason: string } {
  const weatherImpact = weatherEvents.reduce((sum, e) => sum + e.miningImpact, 0);
  const totalImpact = weatherImpact + hashrateEvents.estimatedHashrateDrop;

  if (totalImpact > 0.1) {
    return {
      signal: 'up',
      confidence: Math.min(0.7, totalImpact),
      reason: `Potential hashrate drop: ${(totalImpact * 100).toFixed(1)}%`,
    };
  }

  return { signal: 'neutral', confidence: 0, reason: 'No hashrate risks' };
}
