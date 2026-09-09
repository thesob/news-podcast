/**
 * Daily News Podcast — Gmail → GitHub bridge
 *
 * Reads today's "Daily News Brief" email and commits its payload to GitHub:
 *   1. the tagged podcast script  → episode/script.txt   (this commit is the
 *      pipeline trigger — the GitHub Action that builds the MP3 watches it)
 *   2. the Hypothesis Watch daily log line → docs/hypothesis-log.md  (one
 *      line appended per email; the file is seeded on first run)
 *   3. the periodic "integral review" markdown block, present ONLY in the
 *      first brief of each calendar month → docs/hypothesis-reviews.md
 *      (seeded on first run; absent from the email on every other day)
 *
 * All three payloads travel in delimited blocks in the email's PLAIN-TEXT
 * body — never as attachments — because the Gmail tool that composes the
 * source email silently corrupts non-ASCII characters in attachments (see
 * prompts/agent-prompt.md step C). The plain-text body path round-trips
 * UTF-8 correctly.
 *
 * Idempotency: LAST_PROCESSED_MESSAGE_ID guards the whole run so a normal
 * poll that finds nothing new is a no-op. On top of that, each of the three
 * writes is individually content-checked (same script content → no commit;
 * a log line for a date already present → skipped; a review for a month
 * already present → skipped), so a partial failure can be safely retried on
 * the next poll without double-writing anything.
 *
 * SETUP:
 * 1. script.google.com -> New project -> paste this in.
 * 2. Project Settings (gear icon) -> Script Properties -> add:
 *      GITHUB_TOKEN = <your fine-grained PAT, scoped to this repo only,
 *                      Contents: Read and write>
 * 3. Update the CONFIG constants below (repo, subject line, your email).
 * 4. Run `pushDailyScriptToGithub` once manually from the editor to trigger
 *    Google's permission prompts (Gmail read + external requests). Approve them.
 * 5. Triggers (clock icon, left sidebar) -> Add Trigger:
 *      Function: pushDailyScriptToGithub
 *      Event source: Time-driven -> Minutes timer -> Every 5 minutes
 *    (Apps Script has no native "on email received" trigger, so this polls
 *    frequently instead — effectively near-instant, and safe to run all day:
 *    the LAST_PROCESSED_MESSAGE_ID guard below means it only actually commits
 *    once per email, no matter how many times it polls and finds nothing new.)
 */

const CONFIG = {
  GITHUB_REPO: 'thesob/news-podcast',   // owner/repo
  GITHUB_BRANCH: 'main',

  // Payload 1 — the podcast script. This commit triggers the build workflow.
  FILE_PATH: 'episode/script.txt',
  SCRIPT_START_MARKER: '<<<PODCAST_SCRIPT_START>>>',
  SCRIPT_END_MARKER: '<<<PODCAST_SCRIPT_END>>>',

  // Payload 2 — the Hypothesis Watch daily log line. Appended, one line per
  // email, to a published page the daily agent fetches read-only.
  HYPO_LOG_PATH: 'docs/hypothesis-log.md',
  HYPO_LOG_START_MARKER: '<<<HYPOTHESIS_LOG_START>>>',
  HYPO_LOG_END_MARKER: '<<<HYPOTHESIS_LOG_END>>>',

  // Payload 3 — the periodic integral review. Present in the email only on
  // the first brief of each calendar month; appended as a markdown section.
  HYPO_REVIEW_PATH: 'docs/hypothesis-reviews.md',
  HYPO_REVIEW_START_MARKER: '<<<HYPOTHESIS_REVIEW_START>>>',
  HYPO_REVIEW_END_MARKER: '<<<HYPOTHESIS_REVIEW_END>>>',

  GMAIL_SEARCH: 'subject:"Daily News Brief" newer_than:1d',
};

// Written verbatim as the top of docs/hypothesis-log.md the first time the
// file has to be created. Everything below the header is machine-appended.
const HYPO_LOG_SEED =
  '# Hypothesis Watch — daily log\n' +
  '\n' +
  'One dated line per brief, oldest first. Format:\n' +
  '`YYYY-MM-DD | a: <support|challenge|neutral> — <reason> | b: … | c: … | d: …`\n' +
  '\n' +
  'Sub-claims of the standing hypothesis: (a) shrinking thought-leadership /\n' +
  'authority cycles, (b) individuals pushed toward a stronger internal voice,\n' +
  '(c) a move away from individualism, (d) more human collaboration and social\n' +
  'cohesion. Appended automatically by scripts/gmail-to-github.gs; the daily\n' +
  'agent fetches this file read-only. Do not edit entries by hand.\n';

// Written verbatim as the top of docs/hypothesis-reviews.md on first create.
const HYPO_REVIEW_SEED =
  '# Hypothesis Watch — integral reviews\n' +
  '\n' +
  'Periodic reviews — first brief of each calendar month — of the standing\n' +
  'hypothesis as a whole causal chain (a → b → c → d), each ending in an\n' +
  'explicit verdict: net support / net challenge / inconclusive. Newest review\n' +
  'appended at the bottom by scripts/gmail-to-github.gs. Do not edit by hand.\n';

