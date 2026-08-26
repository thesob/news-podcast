/**
 * Daily News Podcast — Gmail → GitHub bridge
 *
 * Reads today's "Daily News Brief" email, extracts the tagged podcast script
 * from a delimited block in the email's plain-text body, and commits it to
 * GitHub as episode/script.txt. That commit triggers the existing GitHub
 * Actions workflow which builds the MP3 and updates the podcast RSS feed.
 *
 * NOTE: this used to read the script from a script.txt attachment instead.
 * That was switched to a delimited plain-text body block because the Gmail
 * attachment tool used to compose the source email silently corrupts
 * non-ASCII characters (see prompts/agent-prompt.md step C for the details) —
 * the plain-text body path does not go through that broken code path and
 * round-trips UTF-8 correctly.
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
  FILE_PATH: 'episode/script.txt',
  GMAIL_SEARCH: 'subject:"Daily News Brief" newer_than:1d',
  SCRIPT_START_MARKER: '<<<PODCAST_SCRIPT_START>>>',
  SCRIPT_END_MARKER: '<<<PODCAST_SCRIPT_END>>>',
};

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
  const found = findTodaysScript_();
  if (!found) {
    // Normal outcome on most polling runs: no new/matching email yet.
    return;
  }

  const props = PropertiesService.getScriptProperties();
  const lastProcessedId = props.getProperty('LAST_PROCESSED_MESSAGE_ID');
  if (found.messageId === lastProcessedId) {
    // Already handled this exact email on an earlier poll — skip to avoid
    // re-triggering the GitHub Action (and re-running TTS) repeatedly.
    return;
  }

  const success = commitToGithub_(found.scriptText);
  if (success) {
    props.setProperty('LAST_PROCESSED_MESSAGE_ID', found.messageId);
    Logger.log('Processed and committed message ' + found.messageId + '.');
  } else {
    Logger.log('Commit failed for message ' + found.messageId +
      ' — NOT marking as processed, will retry on next poll.');
  }
}

/**
 * Looks for today's brief email and extracts the delimited script block from
 * its plain-text body. Returns { messageId, scriptText } or null if nothing
 * found yet.
 */
function findTodaysScript_() {
  const threads = GmailApp.search(CONFIG.GMAIL_SEARCH, 0, 5);
  if (threads.length === 0) {
    return null;
  }

  // Most recent matching thread, most recent message in it
  const messages = threads[0].getMessages();
  const message = messages[messages.length - 1];
  const messageId = message.getId();

  const scriptText = extractDelimitedScript_(message.getPlainBody());
  if (!scriptText) {
    return null; // matching email found but script block not present yet — retry next poll
  }

  return { messageId: messageId, scriptText: scriptText };
}

/**
 * Pulls the text between CONFIG.SCRIPT_START_MARKER and
 * CONFIG.SCRIPT_END_MARKER out of a plain-text email body. Returns null if
 * the markers aren't both present (or are out of order).
 */
function extractDelimitedScript_(plainBody) {
  const startIdx = plainBody.indexOf(CONFIG.SCRIPT_START_MARKER);
  const endIdx = plainBody.indexOf(CONFIG.SCRIPT_END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }
  return plainBody
    .substring(startIdx + CONFIG.SCRIPT_START_MARKER.length, endIdx)
    .trim();
}

/**
 * Commits (creates or updates) the script file in the GitHub repo.
 * Returns true on success, false on failure.
 */
function commitToGithub_(content) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  if (!token) {
    throw new Error('GITHUB_TOKEN not set in Script Properties.');
  }

  const apiUrl =
    'https://api.github.com/repos/' + CONFIG.GITHUB_REPO +
    '/contents/' + CONFIG.FILE_PATH;

  const headers = {
    Authorization: 'token ' + token,
    Accept: 'application/vnd.github+json',
  };

  // Get the current file's SHA (required by GitHub's API to update a file)
  const getResp = UrlFetchApp.fetch(
    apiUrl + '?ref=' + CONFIG.GITHUB_BRANCH,
    { method: 'get', headers: headers, muteHttpExceptions: true }
  );

  let sha = null;
  if (getResp.getResponseCode() === 200) {
    sha = JSON.parse(getResp.getContentText()).sha;
  } else if (getResp.getResponseCode() !== 404) {
    Logger.log('Unexpected response fetching current file: ' +
      getResp.getResponseCode() + ' ' + getResp.getContentText());
  }

  const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  const payload = {
    message: 'Daily script ' + today,
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
    branch: CONFIG.GITHUB_BRANCH,
  };
  if (sha) payload.sha = sha;

  const putResp = UrlFetchApp.fetch(apiUrl, {
    method: 'put',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = putResp.getResponseCode();
  if (code === 200 || code === 201) {
    Logger.log('Committed script.txt successfully (' + code + ').');
    return true;
  } else {
    Logger.log('GitHub commit failed: ' + code + ' ' + putResp.getContentText());
    return false;
  }
}
