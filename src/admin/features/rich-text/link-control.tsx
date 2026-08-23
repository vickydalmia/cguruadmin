// Link handling for the rich-text editor: word-expansion for collapsed
// selections and the URL popover control.
import * as React from 'react';
import { Flex, IconButton, Popover, TextInput } from '@strapi/design-system';
import { Link as LinkIcon } from '@strapi/icons';
import { type Editor } from '@tiptap/react';

import { GlyphButton } from './toolbar-controls';

// When the cursor sits inside a word with nothing selected, ProseMirror has no
// range to attach the link mark to, so setLink is a no-op and the word never
// becomes a (visible) link — the reported bug. Expand a collapsed selection to
// the surrounding word so the link applies to the whole word.
function selectWordIfCollapsed(editor: Editor): void {
  const { state } = editor;
  const { from, empty } = state.selection;
  if (!empty) return;
  const $pos = state.doc.resolve(from);
  const text = $pos.parent.textContent;
  const base = $pos.start();
  let start = from - base;
  let end = start;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  while (end < text.length && !/\s/.test(text[end])) end++;
  if (end > start) {
    editor.commands.setTextSelection({ from: base + start, to: base + end });
  }
}

export function LinkControl({ editor, isActive }: { editor: Editor; isActive: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [url, setUrl] = React.useState('');

  const apply = () => {
    const trimmed = url.trim();
    // Expand a bare cursor to its word, then apply to the full link range so the
    // whole word turns into a styled link and the toolbar reflects it (the
    // selection stays on the range, so isActive('link') reads true afterwards).
    selectWordIfCollapsed(editor);
    if (trimmed) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: trimmed }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    }
    setOpen(false);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (next) setUrl(editor.getAttributes('link').href ?? '');
      }}
    >
      <Popover.Trigger>
        <IconButton
          label="Link"
          size="S"
          variant={isActive ? 'secondary' : 'ghost'}
        >
          <LinkIcon />
        </IconButton>
      </Popover.Trigger>
      <Popover.Content sideOffset={4}>
        <Flex padding={3} gap={2} width="30rem">
          <TextInput
            aria-label="Link URL"
            placeholder="https://…  (empty removes the link)"
            size="S"
            value={url}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                apply();
              }
            }}
          />
          <GlyphButton type="button" onClick={apply} aria-label="Apply link">
            OK
          </GlyphButton>
        </Flex>
      </Popover.Content>
    </Popover.Root>
  );
}
