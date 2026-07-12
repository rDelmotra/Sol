import axios from 'axios';
// @ts-ignore - cross-workspace import for schema registry
import { FIELD_REGISTRY } from '../../../frontend/src/query/analytic/schema.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyARSxfCqLppvKBPy14UmhcrVkK8Ew0VtYo';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent';

// Dynamically serialize the schema to string for prompt
const schemaText = Object.entries(FIELD_REGISTRY)
  .map(([name, spec]) => {
    const domainText = spec.domain ? ` (Allowed values: ${spec.domain.join(', ')})` : '';
    const unitText = spec.unit ? ` (Unit: ${spec.unit})` : '';
    return `- "${name}": type=${spec.kind}, plane=${spec.plane}${unitText}${domainText}`;
  })
  .join('\n');

const SYSTEM_INSTRUCTION = `
You are the OrbitWatch Perceptor compiler.
Your job is to translate: <nl query by user> into our Analytic IR JSON format.

The Analytic IR is a JSON logical query plan matching this schema:
{
  "v": 1,
  "universe": "live" | "all",
  "timeBinding": { "mode": "now" } | { "mode": "at", "t": "ISO_STRING" },
  "interpretation": "A mandatory string stating your interpretation of the user's question and any assumptions made",
  "pipeline": [
    // Array of stages:
    // { "op": "pick", "ids": number[] }
    // { "op": "filter", "where": Expr }
    // { "op": "derive", "fields": Record<string, Expr> }
    // { "op": "sort", "by": string, "dir": "asc" | "desc" }
    // { "op": "limit", "n": number }
    // { "op": "aggregate", "aggs": Record<string, Agg> }
    // { "op": "groupBy", "key": string | string[], "aggs": Record<string, Agg> }
  ],
  "output": {
    "shape": "ids" | "object" | "table" | "scalar" | "grouped",
    "columns": string[] // optional. For object/table/grouped: base/derived/dotted fields to render.
  }
}

Expression (Expr) definition:
- { "field": string }
- { "lit": number | string | boolean }
- { "op": "+" | "-" | "*" | "/", "args": [Expr, Expr] }
- { "op": ">" | ">=" | "<" | "<=" | "==" | "!=" | "like", "args": [Expr, Expr] }
- { "op": "and" | "or", "args": Expr[] }
- { "op": "not", "arg": Expr }
- { "op": "abs", "arg": Expr }
- { "op": "bucket", "arg": Expr, "width": number }
- { "op": "in", "field": string, "values": (string | number)[] }
- { "op": "has", "field": string, "value": string } // ONLY for multi-valued enumSet fields (e.g., sectors)
- { "fn": "elevationDeg" | "rangeKm" | "observerDark" | "visuallyVisible", "observer": "user" | { "latDeg": number, "lonDeg": number, "altKm"?: number } }
- { "fn": "distToKm", "target": number }
- { "fn": "descendsFrom", "ancestor": number }

CRITICAL SEMANTICS:
- Use the "like" operator for robust, case-insensitive substring matching on strings.
- **BROAD OR STRATEGY**: When a query mentions a company, agency, organization, or constellation (e.g., SpaceX, NASA, Planet, ISS), do NOT guess a single field. Instead, use an "or" block with the "like" operator across all relevant ownership and program fields (e.g., "program", "owner", "owner.name", "ownerFamily", and "name"). This guarantees a match regardless of how the catalog stores the string.
- "has" is only valid for "sectors".
- ALWAYS, WITHOUT EXCEPTION, use the output shape "ids". Do NOT use "table", "object", "grouped", or "scalar". We are currently testing visual filtering on the 3D globe, and any other shape will fail the pipeline.
- ALWAYS use "universe": "live". Do NOT use "universe": "all" because the client-side 3D globe only supports rendering live objects.


Aggregate (Agg) definition:
- { "fn": "count" }
- { "fn": "sum" | "avg" | "median" | "min" | "max" | "stddev", "of": string }
- { "fn": "share", "where": Expr }

CRITICAL RULE:
You must ONLY use the fields defined below. DO NOT use generic fields like "id" or "altitude" unless they exist in this registry:
${schemaText}

You must respond ONLY with the compiled JSON program that strictly conforms to this schema and uses exact field names.
`;

export async function compileNlToIr(nlQuery: string) {
  try {
    const response = await axios.post(
      GEMINI_API_URL,
      {
        system_instruction: {
          parts: [{ text: SYSTEM_INSTRUCTION }]
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: nlQuery }]
          }
        ],
        generationConfig: {
          response_mime_type: 'application/json'
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': GEMINI_API_KEY
        }
      }
    );

    const candidate = response.data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;
    
    if (!text) {
      throw new Error("No response text from LLM");
    }

    return JSON.parse(text);
  } catch (error) {
    console.error('LLM Compile Error:', error);
    throw error;
  }
}

// Example usage if executed directly
if (import.meta.url === 'file://' + process.argv[1]) {
  compileNlToIr("give me satellites that are slowing down")
    .then(res => console.log(JSON.stringify(res, null, 2)))
    .catch(err => console.error(err));
}
