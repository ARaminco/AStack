const moscowOrder = { must: 0, should: 1, could: 2, wont: 3 };

export function wsjfScore({ businessValue, timeCriticality, riskReduction, jobSize }) {
  const size = Number(jobSize);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("WSJF requires jobSize > 0");
  }
  const costOfDelay = Number(businessValue ?? 0) + Number(timeCriticality ?? 0) + Number(riskReduction ?? 0);
  return round(costOfDelay / size);
}

export function riceScore({ reach, impact, confidence, effort }) {
  const cost = Number(effort);
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new Error("RICE requires effort > 0");
  }
  return round((Number(reach ?? 0) * Number(impact ?? 0) * Number(confidence ?? 1)) / cost);
}

export function itemPriority(item) {
  const moscow = moscowOrder[item.moscow] ?? moscowOrder.should;
  const wsjf = item.wsjf ? wsjfScore(item.wsjf) : 0;
  const rice = item.rice ? riceScore(item.rice) : 0;
  return { moscow, wsjf, rice };
}

export function rankBacklog(items) {
  return items
    .map((item) => ({ item, priority: itemPriority(item) }))
    .sort((a, b) =>
      a.priority.moscow - b.priority.moscow ||
      b.priority.wsjf - a.priority.wsjf ||
      b.priority.rice - a.priority.rice ||
      String(a.item.id).localeCompare(String(b.item.id)))
    .map(({ item, priority }) => ({ ...item, priority }));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
