#!/usr/bin/env node
'use strict';

/**
 * Telegram -> GitHub file bot.
 *
 * Receives files from Telegram, uploads them as assets to a GitHub Release,
 * and replies with the direct download link.
 *
 * Required environment variables:
 *   TELEGRAM_BOT_TOKEN   token from @BotFather
 *   GITHUB_TOKEN         provided automatically by GitHub Actions
 *   GITHUB_REPOSITORY    provided automatically by GitHub Actions (owner/repo)
 *
 * Optional:
 *   ALLOWED_USER_IDS     comma/space separated Telegram numeric user IDs.
 *                        When empty the bot runs in bootstrap mode: it only
 *                        replies with the sender's ID so the owner can add it.
 *   RELEASE_TAG          release tag to store files under (default: telegram-files)
 *   RUN_MINUTES          how long to poll per workflow run (default: 4.5)
 */

const fs = require('fs');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_REPOSITORY || '';
const RELEASE_TAG = process.env.RELEASE_TAG || 'telegram-files';
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 4.5);
const STATE_FILE = '.bot-state.json';
const MAX_TELEGRAM_BYTES = 20 * 1024 * 1024; // Bot API getFile limit
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const ALLOWED_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || '')
    .split(/[\s,;]+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
);

if (!BOT_TOKEN || !GITHUB_TOKEN || !REPO) {
  console.error(
    'Missing required environment variables: TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { offset: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

async function telegram(method, params = {}) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(45000),
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    // Ignore non-JSON error pages.
  }

  if (!data.ok) {
    throw new Error(
      `Telegram ${method} failed (${response.status}): ${data.description || 'unknown error'}`
    );
  }
  return data.result;
}

async function sendMessage(chatId, text, replyToMessageId) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyToMessageId
      ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
      : {}),
  });
}

