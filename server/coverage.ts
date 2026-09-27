import type { ProjectSource } from '../shared/types.js';

export const EXTRACTION_SEGMENT_CHARS = 12_000;
export const EXTRACTION_SEGMENTS_PER_JOB = 4;

export interface TextSegment {
  index: number;
  total: number;
  start_offset: number;
  end_offset: number;
  text: string;
}

export interface PendingSourceSegment extends TextSegment {
  source_id: string;
  name: string;
}

export function splitSourceText(text: string, maxChars = EXTRACTION_SEGMENT_CHARS): TextSegment[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('Segment size must be a positive integer.');
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const preferredBoundary = text.lastIndexOf('\n', end);
      if (preferredBoundary >= start + Math.floor(maxChars * 0.7)) end = preferredBoundary + 1;
    }
    if (end <= start) end = Math.min(text.length, start + maxChars);
    ranges.push({ start, end });
    start = end;
  }
  const total = ranges.length;
  return ranges.map((range, index) => ({
    index,
    total,
    start_offset: range.start,
    end_offset: range.end,
    text: text.slice(range.start, range.end),
  }));
}

export function nextSourceBatch(
  sources: ProjectSource[],
  textBySource: Map<string, string>,
  maxSegments = EXTRACTION_SEGMENTS_PER_JOB,
): PendingSourceSegment[] {
  if (!Number.isInteger(maxSegments) || maxSegments < 1) throw new Error('Batch size must be a positive integer.');
  const queues = sources
    .filter((source) => source.parser_status === 'parsed' && !source.fixture_only)
    .slice()
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .flatMap((source) => {
      const text = textBySource.get(source.id) || '';
      const processed = new Set(source.processed_segments || []);
      return splitSourceText(text).filter((segment) => !processed.has(segment.index)).map((segment) => ({
        ...segment,
        source_id: source.id,
        name: source.relative_path || source.name,
      }));
    });

  const selected: PendingSourceSegment[] = [];
  const seenSources = new Set<string>();
  for (const segment of queues) {
    if (selected.length >= maxSegments) break;
    if (seenSources.has(segment.source_id)) continue;
    selected.push(segment);
    seenSources.add(segment.source_id);
  }
  if (selected.length < maxSegments) {
    const selectedKeys = new Set(selected.map((segment) => `${segment.source_id}:${segment.index}`));
    for (const segment of queues) {
      if (selected.length >= maxSegments) break;
      const key = `${segment.source_id}:${segment.index}`;
      if (selectedKeys.has(key)) continue;
      selected.push(segment);
      selectedKeys.add(key);
    }
  }
  return selected;
}

export function extractionCoverage(source: ProjectSource, processed: number[], text: string) {
  const total = splitSourceText(text).length;
  const uniqueProcessed = [...new Set(processed)].filter((index) => Number.isInteger(index) && index >= 0 && index < total).sort((a, b) => a - b);
  return {
    parsed_text_characters: text.length,
    segments_total: total,
    processed_segments: uniqueProcessed,
    extraction_coverage: total === 0
      ? 'unavailable' as const
      : uniqueProcessed.length === total
        ? 'complete' as const
        : uniqueProcessed.length
          ? 'partial' as const
          : source.extraction_coverage === 'legacy_unknown'
            ? 'legacy_unknown' as const
            : 'pending' as const,
  };
}
