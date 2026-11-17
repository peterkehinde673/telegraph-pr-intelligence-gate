# ProofGate — Telegraph PR Intelligence

ProofGate makes four typed Telegraph requests directly to miner 5530 for an eligible pull request: `CODE_REVIEW_GENERAL`, `SECURITY_REVIEW_GENERAL`, `CODE_PATCH_VERIFY_GENERAL`, and `REGRESSION_VERIFY_GENERAL`. It also looks for CVE identifiers in the diff and makes up to two additional `CVE_LOOKUP_CVSS` requests. Miner 5530's active registry entry advertises all five Intents. The app records the returned result, miner ID, cost, and signal hash where the Engine supplies them, and marks the result unavailable if the Engine reports a different miner.

The workflow is gated by the protected `telegraph-testnet` GitHub Environment. Each event can incur up to six paid requests. Configure a dedicated burner wallet with only the test funds you authorize. ProofGate never stores a key in the repository. Fork pull requests and private repositories are skipped, the diff is truncated to a configurable byte limit, and the app does not merge or change code. Set `TELEGRAPH_MINER_ID` to override the default target miner ID 5530.

## Setup

1. Fork this repository or copy it into a public repository you control.
2. Enable the `telegraph-testnet` GitHub Environment and require reviewer approval before the job can access secrets.
3. Add `TELEGRAPH_EVM_PRIVATE_KEY` as an environment secret for a dedicated, low-balance test wallet only. Do not use a wallet holding meaningful assets.
4. Review and enable the workflow. Each eligible PR update can make up to six paid requests.
5. The workflow posts a GitHub Check and step summary with outcomes and available request receipts.

The payment client uses the x402 EVM client packages and EIP-3009 authorization. The engine selects the accepted payment network from its 402 challenge. This repository does not include a live paid receipt yet; the app must be run by its owner with a funded test wallet to produce that evidence.

## Scope and limitations

- These are separate ranked Intent requests, not one magical consensus verdict. Inspect each result independently.
- The patch and regression Intents check a repository/change reference; their responses may be unavailable if the selected miners cannot access it.
- The code/security requests receive the PR diff as text; the app does not upload private repositories to a third-party code host beyond the Telegraph request itself. Requests may be public in Telegraph feeds, so do not run on confidential diffs without understanding the platform's disclosure model.
- A passing review is not proof of safety. The app never auto-merges.
- No retries are attempted after a paid request fails. Results are marked unavailable and the workflow continues to collect the remaining checks.
- The source checkout is currently private; publish the app as a separate public repository before using it as the submission source-code link. Keep miner configuration and private evaluation data out of that repository.

## Verify locally

Install the listed dependencies, then inspect the live schemas at `GET /engine/v1/intents/{intent}` before use. Do not run against production unless the operator explicitly chooses the environment and accepts the per-request cost.
