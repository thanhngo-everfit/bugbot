require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const JIRA_HOST    = 'https://everfit.atlassian.net';
const JIRA_PROJECT = 'UP';

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

function extractMentions(text, excludeUserId) {
  const ids = [], re = /<@([A-Z0-9]+)>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== excludeUserId) ids.push(m[1]);
  }
  return [...new Set(ids)];
}

async function getThreadContext(client, channelId, threadTs) {
  try {
    const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
    return result.messages.map(msg => `[${msg.username || msg.user || 'user'}]: ${msg.text || ''}`).join('\n');
  } catch { return null; }
}

async function parseBugReport(context) {
  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: `You are BugBot for Everfit. Extract the bug from the Slack thread and return ONLY valid JSON, no markdown fences.

Schema:
{
  "summary": "concise Jira title max 80 chars",
  "type": "Bug" or "Task",
  "priority": "High" or "Medium" or "Low",
  "labels": ["snake_case_labels"],
  "description": "plain text description with sections: Reported by / Affected area / Steps to reproduce / Expected / Actual / Environment / Intercom link"
}`,
    messages: [{ role: 'user', content: `Extract bug from this thread:\n\n${context}` }],
  });
  const raw = res.content[0].text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); }
  catch { return { summary: context.substring(0, 80), type: 'Bug', priority: 'Medium', labels: [], description: context }; }
}

async function createJiraIssue(ticket, jiraAccountIds) {
  const fields = {
    project:   { key: JIRA_PROJECT },
    summary:   ticket.summary,
    issuetype: { name: ticket.type === 'Task' ? 'Task' : 'Bug' },
    priority:  { name: ticket.priority },
    // labels disabled for project UP
    description: {
      type: 'doc',
      version: 1,
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: ticket.description || '' }]
      }]
    }
  };
  if (jiraAccountIds.length > 0) fields.assignee = { accountId: jiraAccountIds[0] };

  const res = await axios.post(`${JIRA_HOST}/rest/api/3/issue`, { fields }, {
    headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return { key: res.data.key, url: `${JIRA_HOST}/browse/${res.data.key}` };
}

slackApp.event('app_mention', async ({ event, client, logger }) => {
  const botUserId      = (await client.auth.test()).user_id;
  const mentionedUsers = extractMentions(event.text, botUserId);

  try { await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }); } catch (_) {}

  try {
    const threadTs = event.thread_ts || event.ts;
    let context;

    if (event.thread_ts) {
      context = await getThreadContext(client, event.channel, event.thread_ts);
      logger.info('[BugBot] Reading thread');
    } else {
      context = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      logger.info('[BugBot] Reading message');
    }

    if (!context || context.trim().length < 5) {
      await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: '👋 Tag me inside a bug thread, or write the bug description after mentioning me!' });
      return;
    }

    const jiraIds = (await Promise.all(mentionedUsers.map(id => resolveJiraAccountId(client, id)))).filter(Boolean);
    const ticket  = await parseBugReport(context);
    const jira    = await createJiraIssue(ticket, jiraIds);

    const assigneeLine = mentionedUsers.length > 0
      ? `Assigned to ${mentionedUsers.map(id => `<@${id}>`).join(', ')} — please take a look!`
      : '_No assignee tagged — please assign in Jira._';

    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text: `🐛 *Bug logged!* → <${jira.url}|${jira.key}>\n*${ticket.summary}*\nPriority: *${ticket.priority}*  ·  Type: *${ticket.type}*\n\n${assigneeLine}`,
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
