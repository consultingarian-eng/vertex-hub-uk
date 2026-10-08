/**
 * MarkdownBody — renders a playbook topic's body (the small markdown subset
 * the seeded campaign-knowledge topics use) as native text, so headings,
 * bullets, numbered cards, quote boxes and tables read as a page instead of
 * raw `##`, `**` and `|` symbols.
 *
 * Supported: #–#### headings, paragraphs (two trailing spaces = line break),
 * `-`/`*` bullets and `- [ ]` checklist items, `1.` numbered items with
 * indented continuation lines, `>` quote boxes, pipe tables, `![alt](src)`
 * images, `---` rules, and inline **bold**, *italic*, `chips` and
 * [links](https://…). `<!-- … -->` comments are dropped. `⟦…⟧` marks a
 * fill-in field from the source playbook and renders as a blank / label.
 * Anything else falls through as plain text — never a crash.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Image, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { fonts } from '../theme/ThemeContext';

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul'; items: { text: string; check: boolean }[] }
  | { t: 'ol'; items: { n: string; text: string }[] }
  | { t: 'quote'; text: string }
  | { t: 'table'; header: string[]; rows: string[][] }
  | { t: 'img'; alt: string; src: string }
  | { t: 'hr' };

const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_UL = /^\s{0,1}[-*]\s+(\[[ xX]\]\s+)?(.*)$/;
const RE_OL = /^(\d+)\.\s+(.*)$/;
const RE_QUOTE = /^>\s?(.*)$/;
const RE_IMG = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
const RE_HR = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const RE_TABLE_SEP = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Join source lines the markdown way: a line ending in two spaces is a hard
 *  break, otherwise lines flow into one paragraph. */
function joinLines(lines: string[]): string {
  let out = '';
  lines.forEach((ln, i) => {
    if (i === 0) { out = ln.trimEnd(); return; }
    const prevHard = /\s{2,}$/.test(lines[i - 1]);
    out += (prevHard ? '\n' : ' ') + ln.trim();
  });
  return out;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

export function parseMarkdown(src: string): Block[] {
  const text = (src || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const nextNonBlank = (from: number) => {
    let j = from;
    while (j < lines.length && !lines[j].trim()) j++;
    return j < lines.length ? lines[j] : null;
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { i++; continue; }

    let m: RegExpMatchArray | null;
    if ((m = line.match(RE_HEADING))) {
      blocks.push({ t: 'h', level: m[1].length, text: m[2].trim() });
      i++; continue;
    }
    if (RE_HR.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }
    if ((m = line.match(RE_IMG))) {
      blocks.push({ t: 'img', alt: m[1], src: m[2] });
      i++; continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const r = lines[i].trim();
        if (!RE_TABLE_SEP.test(r)) rows.push(splitRow(r));
        i++;
      }
      if (rows.length) blocks.push({ t: 'table', header: rows[0], rows: rows.slice(1) });
      continue;
    }
    if (RE_QUOTE.test(line)) {
      const q: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i].trim())) {
        // trimStart only: two trailing spaces are a hard line break.
        q.push((lines[i].trimStart().match(RE_QUOTE) as RegExpMatchArray)[1]);
        i++;
      }
      blocks.push({ t: 'quote', text: joinLines(q) });
      continue;
    }
    if (RE_OL.test(line)) {
      const items: { n: string; parts: string[] }[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const om = l.trimStart().match(RE_OL);
        if (om && !/^\s{2,}/.test(l)) {
          items.push({ n: om[1], parts: [om[2]] });
          i++;
        } else if (items.length && l.trim() && /^\s{2,}\S/.test(l)) {
          items[items.length - 1].parts.push(l); // indented continuation
          i++;
        } else if (!l.trim()) {
          const nx = nextNonBlank(i);
          if (nx && (RE_OL.test(nx.trim()) && !/^\s{2,}/.test(nx) || /^\s{2,}\S/.test(nx))) { i++; continue; }
          break;
        } else break;
      }
      blocks.push({ t: 'ol', items: items.map((it) => ({ n: it.n, text: joinLines(it.parts) })) });
      continue;
    }
    if (RE_UL.test(raw) || RE_UL.test(line)) {
      const items: { text: string; check: boolean }[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const um = l.trim().match(RE_UL);
        if (um) {
          items.push({ text: um[2], check: !!um[1] });
          i++;
        } else if (items.length && /^\s{2,}\S/.test(l)) {
          items[items.length - 1].text += ' ' + l.trim();
          i++;
        } else break;
      }
      blocks.push({ t: 'ul', items });
      continue;
    }
    // Paragraph: consume until a blank line or the start of another block.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      const t = l.trim();
      if (!t) break;
      if (para.length && (RE_HEADING.test(t) || RE_QUOTE.test(t) || t.startsWith('|')
        || RE_IMG.test(t) || RE_OL.test(t) || RE_UL.test(t))) break;
      para.push(l);
      i++;
    }
    blocks.push({ t: 'p', text: joinLines(para) });
  }
  return blocks;
}