async function editMessage(chatId, messageId, text) {
  try {
    await telegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (error) {
    console.error('editMessageText failed:', error.message);
  }
}

async function downloadTelegramFile(fileId) {
  const file = await telegram('getFile', { file_id: fileId });
  if (!file.file_path) {
    throw new Error('Telegram did not return a file path for this file.');
  }

  const response = await fetch(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
    { signal: AbortSignal.timeout(180000) }
  );

  if (!response.ok) {
    throw new Error(`Telegram file download failed (HTTP ${response.status}).`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

async function githubRequest(path, options = {}) {
  const { allow404 = false, ...fetchOptions } = options;
  const response = await fetch(`https://api.github.com${path}`, {
    ...fetchOptions,
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'telegram-github-bot',
      ...(fetchOptions.headers || {}),
    },
    signal: fetchOptions.signal || AbortSignal.timeout(60000),
  });

  const text = await response.text();

  if (!response.ok) {
    if (allow404 && response.status === 404) return null;
    const error = new Error(
      `GitHub API ${response.status}: ${text.slice(0, 500) || response.statusText}`
    );
    error.status = response.status;
    throw error;
  }

  return text ? JSON.parse(text) : null;
}

let cachedRelease = null;

async function findRelease() {
  if (cachedRelease) return cachedRelease;
  cachedRelease = await githubRequest(
    `/repos/${REPO}/releases/tags/${encodeURIComponent(RELEASE_TAG)}`,
    { allow404: true }
  );
  return cachedRelease;
}

async function ensureRelease() {
  const existing = await findRelease();
  if (existing) return existing;

  const release = await githubRequest(`/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: RELEASE_TAG,
      name: 'Telegram Files',
      body: 'Files uploaded from Telegram. Each asset is available at its direct download URL.',
    }),
  });

  cachedRelease = release;
  console.log(`Created GitHub release "${RELEASE_TAG}" (id ${release.id})`);
  return release;
}

async function uploadAsset(releaseId, desiredName, buffer) {
  let attempt = 0;

  while (attempt <= 5) {
    const assetName = attempt === 0 ? desiredName : addSuffix(desiredName, attempt);

    const response = await fetch(
      `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${GITHUB_TOKEN}`,
          'content-type': 'application/octet-stream',
          'user-agent': 'telegram-github-bot',
        },
        body: buffer,
        signal: AbortSignal.timeout(180000),
      }
    );

    const text = await response.text();

    if (response.ok) {
      return JSON.parse(text);
    }

    if (response.status === 422 && /already_exists/i.test(text) && attempt < 5) {
      attempt += 1;
      continue;
    }

    throw new Error(
      `GitHub asset upload failed (${response.status}): ${text.slice(0, 300)}`
    );
  }

  throw new Error('Could not find a unique asset name on GitHub.');
}

function addSuffix(name, suffix) {
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    return `${name.slice(0, dot)}-${suffix}${name.slice(dot)}`;
  }
  return `${name}-${suffix}`;
}

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------

function extractFile(message) {
  if (message.document) {
    return {
      fileId: message.document.file_id,
      name: message.document.file_name || `document-${message.message_id}`,
      size: message.document.file_size,
    };
  }

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return {
      fileId: largest.file_id,
      name: `photo-${message.message_id}.jpg`,
      size: largest.file_size,
    };
  }

  if (message.video) {
    return {
      fileId: message.video.file_id,
      name: message.video.file_name || `video-${message.message_id}.mp4`,
      size: message.video.file_size,
    };
  }

  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      name: message.audio.file_name || `audio-${message.message_id}.mp3`,
      size: message.audio.file_size,
    };
  }

  if (message.voice) {
    return {
      fileId: message.voice.file_id,
      name: `voice-${message.message_id}.ogg`,
      size: message.voice.file_size,
    };
  }

  if (message.animation) {
    return {
      fileId: message.animation.file_id,
      name: message.animation.file_name || `animation-${message.message_id}.mp4`,
      size: message.animation.file_size,
    };
  }

  if (message.video_note) {
    return {
      fileId: message.video_note.file_id,
      name: `video-note-${message.message_id}.mp4`,
      size: message.video_note.file_size,
    };
  }

  if (message.sticker) {
    const extension = message.sticker.is_animated
      ? 'tgs'
      : message.sticker.is_video
        ? 'webm'
        : 'webp';
    return {
      fileId: message.sticker.file_id,
      name: `sticker-${message.message_id}.${extension}`,
      size: message.sticker.file_size,
    };
  }

  return null;
}

function safeName(name) {
  let base = String(name || 'file').replace(/^.*[\\/]/, '');
  base = base
    .replace(/[^\w.\-()+@ ]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+/, '');

  if (!base) base = 'file';

  const dot = base.lastIndexOf('.');
  let stem = dot > 0 ? base.slice(0, dot) : base;
  let extension = dot > 0 ? base.slice(dot) : '';

  stem = stem.slice(0, 80) || 'file';
  if (extension.length > 12) {
    stem = `${stem}${extension}`.slice(0, 80);
    extension = '';
  }

  return `${stem}${extension.toLowerCase()}`;
}

function buildAssetName(originalName, messageId) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const timestamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
  ].join('') + `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;

  return `${timestamp}-${messageId}-${safeName(originalName)}`;
}

// ---------------------------------------------------------------------------
// Commands and updates
// ---------------------------------------------------------------------------

function isAllowed(userId) {
  return ALLOWED_IDS.has(Number(userId));
}

async function sendDenied(chatId, userId, replyToMessageId) {
  const text =
    ALLOWED_IDS.size === 0
      ? [
          '🔒 This bot is not configured yet.',
          '',
          `Your Telegram user ID is <code>${userId}</code>.`,
          'Ask the owner to add it as the <code>ALLOWED_USER_IDS</code> repository variable, then send the file again.',
        ].join('\n')
      : [
          '🔒 You are not allowed to use this bot.',
          '',
          `Your Telegram user ID: <code>${userId}</code>`,
        ].join('\n');

  await sendMessage(chatId, text, replyToMessageId);
}

async function handleStart(message) {
  const name = message.from.first_name || message.from.username || 'there';
  const text = [
    `👋 Hi ${escapeHtml(name)}!`,
    '',
    'Send me any file — document, photo, video, audio, voice, animation or sticker — and I will upload it to GitHub and reply with a direct download link.',
    '',
    `Your Telegram user ID: <code>${message.from.id}</code>`,
    '',
    '<b>Commands</b>',
    '/help — show this message',
    '/id — show your Telegram user ID',
    '/last — list the 10 most recent files',
    '',
    '⚠️ Telegram bots can download files up to 20 MB.',
  ].join('\n');

  await sendMessage(message.chat.id, text, message.message_id);
}

async function handleLast(message) {
  const release = await findRelease();
  if (!release) {
    await sendMessage(message.chat.id, '📂 No files have been uploaded yet.', message.message_id);
    return;
  }

  const assets = await githubRequest(
    `/repos/${REPO}/releases/${release.id}/assets?per_page=100`
  );

  if (!assets || assets.length === 0) {
    await sendMessage(message.chat.id, '📂 No files have been uploaded yet.', message.message_id);
    return;
  }

  const lines = assets
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 10)
    .map(
      (asset, index) =>
        `${index + 1}. <a href="${escapeHtml(asset.browser_download_url)}">${escapeHtml(asset.name)}</a> (${formatBytes(asset.size)})`
    );

  await sendMessage(
    message.chat.id,
    `📂 <b>Recent files</b>\n\n${lines.join('\n')}`,
    message.message_id
  );
}

async function handleCommand(message, command) {
  if (command === '/start' || command === '/help') {
    await handleStart(message);
    return;
  }

  if (command === '/id') {
    await sendMessage(
      message.chat.id,
      `Your Telegram user ID: <code>${message.from.id}</code>`,
      message.message_id
    );
    return;
  }

  if (!isAllowed(message.from.id)) {
    await sendDenied(message.chat.id, message.from.id, message.message_id);
    return;
  }

  if (command === '/last') {
    await handleLast(message);
    return;
  }

  await sendMessage(message.chat.id, 'Unknown command. Try /help.', message.message_id);
}

async function handleFile(message, file) {
  if (!isAllowed(message.from.id)) {
    await sendDenied(message.chat.id, message.from.id, message.message_id);
    return;
  }

  const acknowledgement = await sendMessage(
    message.chat.id,
    `⏳ Uploading <b>${escapeHtml(file.name)}</b> to GitHub…`,
    message.message_id
  );

  try {
    if (file.size && file.size > MAX_TELEGRAM_BYTES) {
      throw new Error(
        `This file is ${formatBytes(file.size)}, but Telegram bots can only download files up to 20 MB.`
      );
    }

    const buffer = await downloadTelegramFile(file.fileId);

    if (buffer.length > MAX_TELEGRAM_BYTES) {
      throw new Error('The downloaded file is larger than the 20 MB Telegram bot limit.');
    }

    const release = await ensureRelease();
    const asset = await uploadAsset(
      release.id,
      buildAssetName(file.name, message.message_id),
      buffer
    );

    const link = asset.browser_download_url;
    const text = [
      '✅ <b>Uploaded to GitHub</b>',
      '',
      `<b>${escapeHtml(asset.name)}</b> (${formatBytes(asset.size)})`,
      '',
      `<code>${escapeHtml(link)}</code>`,
    ].join('\n');

    await editMessage(message.chat.id, acknowledgement.message_id, text);
    console.log(`Uploaded ${asset.name} (${asset.size} bytes) -> ${link}`);
  } catch (error) {
    console.error('Upload failed:', error);
    await editMessage(
      message.chat.id,
      acknowledgement.message_id,
      `❌ <b>Upload failed</b>\n\n${escapeHtml(error.message)}`
    );
  }
}

async function handleUpdate(update) {
  const message = update.message || update.channel_post;

  if (!message || !message.from || message.from.is_bot) return;

  const file = extractFile(message);
  if (file) {
    await handleFile(message, file);
    return;
  }

  const text = (message.text || '').trim();

  if (text.startsWith('/')) {
    const command = text.split(/[\s@]/)[0].toLowerCase();
    await handleCommand(message, command);
    return;
  }

  if (message.chat.type === 'private' && isAllowed(message.from.id)) {
    await sendMessage(
      message.chat.id,
      '📎 Send me a file and I will turn it into a GitHub direct link. Try /help for details.',
      message.message_id
    );
  }
}

// ---------------------------------------------------------------------------
// Main polling loop
// ---------------------------------------------------------------------------

async function run() {
  const deadline = Date.now() + RUN_MINUTES * 60 * 1000;
  const state = loadState();
  let offset = Number(state.offset) || 0;

  console.log(
    `Bot started for ${REPO}; release="${RELEASE_TAG}"; offset=${offset}; ` +
      `window=${RUN_MINUTES}min; allowlist=${
        ALLOWED_IDS.size > 0 ? [...ALLOWED_IDS].join(',') : 'EMPTY (bootstrap mode)'
      }`
  );

  while (Date.now() < deadline) {
    let updates;

    try {
      updates = await telegram('getUpdates', {
        offset,
        timeout: 20,
        allowed_updates: ['message', 'channel_post'],
      });
    } catch (error) {
      console.error('getUpdates error:', error.message);
      await sleep(5000);
      continue;
    }

    if (!Array.isArray(updates) || updates.length === 0) continue;

    console.log(`Received ${updates.length} update(s)`);

    for (const update of updates) {
      offset = update.update_id + 1;

      try {
        await handleUpdate(update);
      } catch (error) {
        console.error(`Update ${update.update_id} failed:`, error);
      }

      state.offset = offset;
      saveState(state);
    }
  }

  console.log(`Run window ended at offset ${offset}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
