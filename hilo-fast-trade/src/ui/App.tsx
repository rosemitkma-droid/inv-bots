import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import { useStore } from '../state/store';
import { Trader } from '../trading/trader';
import { theme } from './theme';
import { Header } from './Header';
import { BlockPanel } from './BlockPanel';
import { Transcript } from './Transcript';
import { Prompt } from './Prompt';
import { SelectMenu } from './SelectMenu';
import type { CmdCtx } from './commands';

export function App() {
  const { exit } = useApp();
  const config = useStore((s) => s.config);
  const traderRef = useRef<Trader | null>(null);
  const [exiting, setExiting] = useState(false);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      const t = traderRef.current;
      if (t) { try { t.stop(); } catch { /* noop */ } }
    };
  }, []);

  const doExit = () => {
    if (exiting) return;
    setExiting(true);
    try { traderRef.current?.stop(); } catch { /* noop */ }
    setTimeout(() => exit(), 50);
  };

  const ctx: CmdCtx = {
    getTrader: () => traderRef.current,
    ensureTrader: () => {
      if (!traderRef.current) {
        const cfg = useStore.getState().config;
        if (!cfg) throw new Error('no config');
        traderRef.current = new Trader(cfg);
      }
      return traderRef.current;
    },
    dropTrader: () => { traderRef.current = null; },
    requestExit: doExit,
  };

  const { isRawModeSupported } = useStdin();
  const menuOpen = useStore((s) => s.menuStack.length > 0);

  if (!config) return null;

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Header />
      <BlockPanel />
      <Transcript />
      {isRawModeSupported ? (
        menuOpen ? <SelectMenu /> : <Prompt ctx={ctx} />
      ) : (
        <Box>
          <Text color={theme.dim}>(stdin is not a TTY — no interactive prompt; Ctrl+C to exit)</Text>
        </Box>
      )}
    </Box>
  );
}