// ── Inline ─────────────────────────────────────────────────────────────────
const RE_INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|⟦[^⟧]*⟧|\*[^*\s][^*]*\*)/g;
const BLANK_FIELDS = new Set(['number', 'text', 'textarea', 'date', 'calculated', 'sum', 'n', '0.00']);

/** ⟦…⟧ fill-in fields from the source playbook → a readable blank. */
function fieldText(inner: string): string {
  const s = inner.trim();
  if (s === 'checkbox') return '☐';
  if (s.startsWith('checkboxes:')) {
    return s.slice('checkboxes:'.length).split('·').map((o) => `☐ ${o.trim()}`).join('   ');
  }
  const quoted = s.match(/"([^"]+)"/);
  if (quoted) return `[${quoted[1]}]`;
  if (BLANK_FIELDS.has(s)) return '____';
  return `[${s}]`;
}

function Inline({ text, styles, bold }: { text: string; styles: any; bold?: boolean }) {
  const parts = text.split(RE_INLINE).filter((p) => p !== '');
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
          return <Text key={i} style={styles.bold}><Inline text={p.slice(2, -2)} styles={styles} /></Text>;
        }
        if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
          return <Text key={i} style={styles.chip}>{` ${p.slice(1, -1)} `}</Text>;
        }
        if (p.startsWith('⟦') && p.endsWith('⟧')) {
          return <Text key={i} style={styles.field}>{fieldText(p.slice(1, -1))}</Text>;
        }
        const link = p.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        if (link) {
          const url = link[2];
          const safe = /^https?:\/\//i.test(url);
          return (
            <Text
              key={i}
              style={safe ? styles.link : undefined}
              onPress={safe ? () => { Linking.openURL(url).catch(() => {}); } : undefined}
            >
              {link[1]}
            </Text>
          );
        }
        if (p.startsWith('*') && p.endsWith('*') && p.length > 2) {
          return <Text key={i} style={styles.italic}>{p.slice(1, -1)}</Text>;
        }
        return <Text key={i} style={bold ? styles.bold : undefined}>{p}</Text>;
      })}
    </>
  );
}

