/**
 * WYSIWYG replacement for Strapi's built-in markdown editor on `richtext`
 * fields (registered via app.addFields({ type: 'richtext' }) in
 * ../../app.tsx). Field integration lives here; the TipTap extension set is
 * ./extensions, toolbar chrome ./toolbar-controls, link handling
 * ./link-control.
 *
 * The fields store HTML (WP-migrated, rendered raw on the public site), so
 * this editor reads and writes HTML strings — no schema or data change.
 */

import * as React from 'react';
import styled from 'styled-components';
import { useField } from '@strapi/strapi/admin';
import { Box, Field } from '@strapi/design-system';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  StrikeThrough,
  BulletList,
  NumberList,
  Minus,
} from '@strapi/icons';
import { useEditor, useEditorState, EditorContent, type Editor } from '@tiptap/react';

import { normalizeBreaksToBlocks } from '../../utils/normalize-breaks';
import { EXTENSIONS } from './extensions';
import { GlyphButton, Toolbar, ToolbarButton } from './toolbar-controls';
import { LinkControl } from './link-control';

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

/* Block-vs-inline is the recurring confusion in these fields: H2/H3 and the
   list buttons look like the bold/italic buttons next to them but apply to the
   whole block, so an editor who joined lines with Shift+Enter sees one click
   reformat all of them. State the rule in the UI, not only in the schema hint. */
const FormatNote = styled.p`
  margin-top: ${({ theme }) => theme.spaces[1]};
  color: ${({ theme }) => theme.colors.neutral600};
  font-size: 1.2rem;
  line-height: 1.4;
`;

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
    content: normalizeBreaksToBlocks(field.value ?? ''),
    editable: !disabled,
    editorProps: {
      // Load-time normalization alone left a second door open: pasting Word/WP
      // markup drops <br>-joined lines into ONE block, so applying H2 or a list
      // afterwards reformats every visual line in it. Normalize the paste the
      // same way the loaded document is normalized. hardBreak stays enabled on
      // purpose — a Shift+Enter the editor types is a deliberate soft break and
      // survives while it stays in the document. Note this hook runs on EVERY
      // paste, including content copied from this same editor — so a hardBreak
      // that round-trips through copy/paste is split into separate blocks too.
      // Accepted trade: there is no reliable way to tell "own" clipboard HTML
      // from outside markup here.
      transformPastedHTML: (html: string) => normalizeBreaksToBlocks(html),
    },
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
    const incoming = normalizeBreaksToBlocks(field.value ?? '');
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
      <FormatNote>
        Heading (H2/H3) and the list buttons are block formats: they apply to the whole
        block, not just the selected words. Press Enter to start a new block you can
        format on its own — Shift+Enter adds a soft line break that stays inside the
        current block and takes whatever formatting that block has.
      </FormatNote>
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
};

export default React.memo(RichTextEditor);
