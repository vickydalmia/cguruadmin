export type CouponConcurrencyBudget = {
  preparation: number;
  batches: number;
  reserved: number;
};

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function allocateWorkerConcurrency(input: {
  poolMax: number;
  requested: number;
  reserve?: number;
  maximum?: number;
}): number {
  const poolMax = positiveInteger(input.poolMax, 4);
  const requested = positiveInteger(input.requested, 1);
  const reserve = Math.max(0, input.reserve ?? 2);
  const maximum = positiveInteger(input.maximum ?? requested, requested);
  return Math.max(1, Math.min(requested, maximum, poolMax - reserve));
}

/**
 * Keep every possible Coupon PostgreSQL acquisition inside one pool budget.
 * Preparation can touch PostgreSQL through content-media and taxonomy lookup,
 * while each active batch pins one transaction client until commit.
 */
export function allocateCouponConcurrency(input: {
  poolMax: number;
  requestedPreparation: number;
  requestedBatches: number;
  reserve?: number;
}): CouponConcurrencyBudget {
  const poolMax = positiveInteger(input.poolMax, 4);
  const requestedPreparation = positiveInteger(input.requestedPreparation, 1);
  const requestedBatches = positiveInteger(input.requestedBatches, 1);
  const requestedReserve = Math.max(0, input.reserve ?? 2);
  const reserved = Math.min(requestedReserve, Math.max(0, poolMax - 2));
  const workerBudget = Math.max(2, poolMax - reserved);
  const batches = Math.min(requestedBatches, Math.max(1, workerBudget - 1));
  const preparation = Math.min(
    requestedPreparation,
    Math.max(1, workerBudget - batches),
  );

  return { preparation, batches, reserved };
}
