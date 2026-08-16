import React from 'react';
import { Box } from 'ink';
import { Banner } from './header/Banner';
import { MarketCard } from './header/MarketCard';
import { BlockCard } from './header/BlockCard';
import { SessionCard } from './header/SessionCard';

export function Header() {
  return (
    <Box flexDirection="column">
      <Banner />
      <Box flexDirection="row" marginTop={1}>
        <MarketCard />
        <Box width={2} />
        <BlockCard />
        <Box width={2} />
        <SessionCard />
      </Box>
    </Box>
  );
}
