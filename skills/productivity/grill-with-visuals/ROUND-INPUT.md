# Round input

Write one `round.json` beside any visual fragments. Run `scripts/render-round.mjs <round.json>` from the repo being grilled. The output folder is the input file's folder. The renderer writes `index.html`, `grill.css`, `grill.js`, and any glossary explainers; stdout is ready to paste into chat and stderr reports glossary matches, explainer stubs, and whether the round has pictures. It does not open the browser or take screenshots.

```json
{
  "topic": "Retry policy",
  "round": 2,
  "context": "We are deciding how long a request can wait.",
  "contextLink": { "label": "Design note", "href": "../docs/retries.md" },
  "settled": [{ "number": 1, "decision": "Retry no more than once." }],
  "questions": [
    {
      "number": 2,
      "title": "Retry delay",
      "body": "When should the retry run?",
      "options": [
        { "name": "Immediately", "detail": "Lowest added delay, but the fault may still be active." },
        { "name": "After a pause", "detail": "Adds latency but gives the service time to recover." }
      ],
      "recommendedOption": "B",
      "recommendation": "Wait a second so the service can recover.",
      "visual": { "today": { "file": "q2-today.html" }, "views": { "A": { "file": "q2-a.html" }, "B": { "file": "q2-b.html" } } }
    },
    {
      "number": 3,
      "title": "No second retry",
      "body": "Return the last error if the retry fails?",
      "recommendation": "Return it unchanged so the caller can act on it."
    }
  ]
}
```

- **Round:** `topic` and `questions` are required. Set a positive `round` while questions are open. `context`, `contextLink`, `settled`, and `exclude` (an array of glossary names to skip) are optional. Give each question and decision its original number, once per input. `questions: []` produces a settled page; optionally add `closingTable: { "headers": ["Comment", "Outcome"], "rows": [["Timeout", "Approved"]] }` for a review summary.
- **Question:** `number`, `title`, `body`, and `recommendation` are required. Write those as plain text; newlines in the body preserve breaks. The renderer adds “Yes” or the option letter to the recommendation. For choices, give `options` in order (letters are assigned from A) and name the recommended letter in `recommendedOption`. Include the meaning and trade-off in each option's `detail`.
- **Visual:** Omit `visual` for text-only questions. Use `visual.html` for one picture, or `visual.views` with one fragment per option when views differ. Add `visual.today` for a Today pane, `visual.label` for a plain-text caption above the picture, and `visual.intro`/`visual.after` for shared content such as statechart rules and chart provenance. Each fragment is trusted local HTML: a string or `{ "file": "relative/path.html" }` under the round folder. Author fragments yourself; quote or escape any untrusted material from issues, review comments, or repo content before embedding it. Use matching kinds of picture on both sides and across options. The renderer supplies comparison titles, wrappers, and view switching hooks. See [visuals](VISUALS.md) for what to draw.
- **Review sections:** For a ticket draft or PR approval packet, add `sections: [{ "title": "Our response", "text": "The complete draft reply.", "visual": { "file": "fix-diff.html" } }]` to a question. The page shows the sections in order after the recommendation and any question visual; the chat copy stays terse. `title` and `text` are literal, `visual` is optional and takes one fragment. Keep the complete draft in `text`, not in the picture.
- **Legend:** Today, Proposed, and Recommendation are inferred when used by the card shell. For colours used inside fragments, add `legend: { "today": true, "proposed": true, "aside": "what the fourth colour means" }` as needed.
