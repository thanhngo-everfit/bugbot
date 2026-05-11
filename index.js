require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const JIRA_HOST    = 'https://everfit.atlassian.net';
const JIRA_PROJECT = 'UP';

// ── Channels the bot auto-analyzes (replace IDs with real Slack channel IDs)
// How to find: Channel → right-click → View channel details → Channel ID at bottom
const MONITORED_CHANNELS = {
  'C03H5DCAZ45': 'bug_reporting-internal',
  'C064GEV0D6Z': 'enterprise_bug_reporting_internal',
  'C075QSJS81X': 'customer-request-discussion',
};

// ── Squad Roster (from squad_roster.xlsx) ─────
// Each squad has: SM, PC, BA, role-based engineers, and domain keywords for detection
const SQUAD_ROSTER = {
  'Core Product - Training & Automation': {
    sm: 'Thanh Ngo', pc: 'Duyen Tran', ba: 'Ngoc Nguyen',
    backend: 'Dong Vo', web: 'Hanh Tran', android: 'Khoa Huynh', ios: 'Tuyen Tran', qa: 'Trang Ngo',
    domains: [
      'workout', 'training', 'exercise', 'program', 'autoflow', 'video workout',
      'task assignment', 'master planner', 'gamification', 'leaderboard',
      'studio', 'on-demand', 'autoflow', 'sequence',
    ],
  },
  'Core Product - Nutrition': {
    sm: 'Bao Ho', pc: 'Anh Le', ba: 'Dung Pham',
    backend: 'Dong Vo', web: 'Ha Duong', android: 'Hoai Ho', ios: 'Tan Huynh', qa: 'Thao Nguyen',
    domains: [
      'nutrition', 'meal', 'macro', 'food', 'diet', 'recipe',
      'myfitnessPal', 'cronometer', 'ingredient', 'calorie', 'meal plan',
    ],
  },
  'Core Product - Platform Capability': {
    sm: 'Thanh Ngo', pc: 'Ngoc Nguyen', ba: 'Dieu Kieu',
    backend: 'Hong Tu', web: 'Nhan Huynh', android: 'Lam Bui', ios: 'Thinh Le', qa: 'Uyen Thao',
    domains: [
      'login', 'auth', 'authentication', 'permission', 'workspace',
      'localization', 'branding', 'white label', 'notification settings',
      'account settings', 'team settings', 'sign in', 'sign up', 'password',
    ],
  },
  'Core Product - Engagement': {
    sm: 'Bao Ho', pc: 'Anh Le', ba: 'Sally Phan',
    backend: 'Duc Trinh', web: 'Nhan Huynh', android: 'Khoa Huynh', ios: 'Thinh Le', qa: 'Bich Thuy',
    domains: [
      'message', 'chat', 'inbox', 'forum', 'community', 'checkin', 'check-in',
      'form', 'questionnaire', 'onboarding', 'client profile', 'body metric',
      'habit', 'goal', 'referral', 'affiliate', 'broadcast',
    ],
  },
  'Core Product - Integration & Middleware': {
    sm: 'Thanh Ngo', pc: 'Nhi Bien', ba: 'Sally Phan',
    backend: 'Viet Mai', web: 'Nhan Huynh', qa: 'Chieu Hoang',
    domains: [
      'integration', 'webhook', 'apple health', 'garmin', 'fitbit',
      'whoop', 'zapier', 'sync', 'middleware', 'health app',
    ],
  },
};

// ── Slack group IDs ───────────────────────────
const GROUP_CS = 'S04UNE5SW9M';
const GROUP_QA = 'S0120RDU4D9';
const GROUP_SM = 'S066VD6SS0G';

// ── Never auto-assign these users ─────────────
const ASSIGNEE_BLOCKLIST = new Set([
  'URH99J5QA', // Quang Pham — Head of Engineering, always cc, never assignee
]);

// ── Platform → Jira parent epic ───────────────
const PLATFORM_PARENTS = {
  'iOS Client': 'UP-23735', 'iOS Coach': 'UP-23735',
  'Android Client': 'UP-23734', 'Android Coach': 'UP-23734',
  'Web': 'UP-23736', 'API': 'UP-23733',
};

// ── Severity definitions (maps to Jira priority + SLA) ──
const SEVERITY_META = {
  Critical: { emoji: '🔴', label: 'Critical', jiraPriority: 'Highest', sla: 'Immediate — same-day fix required' },
  High:     { emoji: '🟠', label: 'High',     jiraPriority: 'High',    sla: 'Urgent — fix within 1–2 working days' },
  Medium:   { emoji: '🟡', label: 'Medium',   jiraPriority: 'Medium',  sla: 'Normal — fix within current sprint' },
  Low:      { emoji: '🟢', label: 'Low',      jiraPriority: 'Low',     sla: 'Minor — schedule in backlog' },
  Trivial:  { emoji: '⚪', label: 'Trivial',  jiraPriority: 'Lowest',  sla: 'Cosmetic — next available cycle' },
};

// ─────────────────────────────────────────────
// APP INIT
// ─────────────────────────────────────────────

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const followUpStore = new Map(); // in-memory follow-up tracker

