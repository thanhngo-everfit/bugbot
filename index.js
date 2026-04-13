require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const JIRA_HOST    = 'https://everfit.atlassian.net';
const JIRA_PROJECT = 'UP';

// ── Platform → Jira parent ticket ─────────────
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
    max_tokens: 2000,
    system: `You are BugBot for Everfit. Analyze a Slack thread and return a JSON array of tickets to create. Return ONLY valid JSON array, no markdown fences.

HOW TO CLASSIFY:
- Bug: something broken, crashing, not working → type = "Bug"
- Client Request: asking for help, account change, access, feature ask → type = "Task"

WHEN TO CREATE 2 TICKETS:
If the thread reveals BOTH an immediate data fix needed AND a code/system fix needed, create 2 tickets:
1. Data fix task: prefix [Client Report][Platform][Fix data][Feature] — type Task — for fixing the immediate data issue for the client
2. Code fix task: prefix [Client Report][Platform][Feature] — type Task or Bug — for properly fixing the root cause in code/system

Otherwise create just 1 ticket.

TITLE PREFIX RULES:
- Bug/issue reported by client/coach → [Client Report][Platform][Feature]
- Data fix for client issue → [Client Report][Platform][Fix data][Feature]  
- Request from client/coach → [Client Request][Platform][Feature]
- Internal only (no client) → [Platform][Feature]
- Platform = one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach
- Feature = e.g. Login, Workout, Forum, Program sync, Payment, Account

Return an array like:
[
  {
    "summary": "title with correct prefix",
    "type": "Bug" or "Task",
    "priority": "High" or "Medium" or "Low",
    "platform": "one of the platform values",
    "description": "<see templates below>",
    "assignee_names": ["Full Name of intended assignee — look for 'assign to X', 'nhờ X check'. Empty if unclear."]
  }
]

DESCRIPTION TEMPLATE FOR BUG:
Slack thread: ${slackThreadUrl}

Reported by: <coach/client email or name — NOT the CS/SM poster>

Intercom link: <URL if found, else omit>

Affected area: <feature/screen>

Steps to reproduce:
1. <step>
2. <step>

Expected behavior:
- <expected>

Actual behavior:
- <actual>

Note: <useful context or N/A>

DESCRIPTION TEMPLATE FOR TASK/DATA FIX:
Slack thread: ${slackThreadUrl}

Reported by: <coach/client email or name — NOT the CS/SM poster>

Intercom link: <URL if found, else omit>

Request details: <what needs to be done, clearly summarized>

Note: <useful context or N/A>

Priority: High = crash/data loss/payment/urgent, Medium = broken feature/normal request, Low = cosmetic/minor`,
    messages: [{ role: 'user', content: `Thread:\n\n${context}` }],
  });

  const raw = res.content[0].text.replace(/```json|```/g, '').trim();
  try {
    const parsed = JSON.parse(raw);
    // Normalize: always return array
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [{
      summary:        context.substring(0, 80),
      type:           'Bug',
      priority:       'Medium',
      platform:       null,
      description:    `${context}\n\nSlack thread: ${slackThreadUrl}`,
      assignee_names: [],
    }];
  }
}

// Convert a line of text into ADF inline content, making URLs clickable
function lineToAdfContent(line) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = [];
  let last = 0, match;
  while ((match = urlRegex.exec(line)) !== null) {
    if (match.index > last) {
      parts.push({ type: 'text', text: line.slice(last, match.index) });
    }
    parts.push({
      type: 'text',
      text: match[1],
      marks: [{ type: 'link', attrs: { href: match[1] } }],
    });
    last = match.index + match[1].length;
  }
  if (last < line.length) parts.push({ type: 'text', text: line.slice(last) });
  return parts.length > 0 ? parts : [{ type: 'text', text: line }];
}

// Build ADF doc from plain text description, with clickable links
function buildAdfDescription(text) {
  const lines  = (text || '').split('\n');
  const content = [];
  for (const line of lines) {
    if (line.trim() === '') {
      content.push({ type: 'paragraph', content: [] });
    } else {
      content.push({ type: 'paragraph', content: lineToAdfContent(line) });
    }
  }
  return { type: 'doc', version: 1, content };
}

