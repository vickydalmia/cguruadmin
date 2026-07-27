import path from "path";
import { fileURLToPath } from "url";

const FOOTER_ASSET_DIR = fileURLToPath(
  new URL("../../assets/footer/", import.meta.url),
);

export interface FooterCountryAsset {
  code: string;
  name: string;
  url: string;
  fileName: string;
  assetPath: string;
}

export const FOOTER_COUNTRY_ASSETS: readonly FooterCountryAsset[] = [
  { code: "us", name: "USA", url: "https://www.couponzguruusa.com/", fileName: "us.png", assetPath: path.join(FOOTER_ASSET_DIR, "us.png") },
  { code: "sg", name: "Singapore", url: "https://www.couponzguru.sg/", fileName: "sg.png", assetPath: path.join(FOOTER_ASSET_DIR, "sg.png") },
  { code: "ph", name: "Philippines", url: "https://www.couponzguru.ph/", fileName: "ph.png", assetPath: path.join(FOOTER_ASSET_DIR, "ph.png") },
  { code: "ae", name: "UAE", url: "https://www.couponzguru.ae/", fileName: "ae.png", assetPath: path.join(FOOTER_ASSET_DIR, "ae.png") },
  { code: "my", name: "Malaysia", url: "https://www.couponzguru.my/", fileName: "my.png", assetPath: path.join(FOOTER_ASSET_DIR, "my.png") },
] as const;

export const GOOGLE_PREFERRED_DEFAULT = {
  label: "Google Preferred Source",
  url: "https://google.com/preferences/source?q=www.couponzguru.com",
  fileName: "google-preferred.png",
  assetPath: path.join(FOOTER_ASSET_DIR, "google-preferred.png"),
} as const;
