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
    max_tokens: 1500,
    system: `You are BugBot for Everfit. Analyze a Slack thread and extract a structured bug report. Return ONLY valid JSON, no markdown fences.

Schema:
{
  "summary": "Title in this exact format: [Client Report][Platform][Feature] Short description. Rules: Include 'Client Report' only if reported by a client or coach. Platform must be exactly one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach — detect from context. Feature = affected feature e.g. Workout, Forum, Notification, Login, Payment.",
  "type": "Bug" or "Task",
  "priority": "High" or "Medium" or "Low",
  "platform": "exactly one of: Web, API, iOS Client, iOS Coach, Android Client, Android Coach",
  "description": "Format with a blank line between each section. Order strictly as follows:\n\nSlack thread: ${slackThreadUrl}\n\nReported by: <name or email>\n\nIntercom link: <URL if found in thread, else omit this line entirely>\n\nAffected area: <feature/screen>\n\nSteps to reproduce:\n1. <step>\n2. <step>\n\nExpected behavior:\n- <expected>\n\nActual behavior:\n- <actual>\n\nNote: <something useful e.g. missing info, investigation needed, reproduction unclear — or write N/A if nothing meaningful to add>",
  "assignee_names": ["Full Name — only clearly intended assignees: look for 'assign to X', 'nhờ X check', 'X handle this'. Empty array if unclear."]
}

Priority: High = crash/data loss/payment, Medium = broken feature, Low = cosmetic/typo`,
    messages: [{ role: 'user', content: `Thread:\n\n${context}` }],
  });

  const raw = res.content[0].text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    return {
      summary:        context.substring(0, 80),
      type:           'Bug',
      priority:       'Medium',
      platform:       null,
      description:    `${context}\n\nSlack thread: ${slackThreadUrl}`,
      assignee_names: [],
    };
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

    const ticket = await analyzeThread(context, slackThreadUrl);
    logger.info(`[BugBot] Platform: ${ticket.platform} → Parent: ${PLATFORM_PARENTS[ticket.platform] || 'none'}`);
    logger.info(`[BugBot] Assignees from Claude: ${JSON.stringify(ticket.assignee_names)}`);

    // Priority 1: @mentions in the bot trigger message itself (most explicit)
    const triggerMentions = (event.text.match(/<@([A-Z0-9]+)>/g) || [])
      .map(m => m.replace(/<@|>/g, ''))
      .filter(id => id !== botUserId);

    let assigneeSlackIds;
    if (triggerMentions.length > 0) {
      // Someone was directly @mentioned with the bot — use them as assignee
      assigneeSlackIds = triggerMentions;
      logger.info(`[BugBot] Using direct mentions from trigger: ${triggerMentions.join(', ')}`);
    } else {
      // Fall back to Claude's name detection from thread context
      assigneeSlackIds = (
        await Promise.all((ticket.assignee_names || []).map(name => findSlackUserByName(client, name)))
      ).filter(Boolean);
      logger.info(`[BugBot] Using Claude name detection: ${assigneeSlackIds.join(', ')}`);
    }

    const jiraIds = (
      await Promise.all(assigneeSlackIds.map(id => resolveJiraAccountId(client, id)))
    ).filter(Boolean);

    const jira = await createJiraIssue(ticket, jiraIds);

    // Add to active sprint
    const sprintId = await getActiveSprintId();
    if (sprintId) {
      await addIssueToSprint(jira.key, sprintId);
      logger.info(`[BugBot] Added ${jira.key} to sprint ${sprintId}`);
    }

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
