import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from '../state/store';
import { theme } from './theme';
import { Row } from './transcript/Row';

const VISIBLE = 30;

export function Transcript() {
  const lines = useStore((s) => s.transcript);
  const tail = lines.slice(-VISIBLE);
  return (
    <Box flexDirection="column" marginY={1}>
      {tail.length === 0 ? (
        <Text color={theme.dim}>(transcript is empty)</Text>
      ) : (
        tail.map((l, i) => <Row key={`${l.at}-${i}`} line={l} />)
      )}
    </Box>
  );
}
