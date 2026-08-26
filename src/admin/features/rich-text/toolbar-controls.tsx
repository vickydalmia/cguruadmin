// Toolbar chrome for the rich-text editor: the button row container and the
// two button primitives (icon-based and text-glyph).
import * as React from 'react';
import styled from 'styled-components';
import { Flex, IconButton } from '@strapi/design-system';

export const Toolbar = styled(Flex)`
  border-bottom: 1px solid ${({ theme }) => theme.colors.neutral200};
  padding: ${({ theme }) => theme.spaces[1]} ${({ theme }) => theme.spaces[2]};
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.spaces[1]};
`;

/* Text-glyph buttons for actions without a fitting @strapi/icons icon. */
export const GlyphButton = styled.button<{ $active?: boolean }>`
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

export function ToolbarButton({
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
