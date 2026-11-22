// main.ts is mend, the CLI SPEC.md specifies. It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing
// write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Section 3: a file's lines ---- */

interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/* ---- Section 5: matching lines at three tiers ---- */

function matchKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (matchKey(lines[i + j]!, tier) !== matchKey(O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  positions: number[];
}

function tiersFor(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

function findTier(O: string[], lines: string[], strict: boolean, from: number): TierHit | null {
  for (const t of tiersFor(strict)) {
    const pos = occurrences(O, lines, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** First tier with an occurrence at or after `from` that ends at the file's last line. */
function findTierEof(O: string[], lines: string[], strict: boolean, from: number): TierHit | null {
  for (const t of tiersFor(strict)) {
    const pos = occurrences(O, lines, t, from).filter((p) => p + O.length === lines.length);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** First line at or after `from` equal to the anchor at the first tier where one is. */
function findAnchor(anchor: string, lines: string[], strict: boolean, from: number): number {
  for (const t of tiersFor(strict)) {
    for (let i = from; i < lines.length; i++) {
      if (matchKey(lines[i]!, t) === matchKey(anchor, t)) return i;
    }
  }
  return -1;
}

const leadingWs = (s: string): string => {
  const m = s.match(/^[ \t]*/);
  return m === null ? '' : m[0];
};

/** One line of N: a context line is written as the file's own matched line, any other as it is (tier 2 re-indented). */
interface NLine {
  text: string;
  ctx: boolean;
  oIndex: number | null;
}

function buildNew(O: string[], N: NLine[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const F = leadingWs(fileLines[pos] ?? '');
  const P = leadingWs(O[0] ?? '');
  for (const nl of N) {
    if (nl.ctx) {
      out.push(fileLines[pos + nl.oIndex!]!);
    } else if (tier === 2) {
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) out.push(F + t.slice(P.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/* ---- Section 6: unified diffs ---- */

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  lastCtxPlusNoEol: boolean;
  /** a `\` line follows the hunk's last `+` line */
  lastPlusNoEol: boolean;
  plusCount: number;
}

/** The path after `--- `/`+++ `: up to the first tab, spaces removed, a leading `a/`/`b/` removed. */
function cleanPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = lines[i]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  const a = Number(m![1]);
  let j = i + 1;
  const body: string[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true, oIndex: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false, oIndex: null });
    } else if (l === '') {
      o.push('');
      n.push({ text: '', ctx: true, oIndex: o.length - 1 });
    }
    // a `\` line refers to the body line before it; it carries no text of its own.
  }
  // A `\` line refers to the body line before it: the flag is set when a `\` line
  // immediately follows the hunk's last context-or-`+` line (resp. last `+` line).
  let lastCtxPlusNoEol = false;
  let lastPlusNoEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const l = body[k]!;
    if (l.startsWith(' ') || l.startsWith('+') || l === '') {
      lastCtxPlusNoEol = body[k + 1] !== undefined && body[k + 1]!.startsWith('\\');
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k--) {
    const l = body[k]!;
    if (l.startsWith('+')) {
      lastPlusNoEol = body[k + 1] !== undefined && body[k + 1]!.startsWith('\\');
      break;
    }
  }
  const plusCount = n.filter((x) => !x.ctx).length;
  return { hunk: { a, o, n, lastCtxPlusNoEol, lastPlusNoEol, plusCount }, next: j };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(h.o, f.lines, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const pos of found.positions) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const atEof = best + h.o.length === f.lines.length;
      const rep = buildNew(h.o, h.n, f.lines, best, found.tier);
      const newLines = [...f.lines.slice(0, best), ...rep, ...f.lines.slice(best + h.o.length)];
      f = { br: f.br, lines: newLines, final: atEof ? !h.lastCtxPlusNoEol : f.final };
      d += h.n.length - h.o.length;
    } else {
      const insertPos = Math.max(0, Math.min(h.a + d, f.lines.length));
      const rep = h.n.map((nl) => nl.text);
      const newLines = [...f.lines.slice(0, insertPos), ...rep, ...f.lines.slice(insertPos)];
      f = { br: f.br, lines: newLines, final: insertPos === f.lines.length ? !h.lastCtxPlusNoEol : f.final };
      d += h.n.length;
    }
  }
  return joinFile(f);
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const newSection = (oldPath: string | null, newPath: string | null, hasPair: boolean): Section => {
    const s: Section = { oldPath, newPath, hasPair, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+?)\s*$/);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1]!, m[2]!, false);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = cleanPath(line.slice(4));
      const newP = cleanPath(lines[i + 1]!.slice(4));
      if (cur !== null && inHeader) {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.hasPair = true;
      } else {
        cur = newSection(oldP, newP, true);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunk(lines, i);
      cur.hunks.push(parsed.hunk);
      inHeader = false;
      i = parsed.next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.newPath = cleanPath(line.slice(4));
        cur.hasPair = true;
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    // Resolve the section's paths: a `---`/`+++` pair wins over rename lines, which win over `diff --git`.
    let oldPath = sec.oldPath;
    let newPath = sec.newPath;
    if (!sec.hasPair) {
      if (sec.renameFrom !== null) oldPath = sec.renameFrom === '/dev/null' ? null : sec.renameFrom;
      if (sec.renameTo !== null) newPath = sec.renameTo === '/dev/null' ? null : sec.renameTo;
    }
    let kind: 'create' | 'delete' | 'move' | 'change';
    if (newPath === null) kind = 'delete';
    else if (oldPath === null) kind = 'create';
    else if (sec.isDelete) kind = 'delete';
    else if (sec.isCreate) kind = 'create';
    else if (oldPath !== newPath) kind = 'move';
    else kind = 'change';
    return (tree: Tree): void => {
      if (kind === 'create') {
        const p = newPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const nl of h.n) if (!nl.ctx) plus.push(nl.text);
        let content = '';
        if (plus.length > 0) {
          let noEol = false;
          for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
            const h = sec.hunks[hi]!;
            if (h.plusCount > 0) {
              noEol = h.lastPlusNoEol;
              break;
            }
          }
          content = plus.join('\n') + (noEol ? '' : '\n');
        }
        tree.now.set(p, content);
        return;
      }
      if (kind === 'delete') {
        const p = oldPath ?? newPath ?? '';
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (kind === 'move') {
        const oldP = oldPath!;
        const newP = newPath!;
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const curText = tree.get(oldP);
        if (curText === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const result = applyHunks(curText, sec.hunks, strict, oldP);
        tree.now.set(newP, result);
        tree.now.set(oldP, null);
        moves.push([oldP, newP]);
        return;
      }
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      const curText = tree.get(p);
      if (curText === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(curText, sec.hunks, strict, p));
    };
  });
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let e = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        e = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (e < 0) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let j = e + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        r = j;
        break;
      }
    }
    if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, e);
    const newLines = lines.slice(e + 1, r);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = splitFile(cur);
      const found = findTier(oldLines, f.lines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const n: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIndex: null }));
      const rep = buildNew(oldLines, n, f.lines, pos, found.tier);
      const out = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + oldLines.length)];
      tree.now.set(p, joinFile({ br: f.br, lines: out, final: f.final }));
    });
    prevPath = p;
    prevEnd = r + 1;
    i = r + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- Section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i += 1;
    const raw: Array<{ t: string; n: number }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (isSectionStart(l)) break;
      raw.push({ t: l, n: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const { t, n } of raw) {
        if (t.startsWith('+')) fileLines.push(t.slice(1));
        else if (t === '') fileLines.push('');
        else throw new Exit2(`error: parse ${n}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (kind === 'delete') {
      for (const { t, n } of raw) {
        if (!blank(t)) throw new Exit2(`error: parse ${n}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    // Update File
    let idx = 0;
    let moveTo: string | null = null;
    if (raw.length > 0 && raw[0]!.t.startsWith('*** Move to: ')) {
      moveTo = raw[0]!.t.slice('*** Move to: '.length).trim();
      idx = 1;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    let started = false;
    for (; idx < raw.length; idx++) {
      const { t, n } = raw[idx]!;
      if (t.startsWith('@@')) {
        if (cur !== null) chunks.push(cur);
        cur = { anchor: t.slice(2).trim(), o: [], n: [], eof: false };
        started = true;
        continue;
      }
      if (t.trim() === '*** End of File') {
        if (cur !== null) {
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        }
        continue;
      }
      if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
        if (cur === null) {
          if (started) throw new Exit2(`error: parse ${n}`);
          cur = { anchor: null, o: [], n: [], eof: false };
          started = true;
        }
        if (t.startsWith(' ')) {
          const txt = t.slice(1);
          cur.o.push(txt);
          cur.n.push({ text: txt, ctx: true, oIndex: cur.o.length - 1 });
        } else if (t.startsWith('-')) {
          cur.o.push(t.slice(1));
        } else if (t.startsWith('+')) {
          cur.n.push({ text: t.slice(1), ctx: false, oIndex: null });
        } else {
          cur.o.push('');
          cur.n.push({ text: '', ctx: true, oIndex: cur.o.length - 1 });
        }
        continue;
      }
      throw new Exit2(`error: parse ${n}`);
    }
    if (cur !== null) chunks.push(cur);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
    const p = path;
    const mt = moveTo;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
      const curText = tree.get(p);
      if (curText === null) throw new Fail('missing', p);
      if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
      let f = splitFile(curText);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null && ch.anchor !== '') {
          const pos = findAnchor(ch.anchor, f.lines, strict, cursor);
          if (pos < 0) throw new Fail('no-match', p);
          cursor = pos + 1;
        }
        if (ch.o.length > 0) {
          const found = ch.eof ? findTierEof(ch.o, f.lines, strict, cursor) : findTier(ch.o, f.lines, strict, cursor);
          if (found === null) throw new Fail('no-match', p);
          const pos = found.positions[0]!;
          const rep = buildNew(ch.o, ch.n, f.lines, pos, found.tier);
          f = { br: f.br, lines: [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + ch.o.length)], final: f.final };
          cursor = pos + rep.length;
        } else {
          const insertPos = ch.eof ? f.lines.length : cursor;
          const rep = ch.n.map((nl) => nl.text);
          f = { br: f.br, lines: [...f.lines.slice(0, insertPos), ...rep, ...f.lines.slice(insertPos)], final: f.final };
          cursor = insertPos + rep.length;
        }
      }
      const result = joinFile(f);
      if (mt !== null) {
        tree.now.set(mt, result);
        tree.now.set(p, null);
        moves.push([p, mt]);
      } else {
        tree.now.set(p, result);
      }
    });
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move whose old path existed before the patch and is gone after it, and whose new path did not
  // exist before it and is there after it, is one `R <old> -> <new>` line, sorting by <new>.
  const rMoves = new Map<string, string>();
  for (const [o, n] of moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) rMoves.set(o, n);
  }
  const changed: Array<{ p: string; was: string | null; now: string | null }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ p, was, now });
  }
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  for (const [o, n] of rMoves) rows.push({ key: n, text: `R ${o} -> ${n}` });
  for (const c of changed) {
    if (rMoves.has(c.p) || [...rMoves.values()].includes(c.p)) continue;
    rows.push({ key: c.p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.p, { force: true });
      else {
        mkdirSync(dirname(c.p), { recursive: true });
        writeFileSync(c.p, c.now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
