import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { useStore } from '../../state/store';
import { theme, fmtPrice, fmtCountdown } from '../theme';
import { Card, Metric } from './primitives';

function useNowSec(active: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now() / 1000), 500);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function BlockCard() {
  const pair = useStore((s) => s.currentPair);
  const active = !!pair;
  const now = useNowSec(active);

  const accent = active ? theme.gold : theme.dim;
  const icon = active ? '◆' : '○';

  if (!pair) {
    return (
      <Card title="BLOCK" icon={icon} accent={accent}>
        <Metric label="Status">
          <Text color={theme.dim}>waiting for next block</Text>
        </Metric>
        <Metric label="Open">
          <Text color={theme.dim}>—</Text>
        </Metric>
        <Metric label="Pred H">
          <Text color={theme.dim}>—</Text>
        </Metric>
        <Metric label="Pred L">
          <Text color={theme.dim}>—</Text>
        </Metric>
      </Card>
    );
  }

  const remaining = Math.max(0, pair.blockEnd - now);
  const src = pair.predictionSource === 'historical' ? `hist ${pair.daysUsed}d` : 'atr';

  return (
    <Card title="BLOCK" icon={icon} accent={accent}>
      <Metric label="Open">
        <Text color={theme.fg} bold>
          {fmtPrice(pair.blockOpen, 2)}
        </Text>
        <Text color={theme.dim}>  · {src}</Text>
      </Metric>
      <Metric label="Pred H">
        <Text color={theme.up} bold>
          ↑ {fmtPrice(pair.predictedHigh, 2)}
        </Text>
      </Metric>
      <Metric label="Pred L">
        <Text color={theme.down} bold>
          ↓ {fmtPrice(pair.predictedLow, 2)}
        </Text>
      </Metric>
      <Metric label="Ends in">
        <Text color={theme.ice} bold>
          {fmtCountdown(remaining)}
        </Text>
      </Metric>
    </Card>
  );
}
