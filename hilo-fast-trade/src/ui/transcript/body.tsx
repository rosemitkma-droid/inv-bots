import React from 'react';
import { Text } from 'ink';
import { theme } from '../theme';
import type { LogKind } from '../../state/store';
import { renderKeyValuePairs } from './kv';

export function renderBody(kind: LogKind, text: string): React.ReactNode {
  switch (kind) {
    case 'block':
      return renderBlock(text);
    case 'trade-open':
      return renderTradeOpen(text);
    case 'trade-close':
      return renderTradeClose(text);
    case 'sell':
      return renderSell(text);
    case 'status':
      return renderStatus(text);
    case 'info':
      return <Text color={theme.value}>{text}</Text>;
    case 'warn':
      return <Text color={theme.warn}>{text}</Text>;
    case 'error':
      return (
        <Text color={theme.err} bold>
          {text}
        </Text>
      );
    case 'system':
      return <Text color={theme.dim}>{text}</Text>;
    default:
      return <Text color={theme.value}>{text}</Text>;
  }
}

/** "new block HH:MMZ–HH:MMZ  open=1015.02  predH=1019.5  predL=1010.5  [historical 20d]" */
const BLOCK_RE =
  /^new block\s+(\d{2}:\d{2}Z)[–-](\d{2}:\d{2}Z)\s+(.+?)(?:\s+\[(.+?)\])?\s*$/;

function renderBlock(text: string): React.ReactNode {
  const m = BLOCK_RE.exec(text);
  if (!m) return renderKeyValuePairs(text);
  const [, t0, t1, kvs, tag] = m;
  return (
    <Text>
      <Text color={theme.dim}>new block </Text>
      <Text color={theme.gold} bold>
        {t0}–{t1}
      </Text>
      <Text>  </Text>
      {renderKeyValuePairs(kvs!)}
      {tag ? (
        <Text>
          <Text color={theme.muted}>  [</Text>
          <Text color={theme.accent}>{tag}</Text>
          <Text color={theme.muted}>]</Text>
        </Text>
      ) : null}
    </Text>
  );
}

/** Trade-open log line. All leg labels now carry an arrow suffix that points
 *  at the barrier (↑ = upper/predH, ↓ = lower/predL), independent of mode:
 *    higher-lower: "LOWER↑ stake=5.00 …", "HIGHER↓ stake=5.00 …"
 *    no-touch:     "NOTOUCH↑ stake=5.00 …", "NOTOUCH↓ stake=5.00 …"
 *  Plain "HIGHER" / "LOWER" without arrow is matched for legacy logs. */
const TRADE_OPEN_RE = /^(DRY\s+)?((?:HIGHER|LOWER|NOTOUCH)[↑↓]?)\s+(.+?)\s*$/;

function renderTradeOpen(text: string): React.ReactNode {
  const m = TRADE_OPEN_RE.exec(text);
  if (!m) return <Text color={theme.value}>{text}</Text>;
  const [, dry, side, rest] = m;
  const isUpper = side.endsWith('↑') || side === 'HIGHER';
  const sideColor = isUpper ? theme.upBright : theme.downBright;
  return (
    <Text>
      {dry ? (
        <Text color={theme.warn} bold>
          DRY{' '}
        </Text>
      ) : null}
      <Text color={sideColor} bold>
        {side}
      </Text>
      <Text>  </Text>
      {renderKeyValuePairs(rest!)}
    </Text>
  );
}

/** "DRY WIN HIGHER +3.50 exit=1020.5 barrier=1020.5"
 *  "DRY LOSS LOWER -5.00 exit=1010.5 barrier=1010.5"
 *  "DRY WIN NOTOUCH↑ +3.50 exit=1019.0 barrier=1020.5"
 *  "block HH:MMZ realised: +1.50 (H +4.00 / L -2.50) sess +12.50" */
const TRADE_CLOSE_RESULT_RE =
  /^(DRY\s+)?(WIN|LOSS)\s+((?:HIGHER|LOWER|NOTOUCH)[↑↓]?)\s+([+-]?[\d.]+)\s*(.*)$/;
const TRADE_CLOSE_REALISED_RE =
  /^block\s+(\d{2}:\d{2}Z)\s+realised:\s+([+-]?[\d.]+)\s+(.*)$/;

function renderTradeClose(text: string): React.ReactNode {
  const mRes = TRADE_CLOSE_RESULT_RE.exec(text);
  if (mRes) {
    const [, dry, result, side, profit, tail] = mRes;
    const isUpper = side.endsWith('↑') || side === 'HIGHER';
    const sideColor = isUpper ? theme.upBright : theme.downBright;
    const resultColor = result === 'WIN' ? theme.upBright : theme.downBright;
    const profitN = Number(profit);
    const profitColor = profitN >= 0 ? theme.upBright : theme.downBright;
    const profitSign = profitN > 0 ? '+' : '';
    return (
      <Text>
        {dry ? (
          <Text color={theme.warn} bold>
            DRY{' '}
          </Text>
        ) : null}
        <Text color={resultColor} bold>
          {result}
        </Text>
        <Text>  </Text>
        <Text color={sideColor} bold>
          {side}
        </Text>
        <Text>   </Text>
        <Text color={profitColor} bold>
          {profitSign}
          {profitN.toFixed(2)}
        </Text>
        {tail && tail.trim().length ? (
          <Text>
            <Text>  </Text>
            {renderKeyValuePairs(tail)}
          </Text>
        ) : null}
      </Text>
    );
  }

  const mReal = TRADE_CLOSE_REALISED_RE.exec(text);
  if (mReal) {
    const [, t0, realised, rest] = mReal;
    const realN = Number(realised);
    const realColor = realN > 0 ? theme.upBright : realN < 0 ? theme.downBright : theme.value;
    const sign = realN > 0 ? '+' : '';
    return (
      <Text>
        <Text color={theme.dim}>block </Text>
        <Text color={theme.gold} bold>
          {t0}
        </Text>
        <Text color={theme.dim}> realised </Text>
        <Text color={realColor} bold>
          {sign}
          {realN.toFixed(2)}
        </Text>
        <Text>  </Text>
        <Text color={theme.dim}>{rest}</Text>
      </Text>
    );
  }
  return <Text color={theme.value}>{text}</Text>;
}

