# watchdiff

Watch a web page or a JSON API and get told when the part you care about changes. One command, one JSON config file, **zero runtime dependencies**.

```console
$ watchdiff check
🆕 SECOP II — software en Tolima: línea base guardada (25 ítems)
🆕 Node.js — versión LTS publicada: línea base guardada (19 caracteres)

$ watchdiff check          # 10 minutes later, 5 new tenders published
🔔 SECOP II — software en Tolima: 5 nuevo(s)
· Node.js — versión LTS publicada: sin cambios
```

The alert that went out, verbatim:

```
🔔 SECOP II — software en Tolima
5 nuevo(s)

https://www.datos.gov.co/resource/p6dx-8zbt.json?$select=id_del_proceso…

Nuevos (5):
  + CO1.REQ.10974164
  + CO1.REQ.10970545
  + CO1.REQ.10970083
  + CO1.REQ.10953822
  + CO1.REQ.10953329

Total ahora: 30 (antes 25)

Verificado: 2026-11-21T21:09:57.830Z
```

## Install

```bash
git clone <this repo> && cd watchdiff
npm test          # 57 tests, no network, no dependencies to install
npx .  init       # writes a sample watchdiff.config.json
npx .  check      # first run stores the baseline and stays quiet
```

Requires Node.js 20+. There is nothing to build and nothing in `node_modules`.

## Why not one of the existing ones

Check these first — if one fits, use it:

