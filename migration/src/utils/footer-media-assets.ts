import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  migrationProfile,
  migrationRoot,
  profileFile,
} from "./profile-state.js";

const FOOTER_ASSET_DIR = fileURLToPath(
  new URL("../../assets/footer/", import.meta.url)
);

export interface FooterCountryAsset {
  code: string;
  name: string;
  url: string;
  fileName: string;
  assetPath: string;
}

export interface GooglePreferredAsset {
  label: string;
  url: string;
  fileName: string;
  assetPath: string;
}

type FooterCountriesFile = {
  countries?: ReadonlyArray<{
    code?: unknown;
    name?: unknown;
    url?: unknown;
    fileName?: unknown;
  }>;
};

type FooterSettingsFile = {
  googlePreferredSource?: {
    label?: unknown;
    url?: unknown;
    fileName?: unknown;
  } | null;
};

const FOOTER_COUNTRY_REGISTRY_PATH = path.join(
  migrationRoot(),
  "profiles",
  "footer-countries.json"
);

function readJsonFile<T>(filePath: string, optional = false): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (optional && code === "ENOENT") return null;
    throw new Error(
      `[footer] ${filePath} could not be read: ${(error as Error)?.message}`
    );
  }
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sourceCountryCode(environment: NodeJS.ProcessEnv): string {
  const configured = trimmed(environment.SOURCE_COUNTRY_CODE).toLowerCase();
  if (configured) return configured;

  const profile = migrationProfile(environment);
  if (profile === "india") return "in";
  if (profile === "usa") return "us";
  throw new Error(
    `[footer] SOURCE_COUNTRY_CODE is required for migration profile "${profile}".`
  );
}

function validatedHttpsUrl(value: unknown, field: string): string {
  const url = trimmed(value);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("not https");
  } catch {
    throw new Error(`[footer] ${field} must be an absolute HTTPS URL.`);
  }
  return url;
}

/**
 * Every deployment reads the same country-site registry and removes itself.
 * This keeps the network list consistent without copying N-1 links into every
 * profile. Adding a country to the registry makes it available everywhere.
 */
export function footerCountryAssetsFor(
  environment: NodeJS.ProcessEnv = process.env
): readonly FooterCountryAsset[] {
  const file = readJsonFile<FooterCountriesFile>(FOOTER_COUNTRY_REGISTRY_PATH);
  const entries = file?.countries ?? [];
  const currentCountryCode = sourceCountryCode(environment);
  const seenCodes = new Set<string>();

  const countries = entries.map((entry) => {
    const code = trimmed(entry?.code).toLowerCase();
    const name = trimmed(entry?.name);
    const url = validatedHttpsUrl(
      entry?.url,
      `country "${code || "unknown"}" URL`
    );
    const fileName = trimmed(entry?.fileName);
    if (!/^[a-z]{2}$/u.test(code) || !name || !fileName) {
      throw new Error(
        "[footer] every shared country entry needs a two-letter code, name, URL and fileName."
      );
    }
    if (path.basename(fileName) !== fileName) {
      throw new Error(
        `[footer] country "${code}" fileName must be a plain file name.`
      );
    }
    if (seenCodes.has(code)) {
      throw new Error(
        `[footer] duplicate country code "${code}" in the shared registry.`
      );
    }
    seenCodes.add(code);
    return {
      code,
      name,
      url,
      fileName,
      assetPath: path.join(FOOTER_ASSET_DIR, fileName),
    };
  });

  if (!seenCodes.has(currentCountryCode)) {
    throw new Error(
      `[footer] current country "${currentCountryCode.toUpperCase()}" is missing from ${FOOTER_COUNTRY_REGISTRY_PATH}.`
    );
  }

  return countries.filter(({ code }) => code !== currentCountryCode);
}

export function googlePreferredAssetFor(
  environment: NodeJS.ProcessEnv = process.env
): GooglePreferredAsset | null {
  const settingsPath = profileFile("footer-settings.json", environment);
  const settings = readJsonFile<FooterSettingsFile>(settingsPath, true);
  const source = settings?.googlePreferredSource;
  if (!source) return null;

  const label = trimmed(source.label);
  const url = validatedHttpsUrl(source.url, "Google Preferred Source URL");
  const fileName = trimmed(source.fileName);
  if (!label || !fileName || path.basename(fileName) !== fileName) {
    throw new Error(
      "[footer] footer-settings.json googlePreferredSource needs a label, HTTPS URL and plain fileName."
    );
  }
  return {
    label,
    url,
    fileName,
    assetPath: path.join(FOOTER_ASSET_DIR, fileName),
  };
}

export const FOOTER_COUNTRY_ASSETS = footerCountryAssetsFor();
export const GOOGLE_PREFERRED_DEFAULT = googlePreferredAssetFor();