// ── Knowledge base (loaded at startup, reloaded on SIGHUP) ──
let KNOWLEDGE_BASE = '';
function loadKnowledgeBase() {
  try {
    const kbPath = path.join(__dirname, 'knowledge-base.md');
    if (fs.existsSync(kbPath)) {
      KNOWLEDGE_BASE = fs.readFileSync(kbPath, 'utf8');
      console.log(`✅ Knowledge base loaded (${Math.round(KNOWLEDGE_BASE.length / 1024)} KB)`);
    } else {
      console.warn('[BugBot] knowledge-base.md not found — run node knowledge-base-builder.js first');
    }
  } catch (err) {
    console.warn('[BugBot] Could not load knowledge base:', err.message);
  }
}
process.on('SIGHUP', loadKnowledgeBase); // hot-reload KB without restart

// Vietnam timezone (UTC+7)
function nowVN() { return new Date(Date.now() + 7 * 60 * 60 * 1000); }
function isWorkingHours() { const h = nowVN().getUTCHours(); return h >= 9 && h < 18; }

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function jiraAuth() {
  return 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
}

async function resolveJiraAccountId(slackClient, slackUserId) {
  try {
    const info = await slackClient.users.info({ user: slackUserId });
    const email = info.user?.profile?.email;
    if (!email) return null;
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/user/search`, {
      params: { query: email, maxResults: 1 },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    return res.data?.[0]?.accountId ?? null;
  } catch { return null; }
}

async function getThread(client, channelId, threadTs) {
  const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
  const lines = await Promise.all((result.messages || []).map(async msg => {
    let name = msg.username || msg.user || 'user';
    try { name = (await client.users.info({ user: msg.user })).user?.real_name || name; } catch (_) {}
    const text = (msg.text || '').replace(/<@([A-Z0-9]+)>/g, (_, uid) => `@${uid}`);
    return `[${name}]: ${text}`;
  }));
  return lines.join('\n');
}

async function findSlackUserByName(client, name) {
  try {
    const lower = name.toLowerCase();
    const match = (await client.users.list({ limit: 200 })).members?.find(u =>
      (u.real_name || '').toLowerCase().includes(lower) ||
      (u.profile?.display_name || '').toLowerCase().includes(lower) ||
      (u.name || '').toLowerCase().includes(lower)
    );
    return match?.id ?? null;
  } catch { return null; }
}

function buildSlackThreadUrl(channelId, threadTs) {
  return `https://everfit.slack.com/archives/${channelId}/p${threadTs.replace('.', '')}`;
}

// ── Keyword-based squad detection (fast, no API call) ──
function detectSquadFromKeywords(text) {
  const lower = text.toLowerCase();
  let best = null, bestScore = 0;
  for (const [squad, roster] of Object.entries(SQUAD_ROSTER)) {
    const score = (roster.domains || []).filter(kw => lower.includes(kw)).length;
    if (score > bestScore) { bestScore = score; best = squad; }
  }
  return best;
}

function getSquadContacts(squad) {
  const r = SQUAD_ROSTER[squad];
  return r ? { sm: r.sm, pc: r.pc, ba: r.ba } : null;
}

function getRecommendedAssignee(squad, platform) {
  const r = SQUAD_ROSTER[squad];
  if (!r) return null;
  const roleMap = {
    'iOS Client': 'ios', 'iOS Coach': 'ios',
    'Android Client': 'android', 'Android Coach': 'android',
    'Web': 'web', 'API': 'backend',
  };
  return r[roleMap[platform]] || r.backend || null;
}

// ── Resolve SM and PC names → Slack @mentions ─
async function resolveContactMentions(client, contacts) {
  if (!contacts) return null;
  const [smId, pcId] = await Promise.all([
    findSlackUserByName(client, contacts.sm),
    findSlackUserByName(client, contacts.pc),
  ]);
  return {
    sm:     contacts.sm,
    pc:     contacts.pc,
    smMention: smId ? `<@${smId}>` : `*${contacts.sm}*`,
    pcMention: pcId ? `<@${pcId}>` : `*${contacts.pc}*`,
  };
}
// ─────────────────────────────────────────────

async function getAllThreadAttachments(client, channelId, threadTs) {
  try {
    const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
    const atts = [];
    for (const msg of result.messages || []) {
      for (const f of msg.files || []) {
        if (f.url_private_download) {
          atts.push({ name: f.name || 'attachment', url: f.url_private_download, mimetype: f.mimetype || 'application/octet-stream' });
        }
      }
    }
    return atts;
  } catch { return []; }
}

async function downloadSlackFile(url) {
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    responseType: 'arraybuffer',
  });
  return Buffer.from(res.data);
}

async function uploadAttachmentToJira(issueKey, filename, fileBuffer, mimetype) {
  try {
    const form = new FormData();
    form.append('file', fileBuffer, { filename, contentType: mimetype });
    await axios.post(`${JIRA_HOST}/rest/api/3/issue/${issueKey}/attachments`, form, {
      headers: { ...form.getHeaders(), Authorization: jiraAuth(), 'X-Atlassian-Token': 'no-check' },
    });
    return true;
  } catch (err) {
    console.warn(`[BugBot] Attachment upload failed (${filename}):`, err.message);
    return false;
  }
}

// ─────────────────────────────────────────────
// JIRA
// ─────────────────────────────────────────────

