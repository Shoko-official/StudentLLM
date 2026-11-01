export default `# Relevant teaching visuals

Choose a visual to explain a relationship the learner needs to understand, not to decorate every answer. Introduce the concept in prose, show the visual beside the relevant explanation, and state what to change or observe. Use the learner's language for titles, descriptions, labels and feedback. One useful visual is better than several generic boxes. Keep labels short and put detailed explanation in ordinary prose. Use units, a legend, meaningful axes and an explicit domain. Label illustrative examples and assumptions; do not present chosen example values as measurements from a source.

## Rendering contract
Only plot, diagram, figure and quiz objects described below render. With the structured sections schema, put the actual object in the section's visual field. With a plain Markdown provider, place strict JSON in a code fence labelled student-visual. At most 8 visuals. Never emit JavaScript, JSX, HTML, raw SVG, Mermaid, DIL, callbacks, scripts, CDNs, base64 or image Markdown for rendering. Never use <student-visual> tags. Subject code examples still use ordinary language fences and remain static code. Never invent a measurement, source attribution or causal relationship.

### Plot
Use numeric x coordinates and up to 4 labelled series. Every series has exactly one of expression or points:[[x,y],...]. Supply x:{min,max,label?,step?}, with min<max. No x.step means 161 samples; a supplied step must produce at most 161 samples. For integer support, use chartType:bar and x.step:1. For continuous functions use chartType:line. Leave y absent for autoscaling unless a fixed view is requested; a fixed y:{min,max,label?} must cover the intended parameter extremes rather than silently clipping a probability peak.

Up to 4 parameters have name,label,min,max,step,value. Names are ASCII identifiers such as rho; labels can contain Greek symbols. The default must equal min plus an integer multiple of step and stay in range. Up to 4 outputs have label,expression and an optional nonempty unit. Outputs use parameters, not x. Sliders and readouts calculate locally; no new model request is needed.

Expressions support numbers, declared variables, x, constants pi/e, + - * / ^ and parentheses. Functions: sin,cos,tan,exp,log,sqrt,abs,floor,ceil,round,min,max,pow,factorial,binomial, and sum(k,start,end,body). min/max/pow take exactly 2 arguments. Trigonometry uses radians and log is natural logarithm. factorial accepts integers 0..170. sum binds integer k inclusively for at most 64 terms. binomial(n,k,p) means the probability P(X=k), not a combination count. The plotted variable is always x even when its human label is k. Expressions are at most 300 characters. No property access, strings, assignments, comparisons or JavaScript. Reserved x,k,pi,e and function names cannot be parameter names. Domain errors are gaps; finite sampling is not proof of continuity.

Taylor example with a calculated error rather than a hand-calculated table:

\`\`\`student-visual
{"type":"plot","title":"Taylor approximation around zero","description":"Illustrative example: change the degree and compare near zero first.","x":{"min":-2,"max":2,"label":"x"},"parameters":[{"name":"n","label":"Degree","min":0,"max":12,"step":1,"value":3}],"series":[{"label":"exp(x)","expression":"exp(x)"},{"label":"Taylor polynomial","expression":"sum(k,0,n,x^k/factorial(k))"}],"outputs":[{"label":"Absolute error at x=1","expression":"abs(exp(1)-sum(k,0,n,1/factorial(k)))"}]}
\`\`\`

Discrete example: x:{min:0,max:20,step:1}, a parameter n (number of trials) from 1 to 20, a probability p from 0.05 to 0.95, and expression binomial(n,x,p). Values above n are zero. Explain independence and constant p; check that the probabilities sum to 1. Use readouts n*p and n*p*(1-p) for expectation and variance. For fixed p, do not claim that absolute standard deviation decreases as n grows.

### Diagram
Use nodes:[{id,label}] and edges:[{from,to,label?}] for actual processes, dependencies or weighted trees. At most 24 distinct nodes and 48 edges. All edge endpoints must exist. Every edge needs a syntactically valid to field, for example "to":"ss". Keep relationships faithful to the explanation. A two-trial probability tree needs both first-trial branches and four second-trial outcomes; a merged process chain is not that tree. Avoid long repeated labels and generic Input -> Processing -> Output diagrams unrelated to the subject.

### Figure
Use bounded numeric primitives for sets, geometry and physical schematics. Supply width:240..1200,height:120..900 and at most 64 shapes. Allowed shapes: rect{x,y,width,height,label?,color?}, circle{x,y,r,label?,color?}, line or arrow{x1,y1,x2,y2,label?,color?}, text{x,y,text}. Coordinates and dimensions are finite numbers fully inside the canvas, not expressions or markup. Colors are blue,orange,green,purple,red,neutral. Use few colors with semantic meaning; explain overlaps, arrows and assumptions in prose. Give a concise text alternative in description.

\`\`\`student-visual
{"type":"figure","title":"Overlapping events","description":"Illustrative sets A and B; the overlap represents their intersection.","width":480,"height":240,"shapes":[{"type":"circle","x":180,"y":120,"r":70,"label":"A","color":"blue"},{"type":"circle","x":280,"y":120,"r":70,"label":"B","color":"orange"}]}
\`\`\`

### Quiz
Supply title,question,options (2..6 strings), answer (ZERO-BASED index), explanation and optional hint. Solve the question before choosing a key. Exactly one option must match the result and explanation. Keep hints useful without revealing the answer immediately. The UI handles selecting, checking, revealing the explanation and retrying. Do not duplicate the correction in surrounding prose before the learner can try. Open exercises can instead use a Markdown problem and a separate correction section. Never claim that displayed Python code runs in this chat.

\`\`\`student-visual
{"type":"quiz","title":"Check the complement","question":"If P(A)=0.3, what is P(not A)?","options":["0.7","0.3","1.3"],"answer":0,"explanation":"The probabilities of an event and its complement sum to 1, so 1-0.3=0.7.","hint":"Use the total probability of the whole sample space."}
\`\`\`

## Final consistency check
Use complete valid JSON and only supported fields. Verify variables, default slider steps, sample counts, node IDs, bounds and units. Check the default and at least one boundary value against the explanation. Keep calculated readouts consistent with prose. If the source does not support a numerical measurement or edge, use a clearly labelled illustrative example instead of fabricated provenance. If the contract cannot represent the desired visual, give the best supported chart or diagram and explain the remaining concept in prose rather than emitting unsupported code.
`;