/**
 * Run this manually (from the editor) any time you want to force a retry —
 * e.g. after fixing a bad token — even though pushDailyScriptToGithub
 * already skips this itself on any failed commit going forward.
 */
function clearProcessedMarker() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_PROCESSED_MESSAGE_ID');
  Logger.log('Cleared LAST_PROCESSED_MESSAGE_ID.');
}

function pushDailyScriptToGithub() {
  const found = findTodaysBrief_();
  if (!found) {
    // Normal outcome on most polling runs: no new/matching email yet.
    return;
  }

  const props = PropertiesService.getScriptProperties();
  if (found.messageId === props.getProperty('LAST_PROCESSED_MESSAGE_ID')) {
    // Already handled this exact email on an earlier poll — skip to avoid
    // re-triggering the GitHub Action (and re-running TTS) repeatedly.
    return;
  }

  // 1. The podcast script — the primary product and the pipeline trigger.
  //    If this fails, stop and retry the whole thing next poll.
  if (!commitToGithub_(found.scriptText)) {
    Logger.log('Script commit failed for message ' + found.messageId +
      ' — NOT marking processed, will retry on next poll.');
    return;
  }

  // 2 + 3. Hypothesis Watch bookkeeping. Best-effort: a failure here must not
  //    wedge the podcast pipeline, but we still don't mark the message
  //    processed, so the (content-checked, double-write-safe) appends retry
  //    on the next poll.
  let auxOk = true;

  if (found.logLine) {
    auxOk = appendHypothesisLogLine_(found.logLine) && auxOk;
  } else {
    Logger.log('No HYPOTHESIS_LOG block in message ' + found.messageId +
      ' — skipping the daily log append.');
  }

  if (found.reviewBlock) {
    auxOk = appendHypothesisReview_(found.reviewBlock) && auxOk;
  }

  if (auxOk) {
    props.setProperty('LAST_PROCESSED_MESSAGE_ID', found.messageId);
    Logger.log('Processed and committed message ' + found.messageId + '.');
  } else {
    Logger.log('Script committed, but a Hypothesis Watch append failed for ' +
      'message ' + found.messageId + ' — NOT marking processed; the appends ' +
      'will retry next poll (script commit is content-checked, no re-trigger).');
  }
}

/**
 * Looks for today's brief email and pulls the delimited payload blocks out of
 * its plain-text body. Returns { messageId, scriptText, logLine, reviewBlock }
 * or null if nothing usable is found yet. scriptText is required (null return
 * if absent); logLine is expected daily but tolerated missing; reviewBlock is
 * present only on the first brief of a month.
 */
function findTodaysBrief_() {
  const threads = GmailApp.search(CONFIG.GMAIL_SEARCH, 0, 5);
  if (threads.length === 0) {
    return null;
  }

  // Most recent matching thread, most recent message in it
  const messages = threads[0].getMessages();
  const message = messages[messages.length - 1];
  const body = message.getPlainBody();

  const scriptText = extractBetween_(
    body, CONFIG.SCRIPT_START_MARKER, CONFIG.SCRIPT_END_MARKER);
  if (!scriptText) {
    return null; // matching email found but script block not present yet — retry next poll
  }

  return {
    messageId: message.getId(),
    scriptText: scriptText,
    logLine: extractBetween_(
      body, CONFIG.HYPO_LOG_START_MARKER, CONFIG.HYPO_LOG_END_MARKER),
    reviewBlock: extractBetween_(
      body, CONFIG.HYPO_REVIEW_START_MARKER, CONFIG.HYPO_REVIEW_END_MARKER),
  };
}

/**
 * Pulls the text between a start and end marker out of a plain-text email
 * body. Returns null if the markers aren't both present (or are out of
 * order). Result is trimmed.
 */
function extractBetween_(plainBody, startMarker, endMarker) {
  const startIdx = plainBody.indexOf(startMarker);
  const endIdx = plainBody.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }
  return plainBody.substring(startIdx + startMarker.length, endIdx).trim();
}

// ---------------------------------------------------------------------------
// GitHub Contents API helpers
// ---------------------------------------------------------------------------

function githubHeaders_() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    throw new Error('GITHUB_TOKEN not set in Script Properties.');
  }
  return {
    Authorization: 'token ' + token,
    Accept: 'application/vnd.github+json',
  };
}

function contentsApiUrl_(path) {
  return 'https://api.github.com/repos/' + CONFIG.GITHUB_REPO + '/contents/' + path;
}

/**
 * GETs a file from the repo on CONFIG.GITHUB_BRANCH. Returns
 * { code, sha, text }:
 *   code 200 → sha + decoded UTF-8 text populated
 *   code 404 → sha null, text null (file doesn't exist yet)
 *   other    → sha null, text null, and the response is logged
 */
