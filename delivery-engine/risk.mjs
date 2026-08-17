const bands = [
  { min: 16, band: "critical", response: "avoid" },
  { min: 9, band: "high", response: "mitigate" },
  { min: 4, band: "medium", response: "mitigate" },
  { min: 0, band: "low", response: "accept" }
];

export function riskScore(risk) {
  const probability = clampScale(risk.probability, "probability");
  const impact = clampScale(risk.impact, "impact");
  const score = probability * impact;
  const { band, response } = bands.find((entry) => score >= entry.min);
  return { score, band, suggestedResponse: risk.response ?? response };
}

export function rankRisks(risks) {
  return risks
    .map((risk) => ({ ...risk, ...riskScore(risk) }))
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

export function riskExposure(risks) {
  const open = risks.filter((risk) => risk.status !== "closed");
  if (!open.length) {
    return { open: 0, exposure: 0, worst: null };
  }
  const scored = rankRisks(open);
  const exposure = scored.reduce((sum, risk) => sum + risk.score, 0) / (open.length * 25);
  return { open: open.length, exposure: Math.round(exposure * 100) / 100, worst: scored[0] };
}

function clampScale(value, label) {
  const scale = Number(value);
  if (!Number.isInteger(scale) || scale < 1 || scale > 5) {
    throw new Error("Risk " + label + " must be an integer between 1 and 5");
  }
  return scale;
}
