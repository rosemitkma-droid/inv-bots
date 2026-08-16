import React from 'react';
import { Text } from 'ink';
import { useStore } from '../../state/store';
import { theme } from '../theme';
import { Card, Metric } from './primitives';

export function MarketCard() {
  const config = useStore((s) => s.config);
  const accountCurrency = useStore((s) => s.account.currency);
  if (!config) return null;
  const currency = config.currency || accountCurrency || '';

  return (
    <Card title="MARKET" icon="◈" accent={theme.accent}>
      <Metric label="Symbol">
        <Text color={theme.accent} bold>
          {config.symbol}
        </Text>
      </Metric>
      <Metric label="Run">
        {config.dryRun ? (
          <Text color={theme.warn} bold>
            ◆ DRY RUN
          </Text>
        ) : (
          <Text color={theme.ok} bold>
            ● LIVE
          </Text>
        )}
      </Metric>
      <Metric label="Mode">
        {config.mode === 'no-touch' ? (
          <Text color={theme.violet} bold>
            NO TOUCH
          </Text>
        ) : (
          <Text color={theme.accent} bold>
            HIGHER/LOWER
          </Text>
        )}
      </Metric>
      <Metric label="Block">
        <Text color={theme.fg} bold>
          {config.blockMinutes}
        </Text>
        <Text color={theme.dim}> min</Text>
      </Metric>
      <Metric label="Stake">
        <Text color={theme.fg} bold>
          {config.stake.toFixed(2)}
        </Text>
        {currency ? <Text color={theme.dim}> {currency}</Text> : null}
      </Metric>
      <Metric label="Block TP">
        <Text color={theme.gold} bold>
          +{config.blockTp.toFixed(2)}
        </Text>
        {currency ? <Text color={theme.dim}> {currency}</Text> : null}
      </Metric>
      <Metric label="Sess TP">
        {config.sessionTp !== undefined ? (
          <Text color={theme.up} bold>
            +{config.sessionTp.toFixed(2)}
          </Text>
        ) : (
          <Text color={theme.dim}>off</Text>
        )}
      </Metric>
      <Metric label="Sess SL">
        {config.sessionSl !== undefined ? (
          <Text color={theme.down} bold>
            -{config.sessionSl.toFixed(2)}
          </Text>
        ) : (
          <Text color={theme.dim}>off</Text>
        )}
      </Metric>
    </Card>
  );
}
