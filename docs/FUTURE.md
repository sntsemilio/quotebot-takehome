# What the core makes possible

Nothing on this page is built yet. It is what the architecture in `NOTES.md` was designed to carry.

## The core, in one paragraph
Every external site is a **data plugin**. A model does only what needs judgment. **Code verifies every fact** against what the site showed before anyone sees it. Every action leaves an **append-only record**, and code, not the model, owns the limits: budgets per agent, when to stop, when to hand off to a person. Carriers already run as **parallel agents**, one per site, each closed by code, so a blocked site never holds up the rest. QuoteBot is the first use of that core; none of the parts below needs a new one.

## 1. A richer engine: agents that hand work to each other
Today the engine runs one agent per carrier, all at once, and code merges what they verify. Next, agents that pass work along under the same contracts:
- **Quoting → customer → follow-up**, each step its own agent with its own budget, its own record and its own limits in code.
- **Code-owned hand-offs:** an agent never decides on its own that a fact is true. It hands over a record, and the next agent reads only what was verified.

## 2. A customer agent that closes the loop
A second agent dedicated to Mariana's customers, on **WhatsApp** (a WhatsApp Business connector over MCP) and **email**:
- **It knows what the quote still needs.** The quoting agent already lists the missing data per carrier (a postal code, a delivery type, a ship date). The customer agent asks the customer for exactly that, and the quote finishes without Mariana in the middle.
- **One record per customer thread:** the question, the quote, what was promised, when to follow up. Follow-ups are linear and auditable.
- **The same rule as prices:** nothing is said to a customer that the record can't back.
- **Disputes:** "I paid the difference" becomes an evidence pack per shipment, with the page text, the screenshot and the time, ready for the carrier.

## 3. A companion, not a price machine
The conversation prompt today is deliberately short and strict. Next:
- It knows her business through Memorias: her store, her boxes, her usual routes and customers.
- It suggests instead of only answering, for example "this one is a gift, the on-time option is FedEx next-day."
- It stays short, and every number still comes from code.

## 4. Always on, with its own computer
Cloud agents with their own browser keep working while she sleeps or is away from her desk: quoting the morning's questions, following up with customers, preparing the day. The autonomy is a setting, controlled in code:
1. **Suggest:** today. The bot quotes; Mariana decides.
2. **Draft for approval:** replies wait for her tap.
3. **Act on routine cases:** a known route, a known box, a price in her usual range is answered on its own and logged. Anything new goes back to step 2.

Every level runs under the controls that already exist: per-agent budgets, `needs_human` hand-offs, the manual path when a site blocks, and a record of every decision. Booking and buying labels would be a separate plugin behind an explicit approval and a spending limit; until then the agents only quote. This is how she can hand over the reins where she can't be all the time, on foundations built to be trusted.

## 5. Self-improvement, with a person in the loop
- **Failures become proposals.** Every failure is recorded with its reason and scored. Repeated ones (a suggestion list that never appears, a page that loads slower) become proposed changes to that carrier's plugin notes.
- **Proposals are tested before they ship.** Each one is replayed against past records and the scorecard, and a person approves it. Plugins are data, so no code changes.
- **Drift is caught early:** when a site changes, the scorecard shows it before her answers do.

## 6. An app she opens every day
- A notification when a quote is ready.
- Memorias and her history on her phone.
- A shareable quote for the customer, with its evidence.
- A monthly VAT export for her accountant.
- Her own numbers per route over time, from quotes she already made, with no extra site traffic.

## 7. Scale
- **More carriers:** a new data file each, plus its reconnaissance.
- **More stores:** each with its own records and memories, on a shared core.
- **More context:** context plugins for her catalog with weights and boxes, her customers, and orders from her shop platform.
- **More niches:** any business that copies numbers out of websites with no API can reuse the loop: fill public forms, verify every fact against the page, report what failed. Insurance and freight quotes, customs tariffs and supplier prices are the obvious next ones, each with its own plugins and verification rules. The same rules hold: nothing against bot protection, and no number without evidence.

## Why this is a matter of time
The time box decided how much could be polished, not how far this goes. The slow part is foundations an agent can be trusted on: verified facts, one record, limits in code. Those are in place. Everything above is time spent turning them into a product that does more than Mariana thinks she needs.
