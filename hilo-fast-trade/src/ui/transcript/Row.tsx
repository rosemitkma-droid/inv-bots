import React from 'react';
import { Text } from 'ink';
import { theme, fmtTime } from '../theme';
import type { LogLine } from '../../state/store';
import { labelFor } from './labels';
import { renderBody } from './body';

const TAG_WIDTH = 5;
const BAR = '▍';

export const Row = React.memo(
  function Row({ line }: { line: LogLine }) {
    const meta = labelFor(line.kind, line.text);
    const padded = meta.label.padEnd(TAG_WIDTH, ' ');
    // Truncate instead of wrap: a wrapped row splits the timestamp / tag
    // column, which ruins alignment. Truncating at the right edge keeps
    // every row exactly one line tall.
    return (
      <Text wrap="truncate-end">
        <Text color={theme.dim}>{fmtTime(line.at)}</Text>
        <Text color={meta.color}> {BAR} </Text>
        <Text color={meta.color} bold>
          {padded}
        </Text>
        <Text> </Text>
        {renderBody(line.kind, line.text)}
      </Text>
    );
  },
  (prev, next) =>
    prev.line.at === next.line.at &&
    prev.line.kind === next.line.kind &&
    prev.line.text === next.line.text,
);
