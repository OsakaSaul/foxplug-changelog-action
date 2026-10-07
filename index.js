// FoxPlug Changelog and Launch Posts: a GitHub Action with no dependencies and no build step
// (Node 24, built-in fetch).
//
// On a release: sends the release name, notes, tag and link.
// On a push to the default branch: sends the subject line of each commit in that push.
// Nothing else leaves the runner: no source code, no secrets, no environment.
//
// FoxPlug turns it into a changelog entry and launch posts in your project, as drafts
// waiting for your approval. Nothing is posted anywhere by this action.

"use strict";
const fs = require("fs");

const ENDPOINT = "https://fybedvapqhhgctkeqvbs.supabase.co/functions/v1/lcnc-action-ingest";
const USER_AGENT = "foxplug-changelog-action/1 (+https://github.com/OsakaSaul/foxplug-changelog-action)";
const GH_API = process.env.GITHUB_API_URL || "https://api.github.com";

function input(name) {
  return String(process.env["INPUT_" + name.toUpperCase()] || "").trim();
}
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = "FOXPLUG_" + Math.random().toString(36).slice(2);
  fs.appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
}
function summary(text) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, text + "\n");
}
function subjectOf(message) {
  return String(message || "").split("\n")[0].trim().slice(0, 300);
}

// A push event carries at most 20 commits. For a bigger push, list the rest from GitHub
// with the workflow's own token (subjects only, read on the runner).
async function pushSubjects(ev) {
  const subjects = (ev.commits || []).map((c) => subjectOf(c && c.message)).filter(Boolean);
  const size = Number(ev.size || subjects.length);
  if (size <= subjects.length || !ev.before || !ev.after || /^0+$/.test(ev.before)) return subjects;
  const token = input("github-token");
  const repo = ev.repository && ev.repository.full_name;
  try {
    const r = await fetch(`${GH_API}/repos/${repo}/compare/${ev.before}...${ev.after}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!r.ok) return subjects;
    const j = await r.json();
    const all = (j.commits || []).map((c) => subjectOf(c && c.commit && c.commit.message)).filter(Boolean);
    return all.length > subjects.length ? all : subjects;
  } catch (_e) {
    return subjects;
  }
}

async function main() {
  const token = input("foxplug-token");
  if (!token) {
    console.log("::error::No FoxPlug token. Create one in your FoxPlug project (connections, GitHub Action), add it to this repository's secrets as FOXPLUG_TOKEN, and pass it as foxplug-token.");
    process.exitCode = 1;
    return;
  }
  console.log(`::add-mask::${token}`);

  const eventName = process.env.GITHUB_EVENT_NAME || "";
  let ev = {};
  try { ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")); } catch (_e) { ev = {}; }
  const repo = (ev.repository && ev.repository.full_name) || process.env.GITHUB_REPOSITORY || "";

  let payload;
  if (eventName === "release") {
    const rel = ev.release || {};
    if (rel.draft) { console.log("This is a draft release, so nothing is sent until it is published."); return; }
    if (!["published", "released", "created"].includes(String(ev.action || "published"))) {
      console.log(`Release ${ev.action}: only a new release is sent.`); return;
    }
    payload = {
      event: "release", repo,
      release: { id: rel.id, name: rel.name || "", tag: rel.tag_name || "", notes: rel.body || "", url: rel.html_url || "" },
    };
  } else if (eventName === "push") {
    const def = ev.repository && ev.repository.default_branch;
    if (!def || ev.ref !== `refs/heads/${def}`) { console.log(`Not the default branch (${def || "unknown"}), so nothing is sent.`); return; }
    const subjects = await pushSubjects(ev);
    if (!subjects.length) { console.log("No new commits since the last run, so nothing is sent."); return; }
    payload = { event: "push", repo, branch: def, commits: subjects.map((subject) => ({ subject })) };
  } else {
    console.log(`This action runs on push and release. Nothing is sent for ${eventName || "this event"}.`);
    return;
  }
  const project = input("project");
  if (project) payload.project = project;

  let res, body = {};
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    console.log(`::warning::FoxPlug could not be reached (${e.message}). Your build is not affected; the next run will send again.`);
    return;
  }
  const message = String(body.message || `FoxPlug answered ${res.status}.`);
  setOutput("message", message);
  summary(`FoxPlug: ${message}`);
  if (res.status === 401 || res.status === 400 || res.status === 404) {
    console.log(`::error::${message}`);
    process.exitCode = 1;
  } else if (res.status >= 500) {
    console.log(`::warning::${message}`);
  } else {
    console.log(message);
  }
}

main();
