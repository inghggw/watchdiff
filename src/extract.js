/**
 * Turning a response body into the one value we actually watch.
 *
 * Watching a whole page is how a monitor becomes noise: a CSRF token, a session
 * id or an ad rotation changes on every request and every check looks like news.
 * Each extractor narrows the body down to the part that carries meaning.
 */

export class ExtractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExtractError';
  }
}

const BLOCK_TAGS = /<\/?(?:p|div|br|li|tr|h[1-6]|section|article|header|footer|table|thead|tbody)\b[^>]*>/gi;

/** Removes scripts, styles and tags, decodes the common entities, collapses whitespace. */
export function stripHtml(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(BLOCK_TAGS, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    // One blank line or ten between two blocks is the same text to a reader, and
    // layout churn must not register as a change.
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Reads a dotted path out of parsed JSON. Supports `a.b`, `a[0]`, `[*]` and
 * `a[*].b`. A `[*]` segment fans out, so `[*].id` over an array of records
 * returns the array of ids — which is exactly what list mode wants.
 */
export function readJsonPath(data, path) {
  const segments = String(path)
    .replace(/\[(\*|\d+)\]/g, '.[$1]')
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let current = [data];
  let fanned = false;

  for (const segment of segments) {
    if (segment === '[*]') {
      const next = [];
      for (const value of current) {
        if (!Array.isArray(value)) throw new ExtractError(`path "${path}": [*] applied to ${typeName(value)}, not an array`);
        next.push(...value);
      }
      current = next;
      fanned = true;
      continue;
    }
    const indexMatch = /^\[(\d+)\]$/.exec(segment);
    const next = [];
    for (const value of current) {
      if (indexMatch) {
        if (!Array.isArray(value)) throw new ExtractError(`path "${path}": index applied to ${typeName(value)}, not an array`);
        next.push(value[Number(indexMatch[1])]);
      } else {
        if (value === null || typeof value !== 'object') {
          throw new ExtractError(`path "${path}": cannot read "${segment}" of ${typeName(value)}`);
        }
        next.push(value[segment]);
      }
    }
    current = next;
  }

  if (!fanned) return current[0];
  return current;
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function scalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Applies an extractor to a raw body.
 * Returns `{ kind: 'single', value }` or `{ kind: 'list', items }`.
 */
export function extract(body, extractor) {
  switch (extractor.type) {
    case 'text': {
      let text = extractor.stripHtml === false ? String(body) : stripHtml(body);
      if (extractor.between) {
        const [start, end] = extractor.between;
        const from = text.indexOf(start);
        if (from === -1) throw new ExtractError(`start marker ${JSON.stringify(start)} not found in the response`);
        const rest = text.slice(from + start.length);
        const to = rest.indexOf(end);
        if (to === -1) throw new ExtractError(`end marker ${JSON.stringify(end)} not found after the start marker`);
        text = rest.slice(0, to);
      }
      return { kind: 'single', value: text.trim() };
    }
    case 'json': {
      let data;
      try {
        data = JSON.parse(body);
      } catch (error) {
        throw new ExtractError(`response is not valid JSON: ${error.message}`);
      }
      const value = readJsonPath(data, extractor.path);
      if (Array.isArray(value)) return { kind: 'list', items: value.map(scalar) };
      if (value === undefined) throw new ExtractError(`path "${extractor.path}" is not present in the response`);
      return { kind: 'single', value: scalar(value) };
    }
    case 'regex': {
      const flags = extractor.flags.includes('g') ? extractor.flags : `${extractor.flags}g`;
      const regex = new RegExp(extractor.pattern, flags);
      const matches = [...String(body).matchAll(regex)];
      if (!matches.length) throw new ExtractError(`pattern /${extractor.pattern}/ matched nothing in the response`);
      const group = extractor.group ?? 0;
      const values = matches.map((match) => {
        if (match[group] === undefined) {
          throw new ExtractError(`pattern /${extractor.pattern}/ has no capture group ${group}`);
        }
        return String(match[group]).trim();
      });
      return values.length === 1 ? { kind: 'single', value: values[0] } : { kind: 'list', items: values };
    }
    default:
      throw new ExtractError(`unknown extractor type ${JSON.stringify(extractor.type)}`);
  }
}
