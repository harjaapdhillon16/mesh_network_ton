function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseEtaSeconds(eta) {
  if (typeof eta !== 'string') return 0;
  const s = eta.trim().toLowerCase();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs)?$/);
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2] || 's';
  if (!Number.isFinite(value)) return 0;
  if (unit === 'ms') return value / 1000;
  if (unit.startsWith('m')) return value * 60;
  if (unit.startsWith('h')) return value * 3600;
  return value;
}

function normalize(values) {
  const nums = values.map((v) => toNum(v));
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return nums.map(() => 1);
  }
  return nums.map((n) => (n - min) / (max - min));
}

export async function scoreOffers(intent, offers, options = {}) {
  const weights = {
    reputation: options.reputationWeight ?? 0.5,
    fee: options.feeWeight ?? 0.3,
    speed: options.speedWeight ?? 0.2,
  };
  const getReputation = options.getReputation || (async (address, offer) => offer.reputation ?? 100);

  if (!Array.isArray(offers) || offers.length === 0) return [];

  const enriched = [];
  for (const offer of offers) {
    const liveReputation = await getReputation(offer.fromAddress || offer.from, offer);
    enriched.push({
      ...offer,
      _liveReputation: Number.isFinite(liveReputation) ? liveReputation : (offer.reputation ?? 100),
      _feeNum: toNum(offer.fee),
      _etaSeconds: parseEtaSeconds(offer.eta),
      _stakeAgeSeconds: toNum(offer.stakeAgeSeconds),
    });
  }

  const repNorm = normalize(enriched.map((o) => o._liveReputation));
  const feeNorm = normalize(enriched.map((o) => o._feeNum));
  const speedNorm = normalize(enriched.map((o) => {
    const eta = o._etaSeconds;
    return eta === 0 ? Number.MAX_SAFE_INTEGER : 1 / eta;
  }));

  return enriched.map((offer, i) => {
    const score =
      (weights.reputation * repNorm[i]) +
      (weights.fee * (1 - feeNorm[i])) +
      (weights.speed * speedNorm[i]);

    return {
      ...offer,
      intentId: offer.intentId || intent?.id,
      liveReputation: offer._liveReputation,
      score: Number(score.toFixed(4)),
      breakdown: {
        reputation: Number((weights.reputation * repNorm[i]).toFixed(4)),
        fee: Number((weights.fee * (1 - feeNorm[i])).toFixed(4)),
        speed: Number((weights.speed * speedNorm[i]).toFixed(4)),
      },
    };
  });
}

export function pickBestOffer(scoredOffers, options = {}) {
  if (!Array.isArray(scoredOffers) || scoredOffers.length === 0) return null;
  const tieWindow = options.tieWindow ?? 0.05;

  const sorted = scoredOffers.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.liveReputation || 0) - (a.liveReputation || 0);
  });

  const best = sorted[0];
  const competitors = sorted.filter((o) => Math.abs((best.score || 0) - (o.score || 0)) <= tieWindow);
  if (competitors.length === 1) return best;

  competitors.sort((a, b) => {
    if ((b._stakeAgeSeconds || 0) !== (a._stakeAgeSeconds || 0)) {
      return (b._stakeAgeSeconds || 0) - (a._stakeAgeSeconds || 0);
    }
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  return competitors[0];
}

export async function rankOffers(intent, offers, options = {}) {
  const scored = await scoreOffers(intent, offers, options);
  return scored.slice().sort((a, b) => b.score - a.score);
}
