# Results

| Folder or file | What it holds |
|---|---|
| `before/` | The starting code, measured on 3 cases (5, 6 and 7): one `*.summary.json` per case with its answer, time and cost. |
| `after/` | The final code, measured live on 5 cases (1, 5, 6, 7 and 9). |
| `live-memorias/` | Two live sessions using Memorias: each conversation record, its quote records and the memories record (`memory.jsonl`). |
| `traces/dhl-blocked/` | The Playwright trace of a carrier that blocks the automated browser, with its evidence screenshot. Open it with `npx playwright show-trace results/traces/dhl-blocked/dhl.trace.zip`. |
| `scorecard.md` | Pass or fail, time and cost per case, before and after. Rebuilt from the folders above with `npm run score`; manual grades come from `cases/grades.json`. |

A `quote-*.jsonl` is the append-only record of one quote: every step, every price as reported and as verified against the page text, and why each carrier closed. A `conversation-*.jsonl` is the chat around it. A `*.summary.json` holds the time, cost and answer of one measured case.
