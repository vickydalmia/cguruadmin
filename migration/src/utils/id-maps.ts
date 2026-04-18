import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPgPool } from "../db/pg-client.js";
import { generateDocumentId } from "./strapi-insert.js";
import { logger } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPS_DIR = path.resolve(__dirname, "../../.checkpoints");

export interface StrapiEntityRef {
  id: number;
  documentId: string;
  type: string; // 'store' | 'brand' | 'category' | 'bank'
  table: string; // PG table name
}

// wp_term_id -> Strapi entity info
const termIdMap = new Map<number, StrapiEntityRef>();

// wp_post_id -> Strapi entity info
const postIdMap = new Map<number, StrapiEntityRef>();

// wp_attachment_id -> Strapi file id
const mediaIdMap = new Map<number, number>();

// wp_pool_id -> Strapi pool info
const poolIdMap = new Map<number, StrapiEntityRef>();

// wp_uc_coupons.name -> Strapi pool info
const poolNameMap = new Map<string, StrapiEntityRef>();

// wp_tag term_id -> Strapi tag info
const tagIdMap = new Map<number, StrapiEntityRef>();

export function setTermMapping(wpTermId: number, ref: StrapiEntityRef): void {
  termIdMap.set(wpTermId, ref);
}

export function getTermMapping(wpTermId: number): StrapiEntityRef | undefined {
  return termIdMap.get(wpTermId);
}

const TAXONOMY_TABLES: Array<{ table: string; type: string }> = [
  { table: "stores", type: "api::store.store" },
  { table: "brands", type: "api::brand.brand" },
  { table: "banks", type: "api::bank.bank" },
  { table: "categories", type: "api::category.category" },
];

/**
 * Returns the term mapping from the in-memory map, falling back to a DB
 * lookup by the deterministic `term:{table}:{wp_term_id}` document_id
 * convention used by Phase 3. This lets later phases run standalone
 * (e.g., `--phase 08-deals`) without needing Phase 3 in the same process.
 */
export async function ensureTermMapping(
  wpTermId: number
): Promise<StrapiEntityRef | undefined> {
  const cached = termIdMap.get(wpTermId);
  if (cached) return cached;

  const pool = getPgPool();
  for (const { table, type } of TAXONOMY_TABLES) {
    const documentId = generateDocumentId(`term:${table}:${wpTermId}`);
    const result = await pool.query<{ id: number }>(
      `SELECT id FROM "${table}" WHERE "document_id" = $1 LIMIT 1`,
      [documentId]
    );
    const id = result.rows[0]?.id;
    if (id) {
      const ref: StrapiEntityRef = { id, documentId, type, table };
      termIdMap.set(wpTermId, ref);
      return ref;
    }
  }
  return undefined;
}

export function setPostMapping(wpPostId: number, ref: StrapiEntityRef): void {
  postIdMap.set(wpPostId, ref);
}

export function getPostMapping(wpPostId: number): StrapiEntityRef | undefined {
  return postIdMap.get(wpPostId);
}

export function setMediaMapping(wpAttachmentId: number, strapiFileId: number): void {
  mediaIdMap.set(wpAttachmentId, strapiFileId);
}

export function getMediaMapping(wpAttachmentId: number): number | undefined {
  return mediaIdMap.get(wpAttachmentId);
}

export function setPoolMapping(wpPoolId: number, ref: StrapiEntityRef): void {
  poolIdMap.set(wpPoolId, ref);
}

export function getPoolMapping(wpPoolId: number): StrapiEntityRef | undefined {
  return poolIdMap.get(wpPoolId);
}

export function setPoolNameMapping(poolName: string, ref: StrapiEntityRef): void {
  const rawKey = normalizePoolName(poolName, false);
  const normalizedKey = normalizePoolName(poolName, true);

  if (rawKey) poolNameMap.set(rawKey, ref);
  if (normalizedKey) poolNameMap.set(normalizedKey, ref);
}

export function getPoolMappingByName(poolName: string): StrapiEntityRef | undefined {
  const rawKey = normalizePoolName(poolName, false);
  if (rawKey) {
    const exact = poolNameMap.get(rawKey);
    if (exact) return exact;
  }

  const normalizedKey = normalizePoolName(poolName, true);
  return normalizedKey ? poolNameMap.get(normalizedKey) : undefined;
}

export function setTagMapping(wpTermId: number, ref: StrapiEntityRef): void {
  tagIdMap.set(wpTermId, ref);
}

export function getTagMapping(wpTermId: number): StrapiEntityRef | undefined {
  return tagIdMap.get(wpTermId);
}

