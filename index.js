require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const JIRA_HOST    = 'https://everfit.atlassian.net';
const JIRA_PROJECT = 'UP';

// ── Slack group IDs ───────────────────────────
const GROUP_CS      = 'S04UNE5SW9M';  // @cs
const GROUP_QA      = 'S0120RDU4D9';  // @qa
const GROUP_SM      = 'S066VD6SS0G';  // @sm-team

// ── Never auto-assign these users ─────────────
const ASSIGNEE_BLOCKLIST = new Set([
  'URH99J5QA', // Quang Pham — Head of Engineering, always in cc, never assignee
]);

// ── Follow-up store (in-memory) ───────────────
const followUpStore = new Map();

// ── Platform → Jira parent ticket ─────────────
const PLATFORM_PARENTS = {
  'iOS Client':     'UP-23735',
  'iOS Coach':      'UP-23735',
  'Android Client': 'UP-23734',
  'Android Coach':  'UP-23734',
  'Web':            'UP-23736',
  'API':            'UP-23733',
};

// ── Follow-up store (in-memory) ───────────────

// Vietnam timezone offset: UTC+7
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

function nowVN() {
  return new Date(Date.now() + VN_OFFSET_MS);
}

function isWorkingHours() {
  const vn = nowVN();
  const h  = vn.getUTCHours(); // hours in VN time
  return h >= 9 && h < 18;     // 9am–6pm VN
}

function isBefore6pmVN() {
  const vn = nowVN();
  return vn.getUTCHours() < 18;
}

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

// ── Check if assignee has replied in thread ───
async function assigneeHasReplied(client, channelId, threadTs, assigneeSlackIds, afterTs) {
  try {
    const result   = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
    const messages = result.messages || [];
    return messages.some(msg =>
      assigneeSlackIds.includes(msg.user) &&
      parseFloat(msg.ts) > parseFloat(afterTs)
    );
  } catch { return false; }
}

