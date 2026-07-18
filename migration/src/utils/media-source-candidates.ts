import path from "path";

type MediaSourceRow = {
  name: string;
  hash: string;
  ext: string;
};

export type MediaSourceResolution = {
  groupKey: string;
  keyCandidates: string[];
  nameNoExt: string;
};

/**
 * Build the ordered S3 master candidates and a grouping key that represents
 * the complete candidate list. Metadata-less rows with the same hash but
 * different legacy names must remain separate until a real key is resolved.
 */
export function mediaSourceResolution(
  row: MediaSourceRow,
  rootPrefix: string,
  providerKey?: string | null,
): MediaSourceResolution {
  const nameNoExt = path.basename(row.name, path.extname(row.name));
  const keyCandidates = providerKey
    ? [providerKey]
    : [
        `${rootPrefix}${row.hash}${row.ext}`,
        `${rootPrefix}${row.hash}_${nameNoExt}${row.ext}`,
      ];

  return {
    groupKey: JSON.stringify(keyCandidates),
    keyCandidates,
    nameNoExt,
  };
}
