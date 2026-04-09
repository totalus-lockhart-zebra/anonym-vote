/**
 * GitHub storage — tlock edition
 *
 * Only vote files exist now (no reveal files).
 * Each file has: address, nullifier, ciphertext (tlock-encrypted choice).
 */

import {
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH,
  GITHUB_TOKEN,
} from './config.js';

const BASE = 'https://api.github.com';

function headers() {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function ghGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} → ${res.status}`);
  return res.json();
}

async function ghPut(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub PUT ${path} → ${res.status}`);
  }
  return res.json();
}

function votePath(proposalId, address) {
  return `proposals/${proposalId}/votes/vote-${address}.json`;
}

export async function readFile(filePath) {
  const data = await ghGet(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`,
  );
  if (!data) return null;
  const decoded = atob(data.content.replace(/\n/g, ''));
  return JSON.parse(decoded);
}

export async function writeFile(filePath, content, commitMessage) {
  const existing = await ghGet(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`,
  );
  const body = {
    message: commitMessage,
    content: btoa(JSON.stringify(content, null, 2)),
    branch: GITHUB_BRANCH,
  };
  if (existing?.sha) body.sha = existing.sha;
  return ghPut(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`,
    body,
  );
}

export async function listFiles(dirPath) {
  const data = await ghGet(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${dirPath}?ref=${GITHUB_BRANCH}`,
  );
  if (!data || !Array.isArray(data)) return [];
  return data.filter((f) => f.type === 'file');
}

export async function saveVote(proposalId, address, artifact) {
  return writeFile(
    votePath(proposalId, address),
    artifact,
    `vote: tlock commitment for ${proposalId}`,
  );
}

export async function hasVoted(proposalId, address) {
  const data = await ghGet(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${votePath(proposalId, address)}?ref=${GITHUB_BRANCH}`,
  );
  return data !== null;
}

export async function loadVotes(proposalId) {
  const files = await listFiles(`proposals/${proposalId}/votes`);
  const results = await Promise.all(
    files.map(async (f) => {
      try {
        return await readFile(f.path);
      } catch {
        return null;
      }
    }),
  );
  return results.filter(Boolean);
}
