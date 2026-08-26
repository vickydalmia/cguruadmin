// DROP ZONE presentation for the unique-code import: the dashed target, the
// single focusable Browse button, and the visually hidden real input. State
// and handlers come from ./use-code-import.
import * as React from 'react';
import {
  Box,
  Button,
  Field,
  Flex,
  Typography,
  VisuallyHidden,
} from '@strapi/design-system';
import { CloudUpload } from '@strapi/icons';

export function CodeDropZone({
  inputRef,
  busy,
  isDragging,
  setIsDragging,
  acceptFile,
  onDrop,
  onDragOver,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  busy: boolean;
  isDragging: boolean;
  setIsDragging: (value: boolean) => void;
  acceptFile: (file: File | undefined) => Promise<void>;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
}) {
  const dropBorder = isDragging ? 'primary600' : 'neutral200';
  const dropBackground = isDragging ? 'primary100' : 'neutral0';

  return (
      <Field.Root name="unique-code-import-file">
        <Field.Label>Code file</Field.Label>
        <Box
          padding={5}
          hasRadius
          borderStyle="dashed"
          borderWidth="1px"
          borderColor={dropBorder}
          background={dropBackground}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={() => setIsDragging(false)}
        >
          <Flex direction="column" alignItems="center" gap={2}>
            <CloudUpload
              width="2rem"
              height="2rem"
              fill={isDragging ? 'primary600' : 'neutral500'}
              aria-hidden
            />
            <Typography variant="pi" textColor="neutral600" textAlign="center">
              Drag a .csv or .txt file here, or
            </Typography>
            <Button
              variant="secondary"
              size="S"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              Browse files
            </Button>
            <Typography variant="pi" textColor="neutral500" textAlign="center">
              One code per line. Extra columns are ignored and a
              &ldquo;code&rdquo; header row is skipped.
            </Typography>
          </Flex>

          {/*
            The Button above is the single focusable control, so the input is
            taken out of the tab order — otherwise the panel has an invisible
            second tab stop that does the same thing.
          */}
          <VisuallyHidden>
            <input
              ref={inputRef}
              type="file"
              tabIndex={-1}
              accept=".txt,.csv,text/plain,text/csv"
              onChange={(event) => void acceptFile(event.target.files?.[0])}
              disabled={busy}
            />
          </VisuallyHidden>
        </Box>
      </Field.Root>
  );
}
