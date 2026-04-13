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

async function getThread(client, channelId, threadTs) {
  const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
  const messages = result.messages || [];

  // Build readable thread with real names
  const lines = await Promise.all(messages.map(async msg => {
    let name = msg.username || msg.user || 'user';
    try {
      const info = await client.users.info({ user: msg.user });
      name = info.user?.real_name || name;
    } catch (_) {}
    const text = (msg.text || '').replace(/<@([A-Z0-9]+)>/g, (match, uid) => `@${uid}`);
    return `[${name}]: ${text}`;
  }));

  return { messages, context: lines.join('\n') };
}

async function analyzeThread(context) {
  // Ask Claude to extract bug AND determine the correct assignee from intent
  const res = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: `You are BugBot for Everfit. Analyze a Slack thread and extract the bug report AND determine who should be assigned.

For the assignee: look for explicit assignment signals like "assign to @X", "nhờ @X check", "@X handle this", or the most recent person agreed to investigate. 
- If someone explicitly says "assign to @X" or "assign this to @X" → that person is the assignee
- If the thread concludes that a specific team (mobile/iOS/BE) should handle it → pick the person from that team mentioned last
- Do NOT pick everyone mentioned — pick only the intended assignee(s)
- Return an empty array if no clear assignee

Return ONLY valid JSON, no markdown fences:
{
  "summary": "concise Jira title max 80 chars",
  "type": "Bug" or "Task",
  "priority": "High" or "Medium" or "Low",
  "description": "plain text: Reported by / Affected area / Steps to reproduce / Expected / Actual / Environment / Intercom link",
  "assignee_names": ["Full Name as mentioned in thread"] 
}

Priority: High = crash/data loss/payment, Medium = broken feature, Low = cosmetic/typo`,
    messages: [{ role: 'user', content: `Analyze this Slack thread:\n\n${context}` }],
  });

  const raw = res.content[0].text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); }
  catch { return { summary: context.substring(0, 80), type: 'Bug', priority: 'Medium', description: context, assignee_names: [] }; }
}

// Find Slack user ID by matching name
async function findSlackUserByName(client, name) {
  try {
    const res = await client.users.list({ limit: 200 });
    const users = res.members || [];
    const nameLower = name.toLowerCase();
    const match = users.find(u =>
      (u.real_name || '').toLowerCase().includes(nameLower) ||
      (u.profile?.display_name || '').toLowerCase().includes(nameLower) ||
      (u.name || '').toLowerCase().includes(nameLower)
    );
    return match?.id ?? null;
  } catch { return null; }
}

async function createJiraIssue(ticket, jiraAccountIds) {
  const fields = {
    project:   { key: JIRA_PROJECT },
    summary:   ticket.summary,
    issuetype: { name: ticket.type === 'Task' ? 'Task' : 'Bug' },
    priority:  { name: ticket.priority },
    description: {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: ticket.description || '' }] }]
    }
  };
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
    const threadTs = event.thread_ts || event.ts;
    let context;

    if (event.thread_ts) {
      logger.info('[BugBot] Reading thread');
      const { context: threadContext } = await getThread(client, event.channel, event.thread_ts);
      context = threadContext;
    } else {
      context = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      logger.info('[BugBot] Standalone message');
    }

    if (!context || context.trim().length < 10) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts,
        text: '👋 Tag me *inside a bug thread* — I\'ll read the whole conversation and figure out the bug and assignee automatically!',
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // Claude analyzes thread → extracts bug + determines correct assignee
    const ticket = await analyzeThread(context);
    logger.info(`[BugBot] Assignee names from Claude: ${JSON.stringify(ticket.assignee_names)}`);

    // Resolve assignee names → Slack IDs → Jira IDs
    const assigneeSlackIds = (
      await Promise.all((ticket.assignee_names || []).map(name => findSlackUserByName(client, name)))
    ).filter(Boolean);

    const jiraIds = (
      await Promise.all(assigneeSlackIds.map(id => resolveJiraAccountId(client, id)))
    ).filter(Boolean);

    const jira = await createJiraIssue(ticket, jiraIds);
    logger.info(`[BugBot] Created ${jira.key}, assignees: ${assigneeSlackIds.join(', ') || 'none'}`);

    const assigneeLine = assigneeSlackIds.length > 0
      ? `Assigned to ${assigneeSlackIds.map(id => `<@${id}>`).join(', ')} — please take a look!`
      : '_No assignee detected — please assign in Jira._';

    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text:
        `🐛 *Bug logged!* → <${jira.url}|${jira.key}>\n` +
        `*${ticket.summary}*\n` +
        `Priority: *${ticket.priority}*  ·  Type: *${ticket.type}*\n\n` +
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
