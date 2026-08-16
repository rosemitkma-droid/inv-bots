import React from 'react';
import { Text } from 'ink';
import { useStore } from '../../state/store';
import { theme, fmtMoney } from '../theme';
import { Card, Metric, WinRateBar } from './primitives';

export function SessionCard() {
  const account = useStore((s) => s.account);
  const session = useStore((s) => s.session);

  const ccy = account.currency ?? '';
  const pnl = fmtMoney(session.totalProfit, ccy);
  const hasTrades = session.trades > 0;
  const wrPct = hasTrades ? session.wins / session.trades : 0;
  const wrLabel = hasTrades ? `${Math.round(wrPct * 100)}%` : '—';
  const profitUp = session.totalProfit >= 0;
  const sessionAccent = !hasTrades ? theme.dim : profitUp ? theme.up : theme.down;
  const icon = !hasTrades ? '○' : profitUp ? '▲' : '▼';
  const hasAccount = account.type !== undefined;
  const isDemo = account.type === 'demo';

  return (
    <Card title="SESSION" icon={icon} accent={sessionAccent}>
      <Metric label="Account">
        {hasAccount ? (
          <Text color={isDemo ? theme.warn : theme.ok} bold>
            {isDemo ? 'DEMO' : 'REAL'}
          </Text>
        ) : (
          <Text color={theme.dim}>—</Text>
        )}
      </Metric>
      <Metric label="Balance">
        {account.balance !== undefined ? (
          <>
            <Text color={theme.ok} bold>
              {account.balance.toFixed(2)}
            </Text>
            {ccy ? <Text color={theme.dim}> {ccy}</Text> : null}
          </>
        ) : (
          <Text color={theme.dim}>—</Text>
        )}
      </Metric>
      <Metric label="Profit">
        <Text color={profitUp ? theme.up : theme.down} bold>
          {pnl}
        </Text>
      </Metric>
      <Metric label="Win rate">
        <WinRateBar pct={wrPct} hasTrades={hasTrades} />
        <Text color={theme.accent} bold>
          {' '}
          {wrLabel}
        </Text>
        <Text color={theme.dim}> · {session.trades} blk</Text>
      </Metric>
      <Metric label="Legs">
        <Text color={theme.dim}>
          {session.legsWon}/{session.legsLost} W/L
        </Text>
      </Metric>
    </Card>
  );
}
