# Quest

Quest is Waterloo's PeopleSoft Campus Solutions portal at `quest.pecs.uwaterloo.ca`. The six Quest tools are read-only and use the Waterloo sign-in that LEARN, Odyssey and Marmoset already use. There is no second login.

## How sign-in works

The Quest sign-in page has no form. Its **Sign In** button runs `getIdPLink()`, which goes to an ADFS IdP-initiated URL:

```
https://adfs.uwaterloo.ca/adfs/ls/idpinitiatedsignon.aspx?LoginToRP=urn:quest.ss.apps.uwaterloo.ca
```

When the encrypted browser session in `state/browser.json` is used, ADFS accepts its existing cookies. Duo then passes through its prompt page without asking anything, because the saved browser is already remembered. The browser lands on the Fluid homepage (`NUI_FRAMEWORK.PT_LANDINGPAGE.GBL`). This was observed on the live host on 2026-11-24.

If ADFS or Duo ever wants a password or a new factor, the browser stays on their pages. After 40 seconds the read stops and does not touch either page. The tool then runs the same `renew.mjs` renewal that Odyssey and Marmoset use, retries once, and otherwise returns `AUTH_REAUTH_REQUIRED`.

The Quest cookies made after sign-in are kept in memory for 15 minutes, so later reads skip the ADFS round trip. They are never written to disk. They are dropped when `browser.json` changes or when Quest sends the browser back to its sign-in page.

## Where the data is

The Fluid tiles are wrappers around classic components, and every read uses those classic components directly.

| Data                    | Component                                   | Notes                                                                                                                      |
| ----------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Enrolment appointment   | `SA_LEARNER_SERVICES.SSR_SSENRL_APPT.GBL`   | Pick a term, then **Continue**. `ENRL_*` rows are appointments; `OPEN_*` rows are open-enrolment dates.                    |
| Shopping cart           | `SA_LEARNER_SERVICES_2.SSR_SSENRL_CART.GBL` | Rows are `P_CLASS_NAME$n` etc. Status is the image alt text (Open, Closed, Wait List). The page has no component column.   |
| Component for cart rows | `SA_LEARNER_SERVICES.CLASS_SEARCH.GBL`      | One exact subject and catalog search per course, with **open classes only** turned off. `MTG_CLASSNAME` gives `002-LEC`.   |
| Class schedule          | `SA_LEARNER_SERVICES.SSR_SSENRL_LIST.GBL`   | `DERIVED_REGFRM1_DESCR20$k` holds one course. A row with an empty class number is another meeting of the section above it. |
| Grades                  | `UW_SS_MENU.UW_SSR_SSENRL_GRDE.GBL`         | Waterloo's own component. The standard `SSR_SSENRL_GRADE` returns "not authorized".                                        |
| Unofficial transcript   | `SA_LEARNER_SERVICES.SSS_TSRQST_UNOFF.GBL`  | Report type `UGUN`, then **View Report**. The result is a PDF download (`SSR_TSRPT.pdf`).                                  |
| Holds                   | `CC_PORTFOLIO.SS_CC_HOLDS.GBL`              | Shows "There are no current holds." when there are none.                                                                   |
| To-do list              | `CC_PORTFOLIO.SS_CC_TODOS.GBL`              | Returns "not authorized" for this account. The Student Center also has no To Do box.                                       |

`STRM` codes are `1` + the last two digits of the year + the season month: 1 for Winter, 5 for Spring, 9 for Fall. So 1271 is Winter 2027 and 1269 is Fall 2026.

## Side effects and limits

- Each fresh transcript read adds one "Undergrad Unofficial" entry to Quest's **Previous Requests** list. Viewing the transcript on the website does the same. The tool reuses a transcript for 10 minutes to keep that list short.
- The class search, term choice and transcript request are PeopleSoft form posts. The tools never press Validate, Enroll, Add, Drop, Swap, Edit or Delete. The browser is blocked from Quest's logout URL and from every host other than Quest, Waterloo ADFS and Duo.
- Quest calls a full section "Closed". The tools report that word and do not guess between full and administratively closed.
- Course averages and term statistics were not posted yet when this was built (Fall 2026 grades release on Dec 24, 2026). The grade and transcript parsers keep any average or statistics lines Quest shows, but this was checked only against synthetic text.
- Quest has scheduled maintenance windows, shown on its sign-in page. Reads during them return `QUEST_UNAVAILABLE`.
- Quest content is treated as untrusted data. Results carry `contentIsUntrusted: true`.
