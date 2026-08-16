import React from 'react';
import { Text } from 'ink';
import Spinner from 'ink-spinner';
import { useStore } from '../../state/store';
import { theme } from '../theme';

export function StatusPill() {
  const status = useStore((s) => s.status);
  const haltReason = useStore((s) => s.haltReason);

  let color: string = theme.dim;
  let glyph: React.ReactNode = '○';
  let label: string = status;

  switch (status) {
    case 'idle':
      color = theme.dim;
      glyph = '○';
      label = 'idle';
      break;
    case 'connecting':
      color = theme.warn;
      glyph = <Spinner type="dots" />;
      label = 'connecting';
      break;
    case 'running':
      color = theme.ok;
      glyph = '●';
      label = 'live';
      break;
    case 'halted':
      color = theme.warn;
      glyph = '■';
      label = 'halted';
      break;
    case 'error':
      color = theme.err;
      glyph = '✕';
      label = 'error';
      break;
  }

  return (
    <Text color={color} bold>
      {glyph} {label}
      {status === 'halted' && haltReason ? (
        <Text color={theme.dim}>{` (${haltReason})`}</Text>
      ) : null}
    </Text>
  );
}
