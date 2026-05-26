require('dotenv').config();
const { App } = require('@slack/bolt');
const OpenAI  = require('openai');
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
    sm: 'Thanh Ngo', smId: 'U0142GU335F',
    pc: 'Duyen Tran', pcId: 'U06401J6QR4',
    ba: 'Ngoc Nguyen',
    backend: 'Dong Vo', web: 'Hanh Tran', android: 'Khoa Huynh', ios: 'Tuyen Tran', qa: 'Trang Ngo',
    domains: [
      'workout', 'training', 'exercise', 'program', 'autoflow', 'video workout',
      'task assignment', 'master planner', 'gamification', 'leaderboard',
      'studio', 'on-demand', 'autoflow', 'sequence',
    ],
  },
  'Core Product - Nutrition': {
    sm: 'Bao Ho', smId: 'U0445EQS1ED',
    pc: 'Anh Van Le', pcId: 'U04PN2RHT4K',
    ba: 'Dung Pham',
    backend: 'Dong Vo', web: 'Ha Duong', android: 'Hoai Ho', ios: 'Tan Huynh', qa: 'Thao Nguyen',
    domains: [
      'nutrition', 'meal', 'macro', 'food', 'diet', 'recipe',
      'myfitnessPal', 'cronometer', 'ingredient', 'calorie', 'meal plan',
    ],
  },
  'Core Product - Platform Capability': {
    sm: 'Thanh Ngo', smId: 'U0142GU335F',
    pc: 'Nhi Bien', pcId: 'U08J7SGJGNM',
    ba: 'Dieu Kieu',
    backend: 'Hong Tu', web: 'Nhan Huynh', android: 'Lam Bui', ios: 'Thinh Le', qa: 'Uyen Thao',
    domains: [
      'login', 'auth', 'authentication', 'permission', 'workspace',
      'localization', 'branding', 'white label', 'notification settings',
      'account settings', 'team settings', 'sign in', 'sign up', 'password',
    ],
  },
  'Core Product - Engagement': {
    sm: 'Bao Ho', smId: 'U0445EQS1ED',
    pc: 'Anh Van Le', pcId: 'U04PN2RHT4K',
    ba: 'Sally Phan',
    backend: 'Duc Trinh', web: 'Nhan Huynh', android: 'Khoa Huynh', ios: 'Thinh Le', qa: 'Bich Thuy',
    domains: [
      'message', 'chat', 'inbox', 'forum', 'community', 'checkin', 'check-in',
      'form', 'questionnaire', 'onboarding', 'client profile', 'body metric',
      'habit', 'goal', 'referral', 'affiliate', 'broadcast',
    ],
  },
  'Core Product - Integration & Middleware': {
    sm: 'Thanh Ngo', smId: 'U0142GU335F',
    pc: 'Nhi Bien', pcId: 'U08J7SGJGNM',
    ba: 'Sally Phan',
    backend: 'Viet Mai', web: 'Nhan Huynh', qa: 'Chieu Hoang',
    domains: [
      'integration', 'webhook', 'apple health', 'garmin', 'fitbit',
      'whoop', 'zapier', 'sync', 'middleware', 'health app',
    ],
  },
  'Payment & Billing': {
    sm: 'Hoa Nguyen', smId: 'UQZ2PNPN3',
    pc: 'Tam Nguyen', pcId: 'U08R7JP31CZ',
    ba: null,
    domains: [
      'payment', 'billing', 'subscription', 'invoice', 'charge', 'refund',
      'stripe', 'paypal', 'credit card', 'plan upgrade', 'plan downgrade',
      'trial', 'renewal', 'pricing', 'receipt', 'transaction',
      'license', 'licence', 'seat', 'not eligible', 'license assignment',
      'remaining license', 'assigned license',
      'macrosnap', 'macro snap',
    ],
  },
  'AI Features': {
    sm: 'Hoa Nguyen', smId: 'UQZ2PNPN3',
    pc: 'Tam Nguyen', pcId: 'U08R7JP31CZ',
    ba: null,
    domains: [
      // General
      'ai', 'artificial intelligence', 'ai feature',
      // Training Programming
      'ai workout builder', 'ai workout generator', 'ai programming builder', 'push-up challenge',
      // Nutrition Programming
      'ai recipe builder', 'ai alternative recipe', 'ai recipe',
      // Communication
      'smart response', 'knowledge base',
      // AI Agents
      'olly', 'olly voice', 'ask olly',
      // Client Performance
      'bi dashboard', 'compare check-in',
      // Generic
      'ai suggest', 'ai generate', 'ai coach', 'ai meal', 'ai analysis', 'log food with ai',
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
const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── OpenAI wrapper ──
async function aiCall(system, userContent, maxTokens = 1000) {
  const res = await openai.chat.completions.create({
    model:      'gpt-4o',
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: userContent },
    ],
  });
  return res.choices[0].message.content || '';
}

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
      console.warn('[Bot] knowledge-base.md not found — run node knowledge-base-builder.js first');
    }
  } catch (err) {
    console.warn('[Bot] Could not load knowledge base:', err.message);
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
  const nowMs  = Date.now();
  const lines  = await Promise.all((result.messages || []).map(async msg => {
    let name = msg.username || msg.user || 'user';
    try { name = (await client.users.info({ user: msg.user })).user?.real_name || name; } catch (_) {}
    const text = (msg.text || '').replace(/<@([A-Z0-9]+)>/g, (_, uid) => `@${uid}`);
    // Include relative time so Claude knows how old each message is
    const msgMs   = parseFloat(msg.ts) * 1000;
    const hoursAgo = Math.round((nowMs - msgMs) / (60 * 60 * 1000));
    const timeLabel = hoursAgo < 1 ? 'just now'
      : hoursAgo < 24 ? `${hoursAgo}h ago`
      : `${Math.round(hoursAgo / 24)}d ago`;
    return `[${name} — ${timeLabel}]: ${text}`;
  }));
  return lines.join('\n');
}