/** "pair P/L +5.00 >= tp 5.00 — selling sellable legs"
 *  "pair P/L -0.80 <= -sl 0.80 — selling sellable legs"
 *  "pair P/L retraced 0.60 from peak +1.50 — selling sellable legs"
 *  "DRY HIGHER id=-12345 sold @ +3.50"
 *  "HIGHER id=12345 sold_for=8.75" */
const SELL_PAIR_RE = /^pair P\/L\s+([+-]?[\d.]+)\s+>=\s+tp\s+([+-]?[\d.]+)\s+—\s*(.+)$/;
const SELL_SL_RE = /^pair P\/L\s+([+-]?[\d.]+)\s+<=\s+-sl\s+([+-]?[\d.]+)\s+—\s*(.+)$/;
const SELL_TRAIL_RE = /^pair P\/L\s+retraced\s+([\d.]+)\s+from\s+peak\s+([+-]?[\d.]+)\s+—\s*(.+)$/;
const SELL_LEG_RE = /^(DRY\s+)?((?:HIGHER|LOWER|NOTOUCH)[↑↓]?)\s+(.+)$/;

function renderSell(text: string): React.ReactNode {
  const mP = SELL_PAIR_RE.exec(text);
  if (mP) {
    const [, profit, tp, tail] = mP;
    const pN = Number(profit);
    const pColor = pN >= 0 ? theme.upBright : theme.downBright;
    const pSign = pN > 0 ? '+' : '';
    return (
      <Text>
        <Text color={theme.dim}>pair P/L </Text>
        <Text color={pColor} bold>
          {pSign}
          {pN.toFixed(2)}
        </Text>
        <Text color={theme.dim}> ≥ tp </Text>
        <Text color={theme.gold} bold>
          {Number(tp).toFixed(2)}
        </Text>
        <Text color={theme.dim}> — {tail}</Text>
      </Text>
    );
  }
  const mS = SELL_SL_RE.exec(text);
  if (mS) {
    const [, profit, sl, tail] = mS;
    return (
      <Text>
        <Text color={theme.dim}>pair P/L </Text>
        <Text color={theme.downBright} bold>
          {Number(profit).toFixed(2)}
        </Text>
        <Text color={theme.dim}> ≤ -sl </Text>
        <Text color={theme.err} bold>
          {Number(sl).toFixed(2)}
        </Text>
        <Text color={theme.dim}> — {tail}</Text>
      </Text>
    );
  }
  const mT = SELL_TRAIL_RE.exec(text);
  if (mT) {
    const [, retrace, peak, tail] = mT;
    return (
      <Text>
        <Text color={theme.dim}>pair P/L retraced </Text>
        <Text color={theme.downBright} bold>
          {retrace}
        </Text>
        <Text color={theme.dim}> from peak </Text>
        <Text color={theme.upBright} bold>
          {peak}
        </Text>
        <Text color={theme.dim}> — {tail}</Text>
      </Text>
    );
  }
  const mL = SELL_LEG_RE.exec(text);
  if (mL) {
    const [, dry, side, rest] = mL;
    const isUpper = side.endsWith('↑') || side === 'HIGHER';
    const sideColor = isUpper ? theme.upBright : theme.downBright;
    return (
      <Text>
        {dry ? (
          <Text color={theme.warn} bold>
            DRY{' '}
          </Text>
        ) : null}
        <Text color={sideColor} bold>
          {side}
        </Text>
        <Text>  </Text>
        {renderKeyValuePairs(rest!)}
      </Text>
    );
  }
  return <Text color={theme.value}>{text}</Text>;
}

function renderStatus(text: string): React.ReactNode {
  const parts = text.split(/(\s+)/);
  return (
    <Text>
      {parts.map((p, i) => {
        if (/^\s+$/.test(p)) return <Text key={i}>{p}</Text>;
        if (p === 'demo') return <Text key={i} color={theme.warn} bold>{p}</Text>;
        if (p === 'real') return <Text key={i} color={theme.upBright} bold>{p}</Text>;
        if (p === 'connected' || p === 'open' || p === 'live') {
          return <Text key={i} color={theme.upBright} bold>{p}</Text>;
        }
        if (p === 'closed' || p === 'stopped' || p === 'closing') {
          return <Text key={i} color={theme.dim} bold>{p}</Text>;
        }
        if (/^[+-]?\d+(\.\d+)?$/.test(p)) {
          return <Text key={i} color={theme.value} bold>{p}</Text>;
        }
        if (/^[A-Z0-9_]{4,}$/.test(p) && /[A-Z]/.test(p)) {
          return <Text key={i} color={theme.accent} bold>{p}</Text>;
        }
        return <Text key={i} color={theme.value}>{p}</Text>;
      })}
    </Text>
  );
}
