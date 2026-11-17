import { readFile } from "node:fs/promises";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const engine = (process.env.TELEGRAPH_ENGINE_URL || "https://devnode.telegraphprotocol.com/engine").replace(/\/$/, "");
const key = process.env.TELEGRAPH_EVM_PRIVATE_KEY;
const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
const token = process.env.GITHUB_TOKEN;
const eventPath = process.env.GITHUB_EVENT_PATH;
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const maxDiffBytes = Number(process.env.PROOFGATE_MAX_DIFF_BYTES || 12000);
const targetMinerId = process.env.TELEGRAPH_MINER_ID || "5530";

if (!key || !repo || !sha || !token || !eventPath) {
  throw new Error("Missing required runtime configuration. Set TELEGRAPH_EVM_PRIVATE_KEY and provide GitHub Actions context.");
}
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("TELEGRAPH_EVM_PRIVATE_KEY must be a 32-byte EVM private key.");
if (!Number.isInteger(maxDiffBytes) || maxDiffBytes < 256 || maxDiffBytes > 24000) {
  throw new Error("PROOFGATE_MAX_DIFF_BYTES must be an integer from 256 through 24000.");
}

const event = JSON.parse(await readFile(eventPath, "utf8"));
const pr = event.pull_request;
if (!pr?.number) throw new Error("This workflow only handles pull_request events.");
if (pr.head?.repo?.full_name !== repo) {
  throw new Error("Fork pull requests are skipped so payment secrets are never exposed to untrusted code.");
}

const signer = privateKeyToAccount(key);
const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));
const paidFetch = wrapFetchWithPayment(fetch, client);

async function github(path, init = {}) {
  const response = await fetch(`${apiUrl}/repos/${repo}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...init.headers
    }
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return response;
}

const repository = await (await github("")).json();
if (repository.private !== false) {
  throw new Error("ProofGate only sends code from public repositories to Telegraph. Private repository review is disabled.");
}

const diffResponse = await github(`/pulls/${pr.number}`, { headers: { accept: "application/vnd.github.diff" } });
const diff = await diffResponse.text();
const encoder = new TextEncoder();
const bytes = encoder.encode(diff);
const boundedDiff = bytes.byteLength > maxDiffBytes
  ? new TextDecoder().decode(bytes.slice(0, maxDiffBytes)) + "\n[ProofGate: diff truncated at configured byte limit]"
  : diff;
if (!boundedDiff.trim()) throw new Error("The pull request has an empty diff; no review request was sent.");

const ref = `${repo}@${sha}`;
const tasks = [
  {
    intent: "CODE_REVIEW_GENERAL",
    params: { code: boundedDiff },
    title: "Telegraph code review"
  },
  {
    intent: "SECURITY_REVIEW_GENERAL",
    params: { target: `${repo} pull request #${pr.number} at ${sha}; review the changed code for security weaknesses.` },
    title: "Telegraph security review"
  },
  {
    intent: "CODE_PATCH_VERIFY_GENERAL",
    params: { patch: `${ref} (pull request #${pr.number})` },
    title: "Telegraph patch / CI verification"
  },
  {
    intent: "REGRESSION_VERIFY_GENERAL",
    params: { change: `${ref} (pull request #${pr.number})` },
    title: "Telegraph regression check"
  }
];
const cveIds = [...new Set(boundedDiff.match(/\bCVE-\d{4}-\d{4,}\b/gi) || [])].slice(0, 2);
for (const cveId of cveIds) {
  tasks.push({
    intent: "CVE_LOOKUP_CVSS",
    params: { cve_id: cveId.toUpperCase() },
    title: `Telegraph CVE lookup · ${cveId.toUpperCase()}`
  });
}

const results = [];
for (const task of tasks) {
  const response = await paidFetch(`${engine}/v1/ask/${encodeURIComponent(targetMinerId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: task.intent, params: task.params })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    results.push({ ...task, error: body.message || body.error || `Engine HTTP ${response.status}` });
    continue;
  }
  if (body.miner_id != null && String(body.miner_id) !== String(targetMinerId)) {
    results.push({ ...task, error: `Engine returned miner ${body.miner_id}; expected directly targeted miner ${targetMinerId}.` });
    continue;
  }
  results.push({
    ...task,
    result: body.result ?? null,
    minerId: body.miner_id ?? null,
    costUsd: body.cost_usd ?? null,
    signalHash: body.signal_hash ?? null,
    resultShape: body.result_shape ?? null
  });
}

const lines = [
  `## ProofGate · Telegraph PR Intelligence`,
  `Pull request: #${pr.number} · commit: \`${sha}\``,
  `Requests: ${results.length} · source diff bytes: ${bytes.byteLength} · analyzed bytes: ${encoder.encode(boundedDiff).byteLength}`,
  ``,
  `| Check | Outcome | Miner | Cost USD | Signal |`,
  `|---|---|---:|---:|---|`
];
for (const item of results) {
  const outcome = item.error ? `Unavailable: ${item.error}` : `\`${JSON.stringify(item.result)}\``;
  lines.push(`| ${item.title} (${item.intent}) | ${outcome.replaceAll("|", "\\|")} | ${item.minerId ?? "Unavailable"} | ${item.costUsd ?? "Unavailable"} | ${item.signalHash ?? "Unavailable"} |`);
}
lines.push("", "> Advisory intelligence only. A clean or incomplete result is not proof that the change is secure. Review the cited result and run your own CI/security checks.");
const summary = lines.join("\n");
if (summaryPath) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(summaryPath, `${summary}\n`);
}

const critical = results.some(item => {
  const text = JSON.stringify(item.result ?? {}).toLowerCase();
  return text.includes("insecure") || text.includes("request changes") || text.includes('"passed":false') || text.includes('"regression_found":true');
});
const errors = results.some(item => item.error);
const conclusion = errors ? "neutral" : critical ? "failure" : "success";
await github(`/check-runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "ProofGate / Telegraph PR Intelligence",
    head_sha: sha,
    status: "completed",
    conclusion,
    output: {
      title: "Telegraph intelligence checks complete",
      summary,
      text: "Results are advisory and reflect the selected Telegraph miners' responses. They are not a substitute for CI or a complete security audit."
    }
  })
});
if (errors) process.exitCode = 0;
