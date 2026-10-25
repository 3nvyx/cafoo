# Cafoo Advisor

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

A finance advisor you can chat with: the Chief Finance Advisor of Cafoo, an agentic finance team that closes the books every month.
Ask how the business is doing and it asks its specialist agents, then answers with interactive cards and plain advice.

| | |
|---|---|
| Agent name | Cafoo Advisor |
| Agent address | `agent1q0umtvqa3es9hwpd04uhu4fman6epdmy4thrqkp50nqk5ra7al8mvqy8rde` |
| Protocol | Agent Chat Protocol 0.3.0, with ASI:One interactive cards |
| Category | Finance, accounting, month-end close |

## What it does

Closing the books takes a finance team about ten days a month: matching bank lines to invoices, accruing late bills, rebuilding revenue schedules, checking who is behind each customer and vendor.
Cafoo hands that work to a team of agents, but none of them can change the books on its own.
Worker agents only propose changes, a Red Team on a second model critiques them, the Advisor rules on each one with a written reason, and anything material waits for the human CFO's one-click confirmation.
The database itself enforces those rules, so an agent that ignores its instructions still cannot post to the ledger.

The Cafoo Advisor is the one agent you talk to.
It is an orchestrator: for each question it calls the specialists it needs, in parallel, and combines their answers into one card with advice.

| Specialist | Asked with | Answers with |
|---|---|---|
| Bookkeeper | `CashRequest(period_ym)` | `CashResponse`: cash per company in its own currency, unexplained bank lines, unpaid bills, bank matches still pending |
| Revenue | `RevenueRequest(period_ym)` | `RevenueResponse`: revenue recognized this month, revenue still to recognize, what customers owe, what is overdue |
| Credit & Risk | `CreditRequest(top)` | `CreditResponse`: customers by risk tier, the bad-debt reserve, the largest exposures, vendors blocked before payment |
| Consolidation | `GroupRequest(period_ym)` | `GroupResponse`: the group's companies and currencies, the month's exchange rates, revaluation and elimination entries |
| Red Team | `ReviewRequest(proposal_ids)` | `ReviewResponse`: its critiques of each proposed entry |

Every response says whether it succeeded.
If one specialist cannot answer, its part of the card says so and the rest of the answer still arrives.
The models are in [models.py](models.py).

## Ask it

- **"Hi"** opens the menu card.
- **Financial health check** (or "how are we doing?") asks all four business specialists at once and returns one card: cash, revenue and receivables, credit risk, the group, and what the Advisor advises you to do next.
- **Cash and the bank**, **Revenue and receivables**, **Credit risk** and **The group and FX** each ask one specialist for a closer look.
- **What needs the CFO's OK?** lists every material entry waiting for the CFO, largest first, each with a **Why?** button.
- **Why?** shows what was proposed and why, what the Red Team challenged, and how the Advisor ruled.
- **Start the close** asks the Advisor to run month-end; the worker agents start proposing and the CFO sees the results in the Cafoo app.
- **Anything else in plain English**, such as "How much cash do we have?" or "Which customers owe us the most?", is answered by the Advisor from the live books.

It reads the books and explains them.
It never confirms or posts anything: the CFO does that in the Cafoo app.

## Run it

All six agents run in one process next to the Cafoo stack (see the repository README for the ledger and the agent gateway).
Only the Advisor connects to Agentverse, through a mailbox, so the books never leave the machine they run on; it reaches its specialists locally.

```sh
cd apps/asi-advisor
python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env    # set CAFOO_ADVISOR_SEED to a long random secret
.venv/bin/python smoke.py   # end-to-end check: a test client chats with the Advisor, which calls its specialists
.venv/bin/python agent.py
```

On first start, open the Agent Inspector link printed for the Cafoo Advisor, sign in to Agentverse, and choose **Connect** > **Mailbox**.
From its profile on Agentverse, **Chat with Agent** opens it in ASI:One.
The process must keep running to answer.

| Variable | Purpose | Default |
|---|---|---|
| `CAFOO_ADVISOR_SEED` | Secret seed; fixes the Advisor's address, and the specialists' addresses derive from it | required |
| `CAFOO_LEDGER_URL`, `CAFOO_LEDGER_DB` | The Cafoo ledger (SpacetimeDB) | `http://localhost:3000`, `cafoo` |
| `CAFOO_GATEWAY_URL` | The Cafoo agent gateway, where the Advisor answers plain-English questions | `http://127.0.0.1:8787` |
| `CAFOO_GATEWAY_API_KEY` | The gateway's key, only when it runs on another machine | empty |
| `AGENT_NAME`, `AGENT_PORT` | Display name and local port | `Cafoo Advisor`, `8010` |
| `DESK_TIMEOUT_SECONDS` | How long the Advisor waits for a specialist | `20` |

Specialist addresses (local only, not listed on Agentverse):

| Agent | Address |
|---|---|
| Cafoo Bookkeeper | `agent1q268mjp7znyh33pylwdy23y6tmscxf7h2akfqrkcunumq0fdvt2nsn6cjl4` |
| Cafoo Revenue | `agent1qd0j6p9yg2uklfjgumrx59fc0fqvr6c6smftht356kkg39lza5tt6n5ppvt` |
| Cafoo Credit & Risk | `agent1q25a3cnevsjrgmrx9ddy2wqq6ujw0ms6yynpzsqexy2tjmc26gdpz3qjsp6` |
| Cafoo Consolidation | `agent1q2elptd3ff4sh5htr22h6dc0egmzejqjm07e2wwmmhfvr60z49ekcfgegfw` |
| Cafoo Red Team | `agent1qwn005l9dqmmnhk703v3r60c2dckj0kmx2s97sh38gfhvdgzpqw0wjklap2` |

## Tests

```sh
.venv/bin/python -m unittest -v test_agent   # cards, decoding, reports; live checks when the ledger is up
.venv/bin/python smoke.py                    # the real orchestrator-to-specialist path
```

## Troubleshooting

- **"I can't reach the Cafoo books right now"**: start SpacetimeDB and the agent gateway (`pnpm -F @cafoo/agents orchestrator`).
- **A card says a specialist "could not answer"**: the reason follows; usually the ledger is down or busy.
- **The agent does not answer in ASI:One**: check that `agent.py` is still running and that its mailbox is connected in the Agent Inspector.
- **Starting the close is refused**: the gateway only starts a close for this machine or a caller with its API key.
