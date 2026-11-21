#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_MINER_ID = "5530";
export const DEFAULT_MINER_SLUG = "telegraph-verity-intelligence";
export const CATALOG_BASE_URL = "https://devnode.telegraphprotocol.com";
export const ANJOMAN_API_BASE_URL = "https://backend.telegraphprotocol.com";
export const DISCOVERY_INTENT = "CODE_REVIEW_GENERAL";
export const MAX_PARAMS_BYTES = 12000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseResponseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function normalizeIntentName(value) {
  const intent = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,95}$/.test(intent)) {
    throw new Error("Enter a canonical intent name using letters, digits, and underscores.");
  }
  return intent;
}

export function parseParamsJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Parameters must be valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error('Parameters must be a JSON object, such as {"query":"example"}.');
  }
  const byteLength = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
  if (byteLength > MAX_PARAMS_BYTES) {
    throw new Error("Parameters exceed the 12,000-byte safety limit.");
  }
  return parsed;
}

export function getRequestParams(contract) {
  return Array.isArray(contract?.request?.params) ? contract.request.params : null;
}

function matchesType(value, type) {
  switch (String(type ?? "").toLowerCase()) {
    case "string":
    case "date":
    case "datetime":
    case "enum":
    case "url":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
    case "bool":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
    case "list":
      return Array.isArray(value);
    default:
      return true;
  }
}

export function validateTypedParams(contract, params) {
  if (!isRecord(params)) throw new Error("Typed parameters must be a JSON object.");
  const fields = getRequestParams(contract);
  if (!fields || fields.length === 0) {
    throw new Error("This Intent has no published typed request schema; use a plain-language query.");
  }
  const names = new Set(fields.map((field) => field.name));
  const unknown = Object.keys(params).filter((name) => !names.has(name));
  if (unknown.length) {
    throw new Error("Unknown parameter field(s): " + unknown.join(", "));
  }
  const missing = fields
    .filter((field) => field.required && !Object.hasOwn(params, field.name))
    .map((field) => field.name);
  if (missing.length) {
    throw new Error("Missing required parameter(s): " + missing.join(", "));
  }
  for (const field of fields) {
    if (!Object.hasOwn(params, field.name)) continue;
    if (!matchesType(params[field.name], field.type)) {
      throw new Error("Parameter " + field.name + " must have type " + field.type + ".");
    }
    const allowed = field.allowed ?? field.enum;
    if (Array.isArray(allowed) && !allowed.includes(params[field.name])) {
      throw new Error("Parameter " + field.name + " must be one of: " + allowed.join(", ") + ".");
    }
    const value = params[field.name];
    const minimum = field.minimum ?? field.min;
    const maximum = field.maximum ?? field.max;
    if (typeof value === "number" && Number.isFinite(minimum) && value < minimum) {
      throw new Error("Parameter " + field.name + " must be at least " + minimum + ".");
    }
    if (typeof value === "number" && Number.isFinite(maximum) && value > maximum) {
      throw new Error("Parameter " + field.name + " must be at most " + maximum + ".");
    }
  }
  return params;
}

export function buildDirectRequest(intent, contract, { params, query } = {}) {
  const normalizedIntent = normalizeIntentName(intent);
  const fields = getRequestParams(contract);
  if (fields?.length) {
    if (String(query ?? "").trim()) {
      throw new Error("This Intent has a typed schema; provide params JSON or a query, not both.");
    }
    return { intent: normalizedIntent, params: validateTypedParams(contract, params ?? {}) };
  }
  if (params && Object.keys(params).length) {
    throw new Error("This Intent has no published typed request schema; provide a plain-language query instead.");
  }
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery) {
    throw new Error("This Intent has no published typed request schema; a plain-language query is required.");
  }
  if (new TextEncoder().encode(normalizedQuery).byteLength > MAX_PARAMS_BYTES) {
    throw new Error("The query exceeds the 12,000-byte safety limit.");
  }
  return { intent: normalizedIntent, query: normalizedQuery };
}

async function readJsonResponse(fetchImpl, url, label) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  const body = parseResponseJson(text);
  if (!response.ok) {
    throw new Error(label + " returned HTTP " + response.status + ".");
  }
  return body;
}

export async function discoverMiner(fetchImpl = fetch, {
  catalogBase = process.env.TELEGRAPH_CATALOG_BASE_URL || CATALOG_BASE_URL,
  minerId = process.env.TELEGRAPH_MINER_ID || DEFAULT_MINER_ID,
  minerSlug = process.env.TELEGRAPH_MINER_SLUG || DEFAULT_MINER_SLUG
} = {}) {
  const url = new URL("/api/miners", catalogBase);
  url.searchParams.set("intent", DISCOVERY_INTENT);
  url.searchParams.set("limit", "100");
  const payload = await readJsonResponse(fetchImpl, url, "Miner catalog");
  const miners = Array.isArray(payload) ? payload : payload?.miners;
  if (!Array.isArray(miners)) throw new Error("Miner catalog returned an unexpected response.");
  const miner = miners.find((item) =>
    String(item.id) === String(minerId) && item.slug === minerSlug
  );
  if (!miner) {
    throw new Error("The catalog did not verify miner " + minerId + " with slug " + minerSlug + ".");
  }
  if (miner.activation_status !== "active") {
    throw new Error("Miner " + minerId + " is not active in the catalog; no paid request was sent.");
  }
  if (!Array.isArray(miner.supported_intents)) {
    throw new Error("The catalog did not provide this Miner's supported Intent list.");
  }
  return miner;
}

