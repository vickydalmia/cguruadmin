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

// Keep Strapi's native field state, accessibility, focus and validation. Only
// this template option gets a display label; all stored enum values stay intact.
export default function TemplateEnumerationInput(props: Props) {
  const options = props.attribute.enum.map((value) => ({
    value,
    label: props.name === 'pageTemplate' && value === 'festivalTemplate'
      ? 'Festival Template'
      : value,
  }));
  return <InputRenderer {...props} type="enumeration" options={options} />;
}
