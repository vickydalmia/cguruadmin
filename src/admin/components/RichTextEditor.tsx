/**
 * WYSIWYG replacement for Strapi's built-in markdown editor on `richtext`
 * fields (registered via app.addFields({ type: 'richtext' }) in ../app.tsx).
 *
 * The fields store HTML (WP-migrated, rendered raw on the public site), so
 * this editor reads and writes HTML strings — no schema or data change.
 * Extension set is driven by what actually exists in content (tables, images,
 * sup, h1–h6); anything outside the server allowlist is stripped on save by
 * src/utils/sanitize-richtext.ts.
 */

import * as React from 'react';
import styled from 'styled-components';
import { useField } from '@strapi/strapi/admin';
import {
  Box,
  Field,
  Flex,
  IconButton,
  Popover,
  TextInput,
} from '@strapi/design-system';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  StrikeThrough,
  BulletList,
  NumberList,
  Link as LinkIcon,
  Minus,
} from '@strapi/icons';
import { useEditor, useEditorState, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Image from '@tiptap/extension-image';
import Superscript from '@tiptap/extension-superscript';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';

const EXTENSIONS = [
  // Legacy WP content has h1/h4-h6 — accept all levels so loading + saving a
  // document never downgrades headings; the toolbar only offers H2/H3.
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: false }),
  Underline,
  Superscript,
  Link.configure({ openOnClick: false, autolink: true }),
  Image,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
];

const EditorShell = styled(Box)<{ $error?: boolean }>`
  border: 1px solid
    ${({ theme, $error }) => ($error ? theme.colors.danger600 : theme.colors.neutral200)};
  border-radius: ${({ theme }) => theme.borderRadius};
  background: ${({ theme }) => theme.colors.neutral0};

  .ProseMirror {
    min-height: 200px;
    max-height: 560px;
    overflow-y: auto;
    padding: ${({ theme }) => theme.spaces[3]} ${({ theme }) => theme.spaces[4]};
    outline: none;
    color: ${({ theme }) => theme.colors.neutral800};
    font-size: 1.4rem;
    line-height: 1.5;

    p { margin: 0 0 0.75em; }
    h1, h2, h3, h4, h5, h6 { font-weight: 600; margin: 1em 0 0.5em; }
    h1 { font-size: 2rem; }
    h2 { font-size: 1.8rem; }
    h3 { font-size: 1.6rem; }
    h4, h5, h6 { font-size: 1.4rem; }
    ul, ol { padding-left: 2rem; margin: 0 0 0.75em; }
    ul { list-style: disc; }
    ol { list-style: decimal; }
    a { color: ${({ theme }) => theme.colors.primary600}; text-decoration: underline; }
    blockquote {
      border-left: 3px solid ${({ theme }) => theme.colors.neutral200};
      margin: 0 0 0.75em; padding-left: 1rem;
      color: ${({ theme }) => theme.colors.neutral600};
    }
    img { max-width: 100%; height: auto; }
    hr { border: 0; border-top: 1px solid ${({ theme }) => theme.colors.neutral200}; margin: 1em 0; }
    table {
      border-collapse: collapse; width: 100%; margin: 0 0 0.75em;
      table-layout: fixed; overflow: hidden;
    }
    th, td {
      border: 1px solid ${({ theme }) => theme.colors.neutral200};
      padding: 0.4rem 0.6rem; vertical-align: top; word-break: break-word;
    }
    th { background: ${({ theme }) => theme.colors.neutral100}; font-weight: 600; }
  }
`;

const Toolbar = styled(Flex)`
  border-bottom: 1px solid ${({ theme }) => theme.colors.neutral200};
  padding: ${({ theme }) => theme.spaces[1]} ${({ theme }) => theme.spaces[2]};
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.spaces[1]};
`;

/* Text-glyph buttons for actions without a fitting @strapi/icons icon. */
const GlyphButton = styled.button<{ $active?: boolean }>`
  border: none;
  background: ${({ theme, $active }) => ($active ? theme.colors.primary100 : 'transparent')};
  color: ${({ theme, $active }) => ($active ? theme.colors.primary600 : theme.colors.neutral600)};
  border-radius: ${({ theme }) => theme.borderRadius};
  min-width: 3.2rem;
  height: 3.2rem;
  font-size: 1.2rem;
  font-weight: 600;
  cursor: pointer;
  &:hover { background: ${({ theme }) => theme.colors.neutral100}; }
  &:disabled { color: ${({ theme }) => theme.colors.neutral300}; cursor: not-allowed; }
`;

function ToolbarButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <IconButton
      label={label}
      disabled={disabled}
      onClick={onClick}
      variant={active ? 'secondary' : 'ghost'}
      size="S"
    >
      {children}
    </IconButton>
  );
}

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

