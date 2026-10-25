# Apify demo snapshots

Demo mode reads a customer's website from `<domain>.json` here instead of crawling it. The seed's customers are
fictional, so these pages are written for the demo and say so in their `synthesized` field; the app labels them
"demo snapshot", never "crawled". With `APIFY_TOKEN` set, `apps/agents/src/apify.ts` crawls the real domain instead,
and a failed crawl shows nothing rather than falling back to these pages.