function mapToJson(map: Map<number, any>): string {
  return JSON.stringify(Array.from(map.entries()));
}

function jsonToMap<V>(json: string): Map<number, V> {
  return new Map(JSON.parse(json));
}

function jsonToStringMap<V>(json: string): Map<string, V> {
  return new Map(JSON.parse(json));
}

function normalizePoolName(poolName: string, lowercase: boolean): string | null {
  const trimmed = poolName?.trim();
  if (!trimmed) return null;
  return lowercase ? trimmed.toLowerCase() : trimmed;
}

export function saveMaps(): void {
  fs.mkdirSync(MAPS_DIR, { recursive: true });
  fs.writeFileSync(path.join(MAPS_DIR, "termIdMap.json"), mapToJson(termIdMap));
  fs.writeFileSync(path.join(MAPS_DIR, "postIdMap.json"), mapToJson(postIdMap));
  fs.writeFileSync(path.join(MAPS_DIR, "mediaIdMap.json"), mapToJson(mediaIdMap));
  fs.writeFileSync(path.join(MAPS_DIR, "poolIdMap.json"), mapToJson(poolIdMap));
  fs.writeFileSync(path.join(MAPS_DIR, "poolNameMap.json"), JSON.stringify(Array.from(poolNameMap.entries())));
  fs.writeFileSync(path.join(MAPS_DIR, "tagIdMap.json"), mapToJson(tagIdMap));
  logger.info("ID maps saved to disk");
}

export function loadMaps(): void {
  try {
    const termPath = path.join(MAPS_DIR, "termIdMap.json");
    if (fs.existsSync(termPath)) {
      const data = jsonToMap<StrapiEntityRef>(fs.readFileSync(termPath, "utf-8"));
      data.forEach((v, k) => termIdMap.set(k, v));
    }
    const postPath = path.join(MAPS_DIR, "postIdMap.json");
    if (fs.existsSync(postPath)) {
      const data = jsonToMap<StrapiEntityRef>(fs.readFileSync(postPath, "utf-8"));
      data.forEach((v, k) => postIdMap.set(k, v));
    }
    const mediaPath = path.join(MAPS_DIR, "mediaIdMap.json");
    if (fs.existsSync(mediaPath)) {
      const data = jsonToMap<number>(fs.readFileSync(mediaPath, "utf-8"));
      data.forEach((v, k) => mediaIdMap.set(k, v));
    }
    const poolPath = path.join(MAPS_DIR, "poolIdMap.json");
    if (fs.existsSync(poolPath)) {
      const data = jsonToMap<StrapiEntityRef>(fs.readFileSync(poolPath, "utf-8"));
      data.forEach((v, k) => poolIdMap.set(k, v));
    }
    const poolNamePath = path.join(MAPS_DIR, "poolNameMap.json");
    if (fs.existsSync(poolNamePath)) {
      const data = jsonToStringMap<StrapiEntityRef>(fs.readFileSync(poolNamePath, "utf-8"));
      data.forEach((v, k) => poolNameMap.set(k, v));
    }
    const tagPath = path.join(MAPS_DIR, "tagIdMap.json");
    if (fs.existsSync(tagPath)) {
      const data = jsonToMap<StrapiEntityRef>(fs.readFileSync(tagPath, "utf-8"));
      data.forEach((v, k) => tagIdMap.set(k, v));
    }
    logger.info(
      `ID maps loaded: terms=${termIdMap.size}, posts=${postIdMap.size}, media=${mediaIdMap.size}, pools=${poolIdMap.size}, poolNames=${poolNameMap.size}, tags=${tagIdMap.size}`
    );
  } catch (err) {
    logger.warn("Could not load ID maps from disk, starting fresh");
  }
}

export function getTermMapSize(): number {
  return termIdMap.size;
}

export function clearAllMaps(): void {
  termIdMap.clear();
  postIdMap.clear();
  mediaIdMap.clear();
  poolIdMap.clear();
  poolNameMap.clear();
  tagIdMap.clear();
  // Delete map files from disk
  const mapFiles = ["termIdMap.json", "postIdMap.json", "mediaIdMap.json", "poolIdMap.json", "poolNameMap.json", "tagIdMap.json"];
  for (const file of mapFiles) {
    const filePath = path.join(MAPS_DIR, file);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  logger.info("All ID maps cleared");
}

export function getMediaMapSize(): number {
  return mediaIdMap.size;
}

export function getAllTermMappings(): Map<number, StrapiEntityRef> {
  return termIdMap;
}

export function getAllTagMappings(): Map<number, StrapiEntityRef> {
  return tagIdMap;
}
