import axios from 'axios';

// Major economic events that cause volatility
const HIGH_IMPACT_EVENTS = [
  'FOMC', 'Fed', 'CPI', 'PPI', 'NFP', 'Non-Farm', 'Unemployment',
  'GDP', 'ECB', 'BOE', 'SNB', 'RBA', 'BOC', 'PMI', 'ISM',
  'Retail Sales', 'Consumer Confidence', 'Housing Starts',
];

interface Event {
  title: string;
  time: string;
  impact: 'high' | 'medium' | 'low';
  currency: string;
}

/**
 * Check for upcoming high-impact events
 * Uses Forex Factory or similar API
 */
export async function checkUpcomingEvents(): Promise<{
  shouldPause: boolean;
  events: Event[];
  reason?: string;
}> {
  try {
    // Using Forex Factory calendar API (simplified)
    // In production, use proper API with authentication
    const resp = await axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      timeout: 5000,
    });

    const events: Event[] = resp.data || [];
    const now = new Date();

    const upcoming = events.filter((e: any) => {
      const eventTime = new Date(e.date + 'T' + e.time);
      const diff = eventTime.getTime() - now.getTime();
      return diff > 0 && diff < 900000; // Within 15 minutes
    });

    const highImpact = upcoming.filter((e: any) =>
      HIGH_IMPACT_EVENTS.some((keyword) => e.title.toUpperCase().includes(keyword.toUpperCase()))
    );

    if (highImpact.length > 0) {
      return {
        shouldPause: true,
        events: highImpact,
        reason: `High impact events: ${highImpact.map((e) => e.title).join(', ')}`,
      };
    }

    return { shouldPause: false, events: [] };
  } catch {
    // If API fails, check system time for known events
    const now = new Date();
    const hour = now.getHours();
    const min = now.getMinutes();
    const day = now.getDay();

    // FOMC usually 2:00 PM EST on Wednesdays
    if (day === 3 && hour === 13 && min >= 50) {
      return { shouldPause: true, events: [{ title: 'FOMC Potential', time: '14:00', impact: 'high', currency: 'USD' }], reason: 'FOMC window' };
    }

    return { shouldPause: false, events: [] };
  }
}

/**
 * Check if we should pause trading due to news
 */
export async function newsFilter(): Promise<{ canTrade: boolean; reason?: string }> {
  const events = await checkUpcomingEvents();

  if (events.shouldPause) {
    return { canTrade: false, reason: `NEWS BLOCK: ${events.reason}` };
  }

  return { canTrade: true };
}
