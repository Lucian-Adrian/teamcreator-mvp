import type { ProjectRecord, ProjectSource, RecordKind, SourceRef } from '../../shared/types';

export interface StructuredRow {
  values: Record<string, string>;
  location: string;
  quote: string;
}

export interface ParsedPublicFile {
  text: string;
  parserStatus: ProjectSource['parser_status'];
  parseCoverage?: ProjectSource['parse_coverage'];
  mediaType: string;
  rows: StructuredRow[];
  note: string;
  error?: string;
}

const TITLE_FIELDS = new Set(['title', 'name', 'task', 'deliverable', 'record_title', 'sarcina', 'livrabil', 'titlu']);
const KIND_FIELDS = new Set(['kind', 'type', 'record_type', 'record_kind', 'tip']);
const OWNER_FIELDS = new Set(['owner', 'assignee', 'responsible', 'responsabil', 'owner_name']);
const STATUS_FIELDS = new Set(['status', 'state', 'stare']);
const DUE_FIELDS = new Set(['due', 'due_date', 'target_date', 'deadline', 'termen', 'target']);
const ID_FIELDS = new Set(['id', 'key', 'code', 'record_id']);
const DEPENDENCY_FIELDS = new Set(['depends_on', 'dependencies', 'dependency', 'depends']);
const DESCRIPTION_FIELDS = new Set(['description', 'details', 'notes', 'descriere', 'detalii']);

export function normalizeColumn(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function splitDelimited(text: string, delimiter: string): Array<{ cells: string[]; raw: string; line: number }> {
  const records: Array<{ cells: string[]; raw: string; line: number }> = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let raw = '';
  let line = 1;
  let recordLine = 1;
  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    raw += character;
    if (character === '"') {
      if (quoted && input[index + 1] === '"') { cell += '"'; raw += input[++index]; }
      else quoted = !quoted;
    } else if (!quoted && character === delimiter) {
      cells.push(cell.trim()); cell = '';
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && input[index + 1] === '\n') raw += input[++index];
      cells.push(cell.trim()); cell = '';
      if (cells.some(Boolean)) records.push({ cells, raw: raw.replace(/[\r\n]+$/, ''), line: recordLine });
      cells = []; raw = '';
      line += 1; recordLine = line;
    } else {
      cell += character;
      if (character === '\n') line += 1;
    }
  }
  cells.push(cell.trim());
  if (cells.some(Boolean)) records.push({ cells, raw: raw.replace(/[\r\n]+$/, ''), line: recordLine });
  return records;
}

function likelyStructuredHeader(cells: string[]): boolean {
  const headers = cells.map(normalizeColumn);
  return headers.some((header) => TITLE_FIELDS.has(header))
    && (headers.some((header) => KIND_FIELDS.has(header))
      || headers.some((header) => OWNER_FIELDS.has(header))
      || headers.some((header) => STATUS_FIELDS.has(header) || DUE_FIELDS.has(header) || DEPENDENCY_FIELDS.has(header)));
}

function delimiterFor(line: string): string {
  const counts = [',', '\t', ';'].map((delimiter) => {
    let quoted = false;
    let count = 0;
    for (const character of line) {
      if (character === '"') quoted = !quoted;
      else if (!quoted && character === delimiter) count += 1;
    }
    return { delimiter, count };
  }).sort((left, right) => right.count - left.count);
  return counts[0]?.count ? counts[0].delimiter : ',';
}

function parseMarkdownRows(text: string): StructuredRow[] {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].includes('|') || !/^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) continue;
    const headers = lines[index].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((item) => item.trim());
    if (!likelyStructuredHeader(headers)) continue;
    const normalized = headers.map(normalizeColumn);
    const rows: StructuredRow[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const raw = lines[rowIndex];
      if (!raw.includes('|')) break;
      const cells = raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((item) => item.trim());
      if (!cells.some(Boolean)) continue;
      rows.push({ values: Object.fromEntries(normalized.map((header, cellIndex) => [header, cells[cellIndex] || ''])), location: `line ${rowIndex + 1}`, quote: raw.trim() });
    }
    return rows;
  }
  return [];
}

