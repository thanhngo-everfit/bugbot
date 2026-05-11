# Everfit BugBot

Internal Slack bot for bug triage, Jira ticket creation, and squad routing across Everfit's engineering teams.

## What it does

When tagged in a monitored Slack channel, BugBot:

1. **Analyzes** the thread with Claude Sonnet 4 + knowledge base context
2. **Detects** squad, platform, severity, and recommended assignee automatically
3. **Posts** a structured reply with severity level, SLA, routing, and resolution steps
4. **Creates** Jira ticket(s) with ADF-formatted description, correct parent epic, and sprint
5. **Uploads** any thread attachments to the Jira ticket
6. **Tracks** follow-ups and pings assignees; notifies QA/SM on status changes

## Monitored channels

- `#bug_reporting-internal`
- `#enterprise_bug_reporting_internal`
- `#customer-request-discussion`

## Commands

| Command | What it does |
|---------|-------------|
| `@BugBot` | Suggest next action |
| `@BugBot create card` | Analyze + create Jira ticket |
| `@BugBot assign to @person` | Create and assign |
| `@BugBot reassign to @person [UP-XXXXX]` | Change assignee |
| `@BugBot followup` | Smart status check |
| `@BugBot troubleshoot` | CS troubleshooting steps |
| `@BugBot cancel` | Stop follow-up tracking |

## Severity levels

| Level | Triggers | SLA |
|-------|---------|-----|
| 🔴 Critical | Data loss, outage, security, payment failure | Same-day fix |
| 🟠 High | Core feature broken, no workaround | 1–2 working days |
| 🟡 Medium | Partial break, workaround exists | Current sprint |
| 🟢 Low | Cosmetic, edge case | Backlog |
| ⚪ Trivial | Internal cosmetic only | Next cycle |

## Setup

### 1. Clone and install

```bash
git clone https://github.com/thanhngo-everfit/bugbot.git
cd bugbot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in all values in .env
```

Required variables:

| Variable | Where to get it |
|----------|----------------|
| `SLACK_BOT_TOKEN` | Slack App → OAuth & Permissions |
| `SLACK_SIGNING_SECRET` | Slack App → Basic Information |
| `JIRA_EMAIL` | Your Atlassian email |
| `JIRA_API_TOKEN` | https://id.atlassian.com/manage-profile/security/api-tokens |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys |

### 3. Update channel IDs

In `index.js`, find `MONITORED_CHANNELS` and replace the placeholder keys with real Slack channel IDs:

```js
const MONITORED_CHANNELS = {
  'C0XXXXXXXXX': 'bug_reporting-internal',
  'C0YYYYYYYYY': 'enterprise_bug_reporting_internal',
  'C0ZZZZZZZZZ': 'customer-request-discussion',
};
```

**How to find a channel ID:** Click the channel name in Slack → Details → scroll to bottom.

### 4. Generate knowledge base

```bash
npm run build-kb
# Scans last 12 months of the 3 monitored channels
# Outputs: knowledge-base.md
```

### 5. Start

```bash
# Development
npm run dev

# Production (PM2)
pm2 start index.js --name everfit-bugbot
pm2 save
pm2 startup
```

## Knowledge base

`knowledge-base.md` is the bot's memory. It contains:
- Historical issue patterns by platform and type
- Common resolution steps
- Squad ownership and escalation paths
- Priority decision matrix

**Update weekly:**
```bash
npm run build-kb          # regenerate from Slack history
kill -HUP $(pm2 pid everfit-bugbot)   # hot-reload without restart
```

## Squad roster

Squads and team members are defined directly in `index.js` under `SQUAD_ROSTER`. Update this when team membership changes — no restart needed after a `kill -HUP`.

## Files

| File | Purpose |
|------|---------|
| `index.js` | Main bot — all logic |
| `knowledge-base-builder.js` | Scans Slack history, generates KB |
| `knowledge-base.md` | Auto-generated KB (commit a curated version) |
| `.env.example` | Environment variable template |