function getFile_(path) {
  const resp = UrlFetchApp.fetch(
    contentsApiUrl_(path) + '?ref=' + CONFIG.GITHUB_BRANCH,
    { method: 'get', headers: githubHeaders_(), muteHttpExceptions: true }
  );
  const code = resp.getResponseCode();
  if (code === 200) {
    const body = JSON.parse(resp.getContentText());
    const text = Utilities.newBlob(
      Utilities.base64Decode(String(body.content).replace(/\s/g, ''))
    ).getDataAsString('UTF-8');
    return { code: code, sha: body.sha, text: text };
  }
  if (code !== 404) {
    Logger.log('Unexpected GET ' + path + ': ' + code + ' ' + resp.getContentText());
  }
  return { code: code, sha: null, text: null };
}

/**
 * Creates (sha omitted/null) or updates (sha given) a file. Returns true on
 * success, false on failure.
 */
function putFile_(path, content, commitMessage, sha) {
  const payload = {
    message: commitMessage,
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
    branch: CONFIG.GITHUB_BRANCH,
  };
  if (sha) payload.sha = sha;

  const resp = UrlFetchApp.fetch(contentsApiUrl_(path), {
    method: 'put',
    contentType: 'application/json',
    headers: githubHeaders_(),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  if (code === 200 || code === 201) {
    Logger.log('PUT ' + path + ' ok (' + code + ').');
    return true;
  }
  Logger.log('PUT ' + path + ' failed: ' + code + ' ' + resp.getContentText());
  return false;
}

// ---------------------------------------------------------------------------
// The three payload writers
// ---------------------------------------------------------------------------

/**
 * Commits episode/script.txt (create or update). Skips the commit entirely if
 * the file is already byte-identical to the new content, so a retried poll
 * never produces a redundant commit that would re-trigger the build workflow.
 * Returns true on success (including the "already up to date" case).
 */
function commitToGithub_(content) {
  const current = getFile_(CONFIG.FILE_PATH);
  if (current.code === 200 && current.text.trim() === content.trim()) {
    Logger.log('script.txt already at this content — skipping commit.');
    return true;
  }
  if (current.code !== 200 && current.code !== 404) {
    return false; // couldn't read current state; don't blind-write
  }
  const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  return putFile_(CONFIG.FILE_PATH, content, 'Daily script ' + today, current.sha);
}

/**
 * Appends today's Hypothesis Watch log line to docs/hypothesis-log.md,
 * seeding the file (header + line) if it doesn't exist yet. Idempotent: if a
 * line for the same date is already present, does nothing and returns true.
 */
function appendHypothesisLogLine_(logLine) {
  const line = logLine.trim();
  if (!line) return true;

  const dateKey = /^\d{4}-\d{2}-\d{2}/.test(line) ? line.substring(0, 10) : line;
  const current = getFile_(CONFIG.HYPO_LOG_PATH);

  if (current.code === 404) {
    Logger.log('Seeding ' + CONFIG.HYPO_LOG_PATH + '.');
    return putFile_(
      CONFIG.HYPO_LOG_PATH,
      HYPO_LOG_SEED + '\n' + line + '\n',
      'Seed hypothesis log (' + dateKey + ')',
      null
    );
  }
  if (current.code !== 200) return false;

  const already = current.text.split('\n').some(function (l) {
    return l.trim().indexOf(dateKey) === 0;
  });
  if (already) {
    Logger.log('hypothesis-log.md already has an entry for ' + dateKey + ' — skipping.');
    return true;
  }

  const updated = current.text.replace(/\s+$/, '') + '\n' + line + '\n';
  return putFile_(
    CONFIG.HYPO_LOG_PATH, updated, 'Hypothesis log ' + dateKey, current.sha);
}

/**
 * Appends the integral-review markdown block to docs/hypothesis-reviews.md,
 * seeding the file if needed. Idempotent on the "(YYYY-MM)" tag carried in
 * the block's "## Integral Review — <Month YYYY> (<YYYY-MM>)" header line
 * (falls back to the current UTC month if the tag can't be parsed).
 */
function appendHypothesisReview_(reviewBlock) {
  const block = reviewBlock.trim();
  if (!block) return true;

  const monthMatch = block.match(/\((\d{4}-\d{2})\)/);
  const monthKey = monthMatch
    ? monthMatch[1]
    : Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM');

  const current = getFile_(CONFIG.HYPO_REVIEW_PATH);

  if (current.code === 404) {
    Logger.log('Seeding ' + CONFIG.HYPO_REVIEW_PATH + '.');
    return putFile_(
      CONFIG.HYPO_REVIEW_PATH,
      HYPO_REVIEW_SEED + '\n' + block + '\n',
      'Seed hypothesis reviews (' + monthKey + ')',
      null
    );
  }
  if (current.code !== 200) return false;

  if (current.text.indexOf('(' + monthKey + ')') !== -1) {
    Logger.log('hypothesis-reviews.md already has a review for ' + monthKey + ' — skipping.');
    return true;
  }

  const updated = current.text.replace(/\s+$/, '') + '\n\n' + block + '\n';
  return putFile_(
    CONFIG.HYPO_REVIEW_PATH, updated, 'Integral review ' + monthKey, current.sha);
}