// ── Blocks ─────────────────────────────────────────────────────────────────
export function MarkdownBody({ text, colors, title }: { text: string; colors: any; title?: string }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const blocks = useMemo(() => {
    const b = parseMarkdown(text);
    // The card header already shows the title — skip a leading heading that repeats it.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (title && b[0]?.t === 'h' && norm(b[0].text) === norm(title)) b.shift();
    return b;
  }, [text, title]);

  return (
    <View style={styles.wrap}>
      {blocks.map((b, bi) => {
        switch (b.t) {
          case 'h':
            return (
              <Text key={bi} style={[b.level <= 2 ? styles.h2 : b.level === 3 ? styles.h3 : styles.h4]}>
                <Inline text={b.text} styles={styles} />
              </Text>
            );
          case 'p':
            return <Text key={bi} style={styles.p}><Inline text={b.text} styles={styles} /></Text>;
          case 'hr':
            return <View key={bi} style={styles.hr} />;
          case 'quote':
            return (
              <View key={bi} style={styles.quote}>
                <Text style={styles.quoteText}><Inline text={b.text} styles={styles} /></Text>
              </View>
            );
          case 'ul':
            return (
              <View key={bi} style={styles.list}>
                {b.items.map((it, ii) => (
                  <View key={ii} style={styles.row}>
                    {it.check
                      ? <Ionicons name="square-outline" size={14} color={colors.primary} style={styles.checkIcon} />
                      : <View style={[styles.dot, { backgroundColor: colors.primary }]} />}
                    <Text style={styles.itemText}><Inline text={it.text} styles={styles} /></Text>
                  </View>
                ))}
              </View>
            );
          case 'ol':
            return (
              <View key={bi} style={styles.list}>
                {b.items.map((it, ii) => (
                  <View key={ii} style={styles.row}>
                    <Text style={styles.num}>{it.n}.</Text>
                    <Text style={styles.itemText}><Inline text={it.text} styles={styles} /></Text>
                  </View>
                ))}
              </View>
            );
          case 'table':
            return (
              <View key={bi} style={styles.table}>
                <View style={[styles.tr, styles.thRow]}>
                  {b.header.map((c, ci) => (
                    <Text key={ci} style={[styles.td, styles.th]}><Inline text={c} styles={styles} /></Text>
                  ))}
                </View>
                {b.rows.map((r, ri) => (
                  <View key={ri} style={[styles.tr, ri < b.rows.length - 1 && styles.trBorder]}>
                    {b.header.map((_, ci) => (
                      <Text key={ci} style={styles.td}><Inline text={r[ci] ?? ''} styles={styles} /></Text>
                    ))}
                  </View>
                ))}
              </View>
            );
          case 'img':
            return /^https?:\/\//i.test(b.src) ? (
              <View key={bi} style={styles.imgWrap}>
                <Image source={{ uri: b.src }} style={styles.img} resizeMode="contain" accessibilityLabel={b.alt} />
                {!!b.alt && <Text style={styles.imgCaption}>{b.alt}</Text>}
              </View>
            ) : (
              // Relative asset from the source playbook that isn't bundled here —
              // show what the picture is so nobody wonders what's missing.
              <View key={bi} style={styles.imgMissing}>
                <Ionicons name="image-outline" size={18} color={colors.textMuted} />
                <Text style={styles.caption}>{b.alt || 'Image'}</Text>
              </View>
            );
          default:
            return null;
        }
      })}
    </View>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  wrap: { gap: 8 },
  h2: { fontFamily: fonts.display, fontSize: 16, color: colors.text, marginTop: 8, lineHeight: 22 },
  h3: { fontFamily: fonts.display, fontSize: 14.5, color: colors.text, marginTop: 6, lineHeight: 20 },
  h4: {
    fontFamily: fonts.mono, fontSize: 11, fontWeight: '700', color: colors.primary,
    letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 4,
  },
  p: { fontSize: 13.5, color: colors.textSecondary, lineHeight: 20 },
  bold: { fontWeight: '800', color: colors.text },
  italic: { fontStyle: 'italic' },
  chip: {
    fontFamily: fonts.mono, fontSize: 11.5, color: colors.text,
    backgroundColor: colors.surfaceAlt, borderRadius: 6,
  },
  field: { color: colors.textMuted, fontStyle: 'italic' },
  link: { color: colors.primary, fontWeight: '700', textDecorationLine: 'underline' },
  hr: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  quote: {
    borderLeftWidth: 3, borderLeftColor: colors.primary, backgroundColor: colors.surfaceAlt,
    borderRadius: 8, paddingVertical: 9, paddingHorizontal: 12,
  },
  quoteText: { fontSize: 13.5, color: colors.text, lineHeight: 20, fontStyle: 'italic' },
  list: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  dot: { width: 5, height: 5, borderRadius: 3, marginTop: 8 },
  checkIcon: { marginTop: 3 },
  num: { fontFamily: fonts.mono, fontSize: 12, fontWeight: '700', color: colors.primary, marginTop: 2, minWidth: 18 },
  itemText: { flex: 1, fontSize: 13.5, color: colors.text, lineHeight: 20 },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: 'hidden' },
  tr: { flexDirection: 'row' },
  trBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  thRow: { backgroundColor: colors.surfaceAlt },
  td: { flex: 1, paddingVertical: 7, paddingHorizontal: 8, fontSize: 12, color: colors.text, lineHeight: 17 },
  th: { fontWeight: '800' },
  imgWrap: { gap: 4 },
  img: { width: '100%', aspectRatio: 4 / 3, borderRadius: 10 },
  imgMissing: {
    flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10,
    borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border,
  },
  caption: { flex: 1, fontSize: 12, color: colors.textMuted, fontStyle: 'italic', lineHeight: 17 },
  imgCaption: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', lineHeight: 17 },
});

export default MarkdownBody;
