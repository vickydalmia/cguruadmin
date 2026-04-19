import bcrypt from "bcrypt";
import { randomBytes } from "crypto";

export function generateResetToken(): string {
  return randomBytes(20).toString("hex");
}

export function hashRandomPassword(): string {
  return bcrypt.hashSync(randomBytes(32).toString("hex"), 10);
}

export function splitDisplayName(
  displayName: string | null | undefined,
  fallback: string
): { firstname: string; lastname: string | null } {
  const raw = (displayName ?? "").trim();
  if (!raw) return { firstname: fallback, lastname: null };
  const idx = raw.indexOf(" ");
  if (idx === -1) return { firstname: raw, lastname: null };
  return {
    firstname: raw.slice(0, idx),
    lastname: raw.slice(idx + 1).trim() || null,
  };
}