async function findSlackUserByName(client, name) {
  try {
    const lower = name.toLowerCase();
    const lowerBase = lower.replace(/\s*\(.*?\)\s*/g, '').trim();

    let cursor;
    do {
      const res = await client.users.list({ limit: 200, ...(cursor ? { cursor } : {}) });
      const match = (res.members || []).find(u => {
        const realName    = (u.real_name || '').toLowerCase();
        const displayName = (u.profile?.display_name || '').toLowerCase();
        const userName    = (u.name || '').toLowerCase();
        const email       = (u.profile?.email || '').toLowerCase();
        return (
          realName.includes(lowerBase) ||
          displayName.includes(lowerBase) ||
          userName.includes(lowerBase) ||
          realName.includes(lower) ||
          displayName.includes(lower) ||
          email.startsWith(lowerBase.replace(/\s+/g, ''))
        );
      });
      if (match) return match.id;
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);

    return null;
  } catch { return null; }
}

function buildSlackThreadUrl(channelId, threadTs) {
  return `https://everfitt.slack.com/archives/${channelId}/p${threadTs.replace('.', '')}`;
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
  return r ? { sm: r.sm, smId: r.smId, pc: r.pc, pcId: r.pcId } : null;
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


// ── Build @mentions from hardcoded IDs ───────
function resolveContactMentions(contacts) {
  if (!contacts) return null;
  return {
    sm:        contacts.sm,
    pc:        contacts.pc,
    smMention: contacts.smId ? `<@${contacts.smId}>` : `*${contacts.sm}*`,
    pcMention: contacts.pcId ? `<@${contacts.pcId}>` : `*${contacts.pc}*`,
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
    console.warn(`[Bot] Attachment upload failed (${filename}):`, err.message);
    return false;
  }
}

// ─────────────────────────────────────────────
// JIRA
// ─────────────────────────────────────────────


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
  } catch (err) { console.warn('[Bot] Could not add to sprint:', err.message); }
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

  const systemPrompt = `You are Client Report Bot (AI), the internal issue-triage assistant for Everfit — a B2B fitness coaching SaaS platform.

Your job: read a Slack support/bug thread and return a single structured JSON object that drives both a Slack auto-reply and Jira ticket creation.
${kbSection}

════════════════════════════════════════════
SQUADS — detect from the issue context:
  - ${squadList}

SQUAD ROUTING HINTS:
  - AI Workout Builder, AI Recipe Builder, AI Alternative Recipe, Olly Voice,
    Ask Olly, Smart Response, Knowledge Base, BI Dashboard, Push-up Challenge,
    AI Workout Generator, AI Programming Builder, Compare Check-in form
    → always route to "AI Features"
  - MacroSnap, macrosnap license, license assignment, "not eligible for license",
    license seats, subscription, billing, payment, invoice, refund
    → route to "Payment & Billing"
  - If issue involves BOTH an AI feature bug AND a license/billing error
    → create 2 tickets: one for "AI Features", one for "Payment & Billing"

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
- <step>`;

  const raw = (await aiCall(systemPrompt, `Slack thread:\n\n${context}`, 3500)).replace(/```json|```/g, '').trim();
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
// REPLY BUILDERS
// ─────────────────────────────────────────────

// Analysis reply — used by auto-analyze and @Client Report Bot (AI) analyze
function buildAnalysisReply(analysis, squad, contacts) {
  const { issue_summary, root_cause_hypothesis, impact, severity, severity_rationale, tickets } = analysis;
  const sev = SEVERITY_META[severity] || SEVERITY_META.Medium;
  const lines = [];

  lines.push(`📊 *Client Report Bot (AI) — Issue Analysis*`);
  lines.push('');
  lines.push(`${sev.emoji} *Severity: ${sev.label}*   |   SLA: _${sev.sla}_`);
  lines.push(`> *Why:* ${severity_rationale}`);
  lines.push('');
  lines.push(`*📝 Summary*`);
  lines.push(issue_summary);
  if (root_cause_hypothesis) lines.push(`*🔍 Root Cause:* ${root_cause_hypothesis}`);
  lines.push(`*👥 Impact:* ${impact}`);
  lines.push('');
  lines.push(`*🏢 Routing*`);
  if (squad && contacts) {
    lines.push(`Squad: *${squad}*`);
    lines.push(`SM / PC: ${contacts.smMention} / ${contacts.pcMention}`);
  } else {
    lines.push(`Squad: _Could not detect — please route manually_`);
  }

  const steps = tickets[0]?.resolution_steps || [];
  if (steps.length) {
    lines.push('');
    lines.push(`*🛠 Suggested Resolution Steps*`);
    steps.slice(0, 6).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }

  lines.push('');
  if (contacts) {
    lines.push(`${contacts.smMention} ${contacts.pcMention} — please review and decide next action.`);
  }

  return lines.join('\n');
}

