import mammoth from 'mammoth';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import type { ProjectSource } from '../shared/types.js';

const pdfHelperPath = fileURLToPath(new URL('./pdf-parser.cjs', import.meta.url));

export interface ParseInput {
  name: string;
  relativePath?: string;
  mediaType: string;
  bytes: Buffer;
}

export interface ParsedSource extends ParseInput {
  sourceId: string;
  status: ProjectSource['parser_status'];
  text: string;
  parsedTextCharacters: number;
  parseCoverage: ProjectSource['parse_coverage'];
  coverageNote?: string;
  excerpt?: string;
  error?: string;
}

export const MAX_EXTRACTED_CHARS = 2_000_000;
const PDF_MAX_PAGES = 500;
const PDF_MAX_RUNTIME_MS = 30_000;

function parsePdf(bytes: Buffer): Promise<{ text: string; pages: number; clipped: boolean }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const environment: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
        if (process.env[key] !== undefined) environment[key] = process.env[key];
      }
      child = spawn(process.execPath, [pdfHelperPath, String(PDF_MAX_PAGES), String(MAX_EXTRACTED_CHARS)], {
        cwd: process.cwd(), env: environment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(new Error('The PDF parser process could not be started.'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('PDF parsing exceeded its 30-second limit.'));
    }, PDF_MAX_RUNTIME_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 8_000_000 && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(new Error('PDF parser output exceeded its size limit.'));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2_000); });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('The PDF parser process could not be started.'));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || 'PDF parsing failed.'));
      try {
        const result = JSON.parse(stdout) as { text: string; pages: number; clipped: boolean };
        if (typeof result.text !== 'string' || !Number.isInteger(result.pages) || typeof result.clipped !== 'boolean') throw new Error();
        resolve(result);
      } catch {
        reject(new Error('PDF parser returned an invalid result.'));
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(bytes);
  });
}

function cleanName(input: string) {
  const leaf = input.replace(/\\/g, '/').split('/').pop() || 'source';
  return leaf.replace(/[\u0000-\u001f]/g, '').slice(0, 180) || 'source';
}

function normalizedText(text: string) {
  return text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
}

function lineLocated(text: string, prefix: string) {
  return normalizedText(text)
    .split('\n')
    .map((line, index) => line.trim() ? `[${prefix}, line ${index + 1}]: ${line}` : '')
    .filter(Boolean)
    .join('\n');
}

async function extractText(input: ParseInput): Promise<{ text: string; coverageNote?: string }> {
  const name = cleanName(input.name);
  const displayPath = safeRelativePath(input.relativePath, name);
  const ext = name.toLowerCase().split('.').pop() || '';
  if (['txt', 'md', 'markdown'].includes(ext)) return { text: lineLocated(input.bytes.toString('utf8'), displayPath) };

  if (ext === 'docx') {
    const parsed = await mammoth.extractRawText({ buffer: input.bytes });
    return { text: lineLocated(parsed.value, displayPath) };
  }

  if (ext === 'pdf') {
    const parsed = await parsePdf(input.bytes);
    const pages = normalizedText(parsed.text).split('\f').filter((page) => page.trim());
    const text = pages.length > 1
      ? pages.map((page, index) => lineLocated(page, `${displayPath}, page ${index + 1}`)).join('\n')
      : lineLocated(parsed.text, `${displayPath}${parsed.pages === 1 ? ', page 1' : ''}`);
    const limitations = [
      parsed.pages > PDF_MAX_PAGES ? `PDF parsing is limited to the first ${PDF_MAX_PAGES} pages.` : undefined,
      parsed.clipped ? `Extracted PDF text is limited to ${MAX_EXTRACTED_CHARS.toLocaleString()} characters.` : undefined,
    ].filter(Boolean);
    return { text, ...(limitations.length ? { coverageNote: limitations.join(' ') } : {}) };
  }

  if (ext === 'csv') return { text: lineLocated(input.bytes.toString('utf8'), displayPath) };

  if (['xlsx', 'xls'].includes(ext)) {
    const workbook = XLSX.read(input.bytes, { type: 'buffer', cellDates: true, raw: false });
    const output: string[] = [];
    const limitations: string[] = [];
    let rowsRemaining = 20_000;
    if (workbook.SheetNames.length > 40) limitations.push('Only the first 40 worksheets were parsed');
    for (const sheetName of workbook.SheetNames.slice(0, 40)) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet?.['!ref'] || rowsRemaining <= 0) continue;
      const bounds = XLSX.utils.decode_range(sheet['!ref']);
      if (bounds.e.r + 1 > rowsRemaining) limitations.push(`${sheetName} rows after the 20,000-row workbook limit were not parsed`);
      if (bounds.e.c >= 100) limitations.push(`${sheetName} columns after CV were not parsed`);
      const range = XLSX.utils.encode_range({
        s: bounds.s,
        e: { r: Math.min(bounds.e.r, bounds.s.r + rowsRemaining - 1), c: Math.min(bounds.e.c, 99) },
      });
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        range,
        raw: false,
        blankrows: true,
        defval: '',
      });
      rows.forEach((row, index) => {
        const cells = (Array.isArray(row) ? row : []).map((cell) => String(cell ?? '').trim());
        if (cells.some(Boolean)) output.push(`[${displayPath}, sheet ${sheetName}, row ${index + 1}]: ${cells.join(' | ')}`);
      });
      rowsRemaining -= rows.length;
    }
    return { text: output.join('\n'), ...(limitations.length ? { coverageNote: limitations.join('; ') + '.' } : {}) };
  }

  throw new Error('Unsupported file type. Use MD, TXT, PDF, DOCX, CSV, XLSX, or XLS.');
}

