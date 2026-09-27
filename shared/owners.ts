const UNKNOWN_OWNER_LABELS = new Set([
  'unassigned',
  'not assigned',
  'unallocated',
  'tbd',
  'to be determined',
  'unknown',
  'unknown owner',
  'not recorded',
  'not stated',
  'unspecified',
  'not specified',
  'none',
  'no owner',
  'no one',
  'null',
  'n/a',
  'n-a',
  'n.a',
  'not applicable',
  'unowned',
  'neatribuit',
  'neatribuita',
  'necunoscut',
  'necunoscuta',
  'nespecificat',
  'nespecificata',
  'neindicat',
  'neindicata',
  'nu este atribuit',
  'nu e atribuit',
  'nu este precizat',
  'de stabilit',
]);

function normalizedLabel(value: string) {
  return value.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/^[\s"'`([{]+|[\s"'`),\]}:;.!?]+$/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Match only explicit absence labels. Null, missing, or blank values return false
 * so callers can preserve the distinction between omitted owner data and an
 * explicit source-backed request to clear an existing owner.
 */
export function isUnknownOwnerLabel(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  return UNKNOWN_OWNER_LABELS.has(normalizedLabel(value));
}
