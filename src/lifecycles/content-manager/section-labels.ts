import type { Core } from '@strapi/strapi';

import type { SectionLabel } from '../../constants/homepage-sections';

export async function ensureSectionLabels(
  strapi: Core.Strapi,
  uid: string,
  labels: SectionLabel[],
): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('content-types');
  if (!service) return;

  try {
    const contentType = strapi.contentType(uid as any);
    if (!contentType) return;

    const config = await service.findConfiguration(contentType);

    const metadatas = { ...(config.metadatas ?? {}) };
    let metaChanged = false;
    for (const { attr, label, description } of labels) {
      if (!contentType.attributes?.[attr]) {
        strapi.log.warn(`[content-manager] ${uid} has no attribute "${attr}" — label skipped`);
        continue;
      }
      const prev = metadatas[attr] ?? {};
      if (prev.edit?.label === label && prev.edit?.description === description) continue;
      metadatas[attr] = { ...prev, edit: { ...(prev.edit ?? {}), label, description } };
      metaChanged = true;
    }

    // Edit-form order = live page order: one row per attribute in the order
    // above, keeping each cell's stored size; attributes added later (not in
    // the list yet) are appended at the end rather than dropped.
    const prevEdit: any[][] = config.layouts?.edit ?? [];
    const cellsByName = new Map<string, any>();
    for (const row of prevEdit) for (const cell of row) cellsByName.set(cell.name, cell);

    const listed = new Set(labels.map(({ attr }) => attr));
    const ordered = labels.map(({ attr }) => cellsByName.get(attr)).filter(Boolean);
    const leftovers = [...cellsByName.values()].filter((cell) => !listed.has(cell.name));
    const nextEdit = [...ordered, ...leftovers].map((cell) => [cell]);

    const layoutChanged = JSON.stringify(nextEdit) !== JSON.stringify(prevEdit);
    if (!metaChanged && !layoutChanged) return;

    await service.updateConfiguration(contentType, {
      settings: config.settings,
      metadatas,
      layouts: { ...config.layouts, edit: layoutChanged ? nextEdit : prevEdit },
      options: config.options,
    });
    strapi.log.info(`[content-manager] ${uid} section labels & form order pinned`);
  } catch (err: any) {
    strapi.log.warn(
      `[content-manager] ${uid} section labels failed: ${err?.message ?? err}`
    );
  }
}
