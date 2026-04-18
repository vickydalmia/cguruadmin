import { logger } from "./logger.js";

export interface FaqItem {
  question: string;
  answer: string;
}

/**
 * Parses ACF repeater FAQ items from termmeta rows.
 *
 * ACF stores repeaters as:
 *   faq_items = "3"  (count)
 *   faq_items_0_faq_question = "What is...?"
 *   faq_items_0_faq_answer = "It is..."
 *   faq_items_1_faq_question = ...
 */
export function parseFaqRepeater(
  metaRows: Array<{ meta_key: string; meta_value: string }>
): FaqItem[] {
  const items: FaqItem[] = [];

  // Find the count
  const countRow = metaRows.find((r) => r.meta_key === "faq_items");
  if (!countRow) return items;

  const count = parseInt(countRow.meta_value, 10);
  if (isNaN(count) || count <= 0) return items;

  for (let i = 0; i < count; i++) {
    const qRow = metaRows.find(
      (r) => r.meta_key === `faq_items_${i}_faq_question`
    );
    const aRow = metaRows.find(
      (r) => r.meta_key === `faq_items_${i}_faq_answer`
    );

    if (qRow?.meta_value && aRow?.meta_value) {
      items.push({
        question: qRow.meta_value,
        answer: aRow.meta_value,
      });
    } else {
      logger.warn(`FAQ item ${i} missing question or answer`);
    }
  }

  return items;
}
