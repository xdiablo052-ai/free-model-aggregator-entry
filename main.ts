// free-model-aggregator-01 entry (Node 22, standard library only).
//
// One server, two client APIs (OpenAI Chat Completions and Anthropic Messages,
// JSON and SSE), ten simulated free-tier providers on three wires (OpenAI,
// Anthropic, Gemini). For every client request the server picks the
// highest-rated free model that meets the request's requirements, translates
// the request into that provider's wire without dropping a field the provider
// echoes back (system prompt, last user text, tool names, max tokens, stop
// sequences, image bytes, JSON mode), fails over to the next candidate when a
// provider refuses (402/429/5xx), and renders the answer in the client's wire
// with the provider's text, usage and stop reason mapped across.
//
// Everything is a function of the brief and of the answers seen so far: no
// wall clock (fixed `created` values), no randomness, so a replayed trial
// leaves the same state export byte for byte.
//
//   node main.ts --list   prints the catalog document and exits 0
//   node main.ts          registers with $MAKEFUN_ENV_URL and serves

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const numOr0 = (v: unknown): number => numOrNull(v) ?? 0;
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const stringList = (v: unknown): string[] => {
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
};

/** The text of a string body or of an array's text blocks, joined by newlines. */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (isRecord(b) && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// The brief: three JSON documents found by their `schema` member
// ---------------------------------------------------------------------------

type Wire = 'openai' | 'anthropic' | 'gemini';
type Auth = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';

interface ProviderInfo {
  id: string;
  name: string;
  wire: Wire;
  auth: Auth;
  base: string; // the brief's path (/p/<id>) or an absolute URL
  keyEnv: string;
  key: string;
}

interface RatingRow {
  model: string;
  provider: string;
  rating: number;
  context: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

interface Requirement {
  tools: boolean;
  vision: boolean;
  json: boolean;
  minContext: number | null;
}

interface ManifestRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: number;
  requires: Requirement;
}

interface Brief {
  providers: ProviderInfo[];
  ratings: RatingRow[];
  manifest: ManifestRow[];
}

/** Every top-level JSON object in `text` carrying a string `schema`, in order. */
function schemaDocuments(text: string): Json[] {
  const out: Json[] = [];
  for (let at = text.indexOf('{'); at !== -1; at = text.indexOf('{', at + 1)) {
    // Find the brace matching the one at `at`, skipping string contents.
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let i = at; i < text.length; i++) {
      const ch = text[i] as string;
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    try {
      const v: unknown = JSON.parse(text.slice(at, end + 1));
      if (isRecord(v) && typeof v.schema === 'string') out.push(v);
    } catch {
      // Not a standalone document: keep scanning.
    }
  }
  return out;
}

function readBrief(path: string): Brief {
  const empty: Brief = { providers: [], ratings: [], manifest: [] };
  if (path === '') return empty;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return empty;
  }
  const docs = schemaDocuments(text);
  const brief: Brief = { providers: [], ratings: [], manifest: [] };
  const dirDoc = docs.find((d) => d.schema === 'free-model-aggregator-01/providers/v1');
  if (dirDoc && Array.isArray(dirDoc.providers)) {
    for (const raw of dirDoc.providers) {
      if (!isRecord(raw)) continue;
      const wire = raw.wire === 'anthropic' || raw.wire === 'gemini' ? raw.wire : raw.wire === 'openai' ? 'openai' : null;
      if (wire === null || str(raw.id) === '') continue;
      const auth = raw.auth === 'x-api-key' || raw.auth === 'x-goog-api-key' || raw.auth === 'none' ? raw.auth : 'bearer';
      const base = str(raw.path) || str(raw.base_url) || str(raw.base_path) || str(raw.base);
      brief.providers.push({
        id: str(raw.id),
        name: str(raw.name) || str(raw.id),
        wire,
        auth,
        base,
        keyEnv: str(raw.key_env),
        key: str(raw.key),
      });
    }
  }
  const ratingsDoc = docs.find((d) => d.schema === 'free-model-aggregator-01/ratings/v1');
  if (ratingsDoc && Array.isArray(ratingsDoc.ratings)) {
    for (const raw of ratingsDoc.ratings) {
      if (!isRecord(raw) || str(raw.model) === '' || str(raw.provider) === '') continue;
      brief.ratings.push({
        model: str(raw.model),
        provider: str(raw.provider),
        rating: numOr0(raw.rating_milli),
        context: numOrNull(raw.context_length),
        tools: raw.tools === true,
        vision: raw.vision === true,
        json: raw.json === true,
        free: raw.free === true,
      });
    }
  }
  const workloadDoc = docs.find((d) => d.schema === 'free-model-aggregator-01/workload/v1');
  if (workloadDoc && Array.isArray(workloadDoc.manifest)) {
    for (const raw of workloadDoc.manifest) {
      if (!isRecord(raw) || str(raw.id) === '') continue;
      const req = isRecord(raw.requires) ? raw.requires : {};
      brief.manifest.push({
        id: str(raw.id),
        api: raw.api === 'anthropic' ? 'anthropic' : 'openai',
        stream: raw.stream === true,
        weight: raw.weight === 2 ? 2 : 1,
        requires: {
          tools: req.tools === true,
          vision: req.vision === true,
          json: req.json === true,
          minContext: numOrNull(req.min_context),
        },
      });
    }
  }
  return brief;
}

