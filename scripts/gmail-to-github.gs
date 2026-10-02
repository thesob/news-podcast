/**
 * Daily News Podcast — Gmail → GitHub bridge (multi-edition)
 *
 * For each configured EDITION (e.g. the English brief, the Spanish brief),
 * reads today's brief email and commits its payload to GitHub:
 *   1. the tagged podcast script  → the edition's script file (this commit is
 *      the pipeline trigger — the GitHub Action that builds the MP3 watches it)
 *   2. the Hypothesis Watch daily log line → the edition's hypothesis-log.md
 *      (one line appended per email; the file is seeded on first run)
 *   3. the periodic "integral review" markdown block, present ONLY in the
 *      first brief of each calendar month → the edition's hypothesis-reviews.md
 *      (seeded on first run; absent from the email on every other day)
 * and then (optionally) fans a clean copy of the brief out to the edition's
 * recipient list (see RECIPIENTS below).
 *
 * All payloads travel in delimited blocks in the email's PLAIN-TEXT body —
 * never as attachments — because the Gmail tool that composes the source
 * email silently corrupts non-ASCII characters in attachments (see
 * prompts/agent-prompt.md step C). The plain-text body path round-trips
 * UTF-8 correctly.
 *
 * Idempotency: a per-edition processed-message marker guards the whole run so
 * a normal poll that finds nothing new is a no-op. On top of that, each of the
 * three writes is individually content-checked (same script content → no
 * commit; a log line for a date already present → skipped; a review for a
 * month already present → skipped), so a partial failure can be safely retried
 * on the next poll without double-writing anything. Editions are processed
 * independently: one failing never blocks the others.
 *
 * SETUP:
 * 1. script.google.com -> New project -> paste this in.
 * 2. Project Settings (gear icon) -> Script Properties -> add:
 *      GITHUB_TOKEN = <your fine-grained PAT, scoped to this repo only,
 *                      Contents: Read and write>
 *    and optionally, per edition, a comma-separated recipient list (see
 *    RECIPIENTS below), e.g.  RECIPIENTS_ES = ana@example.com, luis@example.com
 * 3. Update the CONFIG constants below (repo, editions, subject lines).
 * 4. Run `pushDailyScriptToGithub` once manually from the editor to trigger
 *    Google's permission prompts (Gmail read/send + external requests).
 *    Approve them.
 * 5. Triggers (clock icon, left sidebar) -> Add Trigger:
 *      Function: pushDailyScriptToGithub
 *      Event source: Time-driven -> Minutes timer -> Every 5 minutes
 *    (Apps Script has no native "on email received" trigger, so this polls
 *    frequently instead — effectively near-instant, and safe to run all day:
 *    the processed-message marker means it only actually commits once per
 *    email, no matter how many times it polls and finds nothing new.)
 *
 * RECIPIENTS: the agent emails ONLY the owner (the email carries the
 * machine-readable blocks in its plain-text part). Anyone else who should
 * receive an edition is listed in that edition's recipientsProp Script
 * Property; after the commits succeed this script sends each of them a copy
 * with the marker blocks stripped and a link to the podcast feed. The same
 * address may appear in several editions' lists (→ gets both). Addresses
 * already on the original email's To line are skipped, so the owner never
 * gets a duplicate. No property set → no fan-out (the pre-edition behavior).
 */

