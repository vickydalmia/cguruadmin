// The TipTap extension set for the rich-text field. Driven by what actually
// exists in content (tables, images, sup, h1–h6); anything outside the server
// allowlist is stripped on save by src/utils/sanitize-richtext.ts.
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Image from '@tiptap/extension-image';
import Superscript from '@tiptap/extension-superscript';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';

export const EXTENSIONS = [
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
