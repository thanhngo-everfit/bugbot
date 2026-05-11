#!/usr/bin/env node

require('dotenv').config();
const { App } = require('@slack/bolt');
const fs = require('fs');
const path = require('path');

const CHANNELS_TO_SCAN = [
  { id: 'C01', name: 'bug_reporting-internal' },
  { id: 'C02', name: 'enterprise_bug_reporting_internal' },
  { id: 'C03', name: 'customer-request-discussion' },
];

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// ── One year ago in milliseconds ───────────
function getOneYearAgoMs() {
  const now = new Date();
  const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  return oneYearAgo.getTime() / 1000;
}

async function scanChannel(client, channelId, channelName) {
  console.log(`\n📡 Scanning #${channelName}...`);
  
  const issues = [];
  let cursor = null;
  const oneYearAgoTs = getOneYearAgoMs();

  try {
    do {
      const result = await client.conversations.history({
        channel: channelId,
        limit: 100,
        cursor: cursor,
      });

      for (const msg of result.messages || []) {
        const msgTs = parseFloat(msg.ts);
        if (msgTs < oneYearAgoTs) break; // stop if older than 1 year

        // Skip bot messages and threads replies (only collect parent messages)
        if (msg.bot_id || msg.thread_ts !== msg.ts) continue;

        // Extract issue info
        const text = msg.text || '';
        const hasJiraLink = /UP-\d+/.test(text);
        const hasError = /error|fail|bug|broken|crash|issue|problem/i.test(text);
        
        if (hasError || hasJiraLink) {
          issues.push({
            channel: channelName,
            ts: msgTs,
            text: text.substring(0, 500), // first 500 chars
            user: msg.user,
            thread_ts: msg.ts,
          });
        }
      }

      cursor = result.response_metadata?.next_cursor;
      if (!cursor) break;
    } while (true);

  } catch (err) {
    console.error(`❌ Error scanning #${channelName}:`, err.message);
  }

  console.log(`✅ Found ${issues.length} relevant messages in #${channelName}`);
  return issues;
}