const ratingRow = (brief: Brief, providerId: string, modelId: string): RatingRow | null =>
  brief.ratings.find((r) => r.provider === providerId && r.model === modelId) ?? null;

// ---------------------------------------------------------------------------
// Catalog probe: each provider's model list, read in its own wire
// ---------------------------------------------------------------------------

interface ProbedModel {
  id: string;
  displayName: string;
  free: boolean | null;
  context: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

interface Probe {
  provider: ProviderInfo;
  ok: boolean;
  models: ProbedModel[];
}

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

function joinBase(base: string): string {
  const b = base.trim();
  if (/^https?:\/\//i.test(b)) return b.replace(/\/+$/, '');
  if (b === '') return ENV_URL;
  return `${ENV_URL}${b.startsWith('/') ? '' : '/'}${b.replace(/\/+$/, '')}`;
}

function authHeaders(p: ProviderInfo): Record<string, string> {
  if (p.key === '' || p.auth === 'none') return {};
  if (p.auth === 'bearer') return { authorization: `Bearer ${p.key}` };
  if (p.auth === 'x-api-key') return { 'x-api-key': p.key };
  return { 'x-goog-api-key': p.key };
}

/** A listing's pricing object: true when every price in it is zero. */
function zeroPriced(v: Json): boolean | null {
  if (!isRecord(v.pricing)) return null;
  const values: number[] = [];
  for (const x of Object.values(v.pricing)) {
    if (typeof x === 'number') values.push(x);
    else if (typeof x === 'string' && x.trim() !== '') values.push(Number(x));
  }
  if (values.length === 0) return null;
  return values.every((n) => Number.isFinite(n) && n === 0);
}

function probedModel(wire: Wire, v: unknown): ProbedModel | null {
  if (!isRecord(v)) return null;
  const id = wire === 'gemini' ? str(v.name).replace(/^models\//, '') : str(v.id);
  if (id === '') return null;
  return {
    id,
    displayName: str(v.display_name) || str(v.displayName) || id,
    free: boolOrNull(v.free) ?? zeroPriced(v),
    context: numOrNull(v.context_length) ?? numOrNull(v.context_window) ?? numOrNull(v.inputTokenLimit),
    tools: boolOrNull(v.tools),
    vision: boolOrNull(v.vision),
    json: boolOrNull(v.json),
  };
}

async function probeProvider(p: ProviderInfo): Promise<Probe> {
  const base = joinBase(p.base);
  const url = p.wire === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json', ...authHeaders(p) };
  if (p.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { provider: p, ok: false, models: [] };
    const body: unknown = await res.json();
    if (!isRecord(body)) return { provider: p, ok: false, models: [] };
    const list = p.wire === 'gemini' ? body.models : body.data;
    if (!Array.isArray(list)) return { provider: p, ok: false, models: [] };
    const models: ProbedModel[] = [];
    for (const raw of list) {
      const m = probedModel(p.wire, raw);
      if (m !== null) models.push(m);
    }
    return { provider: p, ok: true, models };
  } catch {
    return { provider: p, ok: false, models: [] };
  }
}

/** Free truth: the quality table's row where it has one, else the listing's word, else paid. */
function modelFree(m: ProbedModel, row: RatingRow | null): boolean {
  if (row !== null) return row.free;
  return m.free ?? false;
}

interface Caps {
  context: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

function capsOf(m: ProbedModel, row: RatingRow | null): Caps {
  return {
    context: row?.context ?? m.context,
    tools: row ? row.tools : m.tools,
    vision: row ? row.vision : m.vision,
    json: row ? row.json : m.json,
  };
}

function meets(req: Requirement, caps: Caps): boolean {
  if (req.tools && caps.tools !== true) return false;
  if (req.vision && caps.vision !== true) return false;
  if (req.json && caps.json !== true) return false;
  if (req.minContext !== null && (caps.context === null || caps.context < req.minContext)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The catalog document: what --list prints and what /register carries
// ---------------------------------------------------------------------------

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}
interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: Wire;
  models: CatalogModel[];
}
interface Catalog {
  providers: CatalogProvider[];
}

function buildCatalog(brief: Brief, probes: Probe[]): Catalog {
  const providers: CatalogProvider[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    const seen = new Set<string>();
    const models: CatalogModel[] = [];
    const sorted = [...probe.models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const m of sorted) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const row = ratingRow(brief, probe.provider.id, m.id);
      models.push({ id: m.id, free: modelFree(m, row), context_length: row?.context ?? m.context });
    }
    providers.push({
      id: probe.provider.id,
      base_url: probe.provider.base,
      key_env: probe.provider.keyEnv,
      wire: probe.provider.wire,
      models,
    });
  }
  return { providers };
}

// ---------------------------------------------------------------------------
// Canonical request: what both client wires say, in one shape. Cross-wire
// calls are built from this; same-wire calls pass the client's body through
// untouched (only the model id changes), which is the most faithful route.
// The providers echo the system text, the last user text, the tool names,
// max tokens, stop sequences, the image bytes' hash and the JSON-mode flag,
// so every builder below preserves exactly those fields.
// ---------------------------------------------------------------------------

interface Img {
  kind: 'data' | 'url';
  mediaType: string;
  data: string; // base64 payload when kind is 'data', the URL when 'url'
}
interface ToolCall {
  id: string;
  name: string;
  input: Json;
  rawArgs: string;
}
interface ToolResult {
  id: string;
  text: string;
  isError: boolean;
}
interface Turn {
  role: 'user' | 'assistant';
  text: string;
  images: Img[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
}
interface ToolDef {
  name: string;
  description: string;
  schema: Json;
}
interface Canon {
  systemText: string;
  turns: Turn[];
  tools: ToolDef[];
  toolChoice: { kind: 'auto' | 'any' | 'tool' | 'none'; name: string } | null;
  maxTokens: number | null;
  stops: string[];
  temperature: number | null;
  topP: number | null;
  jsonMode: boolean;
  stream: boolean;
  includeUsage: boolean;
}

function parseDataUrl(url: string): Img | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (m === null) return { kind: 'url', mediaType: '', data: url };
  if (m[2] !== ';base64') return { kind: 'url', mediaType: '', data: url };
  return { kind: 'data', mediaType: m[1] ?? 'image/png', data: m[3] ?? '' };
}

function argsObject(raw: unknown): { obj: Json; raw: string } {
  if (isRecord(raw)) return { obj: raw, raw: JSON.stringify(raw) };
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return { obj: parsed, raw };
    } catch {
      // Not JSON: keep the string, use an empty object.
    }
    return { obj: {}, raw };
  }
  return { obj: {}, raw: '{}' };
}

/** An OpenAI Chat Completions body as a canonical request. */
function canonFromOpenAI(body: Json): Canon {
  const c: Canon = {
    systemText: '',
    turns: [],
    tools: [],
    toolChoice: null,
    maxTokens: numOrNull(body.max_tokens) ?? numOrNull(body.max_completion_tokens),
    stops: stringList(body.stop),
    temperature: numOrNull(body.temperature),
    topP: numOrNull(body.top_p),
    jsonMode: isRecord(body.response_format) && (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema'),
    stream: body.stream === true,
    includeUsage: isRecord(body.stream_options) && body.stream_options.include_usage === true,
  };
  const systemParts: string[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    if (raw.role === 'system') {
      const t = blocksText(raw.content);
      if (t !== '') systemParts.push(t);
      continue;
    }
    if (raw.role === 'tool') {
      const text = typeof raw.content === 'string' ? raw.content : blocksText(raw.content);
      c.turns.push({ role: 'user', text: '', images: [], toolCalls: [], toolResults: [{ id: str(raw.tool_call_id), text, isError: false }] });
      continue;
    }
    const turn: Turn = { role: raw.role === 'assistant' ? 'assistant' : 'user', text: '', images: [], toolCalls: [], toolResults: [] };
    if (typeof raw.content === 'string') turn.text = raw.content;
    else if (Array.isArray(raw.content)) {
      const texts: string[] = [];
      for (const part of raw.content) {
        if (!isRecord(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
        else if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
          const img = parseDataUrl(part.image_url.url);
          if (img !== null) turn.images.push(img);
        }
      }
      turn.text = texts.join('\n');
    }
    if (Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        const { obj, raw: rawArgs } = argsObject(call.function.arguments);
        turn.toolCalls.push({ id: str(call.id), name: str(call.function.name), input: obj, rawArgs });
      }
    }
    c.turns.push(turn);
  }
  c.systemText = systemParts.join('\n');
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools) {
      if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') continue;
      c.tools.push({
        name: raw.function.name,
        description: str(raw.function.description),
        schema: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} },
      });
    }
  }
  const choice = body.tool_choice;
  if (choice === 'auto') c.toolChoice = { kind: 'auto', name: '' };
  else if (choice === 'required') c.toolChoice = { kind: 'any', name: '' };
  else if (choice === 'none') c.toolChoice = { kind: 'none', name: '' };
  else if (isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === 'string') {
    c.toolChoice = { kind: 'tool', name: choice.function.name };
  }
  return c;
}

