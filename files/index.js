// ─────────────────────────────────────────────
//  BugBot for Everfit
//  Usage  : @bug-reporting-tracker @assignee [bug description]
//  Action : parse → Jira UP (assigned to tagged person) → reply
// ─────────────────────────────────────────────

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
  return 'Basic ' + Buffer.from(
    `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
  ).toString('base64');
}

// ── Slack user ID → Jira account ID ──────────
// Looks up Slack profile email, then finds matching Jira user.
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
  } catch (err) {
    console.warn(`[BugBot] Could not resolve Jira ID for ${slackUserId}:`, err.message);
    return null;
  }
}

// ── Extract @mentioned user IDs from text ─────
function extractMentions(text, excludeUserId) {
  const ids = [];
  const re  = /<@([A-Z0-9]+)>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== excludeUserId) ids.push(m[1]);
  }
  return [...new Set(ids)];
}

// ── Parse bug report with Claude ──────────────
async function parseBugReport(text) {
  const res = await anthropic.messages.create({
    model:      'claude-sonnet-4-5',
    max_tokens: 1024,
    system: `You are BugBot for Everfit. Parse the Slack bug report and return ONLY valid JSON — no markdown fences, no preamble.

Schema:
{
  "summary":     "concise Jira title, max 80 chars",
  "type":        "Bug" | "Task",
  "priority":    "High" | "Medium" | "Low",
  "labels":      ["snake_case_labels"],
  "description": "Markdown with these sections (omit if no data):\\n## Reported by\\n## Affected area\\n## Steps to reproduce\\n## Expected behavior\\n## Actual behavior\\n## Environment / Device\\n## Intercom link"
}

Priority: High = crash/data loss/payment, Medium = broken feature/workflow, Low = cosmetic/typo`,
    messages: [{ role: 'user', content: text }],
  });

  const raw = res.content[0].text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    return { summary: text.substring(0, 80), type: 'Bug', priority: 'Medium', labels: [], description: text };
  }
}

// ── Create Jira issue ─────────────────────────
async function createJiraIssue(ticket, jiraAccountIds) {
  const adfContent = ticket.description.split('\n').map(line => {
    if (line.startsWith('## ')) {
      return { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: line.replace('## ', '') }] };
    }
    return { type: 'paragraph', content: line.trim() ? [{ type: 'text', text: line }] : [] };
  });

  const fields = {
    project:     { key: JIRA_PROJECT },
    summary:     ticket.summary,
    issuetype:   { name: ticket.type === 'Task' ? 'Task' : 'Bug' },
    priority:    { name: ticket.priority },
    labels:      ticket.labels || [],
    description: { type: 'doc', version: 1, content: adfContent },
  };

  // Jira supports one assignee — use the first resolved one
  if (jiraAccountIds.length > 0) {
    fields.assignee = { accountId: jiraAccountIds[0] };
  }

  const res = await axios.post(
    `${JIRA_HOST}/rest/api/3/issue`,
    { fields },
    { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' } }
  );

  return { key: res.data.key, url: `${JIRA_HOST}/browse/${res.data.key}` };
}

// ── Handle @bug-reporting-tracker mention ─────
slackApp.event('app_mention', async ({ event, client, logger }) => {
  const botUserId      = (await client.auth.test()).user_id;
  const mentionedUsers = extractMentions(event.text, botUserId);
  const bugText        = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!bugText) return; // bare ping, ignore

  try {
    await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts });
  } catch (_) {}

  try {
    // Resolve Slack → Jira IDs in parallel
    const jiraIds = (
      await Promise.all(mentionedUsers.map(id => resolveJiraAccountId(client, id)))
    ).filter(Boolean);

    const ticket = await parseBugReport(bugText);
    const jira   = await createJiraIssue(ticket, jiraIds);

    logger.info(`[BugBot] ${jira.key} created — assignees: ${mentionedUsers.join(', ') || 'none'}`);

    const assigneeLine = mentionedUsers.length > 0
      ? `Assigned to ${mentionedUsers.map(id => `<@${id}>`).join(', ')} — please take a look!`
      : '_No assignee tagged — please assign in Jira._';

    await client.chat.postMessage({
      channel:      event.channel,
      thread_ts:    event.ts,
      unfurl_links: false,
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
    await client.chat.postMessage({
      channel: event.channel, thread_ts: event.ts,
      text: `❌ BugBot error: \`${err.message}\``,
    });
    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'x', timestamp: event.ts }).catch(() => {});
  }
});

(async () => {
  await slackApp.start(process.env.PORT || 3000);
  console.log('✅ BugBot running');
})();