// Ticket reply — used by create card: short confirmation + follow-up schedule
function buildTicketReply(createdJiras) {
  const lines = [];
  for (const { jira, ticket, assigneeSlackIds, uploadedCount } of createdJiras) {
    const typeEmoji    = ticket.summary.includes('Fix data') ? '🔧' : ticket.type === 'Task' ? '📋' : '🐛';
    const assigneeLine = assigneeSlackIds.length
      ? `Assigned → ${assigneeSlackIds.map(id => `<@${id}>`).join(', ')}`
      : `Assigned → _unassigned_`;
    const attachLine = uploadedCount > 0 ? ` · 📎 ${uploadedCount} file(s)` : '';
    lines.push(`${typeEmoji} <${jira.url}|${jira.key}> created`);
    lines.push(`   ${ticket.summary}`);
    lines.push(`   ${assigneeLine}${attachLine}`);
  }

  lines.push('');
  lines.push(`_Follow-up schedule:_`);
  lines.push(`• I'll ping the assignee daily if no status update`);
  lines.push(`• *QA Ready* → I'll tag SM to assign a QA member`);
  lines.push(`• *QA Success* → I'll tag PC to notify CS and close Intercom`);
  lines.push(`• Use \`@Client Report Bot (AI) followup\` to check status anytime`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// FOLLOW-UP SYSTEM
// ─────────────────────────────────────────────

/*
  followUpStore shape:
  {
    channelId,          Slack channel ID
    threadTs,           parent message timestamp
    jiraKey,            e.g. "UP-12345"
    jiraUrl,            full Jira URL
    squad,              squad name (for SM/PC lookup)
    lastStatus,         last Jira status observed
    lastStatusAt,       epoch ms when status last changed
    lastPingAt,         epoch ms when we last posted a message
    notifiedQaReady,    bool — SM already tagged for QA Ready
    done,               bool — stop tracking
  }
*/

// ── Get Jira issue: status + assignee in one call ──
async function getJiraIssueDetails(issueKey) {
  try {
    const res = await axios.get(
      `${JIRA_HOST}/rest/api/3/issue/${issueKey}?fields=status,assignee`,
      { headers: { Authorization: jiraAuth(), Accept: 'application/json' } }
    );
    const fields = res.data?.fields || {};
    const details = {
      status:          (fields.status?.name || '').toLowerCase(),
      assigneeEmail:   fields.assignee?.emailAddress || null,
      assigneeDisplay: fields.assignee?.displayName || null,
    };
    console.log(`[Bot] ${issueKey} → status="${details.status}" assignee="${details.assigneeDisplay}" email="${details.assigneeEmail}"`);
    return details;
  } catch (err) {
    console.warn(`[Bot] getJiraIssueDetails(${issueKey}) failed:`, err.message);
    return null;
  }
}

// ── Resolve Jira email → Slack user ID ────────
// Primary: users.lookupByEmail (exact, single call, requires users:read.email)
// Fallback: name search via users.list if email lookup fails
async function resolveEmailToSlackId(client, email, displayName = null) {
  // 1. Try exact email lookup first
  if (email) {
    try {
      const res = await client.users.lookupByEmail({ email: email.toLowerCase() });
      if (res.user?.id) return res.user.id;
    } catch (err) {
      if (err.data?.error !== 'users_not_found') {
        console.warn(`[Bot] lookupByEmail(${email}): ${err.data?.error || err.message}`);
      }
    }
  }

  // 2. Fallback: search by display name across all members
  if (displayName) {
    try {
      const lower = displayName.toLowerCase();
      const base  = lower.replace(/\s*\(.*?\)\s*/g, '').trim(); // strip (PC), (SM) etc.
      let cursor;
      do {
        const res = await client.users.list({ limit: 200, ...(cursor ? { cursor } : {}) });
        const match = (res.members || []).find(u => {
          const real    = (u.real_name || '').toLowerCase();
          const display = (u.profile?.display_name || '').toLowerCase();
          return real.includes(base) || display.includes(base);
        });
        if (match) {
          console.log(`[Bot] Resolved "${displayName}" by name fallback → ${match.id}`);
          return match.id;
        }
        cursor = res.response_metadata?.next_cursor;
      } while (cursor);
    } catch (_) {}
  }

  console.warn(`[Bot] Could not resolve Slack ID for email="${email}" name="${displayName}"`);
  return null;
}

// ── Register a thread+ticket for follow-up ────
// Called after create card, or when scanning a thread with any UP-XXXXX
function registerFollowUp({ channelId, threadTs, jiraKey, jiraUrl, squad }) {
  if (followUpStore.has(jiraKey)) return; // already tracked
  followUpStore.set(jiraKey, {
    channelId,
    threadTs,
    jiraKey,
    jiraUrl,
    squad:           squad || null,
    lastStatus:      null,
    lastStatusAt:    Date.now(),
    lastPingAt:      null,
    notifiedQaReady: false,
    done:            false,
  });
  console.log(`[FollowUp] Registered ${jiraKey} (squad: ${squad || 'unknown'})`);
}

// ── Scan thread for any UP-XXXXX links (bot or manual) ──
async function scanThreadForTickets(client, channelId, threadTs) {
  try {
    const messages = (await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 })).messages || [];
    const keys = new Set();
    for (const msg of messages) {
      const matches = (msg.text || '').match(/UP-\d+/g) || [];
      matches.forEach(k => keys.add(k));
    }
    return [...keys].map(k => ({ key: k, url: `${JIRA_HOST}/browse/${k}` }));
  } catch { return []; }
}

