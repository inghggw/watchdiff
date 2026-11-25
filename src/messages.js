/**
 * Every string a human reads, in one place.
 *
 * Alerts are the product: if they arrive in a language the reader does not use,
 * the monitor is worthless no matter how correct the diff is. English is the
 * default because that is what the config, the CLI and the docs are written in;
 * `language: "es"` switches the reader-facing text without touching anything else.
 *
 * Adding a language means adding one object here. Nothing else in the codebase
 * contains a user-visible sentence.
 */

const LANGUAGES = {
  en: {
    noChange: 'no change',
    contentChanged: (added, removed) => `content changed (${added} new line(s), ${removed} removed)`,
    listAdded: (n) => `${n} new`,
    listRemoved: (n) => `${n} removed`,
    notANumber: (value) => `"${value}" is not a number`,
    initialValue: (value) => `initial value ${value}`,
    shapeChanged: (before, after) => `the data shape changed: ${before} → ${after}`,

    alertNew: (n) => `New (${n}):`,
    alertGone: (n) => `Gone (${n}):`,
    alertAndMore: (n) => `… and ${n} more`,
    alertTotalNow: (total, previous) => `Total now: ${total} (was ${previous})`,
    alertBefore: (value) => `Before: ${value}`,
    alertNow: (value) => `Now: ${value}`,
    alertNewText: 'New text:',
    alertRemovedText: 'Removed text:',
    alertPreviousChange: (iso) => `Previous change: ${iso}`,
    alertChecked: (iso) => `Checked: ${iso}`,

    digestChanges: (changed, total) => `📋 Summary — ${changed} of ${total} with changes`,
    digestQuiet: (total) => `✅ Summary — ${total} watched, no changes`,
    digestUnreadable: (n) => `${n} could not be read in this cycle.`,

    extractFailed: 'could not extract the value',
    fetchFailed: 'could not read the page',
    checkFailedTitle: (label, consecutive) => `⚠️ ${label} — check failed (${consecutive} in a row)`,
    baselineItems: (n) => `baseline stored (${n} items)`,
    baselineChars: (n) => `baseline stored (${n} characters)`,
    quietHours: 'quiet hours',
    cooldown: (minutes) => `cooldown (${minutes} min remaining)`,

    cliHeld: (reason) => ` (held: ${reason})`,
    cliUndelivered: (error) => ` (could not deliver: ${error})`,
    cliAttempts: (n) => ` (${n} attempts)`,
    cliCounts: (counts) =>
      `${counts.total} checked: ${counts.changed} changed, ${counts.baseline} baseline, ` +
      `${counts.deferred} held, ${counts.errors} errored`,
    cliDryNote: ' — --dry mode, nothing sent',
    cliSendFailed: (notifier, error) => `   send failed → ${notifier}: ${error}`,
    cliDigestFailed: (notifier, error) => `   digest failed → ${notifier}: ${error}`,
    cliStatusHeader: (dir) => `State in ${dir}\n`,
    cliStatusCounts: (checks, changes) => `${checks} checks, ${changes} changes`,
    cliStatusLast: (iso) => `, last ${iso}`,
    cliStatusNever: ', never checked',
    cliStatusErrors: (n, error) => `, ${n} consecutive error(s): ${error}`,
    cliInitWritten: (target) => `Sample config written to ${target}`,
    cliInitNextStep: 'Next: watchdiff check --dry   (reads, compares, sends nothing)',
  },

  es: {
    noChange: 'sin cambios',
    contentChanged: (added, removed) => `el contenido cambió (${added} línea(s) nueva(s), ${removed} eliminada(s))`,
    listAdded: (n) => `${n} nuevo(s)`,
    listRemoved: (n) => `${n} eliminado(s)`,
    notANumber: (value) => `"${value}" no es un número`,
    initialValue: (value) => `valor inicial ${value}`,
    shapeChanged: (before, after) => `la forma del dato cambió: ${before} → ${after}`,

    alertNew: (n) => `Nuevos (${n}):`,
    alertGone: (n) => `Ya no están (${n}):`,
    alertAndMore: (n) => `… y ${n} más`,
    alertTotalNow: (total, previous) => `Total ahora: ${total} (antes ${previous})`,
    alertBefore: (value) => `Antes: ${value}`,
    alertNow: (value) => `Ahora: ${value}`,
    alertNewText: 'Texto nuevo:',
    alertRemovedText: 'Texto eliminado:',
    alertPreviousChange: (iso) => `Cambio anterior: ${iso}`,
    alertChecked: (iso) => `Verificado: ${iso}`,

    digestChanges: (changed, total) => `📋 Resumen — ${changed} de ${total} con novedades`,
    digestQuiet: (total) => `✅ Resumen — ${total} vigilados, sin novedades`,
    digestUnreadable: (n) => `${n} no se pudo(ieron) leer en este ciclo.`,

    extractFailed: 'no se pudo extraer el dato',
    fetchFailed: 'no se pudo leer la página',
    checkFailedTitle: (label, consecutive) => `⚠️ ${label} — fallo de verificación (${consecutive} seguidos)`,
    baselineItems: (n) => `línea base guardada (${n} ítems)`,
    baselineChars: (n) => `línea base guardada (${n} caracteres)`,
    quietHours: 'horario de silencio',
    cooldown: (minutes) => `cooldown (${minutes} min restantes)`,

    cliHeld: (reason) => ` (retenido: ${reason})`,
    cliUndelivered: (error) => ` (no se pudo entregar: ${error})`,
    cliAttempts: (n) => ` (${n} intentos)`,
    cliCounts: (counts) =>
      `${counts.total} verificado(s): ${counts.changed} con cambios, ${counts.baseline} línea base, ` +
      `${counts.deferred} retenido(s), ${counts.errors} con error`,
    cliDryNote: ' — modo --dry, nada enviado',
    cliSendFailed: (notifier, error) => `   envío fallido → ${notifier}: ${error}`,
    cliDigestFailed: (notifier, error) => `   resumen fallido → ${notifier}: ${error}`,
    cliStatusHeader: (dir) => `Estado en ${dir}\n`,
    cliStatusCounts: (checks, changes) => `${checks} chequeos, ${changes} cambios`,
    cliStatusLast: (iso) => `, último ${iso}`,
    cliStatusNever: ', nunca verificado',
    cliStatusErrors: (n, error) => `, ${n} error(es) seguidos: ${error}`,
    cliInitWritten: (target) => `Config de ejemplo escrita en ${target}`,
    cliInitNextStep: 'Siguiente paso: watchdiff check --dry   (lee, compara y no envía nada)',
  },
};

/** The languages a config may ask for. */
export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGES);

export const DEFAULT_LANGUAGE = 'en';

/**
 * Message catalog for a language tag. An unknown or missing tag falls back to
 * English rather than throwing: a monitor that still alerts in the wrong
 * language beats a monitor that crashes at 3am over a typo in a config field.
 * `parseConfig` rejects unknown tags up front, so this path is for direct
 * library callers.
 */
export function messagesFor(language) {
  return LANGUAGES[language] ?? LANGUAGES[DEFAULT_LANGUAGE];
}