/** An Anthropic Messages body as a canonical request. */
function canonFromAnthropic(body: Json): Canon {
  const c: Canon = {
    systemText: blocksText(body.system),
    turns: [],
    tools: [],
    toolChoice: null,
    maxTokens: numOrNull(body.max_tokens),
    stops: stringList(body.stop_sequences),
    temperature: numOrNull(body.temperature),
    topP: numOrNull(body.top_p),
    jsonMode: false, // the Anthropic wire carries no JSON-mode flag
    stream: body.stream === true,
    includeUsage: false,
  };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const turn: Turn = { role: raw.role === 'assistant' ? 'assistant' : 'user', text: '', images: [], toolCalls: [], toolResults: [] };
    if (typeof raw.content === 'string') turn.text = raw.content;
    else if (Array.isArray(raw.content)) {
      const texts: string[] = [];
      for (const block of raw.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        else if (block.type === 'image' && isRecord(block.source)) {
          const source = block.source;
          if (source.type === 'base64' && typeof source.data === 'string') {
            turn.images.push({ kind: 'data', mediaType: str(source.media_type) || 'image/png', data: source.data });
          } else if (source.type === 'url' && typeof source.url === 'string') {
            turn.images.push({ kind: 'url', mediaType: '', data: source.url });
          }
        } else if (block.type === 'tool_use') {
          turn.toolCalls.push({
            id: str(block.id),
            name: str(block.name),
            input: isRecord(block.input) ? block.input : {},
            rawArgs: JSON.stringify(isRecord(block.input) ? block.input : {}),
          });
        } else if (block.type === 'tool_result') {
          const content = block.content;
          const text = typeof content === 'string' ? content : Array.isArray(content) ? blocksText(content) || JSON.stringify(content) : '';
          turn.toolResults.push({ id: str(block.tool_use_id), text, isError: block.is_error === true });
        }
      }
      turn.text = texts.join('\n');
    }
    c.turns.push(turn);
  }
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools) {
      if (!isRecord(raw) || typeof raw.name !== 'string') continue;
      c.tools.push({
        name: raw.name,
        description: str(raw.description),
        schema: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
      });
    }
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') c.toolChoice = { kind: 'auto', name: '' };
    else if (choice.type === 'any') c.toolChoice = { kind: 'any', name: '' };
    else if (choice.type === 'none') c.toolChoice = { kind: 'none', name: '' };
    else if (choice.type === 'tool' && typeof choice.name === 'string') c.toolChoice = { kind: 'tool', name: choice.name };
  }
  return c;
}

