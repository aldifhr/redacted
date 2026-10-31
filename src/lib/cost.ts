// Rough per-1M-token prices (USD). Used only for the in-chat meter.
const PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /gpt-4o-mini/i, input: 0.15, output: 0.6 },
  { match: /gpt-4o/i, input: 2.5, output: 10 },
  { match: /o4-mini/i, input: 1.1, output: 4.4 },
  { match: /claude.*opus/i, input: 15, output: 75 },
  { match: /claude.*haiku/i, input: 1, output: 5 },
  { match: /claude.*sonnet/i, input: 3, output: 15 },
];

export function estimateCost(model: string, inputTokens = 0, outputTokens = 0) {
  const price = PRICES.find((p) => p.match.test(model));
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

export function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
