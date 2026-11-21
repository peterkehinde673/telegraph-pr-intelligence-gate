import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDirectRequest,
  discoverMiner,
  fetchIntentContract,
  normalizeIntentName,
  parseParamsJson,
  sendPaidRequest,
  validateTypedParams
} from "../src/intent-agent.mjs";

const codeReviewContract = {
  intent_name: "CODE_REVIEW_GENERAL",
  request: {
    params: [
      { name: "code", type: "string", required: true, description: "Code to review" },
      { name: "language", type: "enum", required: false, allowed: ["js", "ts"] }
    ]
  }
};

test("normalizes canonical intent names and rejects malformed names", () => {
  assert.equal(normalizeIntentName(" fact_check_general "), "FACT_CHECK_GENERAL");
  assert.throws(() => normalizeIntentName("bad intent"), /canonical intent name/);
});

test("parses only bounded JSON objects for typed inputs", () => {
  assert.deepEqual(parseParamsJson('{"claim":"A public claim"}'), { claim: "A public claim" });
  assert.throws(() => parseParamsJson("[]"), /JSON object/);
  assert.throws(() => parseParamsJson("{"), /valid JSON/);
});

test("typed params enforce required names, known fields, types, and enum values", () => {
  assert.deepEqual(validateTypedParams(codeReviewContract, { code: "const x = 1", language: "js" }), {
    code: "const x = 1",
    language: "js"
  });
  assert.throws(() => validateTypedParams(codeReviewContract, {}), /Missing required/);
  assert.throws(() => validateTypedParams(codeReviewContract, { code: 3 }), /must have type string/);
  assert.throws(() => validateTypedParams(codeReviewContract, { code: "x", extra: true }), /Unknown parameter/);
  assert.throws(() => validateTypedParams(codeReviewContract, { code: "x", language: "py" }), /must be one of/);
});

test("builds typed requests from published request fields", () => {
  assert.deepEqual(buildDirectRequest("code_review_general", codeReviewContract, {
    params: { code: "function add(a,b) { return a+b; }" }
  }), {
    intent: "CODE_REVIEW_GENERAL",
    params: { code: "function add(a,b) { return a+b; }" }
  });
  assert.throws(() => buildDirectRequest("CODE_REVIEW_GENERAL", codeReviewContract, {
    params: { code: "x" },
    query: "also send a query"
  }), /not both/);
});

test("uses a query when an Intent has no published typed request schema", () => {
  assert.deepEqual(buildDirectRequest("SOME_UNTYPED_INTENT", {
    intent_name: "SOME_UNTYPED_INTENT",
    request: {}
  }, { query: "Answer a public-safe question" }), {
    intent: "SOME_UNTYPED_INTENT",
    query: "Answer a public-safe question"
  });
  assert.throws(() => buildDirectRequest("SOME_UNTYPED_INTENT", {
    intent_name: "SOME_UNTYPED_INTENT",
    request: {}
  }, { params: { value: "x" } }), /plain-language query/);
});

test("discovers only the exact active miner identity from the filtered catalog", async () => {
  let calls = 0;
  const fetchMock = async (url) => {
    calls += 1;
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/api/miners");
    assert.equal(parsed.searchParams.get("intent"), "CODE_REVIEW_GENERAL");
    return new Response(JSON.stringify([
      { id: "5530", slug: "different-miner", activation_status: "active", supported_intents: [] },
      { id: "5530", slug: "telegraph-verity-intelligence", activation_status: "active",
        supported_intents: ["CODE_REVIEW_GENERAL", "FACT_CHECK_GENERAL"], min_price_usdc: 10000 }
    ]), { status: 200, headers: { "content-type": "application/json" } });
  };
  const miner = await discoverMiner(fetchMock);
  assert.equal(calls, 1);
  assert.equal(miner.slug, "telegraph-verity-intelligence");
  assert.deepEqual(miner.supported_intents, ["CODE_REVIEW_GENERAL", "FACT_CHECK_GENERAL"]);
});

test("refuses a non-active target miner before any paid call", async () => {
  const fetchMock = async () => new Response(JSON.stringify([
    { id: "5530", slug: "telegraph-verity-intelligence", activation_status: "paused",
      supported_intents: ["CODE_REVIEW_GENERAL"] }
  ]), { status: 200 });
  await assert.rejects(() => discoverMiner(fetchMock), /not active/);
});

test("fetches the live canonical schema for the selected Intent", async () => {
  const fetchMock = async (url) => {
    assert.match(String(url), /\/engine\/v1\/intents\/FACT_CHECK_GENERAL$/);
    return new Response(JSON.stringify({
      intent_name: "FACT_CHECK_GENERAL",
      request: { params: [{ name: "claim", type: "string", required: true }] }
    }), { status: 200 });
  };
  const contract = await fetchIntentContract(fetchMock, "fact_check_general");
  assert.equal(contract.intent_name, "FACT_CHECK_GENERAL");
});

test("sends exactly one direct paid call and returns receipt metadata", async () => {
  let calls = 0;
  const key = "anjoman_test_secret";
  const fetchMock = async (url, init) => {
    calls += 1;
    assert.equal(String(url), "https://backend.telegraphprotocol.com/engine/ask/5530");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer " + key);
    assert.deepEqual(JSON.parse(init.body), {
      intent: "CODE_REVIEW_GENERAL",
      params: { code: "function add(a,b) { return a+b; }" }
    });
    return new Response(JSON.stringify({
      miner_id: "5530",
      cost_usd: 0.01,
      signal_hash: "0x1234",
      result: { verdict: "Approve" }
    }), { status: 200 });
  };
  const receipt = await sendPaidRequest(fetchMock, {
    intent: "CODE_REVIEW_GENERAL",
    params: { code: "function add(a,b) { return a+b; }" }
  }, { apiKey: key });
  assert.equal(calls, 1);
  assert.equal(receipt.minerId, "5530");
  assert.equal(receipt.costUsd, 0.01);
  assert.equal(receipt.signalHash, "0x1234");
  assert.deepEqual(receipt.result, { verdict: "Approve" });
});

test("does not retry rejected paid-call requests and redacts the key from errors", async () => {
  let calls = 0;
  const key = "anjoman_test_secret";
  const fetchMock = async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: "Rejected key " + key }), { status: 422 });
  };
  await assert.rejects(
    () => sendPaidRequest(fetchMock, { intent: "CODE_REVIEW_GENERAL", params: { code: "x" } }, { apiKey: key }),
    (error) => {
      assert.match(error.message, /HTTP 422/);
      assert.doesNotMatch(error.message, new RegExp(key));
      return true;
    }
  );
  assert.equal(calls, 1);
});
