import { describe, expect, it } from "vitest";

import pluginsConfig from "../../config/plugins";
import {
  CULTURE_GALLERY_IMAGE_OPTIMIZATION,
  IMAGE_BREAKPOINTS,
  IMAGE_OPTIMIZATION,
  THUMBNAIL,
} from "./image";

// A minimal stand-in for Strapi's env helper: plain lookup with defaults plus
// the .bool/.int accessors config/plugins.ts actually calls.
function stubEnv(vars: Record<string, string>) {
  const env = ((key: string, defaultValue?: unknown) =>
    key in vars ? vars[key] : defaultValue) as any;
  env.bool = (key: string, defaultValue?: boolean) =>
    key in vars ? vars[key] === "true" : defaultValue;
  env.int = (key: string, defaultValue?: number) =>
    key in vars ? Number(vars[key]) : defaultValue;
  return env;
}

function uploadConfig(vars: Record<string, string>) {
  const config = pluginsConfig({ env: stubEnv(vars) } as any) as any;
  return config.upload.config;
}

describe("image variant matrix constants", () => {
  it("pins the shared breakpoint and thumbnail values", () => {
    // These values are contract, not tuning: migration formats, the upload
    // extension's AVIF twins, and frontend srcsets all derive from them — a
    // change here must be a deliberate catalog-wide re-generation decision.
    expect(IMAGE_BREAKPOINTS).toEqual({
      large: 1000,
      medium: 750,
      small: 500,
      xsmall: 320,
    });
    expect(THUMBNAIL).toEqual({ width: 245, height: 156 });
  });

  it("keeps a high-quality photographic master and encoder profile", () => {
    expect(IMAGE_OPTIMIZATION.maxDimension).toBe(1920);
    expect(IMAGE_OPTIMIZATION.quality).toBe(80);
    expect(CULTURE_GALLERY_IMAGE_OPTIMIZATION.maxDimension).toBe(2560);
    expect(CULTURE_GALLERY_IMAGE_OPTIMIZATION.quality).toBe(90);
    expect(CULTURE_GALLERY_IMAGE_OPTIMIZATION.webp).toEqual({
      effort: 4,
      smartSubsample: true,
    });
    expect(CULTURE_GALLERY_IMAGE_OPTIMIZATION.avif).toEqual({
      quality: 60,
      effort: 4,
    });
  });
});

describe("upload plugin breakpoints gating", () => {
  // Breakpoints must sit OUTSIDE the S3 gate: a production boot without
  // S3_UPLOAD_ENABLED falls back to local disk but must still generate the
  // exact same variant matrix (guards against re-gating the whole block).
  it("sets the shared breakpoints when S3 uploads are enabled", () => {
    const upload = uploadConfig({
      NODE_ENV: "production",
      S3_UPLOAD_ENABLED: "true",
      // Required alongside S3 uploads: it is stamped into every stored file URL.
      S3_BASE_URL: "https://media.example.com",
    });
    expect(upload.breakpoints).toEqual({ ...IMAGE_BREAKPOINTS });
    expect(upload.provider).toBe("aws-s3");
  });

  it("refuses S3 uploads without a media base URL", () => {
    expect(() =>
      uploadConfig({ NODE_ENV: "production", S3_UPLOAD_ENABLED: "true" })
    ).toThrow("S3_BASE_URL is required");
  });

  it("sets the shared breakpoints when S3 uploads are disabled", () => {
    const upload = uploadConfig({
      NODE_ENV: "production",
      S3_UPLOAD_ENABLED: "false",
    });
    expect(upload.breakpoints).toEqual({ ...IMAGE_BREAKPOINTS });
    expect(upload.provider).toBeUndefined();
  });
});