// ── Claude thread assessment before any follow-up action ──
// hoursSinceAssigneeReply is calculated in CODE before calling — not left to Claude's judgement
async function assessThreadBeforeFollowUp(threadContext, jiraKey, jiraStatus, assigneeDisplay, hoursSinceAssigneeReply) {
  const timeContext = hoursSinceAssigneeReply === null
    ? 'Assignee has never replied in this thread.'
    : hoursSinceAssigneeReply < 1
    ? 'Assignee replied less than 1 hour ago.'
    : hoursSinceAssigneeReply < 48
    ? `Assignee replied ${Math.round(hoursSinceAssigneeReply)} hours ago.`
    : `Assignee last replied ${Math.round(hoursSinceAssigneeReply / 24)} days ago — this is considered STALE.`;

  const raw = (await aiCall(
    `You are Client Report Bot (AI) for Everfit. Decide whether to ping the dev assignee.

Jira ticket: ${jiraKey}
Jira status: ${jiraStatus}
Assignee: ${assigneeDisplay || 'unassigned'}
Timing: ${timeContext}

RULE — if assignee replied less than 48 hours ago → ALWAYS return "skip".
RULE — if assignee replied 48+ hours ago or never replied → return "ping_dev" UNLESS the thread shows the issue is resolved.
RULE — if thread shows issue is resolved (CS confirmed, coach said fixed, etc.) → return "close".

Return ONLY valid JSON:
{
  "action": "ping_dev | skip | close",
  "reason": "1 sentence"
}`,
    `Thread (with timestamps):\n\n${threadContext}`,
    300
  )).replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(raw);
  } catch {
    return { action: 'skip', reason: 'Could not parse assessment — defaulting to skip' };
  }
}

// ── Calculate hours since assignee's last reply in thread ──
async function hoursSinceAssigneeReply(client, channelId, threadTs, assigneeSlackId) {
  if (!assigneeSlackId) return null;
  try {
    const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
    const messages = result.messages || [];
    // Find the most recent message from the assignee
    const assigneeMessages = messages
      .filter(m => m.user === assigneeSlackId)
      .map(m => parseFloat(m.ts) * 1000);
    if (!assigneeMessages.length) return null;
    const lastReplyMs = Math.max(...assigneeMessages);
    return (Date.now() - lastReplyMs) / (60 * 60 * 1000);
  } catch { return null; }
}
// ─────────────────────────────────────────────