async function generateKnowledgeBase(allIssues) {
  console.log(`\n📚 Generating knowledge base from ${allIssues.length} issues...`);

  // Categorize issues
  const categories = {
    'iOS Client': [],
    'iOS Coach': [],
    'Android Client': [],
    'Android Coach': [],
    'Web': [],
    'API': [],
    'General': [],
  };

  const issues_by_type = {
    'Login & Auth': [],
    'Workout Management': [],
    'Nutrition': [],
    'Account & Profile': [],
    'Payment': [],
    'Sync Issues': [],
    'UI/UX': [],
    'Performance': [],
    'Data Issues': [],
    'Other': [],
  };

  for (const issue of allIssues) {
    const text = issue.text.toLowerCase();
    
    // Categorize by platform
    if (text.includes('ios') && text.includes('client')) categories['iOS Client'].push(issue);
    else if (text.includes('ios') && text.includes('coach')) categories['iOS Coach'].push(issue);
    else if (text.includes('android') && text.includes('client')) categories['Android Client'].push(issue);
    else if (text.includes('android') && text.includes('coach')) categories['Android Coach'].push(issue);
    else if (text.includes('web') || text.includes('dashboard')) categories['Web'].push(issue);
    else if (text.includes('api') || text.includes('backend')) categories['API'].push(issue);
    else categories['General'].push(issue);

    // Categorize by issue type
    if (text.includes('login') || text.includes('auth') || text.includes('password') || text.includes('sign')) 
      issues_by_type['Login & Auth'].push(issue);
    else if (text.includes('workout') || text.includes('exercise') || text.includes('program'))
      issues_by_type['Workout Management'].push(issue);
    else if (text.includes('nutrition') || text.includes('meal') || text.includes('macro'))
      issues_by_type['Nutrition'].push(issue);
    else if (text.includes('account') || text.includes('profile') || text.includes('email'))
      issues_by_type['Account & Profile'].push(issue);
    else if (text.includes('payment') || text.includes('subscription') || text.includes('charge'))
      issues_by_type['Payment'].push(issue);
    else if (text.includes('sync') || text.includes('synced') || text.includes('synchron'))
      issues_by_type['Sync Issues'].push(issue);
    else if (text.includes('ui') || text.includes('display') || text.includes('layout') || text.includes('color') || text.includes('button'))
      issues_by_type['UI/UX'].push(issue);
    else if (text.includes('slow') || text.includes('performance') || text.includes('lag') || text.includes('crash'))
      issues_by_type['Performance'].push(issue);
    else if (text.includes('data') || text.includes('missing') || text.includes('lost'))
      issues_by_type['Data Issues'].push(issue);
    else
      issues_by_type['Other'].push(issue);
  }

  // Build markdown document
  let md = `# Everfit BugBot Knowledge Base

_Generated: ${new Date().toISOString()}_
_Covering: Last 12 months of issues from bug_reporting-internal, enterprise_bug_reporting_internal, and customer-request-discussion_

## Overview

- **Total Issues Analyzed**: ${allIssues.length}
- **Platforms**: iOS Client, iOS Coach, Android Client, Android Coach, Web, API
- **Time Period**: Last 12 months

---

## Issues by Platform

`;

  for (const [platform, issues] of Object.entries(categories)) {
    if (issues.length === 0) continue;
    md += `### ${platform} (${issues.length} issues)\n\n`;
    
    // Show top 5 most recent issues
    const top5 = issues.sort((a, b) => b.ts - a.ts).slice(0, 5);
    for (const issue of top5) {
      md += `- **${new Date(issue.ts * 1000).toLocaleDateString()}**: ${issue.text.substring(0, 150)}\n`;
    }
    md += '\n';
  }

  md += `---\n\n## Issues by Type\n\n`;

  for (const [type, issues] of Object.entries(issues_by_type)) {
    if (issues.length === 0) continue;
    md += `### ${type} (${issues.length} issues)\n\n`;
    
    // Show common patterns
    const top3 = issues.sort((a, b) => b.ts - a.ts).slice(0, 3);
    for (const issue of top3) {
      md += `- ${issue.text.substring(0, 150)}\n`;
    }
    md += '\n';
  }

  md += `---\n\n## Common Resolution Patterns

Based on past issues, here are common troubleshooting steps:

### For Login & Auth Issues:
- Ask user to clear app cache and try again
- Check if email is verified in account settings
- Try force logout and re-login
- Verify account is active in admin panel

### For Workout Issues:
- Check if workout is assigned to the correct client
- Verify client has accepted the assignment
- Check video upload status in admin
- Ensure client app is up to date

### For Nutrition Issues:
- Check meal plan is properly assigned
- Verify meal syncing service (MyFitnessPal/Cronometer)
- Clear app cache and re-sync
- Check for duplicate entries in nutrition log

### For Account Issues:
- Verify email update in database
- Check user permissions for the workspace
- Confirm account status (active/inactive)
- Review recent account changes in admin

### For Sync Issues:
- Force app refresh/reload
- Clear cache and retry
- Check internet connectivity
- Verify API health status
- Re-authenticate external integrations (Apple Health, etc.)

### For UI/UX Issues:
- Check if issue reproduces in staging
- Test on different devices/OS versions
- Verify recent app updates
- Check browser compatibility (Web)

### For Performance Issues:
- Check network latency
- Monitor server response times
- Review database query performance
- Check for memory leaks in app

### For Data Issues:
- Export data from affected account
- Verify data integrity in database
- Check for sync conflicts
- Review transaction logs

---

## Squad Mapping for Issues

### Core Product - Training & Automation
- **Platforms**: All
- **SM**: Thanh Ngo
- **PC**: Duyen Tran
- **Common Issues**: Workout assignment, Video workouts, Training tracking, Autoflow
- **Escalation**: Contact training squad lead

### Core Product - Nutrition
- **Platforms**: All
- **SM**: Bao Ho
- **PC**: Anh Le
- **Common Issues**: Meal plans, Nutrition tracking, Macros, Integrations (MyFitnessPal)
- **Escalation**: Contact nutrition squad lead

### Core Product - Engagement
- **Platforms**: All
- **SM**: Bao Ho
- **PC**: Anh Le
- **Common Issues**: Client communication, Check-ins, Forms, Client onboarding
- **Escalation**: Contact engagement squad lead

### Core Product - Platform Capability
- **Platforms**: All
- **SM**: Thanh Ngo
- **PC**: Ngoc Nguyen
- **Common Issues**: Authentication, Workspace settings, Localization, Permissions
- **Escalation**: Contact platform squad lead

### Core Product - Integration & Middleware
- **Platforms**: API, Web, Mobile
- **SM**: Thanh Ngo
- **PC**: Nhi Bien
- **Common Issues**: External integrations, Data sync, API errors
- **Escalation**: Contact integration squad lead

---

## Decision Tree for Issue Classification

\`\`\`
Start: New issue reported
  ├─ Is it a crash? → Highest priority → Notify Squad Lead immediately
  ├─ Is data missing/lost? → Highest priority → Data recovery needed
  ├─ Is it payment related? → High priority → Financial impact
  ├─ Is core feature broken? → High priority → Affects multiple users
  ├─ Is it an account-specific issue? → Medium priority → API/data fix needed
  ├─ Is it a UI problem? → Medium priority → Follow design guidelines
  ├─ Is it a feature request? → Task, Medium priority → Plan with product
  └─ Is it a minor cosmetic issue? → Low priority → Backlog
\`\`\`

---

## Quick Reference: Who to Contact

| Issue Type | Likely Squad | Contact (SM) | Contact (PC) |
|---|---|---|---|
| App crashes | Training or Platform | Thanh Ngo | Duyen Tran / Ngoc Nguyen |
| Workout problems | Training | Thanh Ngo | Duyen Tran |
| Nutrition problems | Nutrition | Bao Ho | Anh Le |
| Client communication | Engagement | Bao Ho | Anh Le |
| Login/Auth | Platform | Thanh Ngo | Ngoc Nguyen |
| Integration issues | Integration | Thanh Ngo | Nhi Bien |
| Account/Data issues | Platform or API | Thanh Ngo | Ngoc Nguyen |

---

## Notes

- This knowledge base is auto-generated from Slack channel history
- Update by running \`node knowledge-base-builder.js\` regularly
- Review and add manual patterns based on customer insights
- Use this context when analyzing new issues for better suggestions

`;

  return md;
}

async function main() {
  console.log('🚀 Starting knowledge base generation...');
  
  try {
    const allIssues = [];

    for (const channel of CHANNELS_TO_SCAN) {
      const issues = await scanChannel(slackApp.client, channel.id, channel.name);
      allIssues.push(...issues);
    }

    const kb = await generateKnowledgeBase(allIssues);
    
    // Save to knowledge-base.md
    const kbPath = path.join(__dirname, 'knowledge-base.md');
    fs.writeFileSync(kbPath, kb, 'utf8');
    
    console.log(`\n✅ Knowledge base saved to: ${kbPath}`);
    console.log(`📊 Total issues processed: ${allIssues.length}`);
    console.log(`📄 Knowledge base size: ${(kb.length / 1024).toFixed(2)} KB`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main();
