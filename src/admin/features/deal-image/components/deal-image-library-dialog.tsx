import {
  Box,
  Button,
  Flex,
  Modal,
  Searchbar,
  Typography,
} from '@strapi/design-system';
import * as React from 'react';
import styled from 'styled-components';
import type { DealImageAsset } from '../api/deal-image-api';

interface DealImageLibraryDialogProps {
  assets: DealImageAsset[];
  current: DealImageAsset | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (asset: DealImageAsset) => void;
}

const assetPreviewUrl = (asset: DealImageAsset): string => {
  const thumbnail = asset.formats?.thumbnail;
  if (
    thumbnail &&
    typeof thumbnail === 'object' &&
    typeof (thumbnail as { url?: unknown }).url === 'string'
  ) {
    return (thumbnail as { url: string }).url;
  }
  return asset.url;
};

const DialogContent = styled(Modal.Content)`
  width: min(112rem, calc(100vw - 3.2rem));
  max-width: none;
`;

const GalleryGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  gap: ${({ theme }) => theme.spaces[4]};
  padding-block: ${({ theme }) => theme.spaces[4]};
`;

const AssetButton = styled.button<{ $selected: boolean }>`
  display: block;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  color: inherit;
  text-align: left;
  background: ${({ theme }) => theme.colors.neutral0};
  border: 2px solid
    ${({ theme, $selected }) =>
      $selected ? theme.colors.primary600 : theme.colors.neutral200};
  border-radius: ${({ theme }) => theme.borderRadius};
  box-shadow: ${({ theme, $selected }) =>
    $selected ? `0 0 0 2px ${theme.colors.primary100}` : 'none'};
  cursor: pointer;
  content-visibility: auto;
  contain-intrinsic-size: 22rem;

  &:hover {
    border-color: ${({ theme }) => theme.colors.primary500};
  }

  &:focus-visible {
    outline: 3px solid ${({ theme }) => theme.colors.primary200};
    outline-offset: 2px;
  }
`;

const PreviewFrame = styled.div`
  position: relative;
  display: grid;
  place-items: center;
  height: 15rem;
  overflow: hidden;
  background-color: ${({ theme }) => theme.colors.neutral100};
  background-image:
    linear-gradient(45deg, ${({ theme }) => theme.colors.neutral200} 25%, transparent 25%),
    linear-gradient(-45deg, ${({ theme }) => theme.colors.neutral200} 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, ${({ theme }) => theme.colors.neutral200} 75%),
    linear-gradient(-45deg, transparent 75%, ${({ theme }) => theme.colors.neutral200} 75%);
  background-position:
    0 0,
    0 0.8rem,
    0.8rem -0.8rem,
    -0.8rem 0;
  background-size: 1.6rem 1.6rem;
`;

const AssetImage = styled.img`
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
`;

const SelectionBadge = styled.span`
  position: absolute;
  top: ${({ theme }) => theme.spaces[2]};
  right: ${({ theme }) => theme.spaces[2]};
  padding: ${({ theme }) => `${theme.spaces[1]} ${theme.spaces[2]}`};
  color: ${({ theme }) => theme.colors.neutral0};
  font-size: 1.1rem;
  font-weight: 600;
  line-height: 1.4;
  background: ${({ theme }) => theme.colors.primary600};
  border-radius: 999px;
`;

const AssetName = styled(Typography)`
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export function DealImageLibraryDialog({
  assets,
  current,
  open,
  onOpenChange,
  onSelect,
}: DealImageLibraryDialogProps) {
  const [search, setSearch] = React.useState('');
  const [selectedId, setSelectedId] = React.useState<number | null>(
    current?.id ?? null,
  );

  React.useEffect(() => {
    if (open) {
      setSelectedId(current?.id ?? null);
      setSearch('');
    }
  }, [current?.id, open]);

  const visibleAssets = React.useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return assets;
    return assets.filter((asset) =>
      `${asset.name} ${asset.alternativeText ?? ''}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [assets, search]);

  const selected = assets.find((asset) => asset.id === selectedId) ?? null;

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Modal.Header closeLabel="Close image gallery">
          <Modal.Title>Select a transparent Deal image</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Flex direction="column" alignItems="stretch" gap={3}>
            <Typography textColor="neutral600">
              This gallery only contains images already processed for Deal
              backgrounds.
            </Typography>
            <Searchbar
              name="deal-image-gallery-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onClear={() => setSearch('')}
              clearLabel="Clear image search"
              placeholder="Search by image name"
            >
              Search processed Deal images
            </Searchbar>

            {visibleAssets.length > 0 ? (
              <GalleryGrid aria-label="Processed Deal images">
                {visibleAssets.map((asset) => {
                  const isSelected = asset.id === selectedId;
                  return (
                    <AssetButton
                      key={asset.id}
                      type="button"
                      $selected={isSelected}
                      aria-pressed={isSelected}
                      title={asset.name}
                      onClick={() => setSelectedId(asset.id)}
                    >
                      <PreviewFrame>
                        <AssetImage
                          src={assetPreviewUrl(asset)}
                          alt={asset.alternativeText || ''}
                          width={240}
                          height={150}
                          loading="lazy"
                          decoding="async"
                        />
                        {isSelected ? (
                          <SelectionBadge>Selected</SelectionBadge>
                        ) : null}
                      </PreviewFrame>
                      <Box padding={3}>
                        <AssetName tag="p" fontWeight="semiBold">
                          {asset.name}
                        </AssetName>
                        {asset.width && asset.height ? (
                          <Typography
                            tag="p"
                            variant="pi"
                            textColor="neutral600"
                            marginTop={1}
                          >
                            {asset.width} × {asset.height}
                          </Typography>
                        ) : null}
                      </Box>
                    </AssetButton>
                  );
                })}
              </GalleryGrid>
            ) : (
              <Box
                padding={8}
                marginTop={4}
                background="neutral100"
                hasRadius
              >
                <Typography tag="p" textAlign="center" textColor="neutral600">
                  No processed Deal images match “{search}”.
                </Typography>
              </Box>
            )}
          </Flex>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close>
            <Button variant="tertiary">Cancel</Button>
          </Modal.Close>
          <Button
            disabled={!selected}
            onClick={() => {
              if (!selected) return;
              onSelect(selected);
              onOpenChange(false);
            }}
          >
            Use selected image
          </Button>
        </Modal.Footer>
      </DialogContent>
    </Modal.Root>
  );
}