function startFollowUpScheduler(client) {
  const THIRTY_MIN   = 30 * 60 * 1000;
  const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;

  setInterval(async () => {
    if (!followUpStore.size) return;
    console.log(`[FollowUp] Scheduler tick — ${followUpStore.size} tracked ticket(s)`);

    for (const [jiraKey, item] of followUpStore.entries()) {
      if (item.done) { followUpStore.delete(jiraKey); continue; }

      try {
        // ── 1. Get fresh Jira status + assignee ──────
        const details = await getJiraIssueDetails(jiraKey);
        if (!details) continue;

        const { status, assigneeEmail, assigneeDisplay } = details;

        // Track status changes
        if (status !== item.lastStatus) {
          console.log(`[FollowUp] ${jiraKey} status changed: ${item.lastStatus} → ${status}`);
          item.lastStatus   = status;
          item.lastStatusAt = Date.now();
        }

        // ── 2. Resolve assignee Slack ID fresh from Jira ──
        const assigneeSlackId = await resolveEmailToSlackId(client, assigneeEmail, assigneeDisplay);
        const assigneeMention = assigneeSlackId
          ? `<@${assigneeSlackId}>`
          : assigneeDisplay ? `*${assigneeDisplay}*` : '_unassigned_';

        // ── 3. Get squad contacts ─────────────────────
        const contacts = item.squad
          ? resolveContactMentions(getSquadContacts(item.squad))
          : null;

        // ── 4. Branch by Jira status ──────────────────

        // ── Terminal: Done / Released → silent close ──
        if (['done', 'released', 'closed'].includes(status)) {
          item.done = true;
          continue;
        }

        // ── QA Success → tag PC once, then close ──────
        if (status === 'qa success') {
          const pcMention = contacts?.pcMention || `<!subteam^${GROUP_SM}>`;
          await client.chat.postMessage({
            channel: item.channelId, thread_ts: item.threadTs, unfurl_links: false,
            text:
              `✅ <${item.jiraUrl}|${jiraKey}> has passed QA!\n` +
              `${pcMention} — please let the CS team know so they can follow up with the coach/client and close the Intercom ticket.`,
          });
          item.done = true;
          continue;
        }

        // ── QA Ready → tag SM to assign QA (once) ─────
        if (status === 'qa ready') {
          if (!item.notifiedQaReady) {
            const smMention = contacts?.smMention || `<!subteam^${GROUP_SM}>`;
            await client.chat.postMessage({
              channel: item.channelId, thread_ts: item.threadTs, unfurl_links: false,
              text:
                `🧪 <${item.jiraUrl}|${jiraKey}> is now *QA Ready*.\n` +
                `${smMention} — please assign a QA member to verify this ticket.`,
            });
            item.notifiedQaReady = true;
            item.lastPingAt = Date.now();
          }
          continue;
        }

        // ── Dev stages: To Do / In Progress / In Review ──
        // Only ping on working days (Mon–Fri) and after 48h since last ping
        const DEV_STATUSES = ['to do', 'in progress', 'in review'];
        if (!DEV_STATUSES.includes(status)) continue;

        // Skip weekends — VN timezone (UTC+7)
        if (!isWorkingHours()) continue;
        const vnDay = nowVN().getUTCDay(); // 0=Sun, 6=Sat
        if (vnDay === 0 || vnDay === 6) continue;

        const hoursSinceLastPing = item.lastPingAt
          ? (Date.now() - item.lastPingAt) / (60 * 60 * 1000)
          : 49; // never pinged → treat as overdue

        if (hoursSinceLastPing < 48) continue;

        // ── Scan thread + ask Claude before pinging ────
        const threadContext = await getThread(client, item.channelId, item.threadTs);
        const hoursStale    = await hoursSinceAssigneeReply(client, item.channelId, item.threadTs, assigneeSlackId);
        const assessment    = await assessThreadBeforeFollowUp(
          threadContext, jiraKey, status, assigneeDisplay, hoursStale
        );

        console.log(`[FollowUp] ${jiraKey} (${status}): ${assessment.action} — ${assessment.reason}`);

        if (assessment.action === 'close') { item.done = true; continue; }
        if (assessment.action === 'skip') continue;

        // ── Status-specific ping message ───────────────
        let pingText;
        if (status === 'to do') {
          pingText =
            `👋 ${assigneeMention} — <${item.jiraUrl}|${jiraKey}> has been assigned to you and is still *To Do*.\n` +
            `Could you acknowledge this ticket and let us know when you plan to start?`;
        } else if (status === 'in progress') {
          pingText =
            `👋 ${assigneeMention} — checking in on <${item.jiraUrl}|${jiraKey}> (*In Progress*).\n` +
            `Any updates, ETA, or blockers we should know about?`;
        } else if (status === 'in review') {
          pingText =
            `👋 ${assigneeMention} — <${item.jiraUrl}|${jiraKey}> is *In Review*.\n` +
            `Is the review complete? Please move it to *QA Ready* when done so QA can pick it up.`;
        }

        await client.chat.postMessage({
          channel: item.channelId, thread_ts: item.threadTs, unfurl_links: false,
          text: pingText,
        });
        item.lastPingAt = Date.now();

      } catch (err) {
        console.error(`[FollowUp] Error processing ${jiraKey}:`, err.message);
      }
    }
  }, THIRTY_MIN);
}

// ── findOrRegisterTracked — used by @Client Report Bot (AI) followup command ──
async function findOrRegisterTracked(client, channelId, threadTs, botBotId, botUserId) {
  // 1. Check in-memory store first
  const fromStore = [...followUpStore.values()].find(
    item => item.threadTs === threadTs && item.channelId === channelId
  );
  if (fromStore) return fromStore;

  // 2. Scan thread for any Jira ticket (bot-created or manually posted)
  try {
    const messages = (await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 })).messages || [];
    let jiraKey = null, jiraUrl = null, squad = null;

    // Find first UP-XXXXX in any message
    for (const msg of messages) {
      const match = (msg.text || '').match(/UP-\d+/);
      if (match) {
        jiraKey = match[0];
        jiraUrl = `${JIRA_HOST}/browse/${jiraKey}`;
        break;
      }
    }
    if (!jiraKey) return null;

    // Try to detect squad from thread text
    const fullText = messages.map(m => m.text || '').join(' ');
    squad = detectSquadFromKeywords(fullText);

    registerFollowUp({ channelId, threadTs, jiraKey, jiraUrl, squad });
    return followUpStore.get(jiraKey);
  } catch { return null; }
}

// ─────────────────────────────────────────────
// MAIN EVENT HANDLER (@Client Report Bot (AI) commands)
// ─────────────────────────────────────────────

