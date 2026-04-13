# BugBot — Everfit

Tag `@bug-reporting-tracker` + the assignee(s) anywhere in your message. BugBot parses the bug, creates a Jira ticket in project **UP**, assigns it to whoever was tagged, and replies in-thread.

---

## Usage

```
@bug-reporting-tracker @DucTrinh coach paul@plt... reports forum tab disappearing
randomly and app crashes on notification click. Intercom: https://app.intercom.com/...
```

**Multiple assignees** — Jira gets the first one as assignee, all are tagged in the Slack reply:
```
@bug-reporting-tracker @DucTrinh @BaoHo app crashes on iOS notification tap
```

**No assignee** — ticket is created unassigned:
```
@bug-reporting-tracker login screen freezes after wrong password on Android
```

---

## How it works

```
@bug-reporting-tracker @SomePerson [bug description]
         │
         ├─ extract @SomePerson mentions (excluding bot)
         ├─ look up their Slack email → find matching Jira account
         │
         ▼
   Claude parses text → summary / type / priority / labels / description
         │
         ▼
   Jira REST API → creates UP-XXXXX, assigns to resolved Jira user
         │
         ▼
   Slack reply → "🐛 Bug logged → UP-XXXXX · Assigned to @SomePerson"
```

---

## Setup (~15 min)

### 1. Create the Slack App

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name: `bug-reporting-tracker`, pick your Everfit workspace
3. **OAuth & Permissions → Bot Token Scopes**:
   - `app_mentions:read`
   - `chat:write`
   - `reactions:write`
   - `users:read`
   - `users:read.email`  ← needed to map Slack → Jira by email
   - `channels:history` or `groups:history` (depending on channel type)
4. **Install to workspace** → copy `xoxb-...` Bot Token
5. **Basic Information → Signing Secret** → copy it
6. **Event Subscriptions → Enable**, set Request URL to `https://YOUR_DOMAIN/slack/events`
7. Subscribe to bot event: `app_mention`
8. Reinstall the app after saving

### 2. Jira API Token

[id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) → Create token → copy it.

### 3. Environment

```bash
cp .env.example .env
# Fill in all five values
```

### 4. Run locally

```bash
npm install
npm start
```

For local testing, expose port 3000 with [ngrok](https://ngrok.com):
```bash
ngrok http 3000
# Use the https://xxxx.ngrok.io/slack/events URL in Slack app settings
```

---

## Deploy to Railway (recommended, free tier)

```bash
npm install -g @railway/cli
railway login
railway init
railway up

# Set env vars:
railway variables set SLACK_BOT_TOKEN=xoxb-...
railway variables set SLACK_SIGNING_SECRET=...
railway variables set ANTHROPIC_API_KEY=...
railway variables set JIRA_EMAIL=your@everfit.io
railway variables set JIRA_API_TOKEN=...
```

Point Slack Event Subscriptions to: `https://your-app.railway.app/slack/events`

---

## Invite to channel

```
/invite @bug-reporting-tracker
```

---

## Assignee resolution

BugBot maps Slack users → Jira accounts via **email**. This works automatically as long as team members use the same email in both Slack and Atlassian. If a user can't be resolved (e.g. different emails), the ticket is created unassigned and the note says so.