async function getJiraStatus(issueKey) {
  try {
    const res = await axios.get(`${JIRA_HOST}/rest/api/3/issue/${issueKey}?fields=status`, {
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    return res.data?.fields?.status?.name ?? null;
  } catch { return null; }
}

async function getActiveSprintId() {
  try {
    const boardRes = await axios.get(`${JIRA_HOST}/rest/agile/1.0/board`, {
      params: { projectKeyOrId: JIRA_PROJECT, type: 'scrum' },
      headers: { Authorization: jiraAuth(), Accept: 'application/json' },
    });
    const board = boardRes.data?.values?.[0];
    if (!board) return null;
    const sprintRes = await axios.get(`${JIRA_HOST}/rest/agile/1.0/board/${board.id}/sprint`, {
      params: { state: 'active' },
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

// ─────────────────────────────────────────────
// ADF BUILDER (Jira rich text format)
// ─────────────────────────────────────────────

const BOLD_HEADER_RE = /^(Slack thread|Squad|Severity|Reported by|Intercom link|Affected area|Steps to reproduce|Expected behavior|Actual behavior|Request details|Resolution Steps|Notes?)(:)(.*)$/i;

function lineToAdfContent(line) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = [];
  let last = 0, m;
  while ((m = urlRegex.exec(line)) !== null) {
    if (m.index > last) parts.push({ type: 'text', text: line.slice(last, m.index) });
    parts.push({ type: 'text', text: m[1], marks: [{ type: 'link', attrs: { href: m[1] } }] });
    last = m.index + m[1].length;
  }
  if (last < line.length) parts.push({ type: 'text', text: line.slice(last) });
  return parts.length ? parts : [{ type: 'text', text: line }];
}

function renderLineAdf(line) {
  const m = line.match(BOLD_HEADER_RE);
  if (m) {
    const parts = [{ type: 'text', text: `${m[1]}${m[2]}`, marks: [{ type: 'strong' }] }];
    if (m[3]) parts.push(...lineToAdfContent(m[3]));
    return parts;
  }
  return lineToAdfContent(line);
}

function buildAdfDescription(text) {
  return {
    type: 'doc', version: 1,
    content: (text || '').split('\n')
      .filter(l => l.trim())
      .map(l => ({ type: 'paragraph', content: renderLineAdf(l) })),
  };
}

async function createJiraIssue(ticket, jiraAccountIds) {
  const sevMeta = SEVERITY_META[ticket.severity] || SEVERITY_META.Medium;
  const fields = {
    project:     { key: JIRA_PROJECT },
    summary:     ticket.summary,
    issuetype:   { name: ticket.type === 'Task' ? 'Task' : 'Bug' },
    priority:    { name: sevMeta.jiraPriority },   // derived from severity
    description: buildAdfDescription(ticket.description),
    fixVersions: [{ id: '27643' }],
  };
  const parentKey = PLATFORM_PARENTS[ticket.platform];
  if (parentKey) fields.parent = { key: parentKey };
  if (jiraAccountIds.length) fields.assignee = { accountId: jiraAccountIds[0] };

  const res = await axios.post(`${JIRA_HOST}/rest/api/3/issue`, { fields }, {
    headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return { key: res.data.key, url: `${JIRA_HOST}/browse/${res.data.key}` };
}

// ─────────────────────────────────────────────
// CORE AI ANALYSIS  ─  single Sonnet 4 call
// ─────────────────────────────────────────────

async function analyzeThread(context, slackThreadUrl) {
  // Trim KB to avoid hitting token limits while keeping the most useful sections
  const kbSection = KNOWLEDGE_BASE
    ? `\n\n---\n📚 KNOWLEDGE BASE — use patterns below to determine severity and resolution steps:\n${KNOWLEDGE_BASE.substring(0, 7000)}\n---\n`
    : '';

  const squadList = Object.keys(SQUAD_ROSTER).join('\n  - ');

  const res = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 3500,
    system: `You are BugBot, the internal issue-triage assistant for Everfit — a B2B fitness coaching SaaS platform.

Your job: read a Slack support/bug thread and return a single structured JSON object that drives both a Slack auto-reply and Jira ticket creation.
${kbSection}

════════════════════════════════════════════
SQUADS — detect from the issue context:
  - ${squadList}

PLATFORM DETECTION (strict):
  - iOS Client / iOS Coach   → user describes iOS app behavior
  - Android Client / Coach   → user describes Android behavior
  - Web                      → issue on the web dashboard / browser
  - API                      → backend/data fix, account changes, email updates, sync errors, anything needing DB/server access

════════════════════════════════════════════
SEVERITY STANDARD — apply strictly, this determines urgency and SLA:

  🔴 Critical
     WHEN: production outage, data loss/corruption, security breach, payment failure,
           complete login failure for all users, crash on launch, GDPR/legal risk.
     SLA: Same-day fix required.

  🟠 High
     WHEN: core feature fully broken with NO workaround, crash on a common user action,
           billing/subscription access broken for a paying coach, sync failure blocking
           daily coaching work for multiple users.
     SLA: Fix within 1–2 working days.

  🟡 Medium
     WHEN: feature partially broken but a workaround exists, issue isolated to 1 account/device,
           confusing UX blocking a specific task, typo in critical copy, minor data display error,
           account update request (email change, etc.), UI misalignment causing confusion.
     SLA: Fix within current sprint.

  🟢 Low
     WHEN: cosmetic spacing/padding/color issue, minor visual glitch, edge case affecting <1%
           of users, nice-to-have improvement, non-blocking inconsistency.
     SLA: Schedule in backlog.

  ⚪ Trivial
     WHEN: internal-only cosmetic issue, dev/staging env only, theoretical concern.
     SLA: Next available cycle.

  Severity drives the Jira priority field:
    Critical → Highest | High → High | Medium → Medium | Low → Low | Trivial → Lowest

════════════════════════════════════════════
TICKET CLASSIFICATION:
  - Bug: something broken, crashing, not working as designed
  - Task: account/data change, feature request, configuration, access request

TWO-TICKET RULE — create 2 tickets ONLY when BOTH are true:
  1. An immediate data/account fix is needed right now (type=Task)
  2. A code/root-cause fix is also needed (type=Bug or Task)
  Otherwise: 1 ticket only.

TITLE PREFIX FORMAT (required, never leave the description after brackets empty):
  Bug from client/coach    → [Client Report][Platform][Feature] Short description
  Data fix for client      → [Client Report][Platform][Fix data][Feature] Short description
  Request from client      → [Client Request][Platform][Feature] Short description
  Internal / no client     → [Platform][Feature] Short description

  Platform = exactly one of: Web | API | iOS Client | iOS Coach | Android Client | Android Coach

════════════════════════════════════════════
ASSIGNEE DETECTION (ordered by confidence):
  1. Explicit in thread: "nhờ X check", "assign to X", "@X làm cái này", "@X help e"
  2. Acceptance reply: person was asked AND responded "ok", "được", "để a xem", "a check"
  3. Last person tagged with a task/request in the thread
  4. Return [] if genuinely unclear
  NEVER assign Quang Pham. Ignore "cc" lines entirely.

════════════════════════════════════════════
OUTPUT — return ONLY valid JSON (no markdown fences, no extra text):

{
  "issue_summary": "2–3 sentence plain-English summary of what happened and who is affected",
  "root_cause_hypothesis": "1-sentence hypothesis from KB patterns, or null",
  "impact": "concise impact statement (e.g. '1 coach on iOS, cannot complete check-in')",
  "severity": "Critical|High|Medium|Low|Trivial",
  "severity_rationale": "1 sentence explaining WHY this severity, citing the standard above",
  "tickets": [
    {
      "summary": "Title in [Prefix][Platform][Feature] format — description after brackets REQUIRED",
      "type": "Bug|Task",
      "severity": "Critical|High|Medium|Low|Trivial",
      "platform": "iOS Client|iOS Coach|Android Client|Android Coach|Web|API",
      "squad": "exact squad name",
      "description": "full Jira ticket body — use the template below",
      "assignee_names": ["Full Name as it appears in Slack"],
      "resolution_steps": [
        "Step 1: ...",
        "Step 2: ..."
      ]
    }
  ]
}

DESCRIPTION TEMPLATE (Bug):
Slack thread: ${slackThreadUrl}
Squad: <squad>
Severity: <severity> — <rationale>

Reported by: <coach/client name or email — NOT the CS/SM who posted>
Intercom link: <URL if found, else omit this line>

Affected area: <feature or screen name>

Steps to reproduce:
1. <step>
2. <step>

Expected behavior: <what should happen>
Actual behavior: <what actually happens>

Resolution Steps:
- <step from KB pattern if applicable>
- <step>

DESCRIPTION TEMPLATE (Task / Data fix):
Slack thread: ${slackThreadUrl}
Squad: <squad>
Severity: <severity> — <rationale>

Reported by: <coach/client name or email>
Intercom link: <URL if found, else omit this line>

Request details: <clear, specific description of what needs to be done>

Resolution Steps:
- <step>
- <step>`,
    messages: [{ role: 'user', content: `Slack thread:\n\n${context}` }],
  });

  const raw = res.content[0].text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    return {
      issue_summary:         context.substring(0, 150),
      root_cause_hypothesis: null,
      impact:                'Unknown — AI response could not be parsed',
      severity:              'Medium',
      severity_rationale:    'Defaulted to Medium (parse error)',
      tickets: [{
        summary:          context.substring(0, 80),
        type:             'Bug',
        severity:         'Medium',
        platform:         null,
        squad:            null,
        description:      `${context}\n\nSlack thread: ${slackThreadUrl}`,
        assignee_names:   [],
        resolution_steps: [],
      }],
    };
  }
}

// ─────────────────────────────────────────────
// AUTO-REPLY BUILDER
// ─────────────────────────────────────────────

function buildAutoReply(analysis, createdJiras, squad, contacts, analyzeOnly = false) {
  const { issue_summary, root_cause_hypothesis, impact, severity, severity_rationale, tickets } = analysis;
  const sev = SEVERITY_META[severity] || SEVERITY_META.Medium;
  const lines = [];

  // ── Section 1: Severity (most prominent) ─────
  lines.push(`📊 *BugBot Issue Analysis*`);
  lines.push('');
  lines.push(`${sev.emoji} *Severity: ${sev.label}*   |   SLA: _${sev.sla}_`);
  lines.push(`> *Why:* ${severity_rationale}`);
  lines.push('');

  // ── Section 2: Issue summary ──────────────────
  lines.push(`*📝 Summary*`);
  lines.push(issue_summary);
  if (root_cause_hypothesis) lines.push(`\n*🔍 Root Cause Hypothesis:* ${root_cause_hypothesis}`);
  lines.push(`*👥 Impact:* ${impact}`);
  lines.push('');

  // ── Section 3: Routing ────────────────────────
  lines.push(`*🏢 Routing*`);
  if (squad && contacts) {
    lines.push(`Squad: *${squad}*`);
    lines.push(`SM / PC: ${contacts.smMention} / ${contacts.pcMention}   ← please review and confirm`);
  } else {
    lines.push(`Squad: _Could not detect — please route manually_`);
  }
  lines.push('');

  // ── Section 4: Tickets created OR analyze-only CTA ──
  if (analyzeOnly) {
    lines.push(`*🎫 No ticket created yet*`);
    lines.push(`If this needs a Jira ticket: \`@BugBot create card\``);
  } else {
    lines.push(`*🎫 Tickets Created*`);
    for (const { jira, ticket, assigneeSlackIds, uploadedCount } of createdJiras) {
      const typeEmoji = ticket.summary.includes('Fix data') ? '🔧' : ticket.type === 'Task' ? '📋' : '🐛';
      const assigneeLine = assigneeSlackIds.length
        ? `Assigned → ${assigneeSlackIds.map(id => `<@${id}>`).join(', ')}`
        : `Assigned → _unassigned (please set in Jira)_`;
      const attachLine = uploadedCount > 0 ? `   · 📎 ${uploadedCount} file(s)` : '';

      lines.push(`${typeEmoji} <${jira.url}|${jira.key}>  ${ticket.summary}`);
      lines.push(`   ${assigneeLine}${attachLine}`);
    }
  }

  // ── Section 5: Resolution steps ───────────────
  const steps = tickets[0]?.resolution_steps || [];
  if (steps.length) {
    lines.push('');
    lines.push(`*🛠 Suggested Resolution Steps*`);
    steps.slice(0, 6).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }

  // ── Section 6: Decision prompt ────────────────
  lines.push('');
  if (contacts) {
    if (analyzeOnly) {
      lines.push(`${contacts.smMention} ${contacts.pcMention} — please review and decide next action.`);
    } else {
      lines.push(`${contacts.smMention} ${contacts.pcMention} — please confirm the assignment or adjust severity/priority as needed.`);
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// FOLLOW-UP STORE HELPERS
// ─────────────────────────────────────────────

async function findOrRegisterTracked(client, channelId, threadTs, botBotId, botUserId) {
  // 1. Check in-memory store first
  const fromStore = [...followUpStore.values()].find(
    item => item.threadTs === threadTs && item.channelId === channelId
  );
  if (fromStore) return fromStore;

  // 2. Scan thread for BugBot Jira links
  try {
    const messages = (await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 })).messages || [];
    let jiraKey = null, jiraUrl = null;
    for (const msg of messages) {
      if (msg.bot_id !== botBotId && msg.user !== botUserId) continue;
      const match = (msg.text || '').match(/https:\/\/everfit\.atlassian\.net\/browse\/(UP-\d+)/);
      if (match) { jiraKey = match[1]; jiraUrl = `${JIRA_HOST}/browse/${jiraKey}`; break; }
    }
    if (!jiraKey) return null;

    // Find assignee from thread
    let assigneeSlackIds = [];
    const assignRe = /nhờ|help|check|assign|làm|fix|giúp|xem/i;
    const ccRe = /^cc\s/i;
    for (const msg of messages) {
      if (msg.bot_id || msg.user === botUserId) continue;
      if (ccRe.test((msg.text || '').trim())) continue;
      if (!assignRe.test(msg.text || '')) continue;
      const ids = (msg.text || '').match(/<@([A-Z0-9]+)>/g)
        ?.map(m => m.replace(/<@|>/g, ''))
        .filter(id => id !== botUserId && !ASSIGNEE_BLOCKLIST.has(id)) || [];
      if (ids.length) assigneeSlackIds = ids;
    }

    const tracked = { channelId, threadTs, assigneeSlackIds, jiraKey, jiraUrl, createdAt: Date.now(), lastPingAt: null, pingCount: 0, done: false };
    followUpStore.set(jiraKey, tracked);
    return tracked;
  } catch { return null; }
}

// ─────────────────────────────────────────────
// FOLLOW-UP SCHEDULER (every 5 min)
// ─────────────────────────────────────────────

function startFollowUpScheduler(client) {
  setInterval(async () => {
    if (!followUpStore.size) return;
    for (const [, item] of followUpStore.entries()) {
      if (item.done) { followUpStore.delete(item.jiraKey); continue; }
      try {
        const status = (await getJiraStatus(item.jiraKey) || '').toLowerCase();
        if (status === 'qa ready') {
          await client.chat.postMessage({
            channel: item.channelId, thread_ts: item.threadTs, unfurl_links: false,
            text: `🧪 <${item.jiraUrl}|${item.jiraKey}> is now *QA Ready!*\n<!subteam^${GROUP_QA}> please verify when you can.`,
          });
          item.done = true;
        } else if (status === 'qa success') {
          await client.chat.postMessage({
            channel: item.channelId, thread_ts: item.threadTs, unfurl_links: false,
            text: `✅ <${item.jiraUrl}|${item.jiraKey}> passed QA and is ready for Production!\n<!subteam^${GROUP_SM}> please confirm to <!subteam^${GROUP_CS}> so they can follow up and close the Intercom ticket.`,
          });
          item.done = true;
        }
      } catch (err) {
        console.error(`[Scheduler] Error for ${item.jiraKey}:`, err.message);
      }
    }
  }, 5 * 60 * 1000);
}

// ─────────────────────────────────────────────
// MAIN EVENT HANDLER
// ─────────────────────────────────────────────

slackApp.event('app_mention', async ({ event, client, logger }) => {
  // Silently ignore channels not in our watch list
  if (!MONITORED_CHANNELS[event.channel]) return;

  const { user_id: botUserId, bot_id: botBotId } = await client.auth.test();
  const triggerText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim().toLowerCase();

  const isBare           = triggerText === '';
  const isAnalyze        = /^(analyze|phân tích|phan tich)/.test(triggerText);
  const isCreateCard     = /^(create\s?(card|ticket)|log\s?(bug|this)|assign\s?to)/.test(triggerText);
  const isFollowup       = /^(followup|follow[- ]up|check\s?status|update)/.test(triggerText);
  const isTroubleshoot   = /^(troubleshoot|trouble\s?shoot|debug|how\s?to\s?fix)/.test(triggerText);
  const isCancel         = /^(cancel|stop|close)/.test(triggerText);
  const isChangeAssignee = /^(reassign|change\s?assignee|assign\s?this\s?to|move\s?to)/.test(triggerText);
  const isValidCommand   = isBare || isAnalyze || isCreateCard || isFollowup || isTroubleshoot || isCancel || isChangeAssignee;

  try { await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }); } catch (_) {}

  try {
    // ── Unknown command ──────────────────────────
    if (!isValidCommand) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.thread_ts || event.ts,
        text:
          `❓ Unknown command. Here's what I can do:\n\n` +
          `• \`<@${botUserId}> analyze\` — analyze thread: severity, squad, impact, resolution steps — *no ticket created*\n` +
          `• \`<@${botUserId}> create card\` — analyze + create Jira ticket\n` +
          `• \`<@${botUserId}> assign to @person\` — create ticket and assign\n` +
          `• \`<@${botUserId}> reassign to @person [UP-XXXXX]\` — change assignee on existing ticket\n` +
          `• \`<@${botUserId}> followup\` — smart status check + ping assignee\n` +
          `• \`<@${botUserId}> troubleshoot\` — CS troubleshooting steps before escalating\n` +
          `• \`<@${botUserId}> cancel\` — stop follow-up tracking for this thread\n` +
          `• \`<@${botUserId}>\` — suggest next action`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'question', timestamp: event.ts }).catch(() => {});
      return;
    }

    const threadTs       = event.thread_ts || event.ts;
    const slackThreadUrl = buildSlackThreadUrl(event.channel, threadTs);
    const context = event.thread_ts
      ? await getThread(client, event.channel, event.thread_ts)
      : event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!context || context.trim().length < 10) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts,
        text: '👋 Tag me *inside a bug thread* — I\'ll read the entire conversation automatically!',
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // CANCEL
    // ═══════════════════════════════════════════
    if (isCancel) {
      const tracked = await findOrRegisterTracked(client, event.channel, threadTs, botBotId, botUserId);
      if (!tracked) {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: '⚠️ No active follow-up found for this thread.' });
      } else {
        tracked.done = true;
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: `🛑 Follow-up cancelled for <${tracked.jiraUrl}|${tracked.jiraKey}>. I'll stop tracking — please keep the ticket updated in Jira.`,
        });
        await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      }
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // CHANGE ASSIGNEE
    // ═══════════════════════════════════════════
    if (isChangeAssignee) {
      const mentionedUsers = (event.text.match(/<@([A-Z0-9]+)>/g) || [])
        .map(m => m.replace(/<@|>/g, '')).filter(id => id !== botUserId && !ASSIGNEE_BLOCKLIST.has(id));

      if (!mentionedUsers.length) {
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: `⚠️ Please mention the new assignee: \`<@${botUserId}> reassign to @person\``,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      const specificKey = (event.text.match(/UP-\d+/i) || [])[0]?.toUpperCase();
      const threadMsgsCA = (await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 50 }).catch(() => ({ messages: [] }))).messages || [];
      const threadKeys = [];
      for (const msg of [...threadMsgsCA].reverse()) {
        if (msg.bot_id !== botBotId) continue;
        for (const k of (msg.text || '').match(/UP-\d+/g) || []) {
          if (!threadKeys.includes(k)) threadKeys.push(k);
        }
      }

      if (!threadKeys.length) {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: '⚠️ No BugBot tickets found in this thread.' });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      if (threadKeys.length > 1 && !specificKey) {
        const list = threadKeys.map(k => `• \`<@${botUserId}> reassign to @person ${k}\` → <${JIRA_HOST}/browse/${k}|${k}>`).join('\n');
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: `📋 Multiple tickets in this thread — which one?\n\n${list}`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      const targetKey = (specificKey && threadKeys.includes(specificKey)) ? specificKey : threadKeys[0];
      const newJiraId = await resolveJiraAccountId(client, mentionedUsers[0]);
      if (!newJiraId) {
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: `⚠️ Could not find Jira account for <@${mentionedUsers[0]}>. Please assign manually in Jira.`,
        });
      } else {
        await axios.put(`${JIRA_HOST}/rest/api/3/issue/${targetKey}/assignee`, { accountId: newJiraId }, {
          headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
        });
        const tracked = followUpStore.get(targetKey);
        if (tracked) tracked.assigneeSlackIds = [mentionedUsers[0]];
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs, unfurl_links: false,
          text: `✅ <${JIRA_HOST}/browse/${targetKey}|${targetKey}> reassigned to <@${mentionedUsers[0]}>.`,
        });
        await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      }
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // FOLLOW-UP
    // ═══════════════════════════════════════════
    if (isFollowup) {
      const tracked = await findOrRegisterTracked(client, event.channel, threadTs, botBotId, botUserId);
      if (!tracked) {
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: '⚠️ No BugBot ticket found in this thread. Create one first with `create card`.',
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      const assessment = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514', max_tokens: 600,
        system: `You are BugBot for Everfit. Assess the current state of a bug thread.
Return ONLY valid JSON:
{
  "state": "acknowledged|in_progress|blocked|resolved_by_cs|done_by_dev|no_response|unclear",
  "summary": "1-2 sentence current situation",
  "eta": "ETA if mentioned, or null",
  "blocker": "what is blocking them, or null",
  "next_message": "message content only — do NOT include @mentions or raw user IDs"
}`,
        messages: [{ role: 'user', content: `Ticket: ${tracked.jiraKey} (${tracked.jiraUrl})\n\nThread:\n\n${context}` }],
      });

      let result;
      try { result = JSON.parse(assessment.content[0].text.replace(/```json|```/g, '').trim()); }
      catch { result = { state: 'unclear', next_message: `📋 <${tracked.jiraUrl}|${tracked.jiraKey}> — can someone share the latest status?` }; }

      const assigneeMentions = tracked.assigneeSlackIds.map(id => `<@${id}>`).join(', ') || '_no assignee_';
      const sanitize = t => (t || '').replace(/@([A-Z0-9]{9,11})\b/g, '<@$1>');

      switch (result.state) {
        case 'done_by_dev':
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs, unfurl_links: false,
            text: `✅ ${assigneeMentions} has fixed this!\nPlease move <${tracked.jiraUrl}|${tracked.jiraKey}> to *QA Ready* so <!subteam^${GROUP_QA}> can verify.`,
          });
          break;
        case 'resolved_by_cs':
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs,
            text: `✅ Resolved at CS level. Closing follow-up for <${tracked.jiraUrl}|${tracked.jiraKey}>.`,
          });
          tracked.done = true;
          break;
        case 'blocked':
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs,
            text: `⚠️ ${assigneeMentions} is blocked on <${tracked.jiraUrl}|${tracked.jiraKey}>.\n*Blocker:* ${result.blocker || 'see thread above'}\n<!subteam^${GROUP_CS}> <!subteam^${GROUP_SM}> — can someone help unblock this?`,
          });
          break;
        case 'acknowledged':
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs,
            text: `👍 ${assigneeMentions} acknowledged <${tracked.jiraUrl}|${tracked.jiraKey}>.${result.eta ? `\n*ETA:* ${result.eta}` : ''}\n<!subteam^${GROUP_CS}> will follow up once it's QA Ready.`,
          });
          break;
        default:
          await client.chat.postMessage({
            channel: event.channel, thread_ts: threadTs,
            text: `${assigneeMentions} ${sanitize(result.next_message)}`,
          });
      }
      tracked.lastPingAt = Date.now();
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'eyes', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // TROUBLESHOOT
    // ═══════════════════════════════════════════
    if (isTroubleshoot) {
      const res = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514', max_tokens: 1000,
        system: `You are BugBot for Everfit. Based on the Slack thread, provide practical troubleshooting steps for the CS team to try BEFORE escalating to dev.

CS are non-technical — steps must be clear, specific, and not require code or server access.
Draw from the platform type (iOS, Android, Web, API) to give targeted steps.

Format:
🔍 *Troubleshooting suggestions* — [Platform detected]

*What CS should check first:*
1. <check>
2. <check>

*Ask the coach/client to try:*
1. <step>
2. <step>

*If still not resolved — collect this info before escalating:*
- <info item>

Max 8 steps total. Plain English only.`,
        messages: [{ role: 'user', content: `Thread:\n\n${context}` }],
      });

      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text: `<!subteam^${GROUP_CS}> here are troubleshooting steps to try before escalating:\n\n${res.content[0].text}`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'mag', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // BARE MENTION — suggest the best next action
    // ═══════════════════════════════════════════
    if (isBare) {
      const bareThreadMsgs = (await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 50 }).catch(() => ({ messages: [] }))).messages || [];
      const existingKeysBare = [];
      for (const msg of bareThreadMsgs) {
        if (msg.bot_id !== botBotId) continue;
        (msg.text || '').match(/UP-\d+/g)?.forEach(k => { if (!existingKeysBare.includes(k)) existingKeysBare.push(k); });
      }

      const suggestion = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514', max_tokens: 250,
        system: `You are BugBot for Everfit. Read this support/bug thread and suggest the single best next action in 1–2 sentences.
Existing BugBot tickets in thread: ${existingKeysBare.length ? existingKeysBare.join(', ') : 'none'}
Suggest ONE action from: create card | assign to @person | reassign to @person | followup | troubleshoot | cancel
Format: 💡 Suggested: \`<@${botUserId}> [command]\` — [1 sentence reason]`,
        messages: [{ role: 'user', content: `Thread:\n\n${context}` }],
      });

      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: suggestion.content[0].text });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'bulb', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // ANALYZE — full analysis, no ticket created
    // ═══════════════════════════════════════════
    if (isAnalyze) {
      logger.info('[BugBot] Analyze mode — analysis only, no ticket');
      const analysis = await analyzeThread(context, slackThreadUrl);
      logger.info(`[BugBot] Severity=${analysis.severity}`);

      const squad    = analysis.tickets[0]?.squad || detectSquadFromKeywords(context);
      const contacts = await resolveContactMentions(client, squad ? getSquadContacts(squad) : null);

      // Build reply without ticket section — pass empty array, analyzeOnly=true
      const replyText = buildAutoReply(analysis, [], squad, contacts, true);
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs, unfurl_links: false,
        text: replyText,
      });

      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'mag_right', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // CREATE CARD (and "assign to" shortcut)
    // ═══════════════════════════════════════════

    // Check for existing tickets in thread (dedup protection)
    const allThreadMsgs = (await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 50 }).catch(() => ({ messages: [] }))).messages || [];
    const existingKeys = [];
    const existingSummaries = [];
    for (const msg of allThreadMsgs) {
      if (msg.bot_id !== botBotId) continue;
      (msg.text || '').match(/UP-\d+/g)?.forEach(k => { if (!existingKeys.includes(k)) existingKeys.push(k); });
      const sm = (msg.text || '').match(/\*(.+?)\*/);
      if (sm) existingSummaries.push(sm[1].toLowerCase());
    }

    // ── Run single Sonnet 4 analysis call ──
    logger.info('[BugBot] Analyzing with claude-sonnet-4-20250514...');
    const analysis = await analyzeThread(context, slackThreadUrl);
    logger.info(`[BugBot] Severity=${analysis.severity} · tickets=${analysis.tickets.length}`);

    // Determine squad from AI result or keyword fallback
    const squad = analysis.tickets[0]?.squad || detectSquadFromKeywords(context);
    const contacts = await resolveContactMentions(client, squad ? getSquadContacts(squad) : null);

    const triggerMentions = (event.text.match(/<@([A-Z0-9]+)>/g) || [])
      .map(m => m.replace(/<@|>/g, '')).filter(id => id !== botUserId && !ASSIGNEE_BLOCKLIST.has(id));

    // Shortcut: "assign to @X" when ticket already exists
    if (triggerText.startsWith('assign to') && existingKeys.length && triggerMentions.length) {
      const targetKey = existingKeys[0];
      const newJiraId = await resolveJiraAccountId(client, triggerMentions[0]);
      if (newJiraId) {
        await axios.put(`${JIRA_HOST}/rest/api/3/issue/${targetKey}/assignee`, { accountId: newJiraId }, {
          headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
        });
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs, unfurl_links: false,
          text: `✅ <${JIRA_HOST}/browse/${targetKey}|${targetKey}> reassigned to <@${triggerMentions[0]}>.`,
        });
      } else {
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: `⚠️ Could not find Jira account for <@${triggerMentions[0]}>. Please assign manually in Jira.`,
        });
      }
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      return;
    }

    // Dedup: skip tickets too similar to existing ones
    const newTickets = analysis.tickets.filter(ticket => {
      const isDupe = existingSummaries.some(existing => {
        const existingWords = new Set(existing.split(/\s+/).filter(w => w.length > 4));
        return ticket.summary.toLowerCase().split(/\s+/).filter(w => w.length > 4).filter(w => existingWords.has(w)).length >= 3;
      });
      if (isDupe) logger.info(`[BugBot] Skipping duplicate: ${ticket.summary}`);
      return !isDupe;
    });

    if (!newTickets.length) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text: `⚠️ Similar tickets already exist in this thread: ${existingKeys.map(k => `<${JIRA_HOST}/browse/${k}|${k}>`).join(', ')}`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    const sprintId          = await getActiveSprintId();
    const threadAttachments = await getAllThreadAttachments(client, event.channel, threadTs);
    const createdJiras      = [];

    for (const ticket of newTickets) {
      // Resolve assignee: trigger @mention > AI-detected names > platform-based recommendation
      let assigneeSlackIds;
      if (triggerMentions.length) {
        assigneeSlackIds = triggerMentions;
      } else if (ticket.assignee_names?.length) {
        assigneeSlackIds = (await Promise.all(ticket.assignee_names.map(n => findSlackUserByName(client, n)))).filter(id => id && !ASSIGNEE_BLOCKLIST.has(id));
      } else {
        const recommended = getRecommendedAssignee(ticket.squad || squad, ticket.platform);
        const resolvedId  = recommended ? await findSlackUserByName(client, recommended) : null;
        assigneeSlackIds  = resolvedId ? [resolvedId] : [];
      }

      const jiraIds = (await Promise.all(assigneeSlackIds.map(id => resolveJiraAccountId(client, id)))).filter(Boolean);

      // Pass severity through to createJiraIssue so it maps to the right Jira priority
      const jira = await createJiraIssue({ ...ticket, severity: analysis.severity }, jiraIds);
      if (sprintId) await addIssueToSprint(jira.key, sprintId);

      // Upload all thread attachments
      let uploadedCount = 0;
      for (const att of threadAttachments) {
        try {
          const buf = await downloadSlackFile(att.url);
          if (await uploadAttachmentToJira(jira.key, att.name, buf, att.mimetype)) uploadedCount++;
        } catch (_) {}
      }

      // Register for follow-up tracking
      if (assigneeSlackIds.length) {
        followUpStore.set(jira.key, {
          channelId: event.channel, threadTs, assigneeSlackIds,
          jiraKey: jira.key, jiraUrl: jira.url,
          createdAt: Date.now(), lastPingAt: null, pingCount: 0, done: false,
        });
      }

      createdJiras.push({ jira, ticket, assigneeSlackIds, uploadedCount });
    }

    // ── Post the rich auto-reply ──────────────────
    const replyText = buildAutoReply(analysis, createdJiras, squad, contacts);
    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text: replyText,
    });

    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});

  } catch (err) {
    logger.error('[BugBot] Unhandled error:', err.response?.data ?? err.message);
    await client.chat.postMessage({
      channel: event.channel, thread_ts: event.thread_ts || event.ts,
      text: `❌ BugBot error: \`${err.message}\``,
    });
    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'x', timestamp: event.ts }).catch(() => {});
  }
});

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────

(async () => {
  loadKnowledgeBase();
  await slackApp.start(process.env.PORT || 3000);
  const channelNames = Object.values(MONITORED_CHANNELS).join(', ');
  console.log(`✅ BugBot (claude-sonnet-4-20250514) running`);
  console.log(`📡 Monitoring: ${channelNames}`);
  startFollowUpScheduler(slackApp.client);
})();
