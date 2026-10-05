import * as React from 'react';
import { InputRenderer } from '@strapi/strapi/admin';

type Props = {
  name: string;
  label?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  labelAction?: React.ReactNode;
  attribute: { enum: string[] };
};

const PAGE_TEMPLATE_LABELS: Record<string, string> = {
  default: 'Default',
  dealTemplate: 'Deal Template',
  independenceDayTemplate: 'Independence Day Template',
  festivalTemplate: 'Festival Template',
};

// Keep Strapi's native field state, accessibility, focus and validation. Only
// the page-template options get display labels; stored enum values stay intact.
export default function TemplateEnumerationInput(props: Props) {
  const options = props.attribute.enum.map((value) => ({
    value,
    label: props.name === 'pageTemplate'
      ? PAGE_TEMPLATE_LABELS[value] ?? value
      : value,
  }));
  return <InputRenderer {...props} type="enumeration" options={options} />;
}
