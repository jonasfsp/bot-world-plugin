import { assert, describe, test } from 'orca/testing';
import {
  decodeBotWorldContent,
  encodeBotWorldContent,
  mergeBotWorldDocuments,
} from '../editor/doc-sync.ts';
import {
  boardProjectLabels,
  boardTotals,
  sanitizeBrand,
  sanitizeProjectBoard,
} from './project-board.ts';

const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const BOARD = {
  updatedAt: '2026-11-27T18:23:23Z',
  source: 'ClickUp · Engenharia',
  projects: [
    { name: '[VoxOS]', backlog: 20, todo: 2, inProgress: 2, toTest: 15, url: 'https://x' },
    { name: '[Prumo]', backlog: 9 },
  ],
};

describe('Project board & brand in .botworld', () => {
  test('sanitizers keep valid data and drop the rest', () => {
    const board = sanitizeProjectBoard(BOARD);
    assert.ok(board);
    assert.equal(board?.projects.length, 2);
    assert.deepEqual(board?.projects[1], { name: '[Prumo]', backlog: 9, todo: 0, inProgress: 0, toTest: 0 });
    assert.equal(sanitizeProjectBoard({ ...BOARD, updatedAt: 'yesterday' }), undefined);
    assert.equal(
      sanitizeProjectBoard({ ...BOARD, projects: [{ name: '\u0000', backlog: -3 }, { name: 'A', backlog: 1e9 }] })
        ?.projects[0].backlog,
      100_000
    );
    assert.deepEqual(sanitizeBrand({ name: 'Stacx', logo: LOGO }), { name: 'Stacx', logo: LOGO });
    assert.equal(sanitizeBrand({ name: 'Stacx', logo: 'data:image/svg+xml;base64,AAAA' })?.logo, null);
    assert.equal(sanitizeBrand({ name: 'Stacx', logo: 'https://evil/x.png' })?.logo, null);
    assert.equal(sanitizeBrand({ logo: LOGO }), undefined);
  });

  test('labels respect Redact Mode; totals add backlog', () => {
    const board = sanitizeProjectBoard(BOARD)!;
    assert.deepEqual(boardProjectLabels(board, false), ['[VoxOS]', '[Prumo]']);
    assert.deepEqual(boardProjectLabels(board, true), ['Project #1', 'Project #2']);
    assert.deepEqual(boardTotals(board), { backlog: 29, projects: 2 });
  });

  test('document decode/encode keeps brand and board; editor saves never drop them', () => {
    const text = JSON.stringify({ version: 1, themeId: 'cyber_ops', brand: { name: 'Stacx', logo: LOGO }, projectBoard: BOARD });
    const doc = decodeBotWorldContent({ kind: 'text', text });
    assert.equal(doc.brand?.name, 'Stacx');
    assert.equal(doc.projectBoard?.projects.length, 2);
    const again = decodeBotWorldContent(encodeBotWorldContent(doc));
    assert.deepEqual(again.brand, doc.brand);
    assert.deepEqual(again.projectBoard, doc.projectBoard);
  });

  test('merge: a new board written outside wins over the open editor', () => {
    const base = decodeBotWorldContent({ kind: 'text', text: JSON.stringify({ version: 1, projectBoard: BOARD }) });
    const newer = { ...BOARD, updatedAt: '2026-11-27T19:00:00Z', projects: [{ name: '[Zapest]', backlog: 7 }] };
    const outside = decodeBotWorldContent({ kind: 'text', text: JSON.stringify({ version: 1, projectBoard: newer }) });
    const mine = { ...base, themeId: 'cozy_cafe' as const };
    const merged = mergeBotWorldDocuments(base, outside, mine);
    assert.equal(merged.themeId, 'cozy_cafe');
    assert.equal(merged.projectBoard?.updatedAt, '2026-11-27T19:00:00Z');
    assert.equal(merged.projectBoard?.projects[0].name, '[Zapest]');
  });
});
