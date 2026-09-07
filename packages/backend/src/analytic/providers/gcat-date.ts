// GCAT vague date → prefix-ISO string.
// Spec: my_plans/marvin/p3/S1_enrichment_provider.md §parseGcatDate.
//
// GCAT dates look like "1998 Nov 20 0649:47", "2019 May 24", "1967 Oct?", "1975".
// We emit the longest exact prefix (year / year-month / year-month-day); time is
// dropped because ISO prefix comparison stays lexicographically valid without it.
// Padding with fake -01-01 would invent data — prefix-only is the honest path.

const MONTH_MAP: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

export function parseGcatDate(s: string | undefined | null): string | null {
  if (!s) return null;
  // Strip trailing uncertainty markers (may appear on any token).
  const clean = s.replace(/[?*]+/g, '').trim();
  if (!clean) return null;

  const tokens = clean.split(/\s+/);
  const year = tokens[0];
  if (!/^\d{4}$/.test(year)) return null;

  if (tokens.length < 2) return year;

  const month = MONTH_MAP[tokens[1]];
  if (!month) return year; // unrecognised month abbreviation → year-only

  if (tokens.length < 3) return `${year}-${month}`;

  const dayRaw = tokens[2];
  if (!/^\d{1,2}$/.test(dayRaw)) return `${year}-${month}`;
  const day = dayRaw.padStart(2, '0');

  return `${year}-${month}-${day}`;
  // tokens[3] (time like "0649:47") is intentionally ignored.
}
