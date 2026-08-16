import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { COMMANDS, dispatchCommand, matchCommands, type CmdCtx } from './commands';
import { theme } from './theme';

const MAX_MENU = 6;

/**
 * Command prompt. Mirrors kairos's aesthetic: `❯` caret, inline autocomplete
 * when typing `/`, history via ↑/↓, Tab to complete, Esc to clear.
 *
 * Raw-mode must be available — the caller (App) gates on isRawModeSupported.
 */
export function Prompt({ ctx }: { ctx: CmdCtx }) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [menuIdx, setMenuIdx] = useState(0);

  const showingMenu = value.startsWith('/');
  const prefix = showingMenu ? value.slice(1).split(/\s+/)[0] ?? '' : '';
  const partsLen = value.trim().split(/\s+/).length;
  const menuActive = showingMenu && partsLen === 1;
  const matches = menuActive ? matchCommands(prefix) : [];
  const effectiveMenuIdx = Math.min(menuIdx, Math.max(0, matches.length - 1));

  const submit = (text: string) => {
    const v = text.trim();
    if (!v) return;
    setHistory((h) => (h[h.length - 1] === v ? h : [...h, v]));
    setHistIdx(null);
    setMenuIdx(0);
    setValue('');
    void dispatchCommand(v, ctx);
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      ctx.requestExit();
      return;
    }
    if (key.return) {
      submit(value);
      return;
    }
    if (key.escape) {
      setValue('');
      setMenuIdx(0);
      setHistIdx(null);
      return;
    }
    if (key.upArrow) {
      if (menuActive && matches.length > 0) {
        setMenuIdx((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (history.length > 0) {
        const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(next);
        setValue(history[next] ?? '');
      }
      return;
    }
    if (key.downArrow) {
      if (menuActive && matches.length > 0) {
        setMenuIdx((i) => (i + 1) % matches.length);
        return;
      }
      if (histIdx !== null) {
        const next = histIdx + 1;
        if (next >= history.length) {
          setHistIdx(null);
          setValue('');
        } else {
          setHistIdx(next);
          setValue(history[next] ?? '');
        }
      }
      return;
    }
    if (key.tab) {
      if (menuActive && matches[effectiveMenuIdx]) {
        const hint = matches[effectiveMenuIdx]!.argHint ? ' ' : ' ';
        setValue(`/${matches[effectiveMenuIdx]!.name}${hint}`);
        setMenuIdx(0);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      setMenuIdx(0);
      return;
    }
    if (input && !key.ctrl && !key.meta && input.length === 1) {
      setValue((v) => v + input);
      setMenuIdx(0);
    }
  });

  return (
    <Box flexDirection="column" marginTop={0}>
      <Box>
        <Text color={theme.accent} bold>❯ </Text>
        <Text color={theme.value}>{value}</Text>
        <Text color={theme.accent}>▌</Text>
      </Box>
      {menuActive && matches.length > 0 ? (
        <CommandMenu matches={matches} highlight={effectiveMenuIdx} />
      ) : null}
      {!showingMenu && value === '' ? (
        <Box>
          <Text color={theme.muted}>  type </Text>
          <Text color={theme.dim}>/help</Text>
          <Text color={theme.muted}> for commands · </Text>
          <Text color={theme.dim}>/start</Text>
          <Text color={theme.muted}> to begin</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function CommandMenu({ matches, highlight }: { matches: typeof COMMANDS; highlight: number }) {
  // Alignment rule: the input row above renders `❯ {value}…`, so the user's
  // typed `/` lands at column 2 relative to the Prompt container. Here we
  // emit a 2-char indicator (`› ` or `  `) so the menu's `/` also lands at
  // column 2 — the user's `/` and the menu's `/` vertically line up.
  const half = Math.floor(MAX_MENU / 2);
  const startIdx = Math.max(0, Math.min(matches.length - MAX_MENU, highlight - half));
  const visible = matches.slice(startIdx, startIdx + MAX_MENU);
  const totalCount = matches.length;

  return (
    <Box flexDirection="column" marginTop={0}>
      {visible.map((c, i) => {
        const isSel = startIdx + i === highlight;
        return (
          <Box key={c.name}>
            <Text color={isSel ? theme.accent : theme.muted} bold={isSel}>
              {isSel ? '› ' : '  '}
            </Text>
            <Text color={isSel ? theme.accent : theme.value} bold={isSel}>
              /{c.name}
            </Text>
            {c.argHint ? <Text color={theme.ice}>{` ${c.argHint}`}</Text> : null}
            <Text color={theme.muted}>  ·  </Text>
            <Text color={theme.valueDim}>{c.desc}</Text>
          </Box>
        );
      })}
      <Box>
        <Text color={theme.muted}>
          {'  '}
          {totalCount > MAX_MENU ? `…${totalCount - MAX_MENU} more · ` : ''}
          ↑↓ nav · Tab complete · Enter run · Esc clear
        </Text>
      </Box>
    </Box>
  );
}
