import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../state/store';
import { theme } from './theme';

/**
 * Nested-menu renderer. Reads the top of `menuStack` from the store.
 * - ↑/↓      move highlight
 * - 1–9      quick-select the Nth item
 * - Enter    invoke the highlighted item's onSelect
 * - Esc / ←  pop the current menu (cancel)
 * - Ctrl+C   close all menus
 *
 * The SelectMenu owns `useInput` while a menu is open. App.tsx renders
 * either Prompt or SelectMenu (never both) so the input hooks don't
 * fight over keystrokes.
 */
export function SelectMenu() {
  const stack = useStore((s) => s.menuStack);
  const popMenu = useStore((s) => s.popMenu);
  const clearMenus = useStore((s) => s.clearMenus);
  const top = stack[stack.length - 1];
  const [idx, setIdx] = useState(0);

  // Reset highlight when we swap menus (push/pop/replace).
  useEffect(() => {
    setIdx(0);
  }, [top]);

  useInput((input, key) => {
    if (!top) return;
    if (key.ctrl && input === 'c') {
      clearMenus();
      return;
    }
    if (key.escape || key.leftArrow) {
      popMenu();
      return;
    }
    if (key.upArrow) {
      setIdx((i) => (i - 1 + top.items.length) % top.items.length);
      return;
    }
    if (key.downArrow) {
      setIdx((i) => (i + 1) % top.items.length);
      return;
    }
    if (key.return) {
      const item = top.items[idx];
      if (item && !item.disabled) void Promise.resolve(item.onSelect());
      return;
    }
    // Number shortcut — only digits 1..9, capped at list length.
    if (input && /^[1-9]$/.test(input)) {
      const n = Number(input);
      if (n <= top.items.length) {
        const item = top.items[n - 1];
        if (item && !item.disabled) void Promise.resolve(item.onSelect());
      }
    }
  });

  if (!top) return null;

  return (
    <Box flexDirection="column" marginTop={0}>
      <Box>
        <Text color={theme.accent} bold>
          ▸ {top.title}
        </Text>
        {stack.length > 1 ? (
          <Text color={theme.dim}> · depth {stack.length}</Text>
        ) : null}
      </Box>
      {top.items.map((item, i) => {
        const sel = i === idx;
        const numLabel = `${i + 1}.`;
        const mark = item.checked ? '●' : ' ';
        return (
          <Box key={i}>
            <Text color={sel ? theme.accent : theme.muted} bold={sel}>
              {sel ? '› ' : '  '}
            </Text>
            <Text color={sel ? theme.accent : theme.dim} bold={sel}>
              {numLabel}{' '}
            </Text>
            <Text color={item.checked ? theme.ok : theme.muted} bold={item.checked}>
              {mark}{' '}
            </Text>
            <Text
              color={
                item.disabled
                  ? theme.dim
                  : sel
                    ? theme.accent
                    : theme.value
              }
              bold={sel}
            >
              {item.label}
            </Text>
            {item.hint ? (
              <Text color={theme.dim}>
                {'  · '}
                {item.hint}
              </Text>
            ) : null}
          </Box>
        );
      })}
      <Box>
        <Text color={theme.muted}>
          {'  '}↑↓ nav · 1–{Math.min(9, top.items.length)} quick · Enter select · Esc back
        </Text>
      </Box>
    </Box>
  );
}
