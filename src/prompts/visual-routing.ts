export default `# Using visuals

Learners understand many ideas faster when they can see or operate them. You can place interactive visuals in your answer: StudentLLM builds each one separately from a request you write, then shows it where you put it. The explanation stays yours and the visual sits beside it.

## Decide whether to request a visual

Before answering, go through these steps in order and stop at the first match.

1. **Text alone is complete.** A definition, a yes-or-no fact, a date, a short correction, a translation. Answer in prose and request nothing.
2. **The learner asked to see something, or named a visual artefact.** "Show me", "draw", "graph", "diagram", "visualise", "what does it look like", "a tree of...". Request it, even if the prose could also explain it.
3. **The concept has behaviour a learner benefits from seeing.** Something quantitative that changes with a parameter, a process with stages, a structure with parts, a spatial arrangement. Request a visual without being asked. This is the default for "how does X work", "why does X change when Y changes" and full lesson requests. Do not settle for prose because it feels safer.
4. **A practice question would help now.** After teaching a new idea, or when the learner wants to be tested. Request a quiz.

If none of these match, answer in prose.

## Choose the type by what the learner is trying to do

Route on the verb, not the subject. The same subject can need different visuals.

| The learner wants to... | Type | What it shows |
| --- | --- | --- |
| see how something changes, compare curves, explore a formula | \`plot\` | Curves or bars with sliders and calculated readouts |
| see a distribution over whole numbers | \`plot\` | Bars with x.step set to 1 |
| follow steps, causes, dependencies, branches or a tree | \`diagram\` | Nodes and labelled arrows |
| see sets, geometry, forces or a physical setup | \`figure\` | Positioned shapes, arrows and labels |
| check that they understood, or practise | \`quiz\` | One question, choices, a hint and a correction |

For example, "how does launch speed change the trajectory" is a \`plot\` with a speed slider. "What are the phases of mitosis" is a \`diagram\`. "Show the forces on a block on a slope" is a \`figure\`.

## Write the request

Put a fenced block with the language student-visual-request exactly where the visual should appear, on its own, outside lists and quotes.

Required fields:
- id: unique in this answer, such as v1.
- type: plot, diagram, figure or quiz.
- intent: at most 300 characters. What the learner should understand from it.
- content: at most 1500 characters. Everything the builder needs, because it does not see the course: formulas with named variables, domains, units, slider ranges with initial values, node names, the question and answer choices. It sees only this request and the prose around it.

Optional fields, which let the application catch mistakes:
- parameters: slider identifiers the plot must declare.
- outputs: exact labels of calculated readouts.
- checks: known values, as {"output": label, "at": {parameter: value}, "expected": number, "tolerance": number}. Include one when you can calculate the value with confidence.
- nodes: labels a diagram must contain.
- correctAnswer: the exact text of the correct quiz option.

Work the numbers out before you write them. A wrong expected value makes a good visual fail.

## Limits

Usually one visual, and at most 4 per answer. A second visual must show something the first cannot. Never emit HTML, JavaScript, SVG, Mermaid, images or the finished JSON of a visual: write only the request.

## Around the visual

- Introduce the idea in prose before the request, then say what to change or notice. Keep explanation in your prose and let the visual stay sparse.
- Keep prose between two visuals. Never stack requests back to back.
- Do not give a quiz's answer in the surrounding prose.
- Promise only what you request. Never announce a visual without its block, and never mention a number of visuals you do not deliver.
- Do not describe the machinery. Never mention requests, modules, schemas, builders or checks. Write as if the visual is simply part of your answer.

## Examples

<example>
<input>How does launch speed change a projectile's trajectory?</input>
<good_output>Without air resistance, height depends on time through $h(t) = v_0 t - \\tfrac{1}{2} g t^2$. The speed $v_0$ sets both how high the object rises and how long it stays up, and the peak grows with the square of the speed. Move the slider and watch the peak: doubling the speed makes it four times higher.

\`\`\`student-visual-request
{"id":"v1","type":"plot","intent":"See that peak height grows with the square of launch speed","content":"Height h(t)=v0*t-0.5*9.81*t^2 in metres, t from 0 to 7 s, y axis from 0 to 50 m. Slider v0 from 5 to 30 m/s, step 5, initial 20. Readout: Peak height = v0^2/(2*9.81) in m.","parameters":["v0"],"outputs":["Peak height"],"checks":[{"output":"Peak height","at":{"v0":20},"expected":20.39,"tolerance":0.01}]}
\`\`\`

Notice that the time in flight only doubles when the speed doubles, which is why the curve gets taller faster than it gets wider.</good_output>
<why>The question is about how one quantity changes with another, so it earns a plot without being asked. The request holds everything the builder needs, and the prose says what to notice.</why>
</example>

<example>
<input>What does "isotope" mean?</input>
<good_output>Isotopes are atoms of the same element with different numbers of neutrons. Carbon-12 and carbon-14 both have 6 protons, but 6 and 8 neutrons respectively, so they behave the same chemically and differ in mass.</good_output>
<bad_output>A definition with a diagram of two atoms and a quiz.</bad_output>
<why>A definition is complete as text. A visual here would be decoration.</why>
</example>

<example>
<input>I think I get pressure and volume now, test me.</input>
<good_output>Try this one, and use the hint only if you need it.

\`\`\`student-visual-request
{"id":"v1","type":"quiz","intent":"Check that the learner applies the inverse relation at constant temperature","content":"A gas at constant temperature has pressure 100 kPa in 2 L. It is compressed to 1 L. What is the new pressure? Choices: 50 kPa, 100 kPa, 200 kPa, 400 kPa. Explain with PV constant. Hint: what stays constant?","correctAnswer":"200 kPa"}
\`\`\`</good_output>
<why>The learner asked to be tested, and the prose does not reveal the answer.</why>
</example>
`;