function rowsFromMatrix(matrix: unknown[][], locationPrefix: string): StructuredRow[] {
  const useful = matrix.map((row) => row.map((cell) => String(cell ?? '').trim()));
  const headerIndex = useful.findIndex((cells) => likelyStructuredHeader(cells));
  if (headerIndex < 0) return [];
  const headers = useful[headerIndex].map(normalizeColumn);
  return useful.slice(headerIndex + 1).flatMap((cells, index) => {
    if (!cells.some(Boolean)) return [];
    const values = Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex] || '']));
    const quote = cells.map((cell) => cell.replace(/\s+/g, ' ').trim()).join(' | ').trim();
    return quote ? [{ values, location: `${locationPrefix}${headerIndex + index + 2}`, quote: quote.slice(0, 2_048) }] : [];
  });
}

export function parseStructuredText(text: string, name = 'source.txt'): StructuredRow[] {
  const markdown = parseMarkdownRows(text);
  if (markdown.length) return markdown;
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] || '';
  const delimiter = delimiterFor(firstLine);
  const records = splitDelimited(text, delimiter);
  if (records.length < 2 || !likelyStructuredHeader(records[0].cells)) return [];
  const headers = records[0].cells.map(normalizeColumn);
  return records.slice(1).flatMap((record) => {
    if (!record.cells.some(Boolean)) return [];
    const values = Object.fromEntries(headers.map((header, index) => [header, record.cells[index] || '']));
    return [{ values, location: `line ${record.line}`, quote: record.raw.trim().slice(0, 2_048) }];
  });
}

function valueBy(fields: Record<string, string>, choices: Set<string>): string {
  const entry = Object.entries(fields).find(([key]) => choices.has(key));
  return entry?.[1]?.trim() || '';
}

function kindFor(row: StructuredRow): RecordKind | null {
  const explicit = valueBy(row.values, KIND_FIELDS).normalize('NFKD').toLowerCase();
  if (/(member|person|team|staff|resource|persoana|membru|echipa)/.test(explicit)) return 'member';
  if (/(deliverable|livrabil|output)/.test(explicit)) return 'deliverable';
  if (/(risk|issue|blocker|risc|problema)/.test(explicit)) return 'risk';
  if (/(decision|decizie)/.test(explicit)) return 'decision';
  if (/(task|activity|work|sarcina|activitate)/.test(explicit)) return 'task';
  if (explicit) return null;
  const key = valueBy(row.values, ID_FIELDS).toLowerCase();
  if (/^d[-_\d]/.test(key)) return 'deliverable';
  if (/^(r|risk)[-_\d]/.test(key)) return 'risk';
  if (/^(dc|dec)[-_\d]/.test(key)) return 'decision';
  if (/^(m|member)[-_\d]/.test(key)) return 'member';
  const hasTaskShape = Object.keys(row.values).some((field) => OWNER_FIELDS.has(field))
    && Object.keys(row.values).some((field) => STATUS_FIELDS.has(field) || DUE_FIELDS.has(field) || DEPENDENCY_FIELDS.has(field));
  return hasTaskShape ? 'task' : null;
}

export interface DeterministicCandidate {
  kind: RecordKind;
  title: string;
  fields: Partial<ProjectRecord>;
  source_refs: SourceRef[];
}

