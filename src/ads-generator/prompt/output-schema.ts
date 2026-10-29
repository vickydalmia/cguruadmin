import { z } from 'zod';
import type { GeneratedAd } from '../../constants/ads-generator';

// Shape the model must return (sent as a strict JSON schema). Counts and
// lengths are NOT encoded here: strict mode does not reliably support them,
// and ../validate-creative.ts checks them with precise repair messages.

/** Declared by hand: z.infer degrades to `unknown` under this repo's `strict: false`. */
export type AdsModelOutput = {
  status: 'ready' | 'insufficient_evidence';
  reason: string;
  ads: GeneratedAd[];
  warnings: string[];
};

export const ADS_OUTPUT_SCHEMA: z.ZodType<AdsModelOutput> = z.object({
  status: z.enum(['ready', 'insufficient_evidence']),
  reason: z.string(),
  ads: z.array(
    z.object({
      headlines: z.array(z.string()),
      descriptions: z.array(z.string()),
    }),
  ),
  warnings: z.array(z.string()),
}) as z.ZodType<AdsModelOutput>;
