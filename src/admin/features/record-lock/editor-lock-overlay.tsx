import { Button, Flex, Typography } from '@strapi/design-system';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { styled } from 'styled-components';

type ViewportBounds = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type EditorLockOverlayProps = {
  self: boolean;
  holderName: string;
  escapeLabel: string;
  onEscape: () => void;
  onTakeover: () => void;
};

const Backdrop = styled.div`
  position: fixed;
  z-index: 1000;
  display: grid;
  place-items: center;
  overflow: auto;
  padding: 2rem;
  background: rgba(33, 33, 52, 0.48);
`;

const DialogCard = styled.div`
  width: min(30rem, 100%);
  overflow: hidden;
  border: 1px solid ${({ theme }) => theme.colors.neutral150};
  border-radius: ${({ theme }) => theme.borderRadius};
  background: ${({ theme }) => theme.colors.neutral0};
  box-shadow: ${({ theme }) => theme.shadows.popupShadow};
  outline: none;
`;

const DialogSection = styled.div`
  padding: 1.5rem;

  & + & {
    border-top: 1px solid ${({ theme }) => theme.colors.neutral150};
  }
`;

function readMainBounds(main: HTMLElement): ViewportBounds | null {
  const rect = main.getBoundingClientRect();
  const top = Math.max(0, rect.top);
  const left = Math.max(0, rect.left);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  const width = right - left;
  const height = bottom - top;
  return width > 0 && height > 0 ? { top, left, width, height } : null;
}

/**
 * A visual modal constrained to the Content Manager's <main> viewport. It is
 * intentionally not a global Radix/Strapi dialog: those portal a full-screen
 * backdrop to <body> and prevent admins from using either navigation sidebar.
 */
export function EditorLockOverlay({
  self,
  holderName,
  escapeLabel,
  onEscape,
  onTakeover,
}: EditorLockOverlayProps) {
  const [bounds, setBounds] = React.useState<ViewportBounds | null>(null);
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const focused = React.useRef(false);
  const titleId = React.useId();
  const descriptionId = React.useId();

  React.useLayoutEffect(() => {
    const main = document.querySelector<HTMLElement>('main');
    if (!main) return undefined;

    let frame = 0;
    const update = () => {
      frame = 0;
      const next = readMainBounds(main);
      setBounds((previous) =>
        previous?.top === next?.top &&
        previous?.left === next?.left &&
        previous?.width === next?.width &&
        previous?.height === next?.height
          ? previous
          : next,
      );
    };
    const scheduleUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(main);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
    };
  }, []);

  React.useEffect(() => {
    if (bounds && !focused.current) {
      focused.current = true;
      dialogRef.current?.focus();
    }
  }, [bounds]);

  if (!bounds) return null;

  const title = self ? 'You are editing this elsewhere' : 'Entry is being edited';
  const description = self
    ? 'Another of your own tabs or a previous session still holds this edit ' +
      'lock. If that tab is closed, take over editing here.'
    : `${holderName} is currently working on this entry. Editing is locked ` +
      'so their changes are not overwritten. You can use the navigation ' +
      'outside this editor while you wait.';

  return createPortal(
    <Backdrop style={bounds}>
      <DialogCard
        ref={dialogRef}
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <DialogSection>
          <Typography id={titleId} tag="h2" variant="beta">
            {title}
          </Typography>
        </DialogSection>
        <DialogSection>
          <Typography id={descriptionId} textColor="neutral700">
            {description}
          </Typography>
        </DialogSection>
        <DialogSection>
          <Flex gap={2} justifyContent="flex-end" wrap="wrap">
            <Button variant="tertiary" onClick={onEscape}>
              {escapeLabel}
            </Button>
            {self ? (
              <Button onClick={onTakeover}>Take over editing here</Button>
            ) : null}
          </Flex>
        </DialogSection>
      </DialogCard>
    </Backdrop>,
    document.body,
  );
}