const CONFIG = {
  GITHUB_REPO: 'thesob/news-podcast',   // owner/repo
  GITHUB_BRANCH: 'main',

  // Shared payload delimiters — identical for every edition.
  SCRIPT_START_MARKER: '<<<PODCAST_SCRIPT_START>>>',
  SCRIPT_END_MARKER: '<<<PODCAST_SCRIPT_END>>>',
  HYPO_LOG_START_MARKER: '<<<HYPOTHESIS_LOG_START>>>',
  HYPO_LOG_END_MARKER: '<<<HYPOTHESIS_LOG_END>>>',
  HYPO_REVIEW_START_MARKER: '<<<HYPOTHESIS_REVIEW_START>>>',
  HYPO_REVIEW_END_MARKER: '<<<HYPOTHESIS_REVIEW_END>>>',

  // The default edition ('en') keeps the original flat paths and the original
  // processed-marker property, so nothing about the running setup moves.
  // Every other edition lives in its own subfolder; its script commit triggers
  // the same workflow (paths: episode/*/script.txt), which builds that edition.
  //   id            – matches EDITION in build_episode.py / editions/<id>/
  //   gmailSearch   – must match ONLY this edition's source email (distinct
  //                   subject lines per edition!)
  //   scriptPath    – Payload 1, the podcast script (commit = pipeline trigger)
  //   hypoLogPath   – Payload 2, appended one line per email
  //   hypoReviewPath– Payload 3, monthly integral review
  //   markerProp    – Script Property holding the last processed message id
  //   recipientsProp– Script Property: comma-separated extra recipients
  //   feedUrl       – podcast feed linked in the fan-out copy (optional)
  EDITIONS: [
    {
      id: 'en',
      gmailSearch: 'subject:"Daily News Brief" newer_than:1d',
      scriptPath: 'episode/script.txt',
      hypoLogPath: 'docs/hypothesis-log.md',
      hypoReviewPath: 'docs/hypothesis-reviews.md',
      markerProp: 'LAST_PROCESSED_MESSAGE_ID',
      recipientsProp: 'RECIPIENTS_EN',
      feedUrl: 'https://thesob.github.io/news-podcast/feed.xml',
    },
    {
      id: 'es',
      gmailSearch: 'subject:"Resumen Diario" newer_than:1d',
      scriptPath: 'episode/es/script.txt',
      hypoLogPath: 'docs/es/hypothesis-log.md',
      hypoReviewPath: 'docs/es/hypothesis-reviews.md',
      markerProp: 'LAST_PROCESSED_MESSAGE_ID_ES',
      recipientsProp: 'RECIPIENTS_ES',
      feedUrl: 'https://thesob.github.io/news-podcast/es/feed.xml',
    },
  ],
  DEFAULT_EDITION_ID: 'en',

  // Give up on a recipient after this many failed sends for one message, so a
  // permanently bad address can't retry every 5 minutes all day.
  FANOUT_MAX_ATTEMPTS: 3,
};

// Written verbatim as the top of an edition's hypothesis-log.md the first time
// the file has to be created. Everything below the header is machine-appended.
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

// Written verbatim as the top of an edition's hypothesis-reviews.md on first create.
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
 * already skips this itself on any failed commit going forward. Clears every
 * edition's processed marker; use clearProcessedMarkerFor_('es') style calls
 * from a wrapper if you only want one.
 */
function clearProcessedMarker() {
  CONFIG.EDITIONS.forEach(function (ed) {
    clearProcessedMarkerFor_(ed.id);
  });
}

function clearProcessedMarkerFor_(editionId) {
  const ed = editionById_(editionId);
  PropertiesService.getScriptProperties().deleteProperty(ed.markerProp);
  PropertiesService.getScriptProperties().deleteProperty(fanoutProp_(ed));
  Logger.log('Cleared processed marker for edition ' + ed.id + '.');
}

function editionById_(id) {
  const found = CONFIG.EDITIONS.filter(function (e) { return e.id === id; })[0];
  if (!found) throw new Error('Unknown edition: ' + id);
  return found;
}

/** ' [es]' for non-default editions, '' for the default — keeps the existing
 *  English commit messages exactly as they were. */
function editionLabel_(ed) {
  return ed.id === CONFIG.DEFAULT_EDITION_ID ? '' : ' [' + ed.id + ']';
}

function pushDailyScriptToGithub() {
  CONFIG.EDITIONS.forEach(function (ed) {
    // One edition failing (bad search, API hiccup) must not block the others.
    try {
      processEdition_(ed);
    } catch (e) {
      Logger.log('Edition ' + ed.id + ' failed: ' + e);
    }
  });
}

