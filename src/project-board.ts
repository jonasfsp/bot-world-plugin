/**
 * Company brand and project board carried inside a .botworld document.
 *
 * Both are written by something outside the plugin (a bot or a script reading the
 * team's tracker, e.g. `fabrica.py clickup board --botworld <file>`); the plugin only
 * validates and draws them. No network access, no credentials: the numbers arrive as data.
 */

export type ProjectBoardEntry = {
  name: string;
  backlog: number;
  todo: number;
  inProgress: number;
  toTest: number;
};

export type ProjectBoard = {
  /** ISO 8601 timestamp of the snapshot, as written by the producer. */
  updatedAt: string;
  /** Where the numbers come from, e.g. "ClickUp · Engenharia". */
  source: string;
  projects: ProjectBoardEntry[];
};

export type BrandInfo = {
  name: string;
  /** Raster logo as a data URL (PNG/JPEG/WebP). */
  logo: string | null;
};

export const MAX_BOARD_PROJECTS = 24;
export const MAX_BRAND_LOGO_DATA_URL_BYTES = 120 * 1024;
const MAX_TEXT = 80;
const MAX_COUNT = 100_000;
const CONTROL_RE = /[\x00-\x1f\x7f]+/g;
const LOGO_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function cleanText(raw: unknown, max = MAX_TEXT): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return null;
  return clean.length > max ? clean.slice(0, max) : clean;
}

function cleanCount(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.min(MAX_COUNT, Math.trunc(raw))
    : 0;
}

export function sanitizeProjectBoard(raw: unknown): ProjectBoard | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const updatedAt =
    typeof rec.updatedAt === 'string' && ISO_RE.test(rec.updatedAt) ? rec.updatedAt : null;
  if (!updatedAt) return undefined;
  const projects: ProjectBoardEntry[] = [];
  if (Array.isArray(rec.projects)) {
    for (const item of rec.projects) {
      if (projects.length >= MAX_BOARD_PROJECTS) break;
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const p = item as Record<string, unknown>;
      const name = cleanText(p.name);
      if (!name) continue;
      projects.push({
        name,
        backlog: cleanCount(p.backlog),
        todo: cleanCount(p.todo),
        inProgress: cleanCount(p.inProgress),
        toTest: cleanCount(p.toTest),
      });
    }
  }
  return { updatedAt, source: cleanText(rec.source) ?? '', projects };
}

export function sanitizeBrand(raw: unknown): BrandInfo | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const name = cleanText(rec.name, 40);
  if (!name) return undefined;
  const logo =
    typeof rec.logo === 'string' &&
    rec.logo.length <= MAX_BRAND_LOGO_DATA_URL_BYTES &&
    LOGO_RE.test(rec.logo)
      ? rec.logo
      : null;
  return { name, logo };
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Project names as the board shows them: real names, or `Project #N` in Redact Mode. */
export function boardProjectLabels(board: ProjectBoard, redactMode: boolean): string[] {
  return board.projects.map((p, i) => (redactMode ? `Project #${i + 1}` : p.name));
}

export function boardTotals(board: ProjectBoard): { backlog: number; projects: number } {
  return {
    backlog: board.projects.reduce((sum, p) => sum + p.backlog, 0),
    projects: board.projects.length,
  };
}
