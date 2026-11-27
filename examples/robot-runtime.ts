// 宿主环境原语的模块化载体：verify-trace 的 RUNTIME 参数指向本文件。
// GIL 不发明物理语义——next/passable/atStation 等全部由宿主提供，本文件就是宿主。
// 审计方重放时必须持有同一份原语模块；建议对该文件做内容寻址并随 trace 一并分发。
import type { Primitives } from '../src/rl-ast.ts';

const SIZE = 4;
const START = '0:0';
const STATION = '3:3';
const HAZARDS = new Set(['1:1']);
const DIRECTIONS: Record<string, { row: number; column: number }> = {
  down: { row: 1, column: 0 }, right: { row: 0, column: 1 },
  up: { row: -1, column: 0 }, left: { row: 0, column: -1 },
};

function parseCell(cell: unknown): { row: number; column: number } | null {
  if (typeof cell !== 'string') return null;
  const parts = cell.split(':').map(Number);
  if (parts.length !== 2 || !parts.every(Number.isSafeInteger)) return null;
  return { row: parts[0], column: parts[1] };
}
const inside = (cell: { row: number; column: number }) =>
  cell.row >= 0 && cell.column >= 0 && cell.row < SIZE && cell.column < SIZE;

/** 越界返回 null：这样 passable 自然为 false，而不是悄悄原地打转。 */
const nextCell = (cell: unknown, direction: unknown): string | null => {
  const start = parseCell(cell);
  const delta = typeof direction === 'string' ? DIRECTIONS[direction] : undefined;
  if (!start || !delta) return null;
  const moved = { row: start.row + delta.row, column: start.column + delta.column };
  return inside(moved) ? `${moved.row}:${moved.column}` : null;
};

const primitives: Primitives = {
  constants: { Start: START },
  relations: {
    next: nextCell,
    passable: (cell: unknown) => typeof cell === 'string' && !HAZARDS.has(cell),
    atStation: (cell: unknown) => cell === STATION,
  },
  membership: { HazardCells: (value: unknown) => typeof value === 'string' && HAZARDS.has(value) },
};
export default primitives;
