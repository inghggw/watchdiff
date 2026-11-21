/**
 * Deciding whether a reading is news, and saying what changed in one screen.
 *
 * Two separate questions, deliberately kept apart:
 *   changed      — the value is not what we stored
 *   significant  — it changed *enough* to be worth a human's attention
 *
 * Only `significant` sends an alert. That split is what lets a number watcher
 * ignore a price moving by one peso while still keeping an exact baseline.
 */

import { hashValue } from './state.js';

const MAX_PREVIEW = 400;

export function truncate(text, max = MAX_PREVIEW) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Line-level difference. Set-based on purpose: readable for a human, cheap, order-insensitive. */
export function lineDiff(before, after, max = 8) {
  const beforeLines = String(before).split('\n').map((l) => l.trim()).filter(Boolean);
  const afterLines = String(after).split('\n').map((l) => l.trim()).filter(Boolean);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  return {
    removed: beforeLines.filter((l) => !afterSet.has(l)).slice(0, max),
    added: afterLines.filter((l) => !beforeSet.has(l)).slice(0, max),
  };
}

export function parseNumber(text) {
  const cleaned = String(text)
    .replace(/[^\d,.\-]/g, '')
    .trim();
  if (!cleaned) return null;
  // "1.234.567,89" (es-CO) and "1,234,567.89" (en-US) both have to read as the
  // same number. Rules, in order:
  //   both separators present -> the rightmost one is the decimal point
  //   one separator, repeated -> thousands grouping, so drop it
  //   one separator, once     -> decimal point
  // "1.250" stays genuinely ambiguous and is read as 1.25; use a threshold in
  // absolute terms, not percent, when a feed prints grouped three-digit values.
  const dots = (cleaned.match(/\./g) ?? []).length;
  const commas = (cleaned.match(/,/g) ?? []).length;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (dots && commas) {
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (dots > 1) {
    normalized = cleaned.replace(/\./g, '');
  } else if (commas > 1) {
    normalized = cleaned.replace(/,/g, '');
  } else if (commas === 1) {
    normalized = cleaned.replace(',', '.');
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function compareValue(previous, reading) {
  const before = previous.value ?? '';
  const after = reading.value;
  const changed = hashValue(after) !== hashValue(before);
  if (!changed) return { changed: false, significant: false, summary: 'sin cambios' };
  const diff = lineDiff(before, after);
  const multiline = before.includes('\n') || after.includes('\n');
  return {
    changed: true,
    significant: true,
    summary: multiline
      ? `el contenido cambió (${diff.added.length} línea(s) nueva(s), ${diff.removed.length} eliminada(s))`
      : `"${truncate(before, 120)}" → "${truncate(after, 120)}"`,
    before: truncate(before),
    after: truncate(after),
    diff: multiline ? diff : undefined,
  };
}

function compareList(previous, reading, watcher) {
  const before = previous.items ?? [];
  const after = reading.items;
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((item) => !beforeSet.has(item));
  const removed = before.filter((item) => !afterSet.has(item));
  const changed = added.length > 0 || removed.length > 0;
  const alertOn = watcher.alertOn ?? 'added';
  const significant =
    alertOn === 'added' ? added.length > 0 : alertOn === 'removed' ? removed.length > 0 : changed;
  const parts = [];
  if (added.length) parts.push(`${added.length} nuevo(s)`);
  if (removed.length) parts.push(`${removed.length} eliminado(s)`);
  return {
    changed,
    significant,
    summary: parts.length ? parts.join(', ') : 'sin cambios',
    added,
    removed,
    total: after.length,
    previousTotal: before.length,
  };
}

function compareNumber(previous, reading, watcher) {
  const after = parseNumber(reading.value);
  if (after === null) {
    return { changed: false, significant: false, summary: 'sin cambios', error: `"${truncate(reading.value, 80)}" no es un número` };
  }
  const before = previous.value === undefined ? null : parseNumber(previous.value);
  if (before === null) {
    return { changed: true, significant: true, summary: `valor inicial ${after}`, before: null, after };
  }
  const delta = after - before;
  const percent = before === 0 ? (delta === 0 ? 0 : Infinity) : (delta / Math.abs(before)) * 100;
  const changed = delta !== 0;
  let significant = changed;
  if (changed && typeof watcher.threshold === 'number') significant = Math.abs(delta) >= watcher.threshold;
  if (significant && typeof watcher.thresholdPercent === 'number') {
    significant = Math.abs(percent) >= watcher.thresholdPercent;
  }
  const arrow = delta > 0 ? '↑' : '↓';
  return {
    changed,
    significant,
    summary: changed
      ? `${before} → ${after} (${arrow} ${formatDelta(delta)}, ${percent === Infinity ? '∞' : percent.toFixed(2)}%)`
      : 'sin cambios',
    before,
    after,
    delta,
    percent,
  };
}

function formatDelta(delta) {
  const absolute = Math.abs(delta);
  return Number.isInteger(absolute) ? String(absolute) : absolute.toFixed(2);
}

/** Compares a fresh reading against the stored baseline. */
export function compare(previous, reading, watcher) {
  if (previous.kind && previous.kind !== reading.kind) {
    // The extractor started returning a different shape (a list where there was
    // a single value). Surfacing it beats silently reporting "everything changed".
        return {
      changed: true,
      significant: true,
      summary: `la forma del dato cambió: ${previous.kind} → ${reading.kind}`,
      shapeChange: true,
    };
  }
  switch (watcher.mode) {
    case 'list':
      return compareList(previous, reading, watcher);
    case 'number':
      return compareNumber(previous, reading, watcher);
    default:
      return compareValue(previous, reading);
  }
}

/** The alert a human reads. Plain text: it has to survive Telegram, Slack and e-mail. */
export function renderAlert(watcher, result, { now = new Date(), state } = {}) {
  // The label lives in the notification title, so the body starts with what
  // changed. Repeating it here printed the same line twice in every channel.
  const lines = [result.summary, '', watcher.url];
  if (watcher.mode === 'list') {
    const max = watcher.maxItemsInAlert ?? 10;
    if (result.added?.length) {
      lines.push('', `Nuevos (${result.added.length}):`);
      for (const item of result.added.slice(0, max)) lines.push(`  + ${truncate(item, 200)}`);
      if (result.added.length > max) lines.push(`  … y ${result.added.length - max} más`);
    }
    if (result.removed?.length && (watcher.alertOn === 'removed' || watcher.alertOn === 'both')) {
      lines.push('', `Ya no están (${result.removed.length}):`);
      for (const item of result.removed.slice(0, max)) lines.push(`  - ${truncate(item, 200)}`);
      if (result.removed.length > max) lines.push(`  … y ${result.removed.length - max} más`);
    }
    lines.push('', `Total ahora: ${result.total} (antes ${result.previousTotal})`);
  } else if (watcher.mode === 'number') {
    lines.push('', `Antes: ${result.before}`, `Ahora: ${result.after}`);
  } else if (result.diff) {
    if (result.diff.added.length) {
      lines.push('', 'Texto nuevo:');
      for (const line of result.diff.added) lines.push(`  + ${truncate(line, 200)}`);
    }
    if (result.diff.removed.length) {
      lines.push('', 'Texto eliminado:');
      for (const line of result.diff.removed) lines.push(`  - ${truncate(line, 200)}`);
    }
  } else {
    lines.push('', `Antes: ${result.before}`, `Ahora: ${result.after}`);
  }
  if (state?.lastChange) lines.push('', `Cambio anterior: ${state.lastChange}`);
  lines.push('', `Verificado: ${now.toISOString()}`);
  return lines.join('\n');
}

/** The "nothing changed, I am still watching" message. Silence is indistinguishable from a dead monitor. */
export function renderDigest(entries, { now = new Date() } = {}) {
  const changed = entries.filter((e) => e.significant);
  const failed = entries.filter((e) => e.status === 'error');
  const header = changed.length
    ? `📋 Resumen — ${changed.length} de ${entries.length} con novedades`
    : `✅ Resumen — ${entries.length} vigilados, sin novedades`;
  const lines = [header, ''];
  for (const entry of entries) {
    const icon = entry.status === 'error' ? '⚠️' : entry.significant ? '🔔' : '·';
    lines.push(`${icon} ${entry.label}: ${entry.status === 'error' ? entry.error : entry.summary}`);
  }
  if (failed.length) lines.push('', `${failed.length} no se pudo(ieron) leer en este ciclo.`);
  lines.push('', `Verificado: ${now.toISOString()}`);
  return lines.join('\n');
}