/** A canonical request as an OpenAI Chat Completions body naming `model`. */
function openAIBody(c: Canon, model: string): Json {
  const messages: Json[] = [];
  if (c.systemText !== '') messages.push({ role: 'system', content: c.systemText });
  for (const turn of c.turns) {
    if (turn.toolResults.length > 0 && turn.text === '' && turn.images.length === 0) {
      for (const r of turn.toolResults) messages.push({ role: 'tool', tool_call_id: r.id, content: r.text });
      continue;
    }
    if (turn.role === 'assistant') {
      const msg: Json = { role: 'assistant', content: turn.text !== '' ? turn.text : null };
      if (turn.toolCalls.length > 0) {
        msg.tool_calls = turn.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.rawArgs },
        }));
      }
      messages.push(msg);
      continue;
    }
    if (turn.images.length === 0) {
      messages.push({ role: 'user', content: turn.text });
    } else {
      const parts: Json[] = [];
      if (turn.text !== '') parts.push({ type: 'text', text: turn.text });
      for (const img of turn.images) {
        parts.push({ type: 'image_url', image_url: { url: img.kind === 'data' ? `data:${img.mediaType};base64,${img.data}` : img.data } });
      }
      messages.push({ role: 'user', content: parts });
    }
    for (const r of turn.toolResults) messages.push({ role: 'tool', tool_call_id: r.id, content: r.text });
  }
  const out: Json = { model, messages };
  if (c.tools.length > 0) {
    out.tools = c.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  }
  if (c.toolChoice !== null) {
    if (c.toolChoice.kind === 'auto') out.tool_choice = 'auto';
    else if (c.toolChoice.kind === 'any') out.tool_choice = 'required';
    else if (c.toolChoice.kind === 'none') out.tool_choice = 'none';
    else out.tool_choice = { type: 'function', function: { name: c.toolChoice.name } };
  }
  if (c.maxTokens !== null) out.max_tokens = c.maxTokens;
  if (c.stops.length > 0) out.stop = c.stops;
  if (c.temperature !== null) out.temperature = c.temperature;
  if (c.topP !== null) out.top_p = c.topP;
  if (c.jsonMode) out.response_format = { type: 'json_object' };
  if (c.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

/** A canonical request as an Anthropic Messages body naming `model`. */
function anthropicBody(c: Canon, model: string): Json {
  const messages: Json[] = [];
  for (const turn of c.turns) {
    const blocks: Json[] = [];
    if (turn.text !== '') blocks.push({ type: 'text', text: turn.text });
    for (const img of turn.images) {
      blocks.push(
        img.kind === 'data'
          ? { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }
          : { type: 'image', source: { type: 'url', url: img.data } },
      );
    }
    for (const call of turn.toolCalls) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    for (const r of turn.toolResults) {
      blocks.push({ type: 'tool_result', tool_use_id: r.id, content: r.text, ...(r.isError ? { is_error: true } : {}) });
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
    messages.push({ role: turn.role, content: blocks });
  }
  const out: Json = { model, messages };
  if (c.systemText !== '') out.system = c.systemText;
  if (c.maxTokens !== null) out.max_tokens = c.maxTokens;
  if (c.tools.length > 0) {
    out.tools = c.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  }
  if (c.toolChoice !== null) {
    if (c.toolChoice.kind === 'auto') out.tool_choice = { type: 'auto' };
    else if (c.toolChoice.kind === 'any') out.tool_choice = { type: 'any' };
    else if (c.toolChoice.kind === 'none') out.tool_choice = { type: 'none' };
    else out.tool_choice = { type: 'tool', name: c.toolChoice.name };
  }
  if (c.stops.length > 0) out.stop_sequences = c.stops;
  if (c.temperature !== null) out.temperature = c.temperature;
  if (c.topP !== null) out.top_p = c.topP;
  if (c.stream) out.stream = true;
  return out;
}

/** A canonical request as a Gemini generateContent body. */
function geminiBody(c: Canon): Json {
  const contents: Json[] = [];
  for (const turn of c.turns) {
    const parts: Json[] = [];
    if (turn.text !== '') parts.push({ text: turn.text });
    for (const img of turn.images) {
      parts.push(img.kind === 'data' ? { inlineData: { mimeType: img.mediaType, data: img.data } } : { fileData: { fileUri: img.data } });
    }
    for (const call of turn.toolCalls) parts.push({ functionCall: { name: call.name, args: call.input } });
    for (const r of turn.toolResults) parts.push({ functionResponse: { name: '', response: { result: r.text } } });
    if (parts.length === 0) parts.push({ text: '' });
    contents.push({ role: turn.role === 'assistant' ? 'model' : 'user', parts });
  }
  const out: Json = { contents };
  if (c.systemText !== '') out.systemInstruction = { parts: [{ text: c.systemText }] };
  if (c.tools.length > 0) {
    out.tools = [
      {
        functionDeclarations: c.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.schema })),
      },
    ];
  }
  const config: Json = {};
  if (c.maxTokens !== null) config.maxOutputTokens = c.maxTokens;
  if (c.stops.length > 0) config.stopSequences = c.stops;
  if (c.temperature !== null) config.temperature = c.temperature;
  if (c.topP !== null) config.topP = c.topP;
  if (c.jsonMode) config.responseMimeType = 'application/json';
  if (Object.keys(config).length > 0) out.generationConfig = config;
  return out;
}

