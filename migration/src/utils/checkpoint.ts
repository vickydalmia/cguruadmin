import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKPOINT_DIR = path.resolve(__dirname, "../../.checkpoints");

export function isPhaseComplete(phase: string): boolean {
  const file = path.join(CHECKPOINT_DIR, `${phase}.json`);
  return fs.existsSync(file);
}

export function markPhaseComplete(
  phase: string,
  summary: Record<string, any> = {}
): void {
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const file = path.join(CHECKPOINT_DIR, `${phase}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      { phase, completedAt: new Date().toISOString(), ...summary },
      null,
      2
    )
  );
  logger.info(`Phase ${phase} marked complete`);
}

export function clearCheckpoints(): void {
  if (fs.existsSync(CHECKPOINT_DIR)) {
    const files = fs.readdirSync(CHECKPOINT_DIR);
    for (const file of files) {
      if (file.endsWith(".json") && !file.endsWith("Map.json")) {
        fs.unlinkSync(path.join(CHECKPOINT_DIR, file));
      }
    }
    logger.info("Checkpoints cleared (ID maps preserved)");
  }
}