export async function fetchIntentContract(fetchImpl, intent, {
  catalogBase = process.env.TELEGRAPH_CATALOG_BASE_URL || CATALOG_BASE_URL
} = {}) {
  const normalizedIntent = normalizeIntentName(intent);
  const url = new URL("/engine/v1/intents/" + encodeURIComponent(normalizedIntent), catalogBase);
  const contract = await readJsonResponse(fetchImpl, url, "Intent schema");
  const returnedName = contract.intent_name ?? contract.name;
  if (returnedName && String(returnedName).toUpperCase() !== normalizedIntent) {
    throw new Error("The live schema name did not match the selected Intent.");
  }
  return contract;
}

function redact(text, secret) {
  const value = String(text ?? "Unknown error");
  return secret ? value.split(secret).join("[redacted]") : value;
}

export async function sendPaidRequest(fetchImpl, request, {
  apiKey,
  apiBase = process.env.TELEGRAPH_API_BASE_URL || ANJOMAN_API_BASE_URL,
  minerId = process.env.TELEGRAPH_MINER_ID || DEFAULT_MINER_ID
} = {}) {
  if (!apiKey) throw new Error("TELEGRAPH_API_KEY is required.");
  const url = new URL("/engine/ask/" + encodeURIComponent(minerId), apiBase);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + apiKey
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(60000)
  });
  const raw = await response.text();
  const payload = parseResponseJson(raw);
  if (!response.ok) {
    const message = payload.message ?? payload.error ?? "Request failed.";
    throw new Error("Direct miner request returned HTTP " + response.status + ": " + redact(message, apiKey));
  }
  const inner = payload?.receipt && isRecord(payload?.result) ? payload.result : payload;
  const returnedMinerId = inner.miner_id ?? inner.minerId ?? payload.miner_id ?? payload.minerId ?? null;
  return {
    httpStatus: response.status,
    minerId: returnedMinerId,
    minerMismatch: returnedMinerId != null && String(returnedMinerId) !== String(minerId),
    costUsd: inner.cost_usd ?? inner.costUsd ?? payload.cost_usd ?? payload.costUsd ?? null,
    signalHash: inner.signal_hash ?? inner.signalHash ?? payload.signal_hash ?? payload.signalHash ?? payload.receipt_hash ?? null,
    result: inner.result ?? (inner === payload ? payload.result : inner),
    resultShape: inner.result_shape ?? inner.resultShape ?? payload.result_shape ?? payload.resultShape ?? null
  };
}

function describeParams(fields) {
  for (const field of fields) {
    const requirement = field.required ? "required" : "optional";
    const description = field.description ? " — " + field.description : "";
    stdout.write("  " + field.name + " (" + field.type + ", " + requirement + ")" + description + "\n");
  }
}

async function promptJson(question) {
  const raw = await question("Paste the request parameters as one JSON object: ");
  return parseParamsJson(raw);
}

export async function runInteractiveAgent({
  fetchImpl = fetch,
  env = process.env,
  input = stdin,
  output = stdout
} = {}) {
  const apiKey = env.TELEGRAPH_API_KEY;
  if (!apiKey) throw new Error("Set TELEGRAPH_API_KEY in your local environment; the value is never displayed.");
  const rl = createInterface({ input, output });
  const question = (prompt) => rl.question(prompt);
  try {
    const miner = await discoverMiner(fetchImpl);
    output.write("Verified active miner " + miner.name + " (" + miner.id + ", " + miner.slug + ").\n");
    output.write("Supported Intents from the live catalog:\n");
    for (const intent of miner.supported_intents) output.write("  " + intent + "\n");

    const intent = normalizeIntentName(await question("Choose an Intent: "));
    const supported = miner.supported_intents.map((name) => String(name).toUpperCase());
    if (!supported.includes(intent)) {
      throw new Error("The selected Intent is not listed for miner " + miner.id + "; no paid request was sent.");
    }

    const contract = await fetchIntentContract(fetchImpl, intent);
    const fields = getRequestParams(contract);
    let request;
    if (fields?.length) {
      output.write("Live typed request fields:\n");
      describeParams(fields);
      const params = await promptJson(question);
      request = buildDirectRequest(intent, contract, { params });
    } else {
      output.write("No typed request fields are published for this Intent.\n");
      const query = await question("Enter a plain-language request: ");
      request = buildDirectRequest(intent, contract, { query });
    }

    const floor = Number(miner.min_price_usdc);
    if (Number.isFinite(floor)) {
      output.write("Published miner floor: $" + (floor / 1000000).toFixed(6) + " USD; final cost may differ.\n");
    }
    output.write("This sends one paid request directly to miner " + miner.id + "; there are no retries.\n");
    const confirmation = await question("Type SEND to continue, or anything else to cancel: ");
    if (confirmation.trim() !== "SEND") {
      output.write("Cancelled; no paid request was sent.\n");
      return null;
    }

    const receipt = await sendPaidRequest(fetchImpl, request, { apiKey, minerId: String(miner.id) });
    output.write("HTTP status: " + receipt.httpStatus + "\n");
    output.write("Miner ID: " + (receipt.minerId ?? "Unavailable") + "\n");
    output.write("Cost USD: " + (receipt.costUsd ?? "Unavailable") + "\n");
    output.write("Signal hash: " + (receipt.signalHash ?? "Unavailable") + "\n");
    if (receipt.minerMismatch) {
      output.write("ERROR: The response miner ID did not match the requested miner.\n");
      process.exitCode = 1;
      return receipt;
    }
    output.write("Result:\n" + JSON.stringify(receipt.result, null, 2) + "\n");
    return receipt;
  } finally {
    rl.close();
  }
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  runInteractiveAgent().catch((error) => {
    const message = String(error?.message ?? error).split(process.env.TELEGRAPH_API_KEY ?? "\0").join("[redacted]");
    console.error("ProofGate intent request stopped:", message);
    process.exitCode = 1;
  });
}