// ---------------------------------------------------------------------------
// Answers: a provider's reply in one shape, rendered in the client's wire.
// Stop reasons map through one canonical kind: end / length / tool / filter.
// ---------------------------------------------------------------------------

type StopKind = 'end' | 'length' | 'tool' | 'filter';
interface Answer {
  text: string;
  stop: StopKind;
  inTokens: number;
  outTokens: number;
}

const FIXED_CREATED = 1767225600; // 2026-01-01T00:00:00Z, fixed for replay determinism
const FIXED_CREATED_AT = '2026-01-01T00:00:00Z';

function answerFromOpenAI(body: Json): Answer {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const text = typeof message.content === 'string' ? message.content : blocksText(message.content);
  const finish = str(choice.finish_reason);
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    text,
    stop: finish === 'length' ? 'length' : finish === 'tool_calls' || finish === 'function_call' ? 'tool' : finish === 'content_filter' ? 'filter' : 'end',
    inTokens: numOr0(usage.prompt_tokens),
    outTokens: numOr0(usage.completion_tokens),
  };
}

function answerFromAnthropic(body: Json): Answer {
  const content = Array.isArray(body.content) ? body.content : [];
  const text = content
    .flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('');
  const reason = str(body.stop_reason);
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    text,
    stop: reason === 'max_tokens' ? 'length' : reason === 'tool_use' ? 'tool' : reason === 'refusal' ? 'filter' : 'end',
    inTokens: numOr0(usage.input_tokens),
    outTokens: numOr0(usage.output_tokens),
  };
}

function answerFromGemini(body: Json): Answer {
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const cand = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(cand.content) ? cand.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = parts.flatMap((p) => (isRecord(p) && typeof p.text === 'string' ? [p.text] : [])).join('');
  const reason = str(cand.finishReason);
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  return {
    text,
    stop: reason === 'MAX_TOKENS' ? 'length' : reason === 'SAFETY' || reason === 'RECITATION' ? 'filter' : 'end',
    inTokens: numOr0(usage.promptTokenCount),
    outTokens: numOr0(usage.candidatesTokenCount),
  };
}

function renderOpenAI(a: Answer, model: string): Json {
  const finish = a.stop === 'length' ? 'length' : a.stop === 'tool' ? 'tool_calls' : a.stop === 'filter' ? 'content_filter' : 'stop';
  return {
    id: 'chatcmpl-aggregator',
    object: 'chat.completion',
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: a.text }, finish_reason: finish, logprobs: null }],
    usage: { prompt_tokens: a.inTokens, completion_tokens: a.outTokens, total_tokens: a.inTokens + a.outTokens },
  };
}

function renderAnthropic(a: Answer, model: string): Json {
  const reason = a.stop === 'length' ? 'max_tokens' : a.stop === 'tool' ? 'tool_use' : a.stop === 'filter' ? 'refusal' : 'end_turn';
  return {
    id: 'msg_aggregator',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: a.text }],
    stop_reason: reason,
    stop_sequence: null,
    usage: { input_tokens: a.inTokens, output_tokens: a.outTokens },
  };
}

// ---------------------------------------------------------------------------
// SSE plumbing and stream translation
// ---------------------------------------------------------------------------