function processEdition_(ed) {
  const found = findTodaysBrief_(ed);
  if (!found) {
    // Normal outcome on most polling runs: no new/matching email yet.
    return;
  }

  const props = PropertiesService.getScriptProperties();
  if (found.messageId === props.getProperty(ed.markerProp)) {
    // Already handled this exact email on an earlier poll — skip to avoid
    // re-triggering the GitHub Action (and re-running TTS) repeatedly.
    return;
  }

  // 1. The podcast script — the primary product and the pipeline trigger.
  //    If this fails, stop and retry the whole thing next poll.
  if (!commitToGithub_(ed, found.scriptText)) {
    Logger.log('[' + ed.id + '] Script commit failed for message ' + found.messageId +
      ' — NOT marking processed, will retry on next poll.');
    return;
  }

  // 2 + 3. Hypothesis Watch bookkeeping. Best-effort: a failure here must not
  //    wedge the podcast pipeline, but we still don't mark the message
  //    processed, so the (content-checked, double-write-safe) appends retry
  //    on the next poll.
  let auxOk = true;

  if (found.logLine) {
    auxOk = appendHypothesisLogLine_(ed, found.logLine) && auxOk;
  } else {
    Logger.log('[' + ed.id + '] No HYPOTHESIS_LOG block in message ' + found.messageId +
      ' — skipping the daily log append.');
  }

  if (found.reviewBlock) {
    auxOk = appendHypothesisReview_(ed, found.reviewBlock) && auxOk;
  }

  // 4. Fan the brief out to the edition's extra recipients. Tracked per
  //    recipient, so a retry only sends to whoever is still outstanding.
  auxOk = fanOutBrief_(ed, found) && auxOk;

  if (auxOk) {
    props.setProperty(ed.markerProp, found.messageId);
    Logger.log('[' + ed.id + '] Processed and committed message ' + found.messageId + '.');
  } else {
    Logger.log('[' + ed.id + '] Script committed, but a follow-up step (Hypothesis Watch ' +
      'append / recipient fan-out) failed for message ' + found.messageId +
      ' — NOT marking processed; it will retry next poll (script commit is ' +
      'content-checked, no re-trigger; already-emailed recipients are skipped).');
  }
}

/**
 * Looks for the edition's latest brief email and pulls the delimited payload
 * blocks out of its plain-text body. Returns
 * { messageId, scriptText, logLine, reviewBlock, message } or null if nothing
 * usable is found yet. scriptText is required; logLine is expected daily but
 * tolerated missing; reviewBlock is present only on the first brief of a month.
 *
 * Scans messages newest-first and takes the first one that actually carries
 * the script block, so copies without markers (the fan-out copy this script
 * sends, or anything forwarded) are simply passed over.
 */