export async function parseSource(input: ParseInput, sourceId: string): Promise<ParsedSource> {
  const name = cleanName(input.name);
  const base = { ...input, name, sourceId };
  try {
    const extracted = await extractText(base);
    const fullText = extracted.text;
    if (!fullText.trim()) return { ...base, status: 'empty', text: '', parsedTextCharacters: 0, parseCoverage: 'complete', error: 'No readable text was found.' };
    const text = fullText.slice(0, MAX_EXTRACTED_CHARS);
    const clipped = fullText.length > MAX_EXTRACTED_CHARS;
    const limitations = [extracted.coverageNote, clipped ? `Extracted text is limited to ${MAX_EXTRACTED_CHARS.toLocaleString()} characters.` : undefined].filter(Boolean);
    return {
      ...base,
      status: 'parsed',
      text,
      parsedTextCharacters: text.length,
      parseCoverage: limitations.length ? 'partial' : 'complete',
      ...(limitations.length ? { coverageNote: limitations.join(' ') } : {}),
      excerpt: text.slice(0, 700),
      ...(limitations.length ? { error: `Partial parse: ${limitations.join(' ')}`.slice(0, 240) } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read this file.';
    const unsupported = message.startsWith('Unsupported file type.');
    return {
      ...base,
      status: unsupported ? 'unsupported' : 'failed',
      text: '',
      parsedTextCharacters: 0,
      parseCoverage: 'partial',
      error: message.slice(0, 240),
    };
  }
}

export function safeSourceName(input: string) {
  const leaf = input.replace(/\\/g, '/').split('/').pop() || 'source';
  return leaf.replace(/[\u0000-\u001f]/g, '').slice(0, 180) || 'source';
}

export function checkinSourceName(input: string) {
  const safeName = safeSourceName(input);
  const extension = safeName.toLocaleLowerCase().split('.').pop() || '';
  const supported = new Set(['md', 'markdown', 'txt', 'pdf', 'docx', 'csv', 'xlsx', 'xls']);
  if (supported.has(extension)) return safeName;
  return `${safeName.slice(0, 176)}.txt`;
}

export function safeRelativePath(input: string | undefined, fallback: string) {
  if (!input) return fallback;
  const parts = input.replace(/\\/g, '/').split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[\u0000-\u001f]/g, '').replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 100))
    .filter(Boolean);
  return parts.length ? parts.join('/').slice(0, 300) : fallback;
}