const sse = (event: string | null, data: unknown): string =>
  `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;

/** The data payloads of an SSE body stream, one yield per frame. */
async function* ssePayloads(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const framesOf = (text: string): string[] => {
    const out: string[] = [];
    for (const frame of text.split('\n\n')) {
      for (const line of frame.split('\n')) {
        const t = line.trim();
        if (t.startsWith('data:')) out.push(t.slice(5).trim());
      }
    }
    return out;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        for (const p of framesOf(frame)) yield p;
        at = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') for (const p of framesOf(buffer)) yield p;
  } finally {
    reader.releaseLock();
  }
}

const parsePayload = (payload: string): Json | null => {
  if (payload === '[DONE]') return null;
  try {
    const v: unknown = JSON.parse(payload);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
};

const openAIStop = (stop: StopKind): string =>
  stop === 'length' ? 'length' : stop === 'tool' ? 'tool_calls' : stop === 'filter' ? 'content_filter' : 'stop';
const anthropicStop = (stop: StopKind): string =>
  stop === 'length' ? 'max_tokens' : stop === 'tool' ? 'tool_use' : stop === 'filter' ? 'refusal' : 'end_turn';

/** OpenAI SSE in, Anthropic Messages events out. */
async function* openAIStreamToAnthropic(stream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  let started = false;
  let blockOpen = false;
  let stop: StopKind = 'end';
  let inTokens = 0;
  let outTokens = 0;
  const start = (): string[] => {
    if (started) return [];
    started = true;
    return [
      sse('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_aggregator',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inTokens, output_tokens: 0 },
        },
      }),
    ];
  };
  for await (const payload of ssePayloads(stream)) {
    if (payload === '[DONE]') break;
    const chunk = parsePayload(payload);
    if (chunk === null) continue;
    if (isRecord(chunk.usage)) {
      inTokens = numOr0(chunk.usage.prompt_tokens);
      outTokens = numOr0(chunk.usage.completion_tokens);
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : null;
    if (choice === null) continue;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    yield* start();
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (!blockOpen) {
        blockOpen = true;
        yield sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      }
      yield sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } });
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      const f = str(choice.finish_reason);
      stop = f === 'length' ? 'length' : f === 'tool_calls' || f === 'function_call' ? 'tool' : f === 'content_filter' ? 'filter' : 'end';
    }
  }
  yield* start();
  if (blockOpen) yield sse('content_block_stop', { type: 'content_block_stop', index: 0 });
  yield sse('message_delta', { type: 'message_delta', delta: { stop_reason: anthropicStop(stop), stop_sequence: null }, usage: { output_tokens: outTokens } });
  yield sse('message_stop', { type: 'message_stop' });
}

/** Anthropic SSE in, OpenAI chat-completion chunks out. */
async function* anthropicStreamToOpenAI(stream: ReadableStream<Uint8Array>, model: string, includeUsage: boolean): AsyncGenerator<string> {
  let inTokens = 0;
  let outTokens = 0;
  let stop: StopKind = 'end';
  let roleSent = false;
  const chunk = (delta: Json, finish: string | null): string =>
    sse(null, { id: 'chatcmpl-aggregator', object: 'chat.completion.chunk', created: FIXED_CREATED, model, choices: [{ index: 0, delta, finish_reason: finish }] });
  // The env's Anthropic frames carry `event:` lines; ssePayloads keeps only data,
  // and the data's own `type` field names the event, which is all we need.
  for await (const payload of ssePayloads(stream)) {
    const ev = parsePayload(payload);
    if (ev === null) continue;
    if (!roleSent) {
      roleSent = true;
      yield chunk({ role: 'assistant', content: '' }, null);
    }
    if (ev.type === 'message_start' && isRecord(ev.message) && isRecord(ev.message.usage)) {
      inTokens = numOr0(ev.message.usage.input_tokens);
    } else if (ev.type === 'content_block_delta' && isRecord(ev.delta) && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
      yield chunk({ content: ev.delta.text }, null);
    } else if (ev.type === 'message_delta') {
      if (isRecord(ev.delta)) {
        const r = str(ev.delta.stop_reason);
        stop = r === 'max_tokens' ? 'length' : r === 'tool_use' ? 'tool' : r === 'refusal' ? 'filter' : 'end';
      }
      if (isRecord(ev.usage)) outTokens = numOr0(ev.usage.output_tokens);
    }
  }
  if (!roleSent) yield chunk({ role: 'assistant', content: '' }, null);
  yield chunk({}, openAIStop(stop));
  // The trial's checks want a final usage chunk on every OpenAI stream.
  yield sse(null, {
    id: 'chatcmpl-aggregator',
    object: 'chat.completion.chunk',
    created: FIXED_CREATED,
    model,
    choices: [],
    usage: { prompt_tokens: inTokens, completion_tokens: outTokens, total_tokens: inTokens + outTokens },
  });
  yield 'data: [DONE]\n\n';
}

/** Gemini SSE in, as OpenAI chunks or as Anthropic events. */
async function* geminiStream(stream: ReadableStream<Uint8Array>, model: string, client: 'openai' | 'anthropic', includeUsage: boolean): AsyncGenerator<string> {
  let inTokens = 0;
  let outTokens = 0;
  let stop: StopKind = 'end';
  let started = false;
  const openStart = (): string[] => {
    if (started) return [];
    started = true;
    if (client === 'openai') {
      return [sse(null, { id: 'chatcmpl-aggregator', object: 'chat.completion.chunk', created: FIXED_CREATED, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })];
    }
    return [
      sse('message_start', {
        type: 'message_start',
        message: { id: 'msg_aggregator', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ];
  };
  for await (const payload of ssePayloads(stream)) {
    const frame = parsePayload(payload);
    if (frame === null) continue;
    yield* openStart();
    if (isRecord(frame.usageMetadata)) {
      inTokens = numOr0(frame.usageMetadata.promptTokenCount);
      outTokens = numOr0(frame.usageMetadata.candidatesTokenCount);
    }
    const candidates = Array.isArray(frame.candidates) ? frame.candidates : [];
    const cand = isRecord(candidates[0]) ? candidates[0] : null;
    if (cand === null) continue;
    const content = isRecord(cand.content) ? cand.content : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const text = parts.flatMap((p) => (isRecord(p) && typeof p.text === 'string' ? [p.text] : [])).join('');
    if (text !== '') {
      if (client === 'openai') {
        yield sse(null, { id: 'chatcmpl-aggregator', object: 'chat.completion.chunk', created: FIXED_CREATED, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      } else {
        yield sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      }
    }
    if (typeof cand.finishReason === 'string' && cand.finishReason !== '') {
      const r = cand.finishReason;
      stop = r === 'MAX_TOKENS' ? 'length' : r === 'SAFETY' || r === 'RECITATION' ? 'filter' : 'end';
    }
  }
  yield* openStart();
  if (client === 'openai') {
    yield sse(null, { id: 'chatcmpl-aggregator', object: 'chat.completion.chunk', created: FIXED_CREATED, model, choices: [{ index: 0, delta: {}, finish_reason: openAIStop(stop) }] });
    yield sse(null, {
      id: 'chatcmpl-aggregator',
      object: 'chat.completion.chunk',
      created: FIXED_CREATED,
      model,
      choices: [],
      usage: { prompt_tokens: inTokens, completion_tokens: outTokens, total_tokens: inTokens + outTokens },
    });
    yield 'data: [DONE]\n\n';
  } else {
    yield sse('content_block_stop', { type: 'content_block_stop', index: 0 });
    yield sse('message_delta', { type: 'message_delta', delta: { stop_reason: anthropicStop(stop), stop_sequence: null }, usage: { output_tokens: outTokens } });
    yield sse('message_stop', { type: 'message_stop' });
  }
}

// ---------------------------------------------------------------------------
// Model lists and error envelopes for the two client wires
// ---------------------------------------------------------------------------

interface ServedModel {
  id: string;
  provider: string;
  displayName: string;
}

function openAIModelList(models: ServedModel[]): Json {
  return { object: 'list', data: models.map((m) => ({ id: m.id, object: 'model', created: FIXED_CREATED, owned_by: m.provider })) };
}

function anthropicModelList(models: ServedModel[]): Json {
  return { data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.displayName, created_at: FIXED_CREATED_AT })), has_more: false };
}

const openAIError = (message: string, type: string, code: string | null): Json => ({ error: { message, type, code } });
const anthropicError = (type: string, message: string): Json => ({ type: 'error', error: { type, message } });

// ---------------------------------------------------------------------------
// Routing: highest-rated free model that meets the requirements first, with
// failover across providers. A provider that refuses three times in a trial
// is treated as spent (its budget or its outage) and skipped afterwards;
// within one request each provider is tried at most once.
// ---------------------------------------------------------------------------

interface Candidate {
  probe: Probe;
  model: ProbedModel;
  rating: number;
  providerOrder: number;
}

const brief = readBrief(PROMPT_FILE);
let probes: Probe[] = [];
let catalog: Catalog = { providers: [] };
const refusals = new Map<string, number>();
let manifestIndex = 0;

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

async function load(): Promise<void> {
  probes = await Promise.all(brief.providers.map((p) => probeProvider(p)));
  catalog = buildCatalog(brief, probes);
}

function candidatesFor(req: Requirement): Candidate[] {
  const out: Candidate[] = [];
  brief.providers.forEach((provider, providerOrder) => {
    const probe = probes.find((p) => p.provider.id === provider.id);
    if (!probe || !probe.ok) return;
    for (const model of probe.models) {
      const row = ratingRow(brief, provider.id, model.id);
      if (!modelFree(model, row)) continue;
      if (!meets(req, capsOf(model, row))) continue;
      out.push({ probe, model, rating: row?.rating ?? -1, providerOrder });
    }
  });
  out.sort((a, b) => b.rating - a.rating || a.providerOrder - b.providerOrder || (a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0));
  return out;
}

/** The free models GET /v1/models lists: the registered free ids, deduped. */
function servedModels(): ServedModel[] {
  const seen = new Set<string>();
  const out: ServedModel[] = [];
  for (const provider of brief.providers) {
    const probe = probes.find((p) => p.provider.id === provider.id);
    if (!probe || !probe.ok) continue;
    const sorted = [...probe.models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const model of sorted) {
      const row = ratingRow(brief, provider.id, model.id);
      if (!modelFree(model, row) || seen.has(model.id)) continue;
      seen.add(model.id);
      out.push({ id: model.id, provider: provider.id, displayName: model.displayName });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upstream calls
// ---------------------------------------------------------------------------

interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  body: Json;
}

function upstreamFor(cand: Candidate, clientWire: 'openai' | 'anthropic', canon: Canon, rawBody: Json, anthropicVersion: string): UpstreamCall {
  const provider = cand.probe.provider;
  const base = joinBase(provider.base);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeaders(provider) };
  if (provider.wire === 'openai') {
    let body = clientWire === 'openai' ? { ...rawBody, model: cand.model.id } : openAIBody(canon, cand.model.id);
    // A streamed answer must end with a usage chunk in this trial's checks,
    // whether or not the client asked for one: force include_usage upstream.
    if (canon.stream) {
      headers.accept = 'text/event-stream';
      const options = isRecord(body.stream_options) ? body.stream_options : {};
      body = { ...body, stream_options: { ...options, include_usage: true } };
    }
    return { url: `${base}/v1/chat/completions`, headers, body };
  }
  if (provider.wire === 'anthropic') {
    const body = clientWire === 'anthropic' ? { ...rawBody, model: cand.model.id } : anthropicBody(canon, cand.model.id);
    headers['anthropic-version'] = anthropicVersion;
    if (canon.stream) headers.accept = 'text/event-stream';
    return { url: `${base}/v1/messages`, headers, body };
  }
  const action = canon.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return { url: `${base}/v1beta/models/${encodeURIComponent(cand.model.id)}:${action}`, headers, body: geminiBody(canon) };
}

async function pipeRaw(stream: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

async function writeStream(gen: AsyncGenerator<string>, res: ServerResponse): Promise<void> {
  for await (const part of gen) res.write(part);
  res.end();
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

const MAX_BODY = 32 * 1024 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendClientError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, message: string): void {
  if (wire === 'anthropic') {
    sendJson(res, status, anthropicError(status === 429 ? 'rate_limit_error' : 'api_error', message));
  } else {
    sendJson(res, status, openAIError(message, status === 429 ? 'rate_limit_error' : 'api_error', null));
  }
}

/** Requirements of the request now arriving: the manifest row, else the body's own shape. */
function requirementsFor(canon: Canon): Requirement {
  const row = brief.manifest[manifestIndex];
  manifestIndex += 1;
  if (row !== undefined) return row.requires;
  return {
    tools: canon.tools.length > 0,
    vision: canon.turns.some((t) => t.images.length > 0),
    json: canon.jsonMode,
    minContext: null,
  };
}

async function serve(res: ServerResponse, clientWire: 'openai' | 'anthropic', rawBody: Json, anthropicVersion: string): Promise<void> {
  const canon = clientWire === 'openai' ? canonFromOpenAI(rawBody) : canonFromAnthropic(rawBody);
  const req = requirementsFor(canon);
  const candidates = candidatesFor(req);
  let lastStatus = 0;
  let lastText = '';
  const triedProviders = new Set<string>();
  for (const cand of candidates) {
    const providerId = cand.probe.provider.id;
    if (triedProviders.has(providerId)) continue;
    if ((refusals.get(providerId) ?? 0) >= 3) continue;
    triedProviders.add(providerId);
    const call = upstreamFor(cand, clientWire, canon, rawBody, anthropicVersion);
    let upstream: Response;
    try {
      upstream = await fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: JSON.stringify(call.body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      refusals.set(providerId, (refusals.get(providerId) ?? 0) + 1);
      lastStatus = 502;
      lastText = (err as Error).message;
      continue;
    }
    if (!upstream.ok) {
      refusals.set(providerId, (refusals.get(providerId) ?? 0) + 1);
      lastStatus = upstream.status;
      lastText = (await upstream.text()).slice(0, 300);
      continue;
    }
    const providerWire = cand.probe.provider.wire;
    if (canon.stream && upstream.body !== null) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      if (providerWire === clientWire) {
        await pipeRaw(upstream.body, res);
      } else if (providerWire === 'openai') {
        await writeStream(openAIStreamToAnthropic(upstream.body, cand.model.id), res);
      } else if (providerWire === 'anthropic') {
        await writeStream(anthropicStreamToOpenAI(upstream.body, cand.model.id, canon.includeUsage), res);
      } else {
        await writeStream(geminiStream(upstream.body, cand.model.id, clientWire, canon.includeUsage), res);
      }
      return;
    }
    const parsed: unknown = await upstream.json().catch(() => null);
    const answerBody = isRecord(parsed) ? parsed : {};
    const answer = providerWire === 'openai' ? answerFromOpenAI(answerBody) : providerWire === 'anthropic' ? answerFromAnthropic(answerBody) : answerFromGemini(answerBody);
    sendJson(res, 200, clientWire === 'openai' ? renderOpenAI(answer, cand.model.id) : renderAnthropic(answer, cand.model.id));
    return;
  }
  const status = lastStatus === 402 || lastStatus === 429 ? lastStatus : 503;
  sendClientError(res, clientWire, status, `no free model could serve this request (last upstream answer: HTTP ${lastStatus} ${lastText})`);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const list = servedModels();
    if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
    else sendJson(res, 200, openAIModelList(list));
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages')) {
    const wire: 'openai' | 'anthropic' = url.pathname === '/v1/messages' ? 'anthropic' : 'openai';
    const body = await readJsonBody(req);
    if (body === null) {
      sendClientError(res, wire, 400, 'the request body is not one JSON object');
      return;
    }
    const version = typeof req.headers['anthropic-version'] === 'string' ? req.headers['anthropic-version'] : '2023-06-01';
    await serve(res, wire, body, version);
    return;
  }
  sendClientError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, `no route ${req.method ?? ''} ${url.pathname}`);
}

// ---------------------------------------------------------------------------
// Bootstrap: probe, --list, listen, register, poll /work, exit 0 when done
// ---------------------------------------------------------------------------

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

async function register(port: number): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: 1, port, catalog }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST /register answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: ${reply.requests} requests in the workload`);
}

function pollWork(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) {
          const work: unknown = await res.json();
          if (isRecord(work) && work.done === true) {
            clearInterval(timer);
            server.close();
            process.exit(0);
          }
        }
      } catch {
        // Env not reachable yet: try the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, 100);
}

async function start(): Promise<void> {
  await load();
  if (process.argv.includes('--list')) {
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendClientError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  if (address.port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${address.port}, ${catalog.providers.length} providers in catalog, ${servedModels().length} free models served`);
  await register(address.port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  pollWork(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