// Fetch the active sprint ID for project UP
async function getActiveSprintId() {
  try {
    // Get boards for the project
    const boardRes = await axios.get(`${JIRA_HOST}/rest/agile/1.0/board`, {
      params:  { projectKeyOrId: JIRA_PROJECT, type: 'scrum' },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    const board = boardRes.data?.values?.[0];
    if (!board) return null;

    // Get active sprint on that board
    const sprintRes = await axios.get(`${JIRA_HOST}/rest/agile/1.0/board/${board.id}/sprint`, {
      params:  { state: 'active' },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    return sprintRes.data?.values?.[0]?.id ?? null;
  } catch (err) {
    console.warn('[BugBot] Could not fetch active sprint:', err.message);
    return null;
  }
}

// Add an issue to a sprint
async function addIssueToSprint(issueKey, sprintId) {
  try {
    await axios.post(
      `${JIRA_HOST}/rest/agile/1.0/sprint/${sprintId}/issue`,
      { issues: [issueKey] },
      { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
  } catch (err) {
    console.warn('[BugBot] Could not add issue to sprint:', err.message);
  }
}

async function createJiraIssue(ticket, jiraAccountIds) {
  const fields = {
    project:     { key: JIRA_PROJECT },
    summary:     ticket.summary,
    issuetype:   { name: ticket.type === 'Task' ? 'Task' : 'Bug' },
    priority:    { name: ticket.priority },
    description: buildAdfDescription(ticket.description),
  };

  // Auto-link to platform parent ticket
  const parentKey = PLATFORM_PARENTS[ticket.platform];
  if (parentKey) fields.parent = { key: parentKey };

  // Auto-assign fix version
  fields.fixVersions = [{ id: '27643' }];

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
        text: '👋 Tag me *inside a bug thread* — I\'ll read everything automatically!',
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    const tickets = await analyzeThread(context, slackThreadUrl);
    logger.info(`[BugBot] ${tickets.length} ticket(s) to create`);

    // Priority 1: @mentions in the bot trigger message (most explicit)
    const triggerMentions = (event.text.match(/<@([A-Z0-9]+)>/g) || [])
      .map(m => m.replace(/<@|>/g, ''))
      .filter(id => id !== botUserId);

    // Fetch active sprint once
    const sprintId = await getActiveSprintId();

    const createdJiras = [];

    for (const ticket of tickets) {
      logger.info(`[BugBot] Creating: ${ticket.summary}`);

      let assigneeSlackIds;
      if (triggerMentions.length > 0) {
        assigneeSlackIds = triggerMentions;
      } else {
        assigneeSlackIds = (
          await Promise.all((ticket.assignee_names || []).map(name => findSlackUserByName(client, name)))
        ).filter(Boolean);
      }

      const jiraIds = (
        await Promise.all(assigneeSlackIds.map(id => resolveJiraAccountId(client, id)))
      ).filter(Boolean);

      const jira = await createJiraIssue(ticket, jiraIds);

      if (sprintId) {
        await addIssueToSprint(jira.key, sprintId);
        logger.info(`[BugBot] Added ${jira.key} to sprint ${sprintId}`);
      }

      createdJiras.push({ jira, ticket, assigneeSlackIds });
    }

    // Build combined Slack reply
    const parentKey  = PLATFORM_PARENTS[createdJiras[0].ticket.platform];
    const parentInfo = parentKey ? ` · <${JIRA_HOST}/browse/${parentKey}|${parentKey}>` : '';
    const lines      = createdJiras.map(({ jira, ticket, assigneeSlackIds }, i) => {
      const assigneeLine = assigneeSlackIds.length > 0
        ? `Assigned to ${assigneeSlackIds.map(id => `<@${id}>`).join(', ')}`
        : '_No assignee — please assign in Jira_';
      const emoji = ticket.summary.includes('Fix data') ? '🔧' : '🐛';
      return `${emoji} <${jira.url}|${jira.key}> *${ticket.summary}*\nPriority: *${ticket.priority}* · ${assigneeLine}`;
    });

    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text:
        `✅ *${createdJiras.length} ticket${createdJiras.length > 1 ? 's' : ''} logged!*${parentInfo}\n\n` +
        lines.join('\n\n'),
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
