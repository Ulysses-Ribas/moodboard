import type { Board } from './types';

const MAX = 50;

let stack: string[] = [];
let pointer = -1;

export function pushSnapshot(board: Board): void {
  stack = stack.slice(0, pointer + 1);
  stack.push(JSON.stringify(board));
  if (stack.length > MAX) {
    stack.shift();
  }
  pointer = stack.length - 1;
}

export function undo(): Board | null {
  if (pointer <= 0) return null;
  pointer--;
  return JSON.parse(stack[pointer]);
}

export function redo(): Board | null {
  if (pointer >= stack.length - 1) return null;
  pointer++;
  return JSON.parse(stack[pointer]);
}

export function canUndo(): boolean {
  return pointer > 0;
}

export function canRedo(): boolean {
  return pointer < stack.length - 1;
}

export function clearHistory(): void {
  stack = [];
  pointer = -1;
}