- **[changedetection.io](https://github.com/dgtlmoon/changedetection.io)** — the right answer for most people: web UI, browser rendering, visual diffs, Docker. Use it unless you specifically need something small and scriptable.
- **[urlwatch](https://github.com/thp/urlwatch)** — the mature CLI in this space (Python, YAML, many reporters).
- **Hosted:** Visualping, Distill.io, Sken.io.

`watchdiff` exists for the narrow case those make awkward: a monitor you drop into a server next to a cron line, with no container, no Python, no database and no web UI; whose alerts you can shape; and whose behaviour under quiet hours, cooldowns and delivery failures is exactly specified. It is also deliberately readable — about 1,500 lines of plain JavaScript, no framework, plus 800 lines of tests — because it is meant to be forked for one job.

## Config

```json
{
  "stateDir": ".watchdiff",
  "defaults": { "retries": 2, "errorThreshold": 2, "notify": ["telegram"] },
  "notifiers": {
    "telegram": { "type": "telegram", "botToken": "env:TELEGRAM_BOT_TOKEN", "chatId": "env:TELEGRAM_CHAT_ID" },
    "slack": { "type": "webhook", "url": "env:SLACK_WEBHOOK_URL", "template": "slack" },
    "history": { "type": "jsonl", "file": ".watchdiff/alerts.jsonl" },
    "log": { "type": "console" }
  },
  "watchers": [
    {
      "name": "tenders",
      "label": "New tenders in my category",
      "url": "https://api.example.com/tenders?limit=50",
      "extract": { "type": "json", "path": "[*].id" },
      "mode": "list",
      "alertOn": "added",
      "notify": ["telegram", "history"],
      "quietHours": { "from": "23:00", "to": "07:00", "tz": "America/Bogota" },
      "cooldownMinutes": 60
    }
  ]
}
```

Secrets never go in the file: any string may be `env:VARIABLE_NAME`.

### Extractors — what to watch inside the response

| `extract.type` | Options | Use for |
| --- | --- | --- |
| `text` | `stripHtml` (default true), `between: [start, end]` | A page or a region of it. Scripts, styles and comments are removed first. |
| `json` | `path`: `a.b`, `a[0]`, `[*].id`, `rows[*]` | APIs. A `[*]` segment fans out, so `[*].id` gives the array of ids. |
| `regex` | `pattern`, `flags`, `group` | A price, a version, a status buried in markup. |

### Modes — what counts as news

| `mode` | Alerts when | Options |
| --- | --- | --- |
| `value` | the value is not what it was | — |
| `list` | items appear (or disappear) | `alertOn`: `added` (default), `removed`, `both`; `maxItemsInAlert` |
| `number` | a number moves far enough | `threshold` (absolute), `thresholdPercent` |

### Channels

`console`, `telegram` (Bot API), `webhook` (`template`: `json`, `slack`, `discord`), `jsonl` (append to a file), `command` (run a local program; the payload arrives on stdin and in `WATCHDIFF_*` environment variables).

A channel only has to be resolvable if something routes to it, so the sample config ships Telegram and Slack examples without requiring their tokens.

## Run it on a schedule

```cron
*/15 * * * * cd /srv/watchdiff && /usr/bin/node bin/watchdiff.js check >> /var/log/watchdiff.log 2>&1
# one "still watching, nothing changed" message every evening
0 19 * * *   cd /srv/watchdiff && /usr/bin/node bin/watchdiff.js check --digest telegram >> /var/log/watchdiff.log 2>&1
```

Or keep it in the foreground: `watchdiff watch --interval 15m`.

| Exit code | Meaning |
| --- | --- |
| 0 | everything checked, nothing to report |
| 1 | usage or configuration error |
| 2 | a watcher could not be read, or an alert could not be delivered |
| 3 | something changed, and `--exit-change` was given |

## Behaviour that took a production incident to learn

These are the defaults, and each one exists because the opposite loses an alert or buries the channel in noise.

**The first check never alerts.** It stores a baseline. A monitor whose first run announces everything trains its reader to ignore it.

**A suppressed alert does not advance the baseline.** If quiet hours or a cooldown hold a change back, the old baseline stays, so the next allowed check detects the same change and reports it. This is the whole ballgame: advancing the baseline on a change nobody was told about is how a monitor silently loses the one event it was installed for.

**If every channel fails, the baseline is not advanced either.** A change that could not be delivered is still pending, and the next run tries again. `status` reports `undelivered`.

**One failed request is not an outage.** Reads are retried (429 and 5xx only, honouring `Retry-After`), and a failure is only reported after `errorThreshold` consecutive misses — portals return intermittent 5xx and empty bodies all day. A 404 is *not* retried: the page being gone is news.

**An empty body counts as a failure, not as "the content disappeared".**

**A damaged state file is treated as missing.** It re-seeds quietly instead of reporting that everything changed.

**Scripts, styles and comments are stripped before diffing.** A rotating CSRF token or an ad slot in the HTML makes every single check look like a change.

**A change in the *shape* of the data is reported as such.** If an extractor that returned one value starts returning a list, the site changed structurally and your watcher probably needs an update — that is more useful than a diff of everything.

**`--dry` reads and compares but writes no state and sends nothing.** The way to test a new watcher.

**Quiet hours are evaluated in the timezone you configure**, and a window like `23:00`–`07:00` wraps midnight correctly.

## Library use

```js
import { runAll } from 'watchdiff';
import { parseConfig } from 'watchdiff/config';

const config = parseConfig(myConfigObject);
const { entries, counts } = await runAll(config, { dry: true });
```

`checkWatcher` and `runAll` accept injectable `fetchImpl`, `sleepImpl`, `logger` and `now`, which is how the test suite runs the full path — retries, quiet hours, cooldowns, delivery failures — without a network or a clock.

## Project layout

```
src/config.js   Config validation; every error names its exact path
src/http.js     Fetch with timeout and a retry policy that only retries what retrying can fix
src/extract.js  text / json / regex extractors
src/diff.js     value / list / number comparison, and the alert text
src/state.js    One atomically written JSON baseline per watcher
src/runner.js   Quiet hours, cooldowns, error thresholds, delivery outcomes
src/notify.js   console / telegram / webhook / jsonl / command
src/cli.js      check · watch · status · init
test/           57 tests, including end-to-end runs against a local HTTP server
```

## Limitations

- **No JavaScript rendering.** It fetches HTML; it does not run a browser. For a SPA, watch the API the page calls (open devtools → Network), or use changedetection.io with its Playwright backend.
- No login flows beyond whatever static `headers` you configure.
- Checks run sequentially, by design: it is meant to be polite to the servers it watches.
- `1.250` is genuinely ambiguous in `number` mode and reads as `1.25`. Prefer an absolute `threshold` when a feed prints grouped three-digit values.

## License

MIT — see [LICENSE](LICENSE).

Respect the terms of service and `robots.txt` of whatever you point this at, and use an interval that does not cost the other side money.
