import React from 'react';
import { Text } from 'ink';
import { theme } from '../theme';

export function renderKeyValuePairs(text: string): React.ReactNode {
  const tokens = text.split(/\s+/).filter(Boolean);
  return (
    <Text>
      {tokens.map((tok, i) => (
        <Token key={i} raw={tok} index={i} />
      ))}
    </Text>
  );
}

function Token({ raw, index }: { raw: string; index: number }) {
  const sep = index === 0 ? '' : '  ';
  if (raw.startsWith('id=')) {
    return (
      <Text>
        <Text>{sep}</Text>
        <Text color={theme.muted}>#</Text>
        <Text color={theme.dim}>{raw.slice(3)}</Text>
      </Text>
    );
  }
  const eq = raw.indexOf('=');
  if (eq > 0) {
    const key = raw.slice(0, eq);
    const val = raw.slice(eq + 1);
    const valColor = pickValueColor(key, val);
    return (
      <Text>
        <Text>{sep}</Text>
        <Text color={theme.dim}>{key} </Text>
        <Text color={valColor} bold>
          {val}
        </Text>
      </Text>
    );
  }
  return (
    <Text>
      <Text>{sep}</Text>
      <Text color={theme.value}>{raw}</Text>
    </Text>
  );
}

function pickValueColor(key: string, val: string): string {
  const k = key.toLowerCase();
  if (k === 'stake') return theme.value;
  if (k === 'payout') return theme.upBright;
  if (k === 'dur') return theme.ice;
  if (k === 'barrier') return theme.violet;
  if (k === 'predh') return theme.up;
  if (k === 'predl') return theme.down;
  if (k === 'open') return theme.value;
  if (k === 'exit') return theme.value;
  if (k === 'entry') return theme.valueDim;
  if (k === 'sold_for') return theme.upBright;
  if (k === 'p') return theme.violet;
  if (k === 'ev') return theme.gold;
  if (val.startsWith('+')) return theme.upBright;
  if (val.startsWith('-')) return theme.downBright;
  return theme.value;
}
