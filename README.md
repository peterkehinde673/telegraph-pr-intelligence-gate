# ProofGate — Telegraph PR Intelligence

ProofGate makes four typed Telegraph requests directly to miner 5530 for an eligible pull request: `CODE_REVIEW_GENERAL`, `SECURITY_REVIEW_GENERAL`, `CODE_PATCH_VERIFY_GENERAL`, and `REGRESSION_VERIFY_GENERAL`. It also looks for CVE identifiers in the diff and makes up to two additional `CVE_LOOKUP_CVSS` requests. Miner 5530's active registry entry advertises all five Intents. The app records the returned result, miner ID, cost, and signal hash where the Engine supplies them, and marks the result unavailable if the Engine reports a different miner.

The workflow is gated by the protected `telegraph-testnet` GitHub Environment. Each event can incur up to six paid requests. ProofGate can pay with an Anjoman API key or, as a legacy option, an EVM wallet. It always targets Miner ID 5530 by default. ProofGate never stores a key in the repository. Fork pull requests and private repositories are skipped, the diff is truncated to a configurable byte limit, and the app does not merge or change code. Set `TELEGRAPH_MINER_ID` to override the default target miner ID 5530.

## Setup

1. Fork this repository or copy it into a public repository you control.
2. Enable the `telegraph-testnet` GitHub Environment and require reviewer approval before the job can access secrets.
3. Add `TELEGRAPH_API_KEY` as an **environment secret** in `telegraph-testnet`. Anjoman API-key calls are paid from your Anjoman account balance, so check that balance first. The API key is preferred when both credentials are set. Alternatively, use `TELEGRAPH_EVM_PRIVATE_KEY` for the legacy wallet-payment mode.
4. Review and enable the workflow. Each eligible PR update can make up to six paid requests.
5. The workflow posts a GitHub Check and step summary with outcomes and available request receipts.

With `TELEGRAPH_API_KEY`, ProofGate calls Anjoman's authenticated direct-miner endpoint at `https://backend.telegraphprotocol.com/engine/ask/{minerId}`. It sends the typed Intent and params, so the request remains targeted to Miner 5530 rather than being auto-routed. API-key calls use the account's escrow balance and cannot use the free trial. Without an API key, the legacy path uses the x402 EVM client packages and EIP-3009 authorization. The app must be run by its owner to produce a live paid receipt.

## Scope and limitations

- These are separate ranked Intent requests, not one magical consensus verdict. Inspect each result independently.
- The patch and regression Intents check a repository/change reference; their responses may be unavailable if the selected miners cannot access it.
- The code/security requests receive the PR diff as text; the app does not upload private repositories to a third-party code host beyond the Telegraph request itself. Requests may be public in Telegraph feeds, so do not run on confidential diffs without understanding the platform's disclosure model.
- A passing review is not proof of safety. The app never auto-merges.
- No retries are attempted after a paid request fails. Results are marked unavailable and the workflow continues to collect the remaining checks.
- Keep the miner's YAML, provider secrets, private evaluation materials, and production endpoint credentials out of this app repository.

## Verify locally

Install the listed dependencies, then inspect the live schemas at `GET /engine/v1/intents/{intent}` before use. Do not run against production unless the operator explicitly chooses the environment and accepts the per-request cost.
## Request any supported miner Intent

The interactive intent agent can make one direct request to the active Telegraph Verity Intelligence miner using the live registry and typed schema. It lists the supported Intents, checks the selected Intent against the miner record, shows required fields from the live schema, and validates the JSON parameters before offering a paid call. If Telegraph publishes no typed request fields, it asks for a plain-language query instead.

Run it locally with Node 20 or newer:

```sh
npm run ask-intent
```

Set TELEGRAPH_API_KEY in the local shell environment before starting. The key is never prompted for or printed. Use only public-safe input: the request content is sent to Telegraph. The agent shows the registered minimum price, asks you to type SEND, makes at most one paid request, and does not retry. The final response includes the returned miner ID, cost, signal hash, and result where available.

The interactive agent is a local operator tool; its request text is not sent through GitHub Actions. It does not call all Intents automatically and does not change the miner registration or YAML.

Run the offline unit tests with:

```sh
npm test
```

Tests use mocked catalog, schema, and payment responses; they do not make paid requests.