function findTodaysBrief_(ed) {
  const threads = GmailApp.search(ed.gmailSearch, 0, 5);

  for (let t = 0; t < threads.length; t++) {
    const messages = threads[t].getMessages();
    for (let m = messages.length - 1; m >= 0; m--) {
      const message = messages[m];
      const body = message.getPlainBody();

      const scriptText = extractBetween_(
        body, CONFIG.SCRIPT_START_MARKER, CONFIG.SCRIPT_END_MARKER);
      if (!scriptText) continue; // no script block in this message — keep looking

      return {
        messageId: message.getId(),
        scriptText: scriptText,
        logLine: extractBetween_(
          body, CONFIG.HYPO_LOG_START_MARKER, CONFIG.HYPO_LOG_END_MARKER),
        reviewBlock: extractBetween_(
          body, CONFIG.HYPO_REVIEW_START_MARKER, CONFIG.HYPO_REVIEW_END_MARKER),
        message: message,
      };
    }
  }
  return null; // matching email not here yet (or script block not present) — retry next poll
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

/** Removes every marker-delimited block (markers included) from a plain body. */
function stripMarkedBlocks_(plainBody) {
  let out = plainBody;
  [
    [CONFIG.SCRIPT_START_MARKER, CONFIG.SCRIPT_END_MARKER],
    [CONFIG.HYPO_LOG_START_MARKER, CONFIG.HYPO_LOG_END_MARKER],
    [CONFIG.HYPO_REVIEW_START_MARKER, CONFIG.HYPO_REVIEW_END_MARKER],
  ].forEach(function (pair) {
    const s = out.indexOf(pair[0]);
    const e = out.indexOf(pair[1]);
    if (s !== -1 && e > s) {
      out = out.substring(0, s) + out.substring(e + pair[1].length);
    }
  });
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Recipient fan-out
// ---------------------------------------------------------------------------

function fanoutProp_(ed) {
  return 'FANOUT_STATE_' + ed.id;
}

function parseAddresses_(csv) {
  return String(csv || '')
    .split(/[,;\s]+/)
    .map(function (a) { return a.trim().toLowerCase(); })
    .filter(function (a) { return a.indexOf('@') > 0; });
}

/**
 * Sends each configured extra recipient a copy of the brief: the HTML body
 * (the brief itself) plus a plain fallback with the machine blocks stripped,
 * and a listen link to the edition's feed. One individual email per
 * recipient so nobody sees anyone else's address. State per message id is
 * kept in a Script Property: { messageId, sent: [...], attempts: {addr: n} }.
 * Returns true when nobody is left outstanding (including "no recipients").
 */
function fanOutBrief_(ed, found) {
  const props = PropertiesService.getScriptProperties();
  const configured = parseAddresses_(props.getProperty(ed.recipientsProp));
  if (configured.length === 0) return true;

  // Skip anyone already on the original email (the owner gets that directly).
  const original = parseAddresses_(found.message.getTo() + ',' + found.message.getCc());
  const targets = configured.filter(function (a) { return original.indexOf(a) === -1; });

  let state = { messageId: found.messageId, sent: [], attempts: {} };
  try {
    const saved = JSON.parse(props.getProperty(fanoutProp_(ed)) || 'null');
    if (saved && saved.messageId === found.messageId) state = saved;
  } catch (e) { /* corrupt state → start fresh for this message */ }

  const plain = stripMarkedBlocks_(found.message.getPlainBody());
  const feedHtml = ed.feedUrl
    ? '<p style="font-size:13px;color:#666">Podcast feed: <a href="' + ed.feedUrl + '">' + ed.feedUrl + '</a></p>'
    : '';
  const feedText = ed.feedUrl ? '\n\nPodcast feed: ' + ed.feedUrl : '';
  const html = found.message.getBody() + feedHtml;

  let outstanding = 0;
  targets.forEach(function (addr) {
    if (state.sent.indexOf(addr) !== -1) return;
    const tries = state.attempts[addr] || 0;
    if (tries >= CONFIG.FANOUT_MAX_ATTEMPTS) return; // given up; logged when it happened
    try {
      GmailApp.sendEmail(addr, found.message.getSubject(), plain + feedText, {
        htmlBody: html,
        name: found.message.getFrom().replace(/\s*<.*>$/, '') || undefined,
      });
      state.sent.push(addr);
      Logger.log('[' + ed.id + '] Sent brief copy to ' + addr + '.');
    } catch (e) {
      state.attempts[addr] = tries + 1;
      Logger.log('[' + ed.id + '] Send to ' + addr + ' failed (attempt ' +
        state.attempts[addr] + '/' + CONFIG.FANOUT_MAX_ATTEMPTS + '): ' + e);
      if (state.attempts[addr] < CONFIG.FANOUT_MAX_ATTEMPTS) outstanding++;
    }
  });

  props.setProperty(fanoutProp_(ed), JSON.stringify(state));
  return outstanding === 0;
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
 * Commits the edition's script file (create or update). Skips the commit
 * entirely if the file is already byte-identical to the new content, so a
 * retried poll never produces a redundant commit that would re-trigger the
 * build workflow. Returns true on success (including "already up to date").
 */
function commitToGithub_(ed, content) {
  const current = getFile_(ed.scriptPath);
  if (current.code === 200 && current.text.trim() === content.trim()) {
    Logger.log('[' + ed.id + '] ' + ed.scriptPath + ' already at this content — skipping commit.');
    return true;
  }
  if (current.code !== 200 && current.code !== 404) {
    return false; // couldn't read current state; don't blind-write
  }
  const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  return putFile_(
    ed.scriptPath, content, 'Daily script' + editionLabel_(ed) + ' ' + today, current.sha);
}

/**
 * Appends today's Hypothesis Watch log line to the edition's hypothesis-log.md,
 * seeding the file (header + line) if it doesn't exist yet. Idempotent: if a
 * line for the same date is already present, does nothing and returns true.
 */
function appendHypothesisLogLine_(ed, logLine) {
  const line = logLine.trim();
  if (!line) return true;

  const dateKey = /^\d{4}-\d{2}-\d{2}/.test(line) ? line.substring(0, 10) : line;
  const current = getFile_(ed.hypoLogPath);

  if (current.code === 404) {
    Logger.log('[' + ed.id + '] Seeding ' + ed.hypoLogPath + '.');
    return putFile_(
      ed.hypoLogPath,
      (ed.hypoLogSeed || HYPO_LOG_SEED) + '\n' + line + '\n',
      'Seed hypothesis log' + editionLabel_(ed) + ' (' + dateKey + ')',
      null
    );
  }
  if (current.code !== 200) return false;

  const already = current.text.split('\n').some(function (l) {
    return l.trim().indexOf(dateKey) === 0;
  });
  if (already) {
    Logger.log('[' + ed.id + '] ' + ed.hypoLogPath + ' already has an entry for ' + dateKey + ' — skipping.');
    return true;
  }

  const updated = current.text.replace(/\s+$/, '') + '\n' + line + '\n';
  return putFile_(
    ed.hypoLogPath, updated, 'Hypothesis log' + editionLabel_(ed) + ' ' + dateKey, current.sha);
}

/**
 * Appends the integral-review markdown block to the edition's
 * hypothesis-reviews.md, seeding the file if needed. Idempotent on the
 * "(YYYY-MM)" tag carried in the block's
 * "## Integral Review — <Month YYYY> (<YYYY-MM>)" header line (falls back to
 * the current UTC month if the tag can't be parsed).
 */
function appendHypothesisReview_(ed, reviewBlock) {
  const block = reviewBlock.trim();
  if (!block) return true;

  const monthMatch = block.match(/\((\d{4}-\d{2})\)/);
  const monthKey = monthMatch
    ? monthMatch[1]
    : Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM');

  const current = getFile_(ed.hypoReviewPath);

  if (current.code === 404) {
    Logger.log('[' + ed.id + '] Seeding ' + ed.hypoReviewPath + '.');
    return putFile_(
      ed.hypoReviewPath,
      (ed.hypoReviewSeed || HYPO_REVIEW_SEED) + '\n' + block + '\n',
      'Seed hypothesis reviews' + editionLabel_(ed) + ' (' + monthKey + ')',
      null
    );
  }
  if (current.code !== 200) return false;

  if (current.text.indexOf('(' + monthKey + ')') !== -1) {
    Logger.log('[' + ed.id + '] ' + ed.hypoReviewPath + ' already has a review for ' + monthKey + ' — skipping.');
    return true;
  }

  const updated = current.text.replace(/\s+$/, '') + '\n\n' + block + '\n';
  return putFile_(
    ed.hypoReviewPath, updated, 'Integral review' + editionLabel_(ed) + ' ' + monthKey, current.sha);
}
