import { asSchema, zodSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { validOutput } from '../__fixtures__/ads-fixtures';
import { ADS_OUTPUT_SCHEMA } from './output-schema';

describe('ADS_OUTPUT_SCHEMA', () => {
  it('converts to a JSON schema OpenAI strict mode accepts', async () => {
    const json = (await asSchema(zodSchema(ADS_OUTPUT_SCHEMA as any)).jsonSchema) as any;
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(['status', 'reason', 'ads', 'warnings']);
    expect(json.properties.ads.items.additionalProperties).toBe(false);
    expect(json.properties.ads.items.required).toEqual(['headlines', 'descriptions']);
  });

  it('parses a valid answer and rejects an unknown status', () => {
    expect(ADS_OUTPUT_SCHEMA.safeParse(validOutput()).success).toBe(true);
    expect(ADS_OUTPUT_SCHEMA.safeParse({ ...validOutput(), status: 'done' }).success).toBe(false);
  });
});