slackApp.event('app_mention', async ({ event, client, logger }) => {
  if (!MONITORED_CHANNELS[event.channel]) return;

  const { user_id: botUserId, bot_id: botBotId } = await client.auth.test();
  const triggerText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim().toLowerCase();

  const isAnalyze        = /^(analyze|analysis|phân tích|phan tich)/.test(triggerText);
  const isCreateCard     = /^(create\s?(card|ticket)|log\s?(bug|this)|assign\s?to)/.test(triggerText);
  const isFollowup       = /^(followup|follow[- ]up|check\s?status|update)/.test(triggerText);
  const isTroubleshoot   = /^(troubleshoot|trouble\s?shoot|debug|how\s?to\s?fix)/.test(triggerText);
  const isCancel         = /^(cancel|stop|close)/.test(triggerText);
  const isChangeAssignee = /^(reassign|change\s?assignee|assign\s?this\s?to|move\s?to)/.test(triggerText);
  const isValidCommand   = isAnalyze || isCreateCard || isFollowup || isTroubleshoot || isCancel || isChangeAssignee;

  try { await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }); } catch (_) {}

  try {
    if (!isValidCommand) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.thread_ts || event.ts,
        text:
          `Here's what I can do:\n\n` +
          `• \`@Client Report Bot (AI) create card\` — create Jira ticket from this thread\n` +
          `• \`@Client Report Bot (AI) assign to @person\` — create ticket and assign\n` +
          `• \`@Client Report Bot (AI) reassign to @person [UP-XXXXX]\` — change assignee\n` +
          `• \`@Client Report Bot (AI) followup\` — check ticket status\n` +
          `• \`@Client Report Bot (AI) troubleshoot\` — get CS troubleshooting steps\n` +
          `• \`@Client Report Bot (AI) cancel\` — stop follow-up tracking`,
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
        text: '👋 Tag me *inside a bug thread* so I can read the full conversation.',
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // ANALYZE — re-run analysis on demand
    // ═══════════════════════════════════════════
    if (isAnalyze) {
      logger.info('[Bot] Analyze triggered manually');
      const analysis = await analyzeThread(context, slackThreadUrl);
      const squad    = analysis.tickets[0]?.squad || detectSquadFromKeywords(context);
      const contacts = resolveContactMentions(squad ? getSquadContacts(squad) : null);
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs, unfurl_links: false,
        text: buildAnalysisReply(analysis, squad, contacts),
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'mag_right', timestamp: event.ts }).catch(() => {});
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
          text: `🛑 Follow-up cancelled for <${tracked.jiraUrl}|${tracked.jiraKey}>. Please keep the ticket updated in Jira.`,
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
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: `⚠️ Please mention the new assignee: \`@Client Report Bot (AI) reassign to @person\`` });
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
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: '⚠️ No tickets found in this thread.' });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      if (threadKeys.length > 1 && !specificKey) {
        const list = threadKeys.map(k => `• \`@Client Report Bot (AI) reassign to @person ${k}\` → <${JIRA_HOST}/browse/${k}|${k}>`).join('\n');
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: `📋 Multiple tickets in this thread — which one?\n\n${list}` });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        return;
      }

      const targetKey = (specificKey && threadKeys.includes(specificKey)) ? specificKey : threadKeys[0];
      const newJiraId = await resolveJiraAccountId(client, mentionedUsers[0]);
      if (!newJiraId) {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: `⚠️ Could not find Jira account for <@${mentionedUsers[0]}>. Please assign manually.` });
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
    // FOLLOW-UP (manual trigger)
    // ═══════════════════════════════════════════
    if (isFollowup) {
      const tracked = await findOrRegisterTracked(client, event.channel, threadTs, botBotId, botUserId);

      // ── No ticket yet → tag SM/PC to review and assign ──
      if (!tracked) {
        const squad    = detectSquadFromKeywords(context);
        const contacts = resolveContactMentions(squad ? getSquadContacts(squad) : null);

        const smPcMention = contacts
          ? `${contacts.smMention} ${contacts.pcMention}`
          : `<!subteam^${GROUP_SM}>`;

        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text:
            `📋 No Jira ticket has been created for this thread yet.\n` +
            `${smPcMention} — please review this issue and either:\n` +
            `• Create a ticket: \`@Client Report Bot (AI) create card\`\n` +
            `• Or assign directly to a dev member once created`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'eyes', timestamp: event.ts }).catch(() => {});
        return;
      }

      // Get fresh Jira state
      const details = await getJiraIssueDetails(tracked.jiraKey);
      const status = details?.status || 'unknown';
      const assigneeSlackId = await resolveEmailToSlackId(client, details?.assigneeEmail, details?.assigneeDisplay);
      const assigneeMention = assigneeSlackId
        ? `<@${assigneeSlackId}>`
        : details?.assigneeDisplay ? `*${details.assigneeDisplay}*` : null;
      const contacts = tracked.squad
        ? resolveContactMentions(getSquadContacts(tracked.squad))
        : null;

      // ── No assignee → tag SM/PC to assign a dev ──
      if (!assigneeMention) {
        const smPcMention = contacts
          ? `${contacts.smMention} ${contacts.pcMention}`
          : `<!subteam^${GROUP_SM}>`;
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs, unfurl_links: false,
          text:
            `⚠️ <${tracked.jiraUrl}|${tracked.jiraKey}> has no dev assigned yet (*${status}*).\n` +
            `${smPcMention} — please assign this ticket to the right dev member.`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'eyes', timestamp: event.ts }).catch(() => {});
        return;
      }

      // Scan thread and ask Claude before doing anything
      const hoursStale = await hoursSinceAssigneeReply(client, event.channel, threadTs, assigneeSlackId);
      const assessment = await assessThreadBeforeFollowUp(
        context, tracked.jiraKey, status, details?.assigneeDisplay, hoursStale
      );
      console.log(`[FollowUp] Manual: ${tracked.jiraKey} → ${assessment.action} (assignee last replied: ${hoursStale === null ? 'never' : Math.round(hoursStale) + 'h ago'}) — ${assessment.reason}`);

      if (assessment.action === 'close' || ['done', 'released', 'closed'].includes(status)) {
        tracked.done = true;
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: `✅ <${tracked.jiraUrl}|${tracked.jiraKey}> appears resolved. Closing follow-up tracking.`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
        return;
      }

      if (status === 'qa success') {
        const pcMention = contacts?.pcMention || `<!subteam^${GROUP_SM}>`;
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs, unfurl_links: false,
          text:
            `✅ <${tracked.jiraUrl}|${tracked.jiraKey}> has passed QA!\n` +
            `${pcMention} — please let CS know so they can follow up with the coach/client and close the Intercom ticket.`,
        });
        tracked.done = true;
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
        return;
      }

      if (status === 'qa ready') {
        const smMention = contacts?.smMention || `<!subteam^${GROUP_SM}>`;
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs, unfurl_links: false,
          text:
            `🧪 <${tracked.jiraUrl}|${tracked.jiraKey}> is *QA Ready*.\n` +
            `${smMention} — please assign a QA member to verify this ticket.`,
        });
        tracked.notifiedQaReady = true;
        tracked.lastPingAt = Date.now();
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'eyes', timestamp: event.ts }).catch(() => {});
        return;
      }

      if (assessment.action === 'skip') {
        await client.chat.postMessage({
          channel: event.channel, thread_ts: threadTs,
          text: `ℹ️ <${tracked.jiraUrl}|${tracked.jiraKey}> is *${status}* — ${assessment.reason} No ping sent.`,
        });
        await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
        await client.reactions.add({ channel: event.channel, name: 'eyes', timestamp: event.ts }).catch(() => {});
        return;
      }

      // ping_dev — status-specific message
      let pingText;
      if (status === 'to do') {
        pingText =
          `👋 ${assigneeMention} — <${tracked.jiraUrl}|${tracked.jiraKey}> is assigned to you and still *To Do*.\n` +
          `Could you acknowledge and let us know when you plan to start?`;
      } else if (status === 'in progress') {
        pingText =
          `👋 ${assigneeMention} — checking in on <${tracked.jiraUrl}|${tracked.jiraKey}> (*In Progress*).\n` +
          `Any updates, ETA, or blockers?`;
      } else if (status === 'in review') {
        pingText =
          `👋 ${assigneeMention} — <${tracked.jiraUrl}|${tracked.jiraKey}> is *In Review*.\n` +
          `Is the review complete? Please move to *QA Ready* when done so QA can pick it up.`;
      } else {
        pingText =
          `👋 ${assigneeMention} — following up on <${tracked.jiraUrl}|${tracked.jiraKey}> (*${status}*).\n` +
          `Any updates or blockers?`;
      }

      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs, unfurl_links: false,
        text: pingText,
      });
      tracked.lastPingAt = Date.now();
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'eyes', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // TROUBLESHOOT
    // ═══════════════════════════════════════════
    if (isTroubleshoot) {
      const reply = await aiCall(
        `You are Client Report Bot (AI) for Everfit. Provide practical troubleshooting steps for the CS team to try BEFORE escalating to dev. CS are non-technical — steps must be clear and specific.

Format:
🔍 *Troubleshooting suggestions* — [Platform detected]

*What CS should check first:*
1. <check>

*Ask the coach/client to try:*
1. <step>

*If still not resolved — collect before escalating:*
- <info item>

Max 8 steps total. Plain English only.`,
        `Thread:\n\n${context}`,
        1000
      );

      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text: `<!subteam^${GROUP_CS}> here are troubleshooting steps to try before escalating:\n\n${reply}`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'mag', timestamp: event.ts }).catch(() => {});
      return;
    }

    // ═══════════════════════════════════════════
    // CREATE CARD
    // No re-analysis — auto-analyze already posted the report.
    // Just create the ticket(s) and post a short confirmation.
    // ═══════════════════════════════════════════

    // Check for existing tickets (dedup protection)
    const allThreadMsgs = (await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 50 }).catch(() => ({ messages: [] }))).messages || [];
    const existingKeys = [];
    const existingSummaries = [];
    for (const msg of allThreadMsgs) {
      if (msg.bot_id !== botBotId) continue;
      (msg.text || '').match(/UP-\d+/g)?.forEach(k => { if (!existingKeys.includes(k)) existingKeys.push(k); });
      const sm = (msg.text || '').match(/\*(.+?)\*/);
      if (sm) existingSummaries.push(sm[1].toLowerCase());
    }

    // Run analysis to get ticket details
    logger.info('[Bot] Create card — analyzing thread...');
    const analysis = await analyzeThread(context, slackThreadUrl);
    logger.info(`[Bot] Severity=${analysis.severity} · tickets=${analysis.tickets.length}`);

    const squad = analysis.tickets[0]?.squad || detectSquadFromKeywords(context);
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
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, unfurl_links: false, text: `✅ <${JIRA_HOST}/browse/${targetKey}|${targetKey}> reassigned to <@${triggerMentions[0]}>.` });
      } else {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: `⚠️ Could not find Jira account for <@${triggerMentions[0]}>. Please assign manually.` });
      }
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});
      return;
    }

    // Dedup
    const newTickets = analysis.tickets.filter(ticket => {
      const isDupe = existingSummaries.some(existing => {
        const existingWords = new Set(existing.split(/\s+/).filter(w => w.length > 4));
        return ticket.summary.toLowerCase().split(/\s+/).filter(w => w.length > 4).filter(w => existingWords.has(w)).length >= 3;
      });
      if (isDupe) logger.info(`[Bot] Skipping duplicate: ${ticket.summary}`);
      return !isDupe;
    });

    if (!newTickets.length) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: threadTs,
        text: `⚠️ Similar tickets already exist: ${existingKeys.map(k => `<${JIRA_HOST}/browse/${k}|${k}>`).join(', ')}`,
      });
      await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
      return;
    }

    const sprintId          = await getActiveSprintId();
    const threadAttachments = await getAllThreadAttachments(client, event.channel, threadTs);
    const createdJiras      = [];

    for (const ticket of newTickets) {
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
      const jira    = await createJiraIssue({ ...ticket, severity: analysis.severity }, jiraIds);
      if (sprintId) await addIssueToSprint(jira.key, sprintId);

      let uploadedCount = 0;
      for (const att of threadAttachments) {
        try {
          const buf = await downloadSlackFile(att.url);
          if (await uploadAttachmentToJira(jira.key, att.name, buf, att.mimetype)) uploadedCount++;
        } catch (_) {}
      }

      // Register for follow-up tracking (always, not just when assignee known)
      registerFollowUp({
        channelId: event.channel,
        threadTs,
        jiraKey: jira.key,
        jiraUrl: jira.url,
        squad:   ticket.squad || squad,
      });

      createdJiras.push({ jira, ticket, assigneeSlackIds, uploadedCount });
    }

    // Short ticket confirmation only — no re-analysis
    await client.chat.postMessage({
      channel: event.channel, thread_ts: threadTs, unfurl_links: false,
      text: buildTicketReply(createdJiras),
    });

    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'white_check_mark', timestamp: event.ts }).catch(() => {});

  } catch (err) {
    logger.error('[Bot] Unhandled error:', err.response?.data ?? err.message);
    await client.chat.postMessage({
      channel: event.channel, thread_ts: event.thread_ts || event.ts,
      text: `❌ Client Report Bot error: \`${err.message}\``,
    });
    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'x', timestamp: event.ts }).catch(() => {});
  }
});