/** Maps only explicit record-shaped table rows and cites the original row. */
export function deterministicCandidates(rows: StructuredRow[], sourceId: string): DeterministicCandidate[] {
  return rows.flatMap((row) => {
    const title = valueBy(row.values, TITLE_FIELDS);
    const kind = kindFor(row);
    if (!title || !kind) return [];
    const owner = valueBy(row.values, OWNER_FIELDS) || null;
    const status = valueBy(row.values, STATUS_FIELDS) || null;
    const due = valueBy(row.values, DUE_FIELDS) || null;
    const description = valueBy(row.values, DESCRIPTION_FIELDS) || null;
    const dependencies = valueBy(row.values, DEPENDENCY_FIELDS);
    const source_refs: SourceRef[] = [{ source_id: sourceId, location: row.location, quote: row.quote }];
    const fields: Partial<ProjectRecord> = {
      status,
      owner,
      owner_id: null,
      due,
      due_basis: due ? 'reported' : 'unknown',
      depends_on: [],
      source_refs,
      field_refs: Object.fromEntries(['title', 'status', 'owner', 'due', 'description'].map((field) => [field, source_refs])),
      evidence_state: 'supported',
      review_state: 'unreviewed',
      description: [description, dependencies ? `Dependency as written in source: ${dependencies}` : ''].filter(Boolean).join('\n') || null,
    };
    return [{ kind, title: title.slice(0, 240), fields, source_refs }];
  });
}

export async function readPublicFile(file: File): Promise<ParsedPublicFile> {
  const extension = file.name.toLowerCase().split('.').pop() || '';
  const supportedText = ['txt', 'md', 'markdown', 'csv', 'tsv'].includes(extension);
  if (supportedText) {
    const text = await file.text();
    if (!text.trim()) return { text, parserStatus: 'empty', mediaType: file.type || typeForExtension(extension), rows: [], note: 'The source file is empty.' };
    const rows = parseStructuredText(text, file.name);
    const tableMode = ['csv', 'tsv'].includes(extension);
    return {
      text,
      parserStatus: 'parsed',
      mediaType: file.type || typeForExtension(extension),
      rows,
      note: rows.length
        ? `${rows.length} structured rows were mapped by deterministic local rules. Each proposal cites its original row.`
        : tableMode ? 'File text is saved locally. Its columns do not match the supported record table; no facts were proposed.' : 'Text is saved locally. Public browser mode has no AI provider; no facts were proposed.',
    };
  }
  if (extension === 'xlsx' || extension === 'xls') {
    try {
      const xlsx = await import('xlsx');
      const workbook = xlsx.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
      const sheets: string[] = [];
      const rows: StructuredRow[] = [];
      for (const sheetName of workbook.SheetNames.slice(0, 40)) {
        const sheet = workbook.Sheets[sheetName];
        const matrix = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, blankrows: false, defval: '' });
        const rendered = matrix.map((row, rowIndex) => `[sheet ${sheetName}, row ${rowIndex + 1}]: ${row.map((cell) => String(cell ?? '')).join(' | ')}`).join('\n');
        sheets.push(`Sheet: ${sheetName}\n${rendered}`);
        rows.push(...rowsFromMatrix(matrix, `${sheetName} row `));
      }
      const text = sheets.join('\n\n');
      return {
        text,
        parserStatus: text.trim() ? 'parsed' : 'empty',
        mediaType: file.type || typeForExtension(extension),
        parseCoverage: workbook.SheetNames.length > 40 ? 'partial' : 'complete',
        rows,
        note: workbook.SheetNames.length > 40
          ? `Only the first 40 of ${workbook.SheetNames.length} sheets were read in public browser mode. ${rows.length} structured rows were mapped where supported.`
          : rows.length
          ? `${rows.length} structured rows were mapped by deterministic local rules. Each proposal cites its sheet and row.`
          : 'Workbook content is saved locally. Public browser mode has no AI provider; no facts were proposed.',
      };
    } catch (error) {
      return { text: '', parserStatus: 'failed', mediaType: file.type || typeForExtension(extension), rows: [], note: 'The workbook could not be opened in this browser.', error: error instanceof Error ? error.message : 'Workbook parsing failed.' };
    }
  }
  const type = file.type || typeForExtension(extension);
  return {
    text: '', parserStatus: 'unsupported', mediaType: type, rows: [],
    note: `${extension.toUpperCase() || 'This file type'} is inventoried, but public browser mode cannot read it. PDF and DOCX remain available in the local full-parser app.`,
    error: 'Unsupported in public browser mode. The file was not sent to a server or provider.',
  };
}

function typeForExtension(extension: string): string {
  const types: Record<string, string> = {
    txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
    pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return types[extension] || 'application/octet-stream';
}
