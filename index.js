require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const JIRA_HOST    = 'https://everfit.atlassian.net';
const JIRA_PROJECT = 'UP';

const PLATFORM_PARENTS = {
  'iOS Client':     'UP-23735',
  'iOS Coach':      'UP-23735',
  'Android Client': 'UP-23734',
  'Android Coach':  'UP-23734',
  'Web':            'UP-23736',
  'API':            'UP-23733',
};

const slackApp = new App({
  token:         process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function jiraAuth() {
  return 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
}

async function resolveJiraAccountId(slackClient, slackUserId) {
  try {
    const info  = await slackClient.users.info({ user: slackUserId });
    const email = info.user?.profile?.email;
    if (!email) return null;
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/user/search`, {
      params:  { query: email, maxResults: 1 },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    return res.data?.[0]?.accountId ?? null;
  } catch { return null; }
}

async function getThread(client, channelId, threadTs) {
  const result   = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
  const messages = result.messages || [];
  const lines    = await Promise.all(messages.map(async msg => {
    let name = msg.username || msg.user || 'user';
    try {
      const info = await client.users.info({ user: msg.user });
      name = info.user?.real_name || name;
    } catch (_) {}
    const text = (msg.text || '').replace(/<@([A-Z0-9]+)>/g, (_, uid) => `@${uid}`);
    return `[${name}]: ${text}`;
  }));
  return lines.join('\n');
}

async function findSlackUserByName(client, name) {
  try {
    const res   = await client.users.list({ limit: 200 });
    const lower = name.toLowerCase();
    const match = (res.members || []).find(u =>
      (u.real_name || '').toLowerCase().includes(lower) ||
      (u.profile?.display_name || '').toLowerCase().includes(lower) ||
      (u.name || '').toLowerCase().includes(lower)
    );
    return match?.id ?? null;
  } catch { return null; }
}

function buildSlackThreadUrl(channelId, threadTs) {
  const ts = threadTs.replace('.', '');
  return `https://everfit.slack.com/archives/${channelId}/p${ts}`;
}

async function analyzeThread(context, slackThreadUrl) {
  const res = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    system: `You are BugBot for Everfit. Analyze a Slack thread and extract a structured bug report. Return ONLY valid JSON, no markdown fences.

Schema:
{
  "summary": "Title in this exact format: [Client Report][Platform][Feature] Short description. Rules: Include 'Client Report' only if reported by a client or coach. Platform must be exactly one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach. Feature = affected feature e.g. Workout, Forum, Notification, Login, Payment.",
  "type": "Bug" or "Task",
  "priority": "High" or "Medium" or "Low",
  "platform": "exactly one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach",
  "description": "plain text with these sections (omit if unknown):\nReported by: <name or email>\nAffected area: <feature/screen>\nSteps to reproduce: <steps>\nExpected behavior: <expected>\nActual behavior: <actual>\nEnvironment: <device, OS, app version>\nIntercom link: <URL if present>\nSlack thread: ${slackThreadUrl}",
  "assignee_names": ["Full Name — only clearly intended assignees: look for assign to X, nho X check, X handle this. Empty array if unclear."]
}

Priority: High = crash/data loss/payment, Medium = broken feature, Low = cosmetic/typo`,
    messages: [{ role: 'user', content: `Thread:\n\n${context}` }],
  });

  const raw = res.content[0].text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    return { summary: context.substring(0, 80), type: 'Bug', priority: 'Medium', platform: null, description: `${context}\n\nSlack thread: ${slackThreadUrl}`, assignee_names: [] };
  }
}