// ─────────────────────────────────────────────
// AUTO-ANALYZE — fires on every new thread in monitored channels
// ─────────────────────────────────────────────

slackApp.event('message', async ({ event, client, logger }) => {
  // Only monitored channels
  if (!MONITORED_CHANNELS[event.channel]) return;

  // Only new parent messages — skip replies, edits, deletes, bot messages
  if (event.subtype) return;          // edited, deleted, bot_message, etc.
  if (event.bot_id) return;           // any bot
  if (event.thread_ts && event.thread_ts !== event.ts) return; // reply

  // Skip if message is too short to be a real report
  const text = (event.text || '').trim();
  if (text.length < 20) return;

  // Skip bare @mentions (handled by app_mention)
  if (/^<@[A-Z0-9]+>(\s+\w+)?$/.test(text)) return;

  try {
    logger.info(`[Bot] Auto-analyzing new thread in ${MONITORED_CHANNELS[event.channel]}`);
    await client.reactions.add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});

    const slackThreadUrl = buildSlackThreadUrl(event.channel, event.ts);
    const context = text;

    const analysis = await analyzeThread(context, slackThreadUrl);
    logger.info(`[Bot] Auto-analyze: Severity=${analysis.severity}`);

    const squad    = analysis.tickets[0]?.squad || detectSquadFromKeywords(context);
    const contacts = resolveContactMentions(squad ? getSquadContacts(squad) : null);

    const replyText = buildAnalysisReply(analysis, squad, contacts);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      unfurl_links: false,
      text: replyText,
    });

    // Auto-register any existing UP-XXXXX in this thread for follow-up
    // (covers manually-created Jira tickets pasted in the thread)
    const existingTickets = await scanThreadForTickets(client, event.channel, event.ts);
    for (const { key, url } of existingTickets) {
      registerFollowUp({ channelId: event.channel, threadTs: event.ts, jiraKey: key, jiraUrl: url, squad });
    }

    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
    await client.reactions.add({ channel: event.channel, name: 'mag_right', timestamp: event.ts }).catch(() => {});

  } catch (err) {
    logger.error('[Bot] Auto-analyze error:', err.message);
    await client.reactions.remove({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts }).catch(() => {});
  }
});

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────

(async () => {
  loadKnowledgeBase();
  await slackApp.start(process.env.PORT || 3000);
  const channelNames = Object.values(MONITORED_CHANNELS).join(', ');
  console.log(`✅ Client Report Bot (AI) running (gpt-4o)`);
  console.log(`📡 Monitoring: ${channelNames}`);
  startFollowUpScheduler(slackApp.client);
})();
