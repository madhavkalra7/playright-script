# ChatGPT Playwright Dataset Builder

Automates sending prompts to ChatGPT, intercepting the SSE network response, and extracting structured data back into a CSV dataset.

## What it extracts (per prompt)

| Field | Source |
|---|---|
| `gpt_response` | Full ChatGPT answer text |
| `result_source` | Data provider (e.g. `oxylabs`, `labrador`, `bright`, `serp`) |
| `citation_domains` | Semicolon-separated domains cited |
| `pub_date` | Publication date from first citation |
| `snippet_length` | Total character count of all citation snippets |
| `citations_raw` | Full JSON array of all citations |
| `notes` | Any errors or warnings |

## Setup

### 1. Install dependencies
```bash
npm install
npx playwright install chromium
```

### 2. Log in once (saves session to auth.json)
```bash
npm run login
```
A browser opens → log in to ChatGPT manually → session is saved automatically.

### 3. Run the scraper
```bash
npm start                        # Process all unprocessed prompts
npm test                         # Dry run (2 prompts, no CSV write)
node scraper.js --limit=10       # Process only first 10 unprocessed
node scraper.js --from=20        # Start from the 20th unprocessed row
```

## How it works

1. Reads `geo_aeo_result_source_dataset.csv` and finds rows where `gpt_response` is empty
2. Opens a browser with your saved session (`auth.json`)
3. For each prompt:
   - Sets up a **network response interceptor** on `chatgpt.com/backend-api/conversation`
   - Types and sends the prompt
   - Waits for the **SSE stream** to fully complete
   - Parses all `data:` chunks from the stream
   - **Recursively searches** for `result_source` values at any depth in the JSON
   - Extracts citations (title, url, snippet, pub_date)
   - Saves updated row to CSV **immediately** (safe to interrupt and resume)
4. Navigates to a new chat and waits before the next prompt

## Files

```
├── scraper.js              Main automation script
├── login.js                One-time session saver
├── geo_aeo_result_source_dataset.csv
├── auth.json               Saved browser session (created by login.js)
├── utils/
│   ├── csvHandler.js       CSV read/write
│   └── responseParser.js   SSE stream parser + data extractor
└── package.json
```

## Notes

- **Resume-safe**: If the script is interrupted, re-running `npm start` will skip already-processed rows (those with a `gpt_response` value)
- **No credentials in code**: Auth is handled via saved browser storage state
- **GPT Go required**: `result_source` and citations require web search (GPT Go / Plus)
