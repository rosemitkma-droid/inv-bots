import React from 'react';
import { Box, Text } from 'ink';
import { useStore, type LegState } from '../state/store';
import { theme, fmtPrice } from './theme';

function LegBox({
  title,
  titleColor,
  leg,
  accentColor,
}: {
  title: string;
  titleColor: string;
  leg: LegState | null;
  accentColor: string;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={accentColor}
      paddingX={1}
      flexGrow={1}
      flexBasis={0}
    >
      <Text color={titleColor} bold>
        {title}
      </Text>
      {leg ? <LegFields leg={leg} /> : <EmptyLeg />}
    </Box>
  );
}

function EmptyLeg() {
  return (
    <Box marginTop={1}>
      <Text color={theme.dim}>—</Text>
    </Box>
  );
}

function LegFields({ leg }: { leg: LegState }) {
  const profit = leg.liveProfit ?? 0;
  const profitColor =
    profit > 0 ? theme.upBright : profit < 0 ? theme.downBright : theme.valueDim;
  const profitSign = profit > 0 ? '+' : '';
  const statusColor =
    leg.status === 'won' ? theme.upBright
    : leg.status === 'lost' ? theme.downBright
    : leg.status === 'sold' ? theme.accent2
    : leg.status === 'cancelled' ? theme.dim
    : theme.ok;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Row label="Barrier">
        <Text color={theme.violet} bold>
          {fmtPrice(leg.barrier, 2)}
        </Text>
      </Row>
      <Row label="Buy">
        <Text color={theme.value}>{leg.buyPrice.toFixed(2)}</Text>
        <Text color={theme.dim}> → </Text>
        <Text color={theme.upBright}>{leg.payout.toFixed(2)}</Text>
      </Row>
      <Row label="P/L">
        <Text color={profitColor} bold>
          {profitSign}
          {profit.toFixed(2)}
        </Text>
      </Row>
      <Row label="Status">
        <Text color={statusColor} bold>
          {leg.status.toUpperCase()}
        </Text>
      </Row>
      <Row label="Id">
        <Text color={theme.dim}>#{leg.contractId}</Text>
      </Row>
    </Box>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={9}>
        <Text color={theme.dim}>{label}</Text>
      </Box>
      <Text>{children}</Text>
    </Box>
  );
}

function TpBar({
  profit,
  target,
  triggered,
}: {
  profit: number;
  target: number;
  triggered: boolean;
}) {
  const width = 40;
  const safeTarget = target > 0 ? target : 1;
  const ratio = Math.max(0, Math.min(1, profit / safeTarget));
  const filled = Math.round(ratio * width);
  const reached = profit >= target;
  const fillColor = reached ? theme.upBright : profit >= 0 ? theme.accent : theme.downBright;
  const sign = profit >= 0 ? '+' : '';
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.dim}>TP   </Text>
        <Text color={fillColor}>{'█'.repeat(filled)}</Text>
        <Text color={theme.muted}>{'░'.repeat(width - filled)}</Text>
        <Text> </Text>
        <Text color={fillColor} bold>
          {sign}
          {profit.toFixed(2)}
        </Text>
        <Text color={theme.dim}> / </Text>
        <Text color={theme.gold} bold>
          {target.toFixed(2)}
        </Text>
      </Box>
      {triggered ? (
        <Box marginTop={0}>
          <Text color={theme.accent2} bold>
            ⟐ SELLING sellable legs…
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function BlockPanel() {
  const pair = useStore((s) => s.currentPair);
  const config = useStore((s) => s.config);
  const active = !!pair;
  const borderColor = active ? theme.gold : theme.dim;
  const blockTp = config?.blockTp ?? 0;
  const pairProfit = (pair?.higher?.liveProfit ?? 0) + (pair?.lower?.liveProfit ?? 0);
  const mode = config?.mode ?? 'higher-lower';
  // Arrow points at the barrier (↑ predH, ↓ predL). Contract type depends
  // on mode: higher-lower is a stay-in-range bet using LOWER@predH and
  // HIGHER@predL; no-touch uses NOTOUCH on both barriers.
  const upperTitle = mode === 'no-touch' ? 'NOTOUCH ↑' : 'LOWER ↑';
  const lowerTitle = mode === 'no-touch' ? 'NOTOUCH ↓' : 'HIGHER ↓';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text color={active ? theme.gold : theme.dim} bold>
          ◆ ACTIVE PAIR
        </Text>
        <Text color={theme.muted}>  ·  </Text>
        <Text color={mode === 'no-touch' ? theme.violet : theme.accent} bold>
          {mode === 'no-touch' ? 'NO TOUCH' : 'HIGHER/LOWER'}
        </Text>
        {active ? (
          <Text color={theme.dim}>
            {'  '}block {new Date(pair!.blockStart * 1000).toISOString().slice(11, 16)}Z–
            {new Date(pair!.blockEnd * 1000).toISOString().slice(11, 16)}Z
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <LegBox
          title={upperTitle}
          titleColor={theme.upBright}
          leg={pair?.higher ?? null}
          accentColor={pair?.higher ? theme.up : theme.dim}
        />
        <Box width={2} />
        <LegBox
          title={lowerTitle}
          titleColor={theme.downBright}
          leg={pair?.lower ?? null}
          accentColor={pair?.lower ? theme.down : theme.dim}
        />
      </Box>
      <TpBar profit={pairProfit} target={blockTp} triggered={!!pair?.tpTriggered} />
    </Box>
  );
}
