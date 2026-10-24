const NAIROBI_TZ = 'Africa/Nairobi';

function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const lookup = {};
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = part.value;
  }

  return {
    year: Number(lookup.year || '1970'),
    month: Number(lookup.month || '1'),
    day: Number(lookup.day || '1'),
    hour: Number(lookup.hour || '0'),
    minute: Number(lookup.minute || '0'),
    second: Number(lookup.second || '0'),
  };
}

export function nowInNairobi() {
  const now = new Date();
  const { year, month, day, hour, minute, second } = getZonedParts(now, NAIROBI_TZ);
  return new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+03:00`);
}

export function formatNairobiDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: NAIROBI_TZ,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

function parseMonth(monthText) {
  const map = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11,
  };
  return map[String(monthText).slice(0, 3).toLowerCase()] ?? null;
}

export function parseDateValue(value) {
  if (!value || typeof value !== 'string') return null;

  const raw = value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;

  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  const slashMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  const monthDayYear = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (monthDayYear) {
    const [, dayText, monthText, yearText] = monthDayYear;
    const month = parseMonth(monthText);
    if (month != null) {
      return new Date(Date.UTC(Number(yearText), month, Number(dayText)));
    }
  }

  const yearMonthDay = raw.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (yearMonthDay) {
    const [, monthText, dayText, yearText] = yearMonthDay;
    const month = parseMonth(monthText);
    if (month != null) {
      return new Date(Date.UTC(Number(yearText), month, Number(dayText)));
    }
  }

  return null;
}

export function extractDateRanges(text) {
  if (!text) return [];

  const patterns = [
    /(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/g,
    /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*[-–—]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/g,
    /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/g,
    /(\d{4})-(\d{1,2})-(\d{1,2})/g,
    /(\d{1,2})[/-](\d{1,2})[/-](\d{4})/g,
  ];

  const matches = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const parts = match.slice(1);
      if (parts.length >= 4 && /[A-Za-z]/.test(String(parts[2]))) {
        const startDay = Number(parts[0]);
        const startMonth = parseMonth(parts[2]);
        const startYear = Number(parts[3]);
        const endDay = parts[1] ? Number(parts[1]) : startDay;
        const endMonth = parts[4] ? parseMonth(parts[4]) : startMonth;
        const endYear = parts[5] ? Number(parts[5]) : startYear;
        if (startMonth != null && endMonth != null) {
          matches.push({
            start: new Date(Date.UTC(startYear, startMonth, startDay)),
            end: new Date(Date.UTC(endYear, endMonth, endDay)),
            raw: match[0],
          });
        }
      } else if (parts.length >= 3) {
        const start = parseDateValue(match[0]);
        if (start) {
          matches.push({ start, end: start, raw: match[0] });
        }
      }
    }
  }

  return matches.filter((entry) => entry && Number.isFinite(entry.start.getTime()));
}

export function classifyDateRange(range, now = nowInNairobi()) {
  if (!range) return 'unknown';
  if (range.end && range.end < now) return 'past';
  if (range.start && range.start > now) return 'future';
  return 'ongoing';
}

export function isEventQuestion(question) {
  const q = String(question || '').toLowerCase();
  return /(upcoming|event|events|semester|schedule|programme|conference|deadline|calendar|exam|registration|orientation|date|what happened|past|previous|history|last semester)/.test(q);
}

export function filterTemporalDocs(docs, question, now = nowInNairobi()) {
  if (!Array.isArray(docs) || !docs.length || !isEventQuestion(question)) return docs;

  const q = String(question || '').toLowerCase();
  const futureOnly = /(upcoming|next|coming|soon|this semester|current semester|current academic|what events are there this semester|schedule for this semester)/.test(q);
  const pastOnly = /(past|previous|last semester|history|what happened|what was|already happened|was held|happened)/.test(q);

  if (pastOnly) return docs;
  if (!futureOnly) return docs;

  return docs.filter((doc) => {
    const text = String(doc?.pageContent || '');
    const ranges = extractDateRanges(text);
    if (!ranges.length) return true;
    return ranges.some((range) => classifyDateRange(range, now) !== 'past');
  });
}
