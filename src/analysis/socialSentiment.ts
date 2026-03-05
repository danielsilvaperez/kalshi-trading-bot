import axios from 'axios';

const SENTIMENT_API = 'https://api.twitter.com/2';
const CRYPTO_FEAR_GREED = 'https://api.alternative.me/fng/';

interface SentimentScore {
  overall: 'extreme_fear' | 'fear' | 'neutral' | 'greed' | 'extreme_greed';
  score: number; // 0-100
  source: string;
  timestamp: number;
}

/**
 * Fetch crypto fear & greed index
 */
export async function fetchFearGreedIndex(): Promise<SentimentScore | null> {
  try {
    const r = await axios.get(CRYPTO_FEAR_GREED, { timeout: 5000 });
    const data = r.data?.data?.[0];
    
    if (!data) return null;

    const value = parseInt(data.value);
    let sentiment: SentimentScore['overall'] = 'neutral';
    
    if (value <= 20) sentiment = 'extreme_fear';
    else if (value <= 40) sentiment = 'fear';
    else if (value >= 80) sentiment = 'extreme_greed';
    else if (value >= 60) sentiment = 'greed';

    return {
      overall: sentiment,
      score: value,
      source: 'fear_greed_index',
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Simple keyword-based sentiment from Reddit (r/Bitcoin, r/CryptoCurrency)
 * Uses Pushshift API
 */
export async function fetchRedditSentiment(): Promise<SentimentScore | null> {
  try {
    const r = await axios.get('https://api.pushshift.io/reddit/search/submission/', {
      params: {
        q: 'bitcoin',
        subreddit: 'Bitcoin,CryptoCurrency',
        sort: 'desc',
        sort_type: 'created_utc',
        size: 20,
      },
      timeout: 5000,
    });

    const posts = r.data?.data || [];
    let bullish = 0;
    let bearish = 0;

    const bullishWords = ['moon', 'bull', 'pump', ' ATH', 'breakout', 'accumulate', 'hodl'];
    const bearishWords = ['crash', 'dump', 'bear', 'short', 'sell', 'correction', 'capitulation'];

    for (const post of posts) {
      const title = (post.title || '').toLowerCase();
      const text = (post.selftext || '').toLowerCase();
      const combined = title + ' ' + text;

      if (bullishWords.some((w) => combined.includes(w))) bullish++;
      if (bearishWords.some((w) => combined.includes(w))) bearish++;
    }

    const total = bullish + bearish;
    if (total === 0) return null;

    const score = Math.round((bullish / total) * 100);
    let overall: SentimentScore['overall'] = 'neutral';
    if (score >= 70) overall = 'extreme_greed';
    else if (score >= 55) overall = 'greed';
    else if (score <= 30) overall = 'extreme_fear';
    else if (score <= 45) overall = 'fear';

    return {
      overall,
      score,
      source: 'reddit_sentiment',
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Combine multiple sentiment sources
 */
export async function getAggregateSentiment(): Promise<{
  consensus: SentimentScore['overall'];
  averageScore: number;
  sources: number;
  caution: boolean;
}> {
  const scores: SentimentScore[] = [];

  const fg = await fetchFearGearIndex();
  if (fg) scores.push(fg);

  const reddit = await fetchRedditSentiment();
  if (reddit) scores.push(reddit);

  if (scores.length === 0) {
    return { consensus: 'neutral', averageScore: 50, sources: 0, caution: false };
  }

  const avgScore = scores.reduce((s, r) => s + r.score, 0) / scores.length;
  
  let consensus: SentimentScore['overall'] = 'neutral';
  if (avgScore >= 75) consensus = 'extreme_greed';
  else if (avgScore >= 60) consensus = 'greed';
  else if (avgScore <= 25) consensus = 'extreme_fear';
  else if (avgScore <= 40) consensus = 'fear';

  // Caution when sentiment is extreme (contrarian signal)
  const caution = consensus === 'extreme_greed' || consensus === 'extreme_fear';

  return {
    consensus,
    averageScore: Math.round(avgScore),
    sources: scores.length,
    caution,
  };
}

function fetchFearGearIndex(): Promise<SentimentScore | null> {
  return fetchFearGreedIndex();
}
