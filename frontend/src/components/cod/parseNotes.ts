/**
 * parseNotes — turns the raw impact text ("word salad") into typed blocks
 * the reader can typeset, and re-chunks those blocks into step-through
 * cards for Learn mode.
 *
 * Parsing rules (Notes mode):
 *   • CRLF-normalized, split per line — authors write in a plain TextInput,
 *     so every newline is an intentional boundary.
 *   • Lines starting with -, –, •, * (or "1." / "1)") group into bullet /
 *     numbered list blocks; consecutive list lines merge into one block.
 *   • SHORT lines (≤ 64 chars) that end with ':' or are ALL CAPS become
 *     section headings (the trailing ':' is stripped).
 *   • Everything else is a paragraph — and paragraphs longer than ~340
 *     chars are re-broken at sentence boundaries into ~240-char pieces,
 *     which is the actual anti-word-salad measure.
 *
 * Learn chunking:
 *   • A heading starts a new card; a card holds at most 4 blocks or ~620
 *     chars, then continues onto a follow-up card that repeats its heading.
 *   • Content with no headings still chunks by the same size caps.
 */

export type NoteBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'numbered'; items: string[] };

const BULLET_RE = /^\s*[-–—•*·]\s+(.*)$/;
const NUMBERED_RE = /^\s*(\d{1,2})[.)]\s+(.*)$/;

const isAllCaps = (s: string): boolean => {
  const letters = s.replace(/[^a-zA-Z]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
};

const isHeadingLine = (s: string): boolean => {
  if (!s || s.length > 64) return false;
  if (BULLET_RE.test(s) || NUMBERED_RE.test(s)) return false;
  if (/[:：]$/.test(s)) return true;
  return isAllCaps(s);
};

const splitSentences = (p: string): string[] => {
  const m = p.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g);
  return (m || [p]).map((s) => s.trim()).filter(Boolean);
};

/** Break a wall-of-text paragraph into readable ~240-char pieces. */
const explodeLongParagraph = (p: string): string[] => {
  if (p.length <= 340) return [p];
  const out: string[] = [];
  let cur = '';
  for (const s of splitSentences(p)) {
    if (cur && cur.length + s.length + 1 > 240) { out.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out.length ? out : [p];
};

export function parseNotes(raw: string): NoteBlock[] {
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const blocks: NoteBlock[] = [];
  let list: { kind: 'bullets' | 'numbered'; items: string[] } | null = null;
  const flushList = () => {
    if (list && list.items.length) blocks.push(list);
    list = null;
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) { flushList(); continue; }
    const b = line.match(BULLET_RE);
    if (b) {
      if (!list || list.kind !== 'bullets') { flushList(); list = { kind: 'bullets', items: [] }; }
      list.items.push(b[1].trim());
      continue;
    }
    const n = line.match(NUMBERED_RE);
    if (n) {
      if (!list || list.kind !== 'numbered') { flushList(); list = { kind: 'numbered', items: [] }; }
      list.items.push(n[2].trim());
      continue;
    }
    flushList();
    if (isHeadingLine(line)) {
      blocks.push({ kind: 'heading', text: line.replace(/[:：]\s*$/, '') });
      continue;
    }
    for (const p of explodeLongParagraph(line)) blocks.push({ kind: 'paragraph', text: p });
  }
  flushList();
  return blocks;
}

// ── Learn-mode chunking ─────────────────────────────────────────────────────

export type LearnChunk = { heading: string | null; blocks: NoteBlock[] };

const blockChars = (b: NoteBlock): number =>
  b.kind === 'bullets' || b.kind === 'numbered' ? b.items.join(' ').length : b.text.length;

export function chunkForLearn(blocks: NoteBlock[]): LearnChunk[] {
  const chunks: LearnChunk[] = [];
  let cur: LearnChunk | null = null;
  const push = () => {
    if (cur && cur.blocks.length) chunks.push(cur);
    cur = null;
  };
  for (const b of blocks) {
    if (b.kind === 'heading') {
      push();
      cur = { heading: b.text, blocks: [] };
      continue;
    }
    if (!cur) cur = { heading: null, blocks: [] };
    const size = cur.blocks.reduce((n, x) => n + blockChars(x), 0);
    if (cur.blocks.length >= 4 || (cur.blocks.length >= 1 && size + blockChars(b) > 620)) {
      const heading: string | null = cur.heading;
      push();
      cur = { heading, blocks: [] }; // continuation card keeps its section title
    }
    cur.blocks.push(b);
  }
  push();
  return chunks;
}

// ── Small text helpers (hub previews, read-time chips) ──────────────────────

/** First sentence of the first non-empty part, ellipsized to ≤140 chars. */
export function firstSentence(...parts: Array<string | null | undefined>): string {
  for (const part of parts) {
    const t = String(part || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const m = t.match(/^.*?[.!?](?=["')\]]*(\s|$))/);
    const s = (m ? m[0] : t).trim();
    return s.length > 140 ? `${s.slice(0, 137).trimEnd()}…` : s;
  }
  return '';
}

export function readMinutes(x: { summary?: string; body?: string; key_takeaways?: string[] }): number {
  const words = [x.summary || '', x.body || '', ...(x.key_takeaways || [])]
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 180));
}