function LinkControl({ editor, isActive }: { editor: Editor; isActive: boolean }) {
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

interface RichTextEditorProps {
  name: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  placeholder?: string;
  required?: boolean;
  labelAction?: React.ReactNode;
}

const RichTextEditor = ({
  name,
  label,
  hint,
  disabled,
  required,
  labelAction,
}: RichTextEditorProps) => {
  const field = useField<string>(name);
  const fieldRef = React.useRef(field);
  fieldRef.current = field;

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: field.value ?? '',
    editable: !disabled,
    // Don't re-render the whole component (and its ~20 toolbar buttons) on
    // every keystroke — the useEditorState selector below re-renders only
    // when a toolbar-relevant flag actually flips.
    shouldRerenderOnTransaction: false,
    onUpdate: ({ editor: current }) => {
      // null (not '') when empty so required-validation and the frontend's
      // empty checks behave exactly as with the old editor; the onChange type
      // is narrower than what the form actually accepts.
      fieldRef.current.onChange(name, (current.isEmpty ? null : current.getHTML()) as any);
    },
  });

  const toolbarState = useEditorState({
    editor,
    selector: ({ editor: current }: { editor: Editor | null }) =>
      current
        ? {
            bold: current.isActive('bold'),
            italic: current.isActive('italic'),
            underline: current.isActive('underline'),
            strike: current.isActive('strike'),
            superscript: current.isActive('superscript'),
            h2: current.isActive('heading', { level: 2 }),
            h3: current.isActive('heading', { level: 3 }),
            bulletList: current.isActive('bulletList'),
            orderedList: current.isActive('orderedList'),
            link: current.isActive('link'),
            inTable: current.isActive('table'),
            canUndo: current.can().undo(),
            canRedo: current.can().redo(),
          }
        : null,
  });

  // External value changes (Discard changes, publish-state switch): reload the
  // document — but never while the editor is focused, or the cursor jumps.
  React.useEffect(() => {
    if (!editor || editor.isFocused) return;
    const incoming = field.value ?? '';
    if (incoming !== (editor.isEmpty ? '' : editor.getHTML())) {
      editor.commands.setContent(incoming, false);
    }
  }, [editor, field.value]);

  React.useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  if (!editor || !toolbarState) return null;

  const inTable = toolbarState.inTable;

  return (
    <Field.Root name={name} hint={hint} error={field.error} required={required}>
      <Field.Label action={labelAction}>{label}</Field.Label>
      <EditorShell $error={Boolean(field.error)} width="100%">
        <Toolbar>
          <ToolbarButton
            label="Bold"
            active={toolbarState.bold}
            disabled={disabled}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold />
          </ToolbarButton>
          <ToolbarButton
            label="Italic"
            active={toolbarState.italic}
            disabled={disabled}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic />
          </ToolbarButton>
          <ToolbarButton
            label="Underline"
            active={toolbarState.underline}
            disabled={disabled}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <UnderlineIcon />
          </ToolbarButton>
          <ToolbarButton
            label="Strikethrough"
            active={toolbarState.strike}
            disabled={disabled}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <StrikeThrough />
          </ToolbarButton>
          <GlyphButton
            type="button"
            aria-label="Superscript"
            $active={toolbarState.superscript}
            disabled={disabled}
            onClick={() => editor.chain().focus().toggleSuperscript().run()}
          >
            x²
          </GlyphButton>

          <GlyphButton
            type="button"
            aria-label="Heading 2"
            $active={toolbarState.h2}
            disabled={disabled}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            H2
          </GlyphButton>
          <GlyphButton
            type="button"
            aria-label="Heading 3"
            $active={toolbarState.h3}
            disabled={disabled}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            H3
          </GlyphButton>

          <ToolbarButton
            label="Bullet list"
            active={toolbarState.bulletList}
            disabled={disabled}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <BulletList />
          </ToolbarButton>
          <ToolbarButton
            label="Numbered list"
            active={toolbarState.orderedList}
            disabled={disabled}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <NumberList />
          </ToolbarButton>

          <LinkControl editor={editor} isActive={toolbarState.link} />

          <ToolbarButton
            label="Horizontal rule"
            disabled={disabled}
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
          >
            <Minus />
          </ToolbarButton>

          {inTable ? (
            <>
              <GlyphButton
                type="button"
                aria-label="Add table row below"
                disabled={disabled}
                onClick={() => editor.chain().focus().addRowAfter().run()}
              >
                +Row
              </GlyphButton>
              <GlyphButton
                type="button"
                aria-label="Add table column after"
                disabled={disabled}
                onClick={() => editor.chain().focus().addColumnAfter().run()}
              >
                +Col
              </GlyphButton>
              <GlyphButton
                type="button"
                aria-label="Delete table row"
                disabled={disabled}
                onClick={() => editor.chain().focus().deleteRow().run()}
              >
                −Row
              </GlyphButton>
              <GlyphButton
                type="button"
                aria-label="Delete table"
                disabled={disabled}
                onClick={() => editor.chain().focus().deleteTable().run()}
              >
                ×Tbl
              </GlyphButton>
            </>
          ) : (
            <GlyphButton
              type="button"
              aria-label="Insert table"
              disabled={disabled}
              onClick={() =>
                editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run()
              }
            >
              Tbl
            </GlyphButton>
          )}

          <GlyphButton
            type="button"
            aria-label="Undo"
            disabled={disabled || !toolbarState.canUndo}
            onClick={() => editor.chain().focus().undo().run()}
          >
            ↺
          </GlyphButton>
          <GlyphButton
            type="button"
            aria-label="Redo"
            disabled={disabled || !toolbarState.canRedo}
            onClick={() => editor.chain().focus().redo().run()}
          >
            ↻
          </GlyphButton>
        </Toolbar>
        <EditorContent editor={editor} />
      </EditorShell>
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
};

export default React.memo(RichTextEditor);
