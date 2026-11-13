# Telegram → GitHub File Bot

Send a file to a Telegram bot and get back a **direct GitHub download link**.

Files are stored as assets on a GitHub Release, so links look like:

```
https://github.com/<owner>/<repo>/releases/download/telegram-files/<file>
```

The bot runs entirely on **GitHub Actions** — no server, no VPS, no database.

## How it works

```
Telegram user
    │  sends a document / photo / video / audio
    ▼
Telegram Bot API  ──getUpdates──►  GitHub Actions (every 5 min)
                                        │
                                        │ downloads the file (max 20 MB)
                                        ▼
                                  GitHub Release "telegram-files"
                                        │
                                        │ uploads asset
                                        ▼
                                  Direct download URL ──► reply in Telegram
```

## Setup

### 1. Create the bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts.
3. Copy the **HTTP API token**.

### 2. Add the token to this repository

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**

- Name: `TELEGRAM_BOT_TOKEN`
- Value: the token from BotFather

Or with the GitHub CLI:

```bash
gh secret set TELEGRAM_BOT_TOKEN
```

### 3. Run the bot once

Go to **Actions → Telegram → GitHub file bot → Run workflow**, or:

```bash
gh workflow run telegram-bot.yml
```

### 4. Allow yourself

1. Send `/start` to your bot in Telegram.
2. It replies with your numeric **Telegram user ID** (the bot is locked until an allowlist is configured).
3. Add that ID as a repository **variable**:

   **Settings → Secrets and variables → Actions → Variables → New repository variable**

   - Name: `ALLOWED_USER_IDS`
   - Value: your numeric ID, e.g. `123456789`

   Multiple IDs can be separated by commas.

   Or:

   ```bash
   gh variable set ALLOWED_USER_IDS --body "123456789"
   ```

### 5. Send a file

Send any supported file to the bot. Within a few minutes it replies with the direct link.

Use **Run workflow** any time you want an immediate poll instead of waiting for the schedule.

## Commands

| Command | Description |
| --- | --- |
| `/start`, `/help` | Show instructions and your user ID |
| `/id` | Show your Telegram user ID |
| `/last` | List the 10 most recently uploaded files |

## Supported files

Documents, photos, video, audio, voice messages, animations, video notes and stickers.

**Limits:**

- Telegram bots can download files up to **20 MB** (Bot API limit). Larger files require a self-hosted Bot API server.
- GitHub release assets can be up to 2 GB, but the Telegram limit applies first.
- GitHub Actions scheduled workflows run at most every 5 minutes and may be delayed under load, so replies can take several minutes.
- Scheduled workflows are disabled automatically after 60 days without repository activity. Re-enable the workflow if that happens.

## Notes

- The repository must stay **public** for the download links to work for anyone.
- Only users listed in `ALLOWED_USER_IDS` can upload files. If the variable is empty, the bot only tells people their ID.
- `TELEGRAM_BOT_TOKEN` is stored as an encrypted Actions secret and is never written to the repository.
- The bot stores its polling offset in `.bot-state.json`; the workflow commits that file after each batch of processed updates.
- All uploaded files share one release tagged `telegram-files`. Asset names are prefixed with a UTC timestamp and the Telegram message ID to stay unique.

## Files

```
bot.js                                  the bot (Node.js 20, no dependencies)
.github/workflows/telegram-bot.yml      the scheduled workflow
.bot-state.json                         polling offset (created at runtime)
```
