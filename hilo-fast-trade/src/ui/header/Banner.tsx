import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { theme, fmtTime } from '../theme';
import { StatusPill } from './StatusPill';

const VERSION = '0.1.0';
const TAGLINE = 'time-block paired range trader';
const SUBTAG = 'Deriv synthetic indices · hilo-fast block engine';

// HILO-FAST in ANSI Shadow figlet, split into per-letter cells so the
// header can paint a left-to-right gradient across the wordmark.
// Concatenating each row reproduces the figlet output exactly.
// Cells: H I L O - F A S T (9 total).
const BANNER_LETTERS: readonly (readonly string[])[] = [
  ['██╗  ██╗', '██╗', '██╗     ', ' ██████╗ ', '      ', '███████╗', ' █████╗ ', '███████╗', '████████╗'],
  ['██║  ██║', '██║', '██║     ', '██╔═══██╗', '      ', '██╔════╝', '██╔══██╗', '██╔════╝', '╚══██╔══╝'],
  ['███████║', '██║', '██║     ', '██║   ██║', '█████╗', '█████╗  ', '███████║', '███████╗', '   ██║   '],
  ['██╔══██║', '██║', '██║     ', '██║   ██║', '╚════╝', '██╔══╝  ', '██╔══██║', '╚════██║', '   ██║   '],
  ['██║  ██║', '██║', '███████╗', '╚██████╔╝', '      ', '██║     ', '██║  ██║', '███████║', '   ██║   '],
  ['╚═╝  ╚═╝', '╚═╝', '╚══════╝', ' ╚═════╝ ', '      ', '╚═╝     ', '╚═╝  ╚═╝', '╚══════╝', '   ╚═╝   '],
];

// H → T traces a green → teal → cyan → indigo → violet → fuchsia → rose
// gradient — reads as range expansion through the brand indigo into the
// warm "trade execution" end of the spectrum.
const LETTER_COLORS: readonly string[] = [
  '#4ade80', // H
  '#22c55e', // I
  '#14b8a6', // L
  '#0ea5e9', // O
  '#8b5cf6', // -
  '#a855f7', // F
  '#d946ef', // A
  '#ec4899', // S
  '#f43f5e', // T
];

export function Banner() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={0}
    >
      <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
        <Box flexDirection="column">
          {BANNER_LETTERS.map((row, r) => (
            <Text key={r} bold>
              {row.map((cell, i) => (
                <Text key={i} color={LETTER_COLORS[i]}>
                  {cell}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" alignItems="flex-end" marginLeft={2}>
          <Text color={theme.accent2} bold>
            ◆ hilo-fast
          </Text>
          <Text color={theme.dim}>v{VERSION}</Text>
          <Box marginTop={1}>
            <StatusPill />
          </Box>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="row" justifyContent="space-between" alignItems="flex-end">
        <Box flexDirection="column">
          <Text>
            <Text color={theme.fg} bold>
              {TAGLINE}
            </Text>
          </Text>
          <Text color={theme.dim}>{SUBTAG}</Text>
        </Box>
        <Text>
          <Text color="#FF444F" bold>
            ◆ deriv
          </Text>
          <Text color={theme.muted}>{'  ·  '}</Text>
          <Text color={theme.fg}>Partnerships</Text>
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color={theme.dim}>/help</Text>
          <Text color={theme.muted}>{'  ·  '}</Text>
          <Text color={theme.dim}>/start</Text>
          <Text color={theme.muted}>{'  ·  '}</Text>
          <Text color={theme.dim}>/quit</Text>
          <Text color={theme.muted}>{'  ·  '}</Text>
          <Text color={theme.dim}>Ctrl+C to exit</Text>
        </Text>
        <Text color={theme.dim}>{fmtTime(now)}</Text>
      </Box>
    </Box>
  );
}
