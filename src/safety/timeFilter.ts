import { readFileSync, existsSync } from 'node:fs';

// Avoid low-liquidity periods
interface TimeFilter {
  canTrade: boolean;
  reason?: string;
  quality: 'high' | 'medium' | 'low';
}

export function checkTimeFilter(now = new Date()): TimeFilter {
  const hour = now.getHours();
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday
  const month = now.getMonth();
  const date = now.getDate();

  // Weekend check
  if (day === 0 || day === 6) {
    return { canTrade: false, reason: 'weekend', quality: 'low' };
  }

  // Major holidays (simplified)
  const isHoliday = checkHoliday(month, date);
  if (isHoliday) {
    return { canTrade: false, reason: 'holiday', quality: 'low' };
  }

  // Time of day (EST)
  if (hour < 8 || hour >= 20) {
    // Before 8am or after 8pm EST
    return { canTrade: false, reason: `off-hours (${hour}:00 EST)`, quality: 'low' };
  }

  // Lunch dip (12-1pm EST) - lower quality but still trade
  if (hour === 12) {
    return { canTrade: true, quality: 'medium' };
  }

  // Best hours: 9:30am - 11:30am and 2pm - 4pm
  if ((hour >= 9 && hour <= 11) || (hour >= 14 && hour <= 16)) {
    return { canTrade: true, quality: 'high' };
  }

  return { canTrade: true, quality: 'medium' };
}

function checkHoliday(month: number, date: number): boolean {
  // Simplified US market holidays
  const holidays = [
    { month: 0, date: 1 },   // New Year's
    { month: 6, date: 4 },   // Independence Day
    { month: 11, date: 25 }, // Christmas
  ];

  // Check for MLK Day, Presidents Day, etc (3rd Monday of month)
  // Memorial Day (last Monday of May)
  // Labor Day (1st Monday of September)
  // Thanksgiving (4th Thursday of November)

  return holidays.some((h) => h.month === month && h.date === date);
}

export function applyTimeQualityModifier(baseSpend: number, quality: 'high' | 'medium' | 'low'): number {
  switch (quality) {
    case 'high': return Math.min(100, Math.floor(baseSpend * 1.2));
    case 'medium': return baseSpend;
    case 'low': return Math.floor(baseSpend * 0.5);
  }
}