async function createJiraIssue(ticket, jiraAccountIds) {
  const fields = {
    project:   { key: JIRA_PROJECT },
    summary:   ticket.summary,
    issuetype: { name: ticket.type === 'Task' ? 'Task' : 'Bug' },
    priority:  { name: ticket.priority },
    description: {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: ticket.description || '' }] }],
    },
  };

  const parentKey = PLATFORM_PARENTS[ticket.platform];
  if (parentKey) fields.parent = { key: parentKey };
  if (jiraAccountIds.length > 0) fields.assignee = { accountId: jiraAccountIds[0] };

  const res = await axios.post(`${JIRA_HOST}/rest/api/3/issue`, { fields }, {
    headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return { key: res.data.key, url:
cd ~/Documents/bugbot && \
cat > index.js << 'EOF'
require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const JIRA_HOST    = 'https://everfit.atlassian.net';
const JIRA_PROJECT = 'UP';

const PLATFORM_PARENTS = {
  'iOS Client':     'UP-23735',
  'iOS Coach':      'UP-23735',
  'Android Client': 'UP-23734',
  'Android Coach':  'UP-23734',
  'Web':            'UP-23736',
  'API':            'UP-23733',
};

const slackApp = new App({
  token:         process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function jiraAuth() {
  return 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
}

async function resolveJiraAccountId(slackClient, slackUserId) {
  try {
    const info  = await slackClient.users.info({ user: slackUserId });
    const email = info.user?.profile?.email;
    if (!email) return null;
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/user/search`, {
      params:  { query: email, maxResults: 1 },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    return res.data?.[0]?.accountId ?? null;
  } catch { return null; }
}

async function getThread(client, channelId, threadTs) {
  const result   = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
  const messages = result.messages || [];
  const lines    = await Promise.all(messages.map(async msg => {
    let name = msg.username || msg.user || 'user';
    try {
      const info = await client.users.info({ user: msg.user });
      name = info.user?.real_name || name;
    } catch (_) {}
    const text = (msg.text || '').replace(/<@([A-Z0-9]+)>/g, (_, uid) => `@${uid}`);
    return `[${name}]: ${text}`;
  }));
  return lines.join('\n');
}

async function findSlackUserByName(client, name) {
  try {
    const res   = await client.users.list({ limit: 200 });
    const lower = name.toLowerCase();
    const match = (res.members || []).find(u =>
      (u.real_name || '').toLowerCase().includes(lower) ||
      (u.profile?.display_name || '').toLowerCase().includes(lower) ||
      (u.name || '').toLowerCase().includes(lower)
    );
    return match?.id ?? null;
  } catch { return null; }
}

function buildSlackThreadUrl(channelId, threadTs) {
  const ts = threadTs.replace('.', '');
  return `https://everfit.slack.com/archives/${channelId}/p${ts}`;
}

async function analyzeThread(context, slackThreadUrl) {
  const res = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    system: `You are BugBot for Everfit. Analyze a Slack thread and extract a structured bug report. Return ONLY valid JSON, no markdown fences.

Schema:
{
  "summary": "Title in this exact format: [Client Report][Platform][Feature] Short description. Rules: Include 'Client Report' only if reported by a client or coach. Platform must be exactly one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach. Feature = affected feature e.g. Workout, Forum, Notification, Login, Payment.",
  "type": "Bug" or "Task",
  "priority": "High" or "Medium" or "Low",
  "platform": "exactly one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach",
  "description": "plain text with these sections (omit if unknown):\nReported by: <name or email>\nAffected area: <feature/screen>\nSteps to reproduce: <steps>\nExpected behavior: <expected>\nActual behavior: <actual>\nEnvironment: <device, OS, app version>\nIntercom link: <URL if present>\nSlack thread: ${slackThreadUrl}",
  "assignee_names": ["Full Name — only clearly intended assignees: look for assign to X, nho X check, X handle this. Empty array if unclear."]
}

Priority: High = crash/data loss/payment, Medium = broken feature, Low = cosmetic/typo`,
    messages: [{ role: 'user', content: `Thread:\n\n${context}` }],
  });

  const raw = res.content[0].text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    return { summary: context.substring(0, 80), type: 'Bug', priority: 'Medium', platform: null, description: `${context}\n\nSlack thread: ${slackThreadUrl}`, assignee_names: [] };
  }
}

async function createJiraIssue(ticket, jiraAccountIds) {
  const fields = {
    project:   { key: JIRA_PROJECT },
    summary:   ticket.summary,
    issuetype: { name: ticket.type === 'Task' ? 'Task' : 'Bug' },
    priority:  { name: ticket.priority },
    description: {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: ticket.description || '' }] }],
    },
  };

  const parentKey = PLATFORM_PARENTS[ticket.platform];
  if (parentKey) fields.parent = { key: parentKey };
  if (jiraAccountIds.length > 0) fields.assignee = { accountId: jiraAccountIds[0] };

  const res = await axios.post(`${JIRA_HOST}/rest/api/3/issue`, { fields }, {
    headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return { key: res.data.key, url: `${JIRA_HOST}/browse/${res.data.key}` };
}

slackApp.event('app_mention', async ({ event, client, logger }) => {
  const botUserId = (await client.auth.test()).user_id;

  try { await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }); } catch (_) {}

  try {
    const threadTs       = event.thread_ts || event.ts;
    const slackThreadUrl = buildSlackThreadUrl(event.channel, threadTs);
    let context;

    if (event.thread_ts) {
      logger.info('[BugBot] Reading thread');
      context = await getThread(client, event.channel, event.thread_ts);
    } else {
      context = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      logger.info('[BugBot] Standalone message');
    }

    if (!context || context.trim().length < 10) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts,
        text: '👋 Tag me *inside a bug thread* — I will read everything automatically!',
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    const ticket = await analyzeThread(context, slackThreadUrl);
    logger.info(`[BugBot] Platform: ${ticket.platform} → Parent: ${PLATFORM_PARENTS[ticket.platform] || 'none'}`);

    const assigneeSlackIds = (
      await Promise.all((ticket.assignee_names || []).map(name => findSlackUserByName(client, name)))
    ).filter(Boolean);

    const jiraIds = (
      await Promise.all(assigneeSlackIds.map(id => resolveJiraAccountId(client, id)))
    ).filter(Boolean);

    const jira = await createJiraIssue(ticket, jiraIds);

    const parentKey    = PLATFORM_PARENTS[ticket.platform];
    const parentInfo   = parentKey ? ` · <${JIRA_HOST}/browse/${parentKey}|${parentKey}>` : '';
    const assigneeLine = assigneeSlackIds.length > 0
      ? `Assigned to ${assigneeSlackIds.map(id => `<@${id}>`).join(', ')} — please take a look!`
      : '_No assignee detected — please assign in Jira._';

    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text:
        `🐛 *Bug logged!* → <${jira.url}|${jira.key}>${parentInfo}\n` +
        `*${ticket.summary}*\n` +
        `Priority: *${ticket.priority}*  ·  Platform: *${ticket.platform || 'Unknown'}*\n\n` +
        assigneeLine,
    });

    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});

  } catch (err) {
    logger.error('[BugBot]', err.response?.data ?? err.message);
    await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: `❌ BugBot error: \`${err.message}\`` });
    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'x', timestamp: event.ts }).catch(() => {});
  }
});

(async () => {
  await slackApp.start(process.env.PORT || 3000);
  console.log('✅ BugBot running');
})();
