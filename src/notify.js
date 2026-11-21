/**
 * Delivery. Every notifier takes the same `{ title, text, watcher, result }`
 * payload and returns a per-target outcome instead of throwing, because a dead
 * Slack webhook must not stop the Telegram alert that is going out next to it.
 */

import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const TELEGRAM_LIMIT = 4096;

async function postJson(url, payload, headers = {}, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  return response;
}

function webhookPayload(notifier, payload) {
  if (notifier.template === 'slack') return { text: `*${payload.title}*\n${payload.text}` };
  if (notifier.template === 'discord') return { content: `**${payload.title}**\n${payload.text}`.slice(0, 1900) };
  return {
    title: payload.title,
    text: payload.text,
    watcher: payload.watcher?.name,
    url: payload.watcher?.url,
    mode: payload.watcher?.mode,
    summary: payload.result?.summary,
    result: payload.result,
    sentAt: new Date().toISOString(),
  };
}

const senders = {
  async console(notifier, payload, deps) {
    (deps.logger ?? console.log)(`\n${payload.title}\n${payload.text}\n`);
  },

  async webhook(notifier, payload, deps) {
    await postJson(notifier.url, webhookPayload(notifier, payload), notifier.headers, deps.fetchImpl);
  },

  async telegram(notifier, payload, deps) {
    const text = `${payload.title}\n${payload.text}`.slice(0, TELEGRAM_LIMIT);
    await postJson(
      `https://api.telegram.org/bot${notifier.botToken}/sendMessage`,
      { chat_id: notifier.chatId, text, disable_web_page_preview: true },
      {},
      deps.fetchImpl,
    );
  },

  async command(notifier, payload, deps) {
    const run = deps.execFileImpl ?? execFile;
    const [command, ...args] = notifier.command;
    await new Promise((resolve, reject) => {
      const child = run(
        command,
        [...args, payload.title],
        {
          env: {
            ...process.env,
            WATCHDIFF_TITLE: payload.title,
            WATCHDIFF_TEXT: payload.text,
            WATCHDIFF_WATCHER: payload.watcher?.name ?? '',
            WATCHDIFF_URL: payload.watcher?.url ?? '',
            WATCHDIFF_SUMMARY: payload.result?.summary ?? '',
          },
          timeout: 30_000,
        },
        (error) => (error ? reject(error) : resolve()),
      );
      // The full payload also goes in on stdin, so a script can parse it.
      child.stdin?.end(JSON.stringify({ ...payload, watcher: payload.watcher?.name }));
    });
  },

  async jsonl(notifier, payload, deps) {
    const file = path.resolve(notifier.file);
    await mkdir(path.dirname(file), { recursive: true });
    const line = JSON.stringify({
      at: (deps.now ?? (() => new Date()))().toISOString(),
      watcher: payload.watcher?.name,
      title: payload.title,
      summary: payload.result?.summary,
      text: payload.text,
    });
    await appendFile(file, `${line}\n`, 'utf8');
  },
};

/**
 * Sends one payload to the named notifiers.
 * @returns {Promise<Array<{notifier: string, ok: boolean, error?: string}>>}
 */
export async function notifyAll(notifierNames, notifiers, payload, deps = {}) {
  const results = [];
  for (const name of notifierNames) {
    const notifier = notifiers[name];
    if (!notifier) {
      results.push({ notifier: name, ok: false, error: 'notifier is not defined in the config' });
      continue;
    }
    if (notifier.unavailable) {
      results.push({ notifier: name, ok: false, error: notifier.unavailable });
      continue;
    }
    const send = senders[notifier.type];
    if (!send) {
      results.push({ notifier: name, ok: false, error: `unsupported notifier type ${notifier.type}` });
      continue;
    }
    try {
      await send(notifier, payload, deps);
      results.push({ notifier: name, ok: true });
    } catch (error) {
      results.push({ notifier: name, ok: false, error: error?.message ?? String(error) });
    }
  }
  return results;
}

export const notifierTypes = Object.keys(senders);
