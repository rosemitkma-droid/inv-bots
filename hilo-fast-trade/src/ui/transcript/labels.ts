import { theme } from '../theme';
import type { LogKind } from '../../state/store';

export interface LabelMeta {
  label: string;
  color: string;
}

export function labelFor(kind: LogKind, text: string): LabelMeta {
  switch (kind) {
    case 'block':
      return { label: 'BLOCK', color: theme.gold };
    case 'trade-open':
      return { label: 'BUY', color: theme.gold };
    case 'trade-close': {
      const lead = text.replace(/^DRY\s+/i, '').trim().toUpperCase();
      if (lead.startsWith('WIN')) return { label: 'WIN', color: theme.upBright };
      if (lead.startsWith('LOSS')) return { label: 'LOSS', color: theme.downBright };
      return { label: 'CLOSE', color: theme.accent2 };
    }
    case 'sell':
      return { label: 'SELL', color: theme.violet };
    case 'error':
      return { label: 'ERR', color: theme.err };
    case 'warn':
      return { label: 'WARN', color: theme.warn };
    case 'status':
      return { label: 'STAT', color: theme.ok };
    case 'info':
      return { label: 'INFO', color: theme.accent };
    case 'system':
    default:
      return { label: 'SYS', color: theme.dim };
  }
}