// ── Get Jira issue status ─────────────────────
async function getJiraStatus(issueKey) {
  try {
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/issue/${issueKey}?fields=status`, {
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    return res.data?.fields?.status?.name ?? null;
  } catch { return null; }
}

// ── Follow-up scheduler (runs every 5 min) ────
function startFollowUpScheduler(client) {
  // Polls Jira every 5 min — only fires on status changes (QA Ready / QA Success)
  // Auto-pinging is disabled: use @bug-reporting-tracker followup to manually follow up
  setInterval(async () => {
    if (followUpStore.size === 0) return;

    for (const [key, item] of followUpStore.entries()) {
      if (item.done) { followUpStore.delete(key); continue; }

      try {
        const status = (await getJiraStatus(item.jiraKey) || '').toLowerCase();

        if (status === 'qa ready') {
          await client.chat.postMessage({
            channel: item.channelId, thread_ts: item.threadTs, unfurl_links: false,
            text:
              `🧪 <${item.jiraUrl}|${item.jiraKey}> is now *QA Ready!*\n` +
              `<!subteam^${GROUP_QA}> please verify when you can.`,
          });
          item.done = true;
          continue;
        }

        if (status === 'qa success') {
          await client.chat.postMessage({
            channel: item.channelId, thread_ts: item.threadTs, unfurl_links: false,
            text:
              `✅ <${item.jiraUrl}|${item.jiraKey}> has passed QA and is ready for Production!\n` +
              `<!subteam^${GROUP_SM}> please confirm to <!subteam^${GROUP_CS}> so they can follow up with the coach/client and close the Intercom ticket.`,
          });
          item.done = true;
          continue;
        }

      } catch (err) {
        console.error(`[BugBot Scheduler] Error for ${item.jiraKey}:`, err.message);
      }
    }
  }, 5 * 60 * 1000); // every 5 minutes
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
    "summary": "MUST follow this format: [Prefix][Platform][Feature] Short description of the issue. The short description after the brackets is REQUIRED — never leave it empty. Example: [Client Request][API][Account] Coach update email from flowpilates74@gmail.com to hollandfit86@gmail.com on Academy account",
    "type": "Bug" or "Task",
    "priority": "High" or "Medium" or "Low",
    "platform": "Detect platform using these rules:\n- API: backend/data fixes, database operations, email/auth system issues, verification, account changes that require backend action, sync issues, queue problems — even if reported via web/app\n- Web: issues visible/reproducible only on the web dashboard UI\n- iOS Coach: issues on the coach-facing iOS app\n- iOS Client: issues on the client-facing iOS app\n- Android Coach: issues on the coach-facing Android app\n- Android Client: issues on the client-facing Android app\nWhen in doubt between Web and API for account/auth/data tasks → choose API",
    "description": "<see templates below>",
    "assignee_names": ["Full Name of the person who should be assigned. Use this priority order to detect:\n1. Explicit assignment: 'assign to X', 'nhờ X check', 'nhờ X fix', '@X handle this', '@X help e cái này', '@X làm cái này', '@X check anh vs'\n2. Acceptance signal: if person X was asked AND later replied 'ok', 'ok e nhé', 'ok a nhé', 'được', 'để a xem', 'a check', 'a làm' → X is assignee\n3. Last person tagged with a task request in the thread\nNEVER assign to: Quang Pham (head of engineering, only appears in cc lines)\nIgnore 'cc' lines entirely — they are FYI only, not assignments\nReturn empty array ONLY if truly no one was asked or agreed to take it"]
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

function lineToAdfContent(line) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = [];
  let last = 0, match;
  while ((match = urlRegex.exec(line)) !== null) {
    if (match.index > last) parts.push({ type: 'text', text: line.slice(last, match.index) });
    parts.push({ type: 'text', text: match[1], marks: [{ type: 'link', attrs: { href: match[1] } }] });
    last = match.index + match[1].length;
  }
  if (last < line.length) parts.push({ type: 'text', text: line.slice(last) });
  return parts.length > 0 ? parts : [{ type: 'text', text: line }];
}

function buildAdfDescription(text) {
  const lines   = (text || '').split('\n');
  const content = [];
  for (const line of lines) {
    if (line.trim() === '') content.push({ type: 'paragraph', content: [] });
    else content.push({ type: 'paragraph', content: lineToAdfContent(line) });
  }
  return { type: 'doc', version: 1, content };
}

async function getActiveSprintId() {
  try {
    const boardRes = await axios.get(`${JIRA_HOST}/rest/agile/1.0/board`, {
      params:  { projectKeyOrId: JIRA_PROJECT, type: 'scrum' },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    const board = boardRes.data?.values?.[0];
    if (!board) return null;
    const sprintRes = await axios.get(`${JIRA_HOST}/rest/agile/1.0/board/${board.id}/sprint`, {
      params:  { state: 'active' },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    return sprintRes.data?.values?.[0]?.id ?? null;
  } catch { return null; }
}

async function addIssueToSprint(issueKey, sprintId) {
  try {
    await axios.post(
      `${JIRA_HOST}/rest/agile/1.0/sprint/${sprintId}/issue`,
      { issues: [issueKey] },
      { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
  } catch (err) { console.warn('[BugBot] Could not add to sprint:', err.message); }
}

async function createJiraIssue(ticket, jiraAccountIds) {
  const fields = {
    project:     { key: JIRA_PROJECT },
    summary:     ticket.summary,
    issuetype:   { name: ticket.type === 'Task' ? 'Task' : 'Bug' },
    priority:    { name: ticket.priority },
    description: buildAdfDescription(ticket.description),
  };

  const parentKey = PLATFORM_PARENTS[ticket.platform];
  if (parentKey) fields.parent = { key: parentKey };
  fields.fixVersions = [{ id: '27643' }];
  if (jiraAccountIds.length > 0) fields.assignee = { accountId: jiraAccountIds[0] };

  const res = await axios.post(`${JIRA_HOST}/rest/api/3/issue`, { fields }, {
    headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return { key: res.data.key, url: `${JIRA_HOST}/browse/${res.data.key}` };
}

slackApp.event('app_mention', async ({ event, client, logger }) => {
  const botUserId   = (await client.auth.test()).user_id;
  const triggerText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim().toLowerCase();

  // ── Strict command detection ──────────────
  const isBare          = triggerText === '';
  const isCreateCard    = triggerText.startsWith('create card') || triggerText.startsWith('create a card') || triggerText.startsWith('create ticket') || triggerText.startsWith('assign to') || triggerText.startsWith('log bug') || triggerText.startsWith('log this');
  const isFollowup      = triggerText.startsWith('followup') || triggerText.startsWith('follow up') || triggerText.startsWith('follow-up') || triggerText.startsWith('check status') || triggerText.startsWith('update');
  const isTroubleshoot  = triggerText.startsWith('troubleshoot') || triggerText.startsWith('trouble shoot') || triggerText.startsWith('how to fix') || triggerText.startsWith('debug');
  const isCancel        = triggerText.startsWith('cancel') || triggerText.startsWith('stop') || triggerText.startsWith('close');
  const isChangeAssignee = triggerText.startsWith('change assignee') || triggerText.startsWith('reassign to') || triggerText.startsWith('reassign') || triggerText.startsWith('assign this to') || triggerText.startsWith('move to');

  const isValidCommand  = isBare || isCreateCard || isFollowup || isTroubleshoot || isCancel || isChangeAssignee;

  try { await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }); } catch (_) {}

  try {
    // ── Invalid command ───────────────────────
    if (!isValidCommand) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.thread_ts || event.ts,
        text:
          `❓ Unknown command. Here's what I can do:\n\n` +
          `• \`@bug-reporting-tracker\` — read the thread and suggest what to do next\n` +
          `• \`@bug-reporting-tracker create card\` — create a Jira ticket from this thread\n` +
          `  _Also: \`create ticket\`, \`log bug\`, \`log this\`_\n` +
          `• \`@bug-reporting-tracker assign to @person\` — create ticket and assign\n` +
          `• \`@bug-reporting-tracker reassign to @person\` — update assignee on existing ticket\n` +
          `  _Also: \`change assignee to @person\`, \`assign this to @person\`, \`move to @person\`_\n` +
          `• \`@bug-reporting-tracker followup\` — smart follow-up: read thread and take next action\n` +
          `  _Also: \`follow up\`, \`check status\`, \`update\`_\n` +
          `• \`@bug-reporting-tracker troubleshoot\` — suggest CS troubleshooting steps\n` +
          `  _Also: \`trouble shoot\`, \`debug\`, \`how to fix\`_\n` +
          `• \`@bug-reporting-tracker cancel\` — stop follow-up tracking\n` +
          `  _Also: \`stop\`, \`close\`_`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'question', timestamp: event.ts }).catch(() => {});
      return;
    }

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

    // ── Bare mention mode — suggest next action ─
    if (isBare) {
      logger.info('[BugBot] Bare mention — suggesting next action');

      // Scan thread for existing BugBot tickets
      const authResBare = await client.auth.test();
      const existingKeysBare = [];
      try {
        const threadResult = await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 50 });
        for (const msg of (threadResult.messages || [])) {
          if (msg.bot_id !== authResBare.bot_id) continue;
          const keyMatches = (msg.text || '').match(/UP-\d+/g) || [];
          existingKeysBare.push(...keyMatches);
        }
      } catch (_) {}

      // Ask Claude to read thread and suggest the best next action
      const suggestion = await anthropic.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: `You are BugBot for Everfit. Read this Slack thread and suggest the single best next action. Be concise — 1-2 sentences max.

Existing Jira tickets in this thread: ${existingKeysBare.length > 0 ? existingKeysBare.join(', ') : 'none'}

Based on the thread, suggest ONE of these actions and explain briefly why:
- "create card" — if this looks like a new bug/task with no ticket yet
- "assign to @person" — if there's no assignee yet and someone should own it  
- "reassign to @person" — if an existing ticket needs a different assignee
- "followup" — if a ticket exists and needs a status check
- "troubleshoot" — if the issue needs CS to try steps before escalating
- "cancel" — if the issue appears resolved

Format: 💡 Suggested: \`@bug-reporting-tracker [command]\` — [1 sentence reason]`,
        messages: [{ role: 'user', content: `Thread:\n\n${context}` }],
      });

      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text: suggestion.content[0].text,
      });

      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'bulb', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ── Change assignee mode ──────────────────
    if (isChangeAssignee) {
      logger.info('[BugBot] Change assignee mode');

      // Extract the new assignee from the message
      const mentionedUsers = (event.text.match(/<@([A-Z0-9]+)>/g) || [])
        .map(m => m.replace(/<@|>/g, ''))
        .filter(id => id !== botUserId && !ASSIGNEE_BLOCKLIST.has(id));

      if (mentionedUsers.length === 0) {
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: '⚠️ Please mention the new assignee: `@bug-reporting-tracker change assignee to @person`',
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      // Find the tracked ticket for this thread
      const tracked = await findOrRegisterTracked(event.channel, threadTs);
      if (!tracked) {
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: '⚠️ No BugBot ticket found in this thread.',
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      // Resolve new assignee Slack → Jira
      const newAssigneeSlackId = mentionedUsers[0];
      const newJiraId = await resolveJiraAccountId(client, newAssigneeSlackId);

      if (!newJiraId) {
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: `⚠️ Could not find Jira account for <@${newAssigneeSlackId}>. Please assign manually in Jira.`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      // Update Jira assignee
      await axios.put(
        `${JIRA_HOST}/rest/api/3/issue/${tracked.jiraKey}/assignee`,
        { accountId: newJiraId },
        { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' } }
      );

      // Update store
      tracked.assigneeSlackIds = [newAssigneeSlackId];

      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs, unfurl_links: false,
        text: `✅ <${tracked.jiraUrl}|${tracked.jiraKey}> reassigned to <@${newAssigneeSlackId}>.`,
      });

      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      return;
    }

    if (!context || context.trim().length < 10) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts,
        text: '👋 Tag me *inside a bug thread* — I\'ll read everything automatically!',
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ── Helper: find or register ticket from thread ──
    async function findOrRegisterTracked(channelId, threadTsVal) {
      // 1. Check store first
      let tracked = [...followUpStore.values()].find(
        item => item.threadTs === threadTsVal && item.channelId === channelId
      );
      if (tracked) return tracked;

      // 2. Not in store — scan thread for a BugBot Jira link (UP-XXXXX)
      try {
        const result   = await client.conversations.replies({ channel: channelId, ts: threadTsVal, limit: 50 });
        const messages = result.messages || [];
        const authRes  = await client.auth.test();
        const botUserId = authRes.user_id;
        const botBotId  = authRes.bot_id;

        let jiraKey = null, jiraUrl = null;

        // Find Jira key from any BugBot message
        for (const msg of messages) {
          if (msg.bot_id !== botBotId && msg.user !== botUserId) continue;
          const match = (msg.text || '').match(/https:\/\/everfit\.atlassian\.net\/browse\/(UP-\d+)/);
          if (match) { jiraKey = match[1]; jiraUrl = `${JIRA_HOST}/browse/${jiraKey}`; break; }
        }
        if (!jiraKey) return null;

        // Find assignee from BugBot message mentions first
        let assigneeSlackIds = [];
        for (const msg of messages) {
          if (msg.bot_id !== botBotId && msg.user !== botUserId) continue;
          if (!(msg.text || '').includes(jiraKey)) continue;
          const mentionMatches = (msg.text || '').match(/<@([A-Z0-9]+)>/g) || [];
          const ids = mentionMatches
            .map(m => m.replace(/<@|>/g, ''))
            .filter(id => id !== botUserId && !ASSIGNEE_BLOCKLIST.has(id));
          if (ids.length > 0) { assigneeSlackIds = ids; break; }
        }

        // If no assignee in bot message, scan human messages for explicit assignment signals
        // Use LAST match — the most recent person asked to handle it
        if (assigneeSlackIds.length === 0) {
          const assignmentPatterns = /nh\u1EDD|help|check|assign|l\u00E0m|fix|gi\u00FAp|xem/i;
          const ccPattern = /^cc\s/i;

          for (const msg of messages) {
            if (msg.bot_id || msg.user === botUserId) continue;
            const text = msg.text || '';
            if (ccPattern.test(text.trim())) continue; // skip cc lines
            if (!assignmentPatterns.test(text)) continue;
            const mentionMatches = text.match(/<@([A-Z0-9]+)>/g) || [];
            const ids = mentionMatches
              .map(m => m.replace(/<@|>/g, ''))
              .filter(id => id !== botUserId && !ASSIGNEE_BLOCKLIST.has(id));
            if (ids.length > 0) assigneeSlackIds = ids; // keep going — use last match
          }
        }

        tracked = {
          channelId, threadTs: threadTsVal,
          assigneeSlackIds, jiraKey, jiraUrl,
          createdAt: Date.now(), lastPingAt: null,
          pingCount: 0, day: 1, day2Pings: 0, done: false,
        };
        followUpStore.set(jiraKey, tracked);
        logger.info(`[BugBot] Auto-registered ${jiraKey} — assignees: ${assigneeSlackIds.join(', ') || 'none'}`);
        return tracked;
      } catch (_) {}
      return null;
    }

    // ── Cancel follow-up mode ─────────────────
    if (isCancel) {
      const tracked = await findOrRegisterTracked(event.channel, threadTs);

      if (!tracked) {
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: '⚠️ No active follow-up found for this thread.',
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      tracked.done = true;
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text: `🛑 Follow-up cancelled for <${tracked.jiraUrl}|${tracked.jiraKey}>. I'll stop pinging — please make sure the ticket is updated in Jira.`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ── Followup mode ─────────────────────────
    if (isFollowup) {
      logger.info('[BugBot] Followup mode');

      // Find or auto-register from thread
      const tracked = await findOrRegisterTracked(event.channel, threadTs);

      if (!tracked) {
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: '⚠️ No BugBot ticket found in this thread. Create a ticket first by tagging me without any keyword.',
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      // Read thread and let Claude assess current state + decide next action
      const assessment = await anthropic.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: `You are BugBot for Everfit. Read this Slack thread about a bug/task ticket and determine the current state. Return ONLY valid JSON, no markdown fences.

Possible states and what to do:
- "acknowledged": assignee replied and acknowledged the ticket, may have given ETA
- "in_progress": assignee is actively working, gave updates
- "blocked": assignee is blocked/waiting on something
- "resolved_by_cs": the CS team resolved it without dev (e.g. user error, config issue)
- "done_by_dev": dev said they fixed/deployed it — needs QA
- "no_response": assignee has not replied at all
- "unclear": thread has activity but status is unclear

IMPORTANT: Never include raw user IDs or @mentions in next_message — the calling code will handle tagging the assignee. Just write the message content without any @mentions.

Return:
{
  "state": "<one of the states above>",
  "summary": "1-2 sentence summary of current situation",
  "eta": "ETA mentioned by assignee, or null",
  "blocker": "what they are blocked on, or null",
  "next_message": "message content only — no @mentions, no user IDs. The assignee will be tagged automatically before this message."
}`,
        messages: [{ role: 'user', content: `Ticket: ${tracked.jiraKey} (${tracked.jiraUrl})\n\nThread:\n\n${context}` }],
      });

      const raw = assessment.content[0].text.replace(/```json|```/g, '').trim();
      let result;
      try { result = JSON.parse(raw); }
      catch { result = { state: 'unclear', next_message: `📋 <${tracked.jiraUrl}|${tracked.jiraKey}> — can someone share the latest status?` }; }

      logger.info(`[BugBot] Followup state: ${result.state}`);

      const assigneeMentions = tracked.assigneeSlackIds.map(id => `<@${id}>`).join(', ');

      // Sanitize Claude's message: convert any raw @USERID to proper <@USERID> Slack mentions
      function sanitizeMentions(text) {
        return (text || '').replace(/@([A-Z0-9]{9,11})\b/g, '<@$1>');
      }

      // Take action based on state
      switch (result.state) {
        case 'done_by_dev':
          // Dev says it's done → remind them to move to QA Ready in Jira
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs, unfurl_links: false,
            text:
              `✅ Looks like ${assigneeMentions} has fixed this!\n` +
              `Please move <${tracked.jiraUrl}|${tracked.jiraKey}> to *QA Ready* in Jira so <!subteam^${GROUP_QA}> can verify.`,
          });
          // Reset ping count — scheduler will detect QA Ready and fire next step
          tracked.pingCount = 0;
          tracked.lastPingAt = Date.now();
          break;

        case 'resolved_by_cs':
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs,
            text: `✅ Issue resolved at CS level. Closing follow-up for <${tracked.jiraUrl}|${tracked.jiraKey}>.`,
          });
          tracked.done = true;
          break;

        case 'blocked':
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs,
            text:
              `⚠️ ${assigneeMentions} is blocked on <${tracked.jiraUrl}|${tracked.jiraKey}>.\n` +
              `*Blocker:* ${result.blocker || 'see thread above'}\n` +
              `<!subteam^${GROUP_CS}> <!subteam^${GROUP_SM}> — can someone help unblock this?`,
          });
          tracked.lastPingAt = Date.now();
          break;

        case 'acknowledged':
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs,
            text:
              `👍 ${assigneeMentions} has acknowledged <${tracked.jiraUrl}|${tracked.jiraKey}>.\n` +
              (result.eta ? `*ETA:* ${result.eta}\n` : '') +
              `<!subteam^${GROUP_CS}> will follow up once it moves to QA Ready.`,
          });
          tracked.pingCount  = 0;
          tracked.lastPingAt = Date.now();
          break;

        default:
          // no_response, in_progress, unclear → prepend proper mention + sanitized Claude message
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs,
            text: `${assigneeMentions} ${sanitizeMentions(result.next_message)}`,
          });
          tracked.lastPingAt = Date.now();
      }

      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'eyes', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ── Troubleshoot mode ─────────────────────
    if (isTroubleshoot) {
      logger.info('[BugBot] Troubleshoot mode');
      const res = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 1000,
        system: `You are BugBot for Everfit, a B2B fitness coaching platform. Based on the Slack thread, suggest practical troubleshooting steps for the *Customer Support (CS) team* to try with the coach or client before escalating to the dev team.

The CS team are non-technical — steps should be clear, actionable, and not require code or system access. Focus on what they can verify in Intercom, ask the coach/client to do, or check in the Everfit dashboard.

PLATFORM-SPECIFIC GUIDANCE:

iOS / Android (Coach or Client app):
- Ask coach/client for: app version, iOS/Android OS version
- Ask them to: force close & reopen, restart device, log out/in, uninstall & reinstall
- Ask CS to: check Intercom for recent account changes, confirm account is active
- Check: does issue affect only this account or others too?
- Collect for escalation: screen recording of the issue, device model, OS version

Web (Dashboard):
- Ask coach to: try Chrome incognito, clear cache & cookies, try another browser
- Ask CS to: check if issue is account-specific or affects all coaches
- Collect for escalation: screenshot with URL visible, browser version

API / Backend / Data issues:
- Ask CS to: confirm exact account email, check Intercom conversation history for recent changes
- Verify: what action triggered the issue, exact time it occurred
- Collect for escalation: account email, user ID, exact timestamp, action performed, expected vs actual result

Account / Auth issues:
- Ask CS to: confirm login method (email/Google/Apple), check if email is verified in Intercom
- Ask coach to: try password reset, try logging in from web if mobile fails
- Collect for escalation: login method, error message, account email

Format exactly like this:
🔍 *Troubleshooting suggestions* — [Platform detected]

*What CS should check first:*
1. <specific check>
2. <another check>

*Ask the coach/client to try:*
1. <clear step>
2. <another step>

*If still not resolved — collect this info before escalating:*
- <data point>
- <data point>

Max 8 steps total. English only.`,
        messages: [{ role: 'user', content: `Slack thread:\n\n${context}` }],
      });

      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text: `<!subteam^${GROUP_CS}> here are some troubleshooting steps to try before escalating:\n\n${res.content[0].text}`,
      });

      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'mag', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ── Normal ticket creation mode ───────────
    const tickets  = await analyzeThread(context, slackThreadUrl);
    logger.info(`[BugBot] ${tickets.length} ticket(s) to create`);

    // Scan thread for tickets already created by BugBot
    const existingKeys = [];
    const existingSummaries = [];
    const authRes2 = await client.auth.test();
    try {
      const threadResult = await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 50 });
      for (const msg of (threadResult.messages || [])) {
        if (msg.bot_id !== authRes2.bot_id) continue;
        const keyMatches = (msg.text || '').match(/UP-\d+/g) || [];
        existingKeys.push(...keyMatches);
        const summaryMatch = (msg.text || '').match(/\*(.+?)\*/);
        if (summaryMatch) existingSummaries.push(summaryMatch[1].toLowerCase());
      }
    } catch (_) {}

    // ── If "assign to @X" and existing ticket found → just update assignee ──
    if (triggerText.startsWith('assign to') && existingKeys.length > 0) {
      const newAssigneeIds = (event.text.match(/<@([A-Z0-9]+)>/g) || [])
        .map(m => m.replace(/<@|>/g, ''))
        .filter(id => id !== botUserId && !ASSIGNEE_BLOCKLIST.has(id));

      if (newAssigneeIds.length > 0) {
        const targetKey = existingKeys[0]; // use most recent existing ticket
        const targetUrl = `${JIRA_HOST}/browse/${targetKey}`;
        const newJiraId = await resolveJiraAccountId(client, newAssigneeIds[0]);

        if (newJiraId) {
          await axios.put(
            `${JIRA_HOST}/rest/api/3/issue/${targetKey}/assignee`,
            { accountId: newJiraId },
            { headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' } }
          );

          // Update store if tracked
          const tracked = followUpStore.get(targetKey);
          if (tracked) tracked.assigneeSlackIds = [newAssigneeIds[0]];

          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs, unfurl_links: false,
            text: `✅ <${targetUrl}|${targetKey}> reassigned to <@${newAssigneeIds[0]}>.`,
          });
        } else {
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs,
            text: `⚠️ Could not find Jira account for <@${newAssigneeIds[0]}>. Please assign manually in Jira.`,
          });
        }

        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
        return;
      }
    }

    // Filter out tickets whose summary is too similar to an existing one
    const newTickets = tickets.filter(ticket => {
      const summary = ticket.summary.toLowerCase();
      const isDupe = existingSummaries.some(existing => {
        const existingWords = new Set(existing.split(/\s+/).filter(w => w.length > 4));
        const newWords      = summary.split(/\s+/).filter(w => w.length > 4);
        const overlap       = newWords.filter(w => existingWords.has(w)).length;
        return overlap >= 3;
      });
      if (isDupe) logger.info(`[BugBot] Skipping duplicate: ${ticket.summary}`);
      return !isDupe;
    });

    if (newTickets.length === 0) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text: `⚠️ No new tickets created — similar tickets already exist in this thread: ${existingKeys.map(k => `<${JIRA_HOST}/browse/${k}|${k}>`).join(', ')}`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    const triggerMentions = (event.text.match(/<@([A-Z0-9]+)>/g) || [])
      .map(m => m.replace(/<@|>/g, ''))
      .filter(id => id !== botUserId && !ASSIGNEE_BLOCKLIST.has(id));

    const sprintId    = await getActiveSprintId();
    const createdJiras = [];

    for (const ticket of newTickets) {
      logger.info(`[BugBot] Creating: ${ticket.summary}`);

      let assigneeSlackIds;
      if (triggerMentions.length > 0) {
        assigneeSlackIds = triggerMentions;
      } else {
        assigneeSlackIds = (
          await Promise.all((ticket.assignee_names || []).map(name => findSlackUserByName(client, name)))
        ).filter(id => id && !ASSIGNEE_BLOCKLIST.has(id));
      }

      const jiraIds = (
        await Promise.all(assigneeSlackIds.map(id => resolveJiraAccountId(client, id)))
      ).filter(Boolean);

      const jira = await createJiraIssue(ticket, jiraIds);

      if (sprintId) {
        await addIssueToSprint(jira.key, sprintId);
        logger.info(`[BugBot] Added ${jira.key} to sprint ${sprintId}`);
      }

      // ── Register for follow-up ────────────────
      if (assigneeSlackIds.length > 0) {
        followUpStore.set(jira.key, {
          channelId:        event.channel,
          threadTs:         threadTs,
          assigneeSlackIds: assigneeSlackIds,
          jiraKey:          jira.key,
          jiraUrl:          jira.url,
          createdAt:        Date.now(),
          lastPingAt:       null,
          pingCount:        0,
          day:              1,
          day2Pings:        0,
          done:             false,
        });
        logger.info(`[BugBot] Registered follow-up for ${jira.key}`);
      }

      createdJiras.push({ jira, ticket, assigneeSlackIds });
    }

    const parentKey  = PLATFORM_PARENTS[createdJiras[0].ticket.platform];
    const parentInfo = parentKey ? ` · <${JIRA_HOST}/browse/${parentKey}|${parentKey}>` : '';
    const lines      = createdJiras.map(({ jira, ticket, assigneeSlackIds }) => {
      const assigneeLine = assigneeSlackIds.length > 0
        ? `Assigned to ${assigneeSlackIds.map(id => `<@${id}>`).join(', ')}`
        : '_No assignee — please assign in Jira_';
      const emoji = ticket.summary.includes('Fix data') ? '🔧' : ticket.type === 'Task' ? '📋' : '🐛';
      const label = ticket.type === 'Task' ? 'Task' : 'Bug';
      return `${emoji} *${label} logged!* → <${jira.url}|${jira.key}>\n*${ticket.summary}*\nPriority: *${ticket.priority}* · ${assigneeLine}`;
    });

    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text: lines.join('\n\n') + (parentInfo ? `\n\nParent: ${parentInfo}` : ''),
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
  startFollowUpScheduler(slackApp.client);
})();
