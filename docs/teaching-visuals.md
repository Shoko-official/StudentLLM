# Teaching visuals in course chat

The assistant can mix Markdown, LaTeX, worked examples and interactive visuals in one answer. Ask for a visual explanation or an interactive lesson, for example:

- "Explique Taylor avec une courbe et un degré réglable."
- "Montre comment n et p changent une loi binomiale."
- "Explique la pression hydrostatique avec les unités, un schéma et un exemple."
- "Donne-moi un quiz avec un indice avant la correction."

The model chooses whether a visual helps. It must distinguish illustrative examples from measurements and keep course-specific claims grounded in the retrieved course evidence. A visual is generated educational content, not a verified reference answer.

In development NVIDIA mode, **Mistral Large 4** is available in the model suggestions. Synthetic trials produced usable Taylor and binomial widgets; this does not establish universal lesson accuracy, and longer responses can be slow or time out. Its connection check uses a bounded128-token final-answer probe with the same15-second deadline. Eight tokens produced reasoning-only output in the observed endpoint, while128 returned a final answer. This profile does not change the shared default or automatically switch your selection. The endpoint is documented in [NVIDIA's Mistral Large4 API reference](https://docs.api.nvidia.com/nim/reference/mistralai-mistral-large-4-1t-a52b-infer).

## Supported interactions

- **Plots:** up to four numeric series, linear numeric x coordinates, optional sliders and calculated readouts. Use integer x steps for discrete distributions. Curves and readouts recalculate locally; moving a slider makes no model or network request. The data disclosure exposes sampled, formatted values.
- **Diagrams:** directed nodes and labelled edges, such as a probability tree, process or concept relationship. Long diagrams scroll within their own region; a text equivalent lists the relations.
- **Illustrations:** typed circles, rectangles, lines, arrows and labels for sets, geometry and physical schematics. No arbitrary SVG or external assets.
- **Quizzes:** two to six choices, an optional hint, explicit answer checking, an explanation and a retry action. The expected answer is supplied by the model and should be checked when consequential.

Responses are saved with the conversation and appear again after reload or course export/import. Slider positions, opened disclosures and attempted quiz answers are temporary interface state; they reset when the answer remounts. Python and other code examples are displayed, not executed. This is not a Python notebook or a general-purpose simulation runtime.

## Response contract

The assistant embeds strict JSON in a `student-visual` code fence at the relevant point in its Markdown. Only assistant messages opt into rendering; pasted user code and imported notes stay inert. Other code fences remain ordinary code. At most eight interactive blocks render per Markdown answer. Invalid, truncated or unsupported blocks show a fallback with the generated specification, preserving the surrounding explanation.

For providers that advertise structured outputs, chat requests a strict `sections` envelope containing Markdown and typed visual objects, then validates and converts it to this saved format. A malformed envelope returns the question to the composer instead of saving an incomplete lesson. There is no automatic repair generation or model switch. Providers without that capability use the fenced Markdown contract directly.

```student-visual
{
  "type": "plot",
  "title": "Taylor approximation of exp(x)",
  "description": "Illustrative example centered at zero. Compare near the center first.",
  "x": { "min": -2, "max": 2, "label": "x" },
  "parameters": [
    { "name": "n", "label": "Degree", "min": 0, "max": 12, "step": 1, "value": 3 }
  ],
  "series": [
    { "label": "exp(x)", "expression": "exp(x)" },
    { "label": "Taylor polynomial", "expression": "sum(k,0,n,x^k/factorial(k))" }
  ],
  "outputs": [
    { "label": "Absolute error at x=1", "expression": "abs(exp(1)-sum(k,0,n,1/factorial(k)))" }
  ]
}
```

The canonical normalized types and validators are in [teaching-visuals.ts](../src/lib/teaching-visuals.ts). The generation contract is in [teaching-visual-prompt.ts](../src/lib/teaching-visual-prompt.ts). Additions must update the parser, renderer, generation instructions and relevant tests together.

Expressions use a bounded arithmetic parser, never JavaScript evaluation. Available operations are `+ - * / ^`, parentheses, `sin`, `cos`, `tan`, `exp`, `log`, `sqrt`, `abs`, `floor`, `ceil`, `round`, two-argument `min`/`max`/`pow`, `factorial`, `binomial(n,k,p)` and `sum(k,start,end,body)`. Trigonometry uses radians; `log` is natural logarithm. `binomial` returns a probability mass, not a combination count. Parameter identifiers use ASCII; human labels can use Unicode. Defaults must align with their slider steps. Outputs refer to parameters, while plotted expressions can also refer to `x`.

## Bounds and interpretation

Each block is limited to 32,768 characters. Plots have at most four series, four parameters, four readouts and 161 samples per series. Arithmetic expressions have at most 300 characters, 160 syntax nodes, depth20, 64 terms per sum and 4,096 evaluation steps. Diagrams have at most24 nodes and48 edges; figures have at most64 shapes in a bounded canvas. Unknown properties are discarded rather than passed to DOM elements.

Non-finite intermediate calculations remain undefined and appear as gaps; they cannot turn into a valid number through later arithmetic. Tiny nonzero results use scientific notation. Values in tables/readouts are formatted, not exact symbolic results. Discontinuity detection is a sampling heuristic: it cannot identify every pole, narrow feature or domain boundary. Specifying a y range clips the graph to that range. Labels, equations, units, assumptions, sampled curves and quiz keys still need mathematical review.

Rendering does not change the app's CSP or authorize image analysis. It adds no external script, asset or host. Generating a chat answer uses the provider already selected in Settings; local visual interactions do not send more data. The separate per-file NVIDIA image consent remains unchanged.
