// Supabase Edge Function: generate-leads
// Deno runtime
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

interface Lead {
  name: string;
  title: string;
  company: string;
  location: string;
  profile_url: string;
  relevance_score: number;
}

interface GenerateRequestBody {
  prompt: string;
  jobDescription: string;
  limit?: number;
}

const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function buildInstruction(jobDescription: string, query: string) {
  return `Find up to 25 hiring managers that match the following job description: "${jobDescription}".
Search using: "${query}".
Return ONLY a valid JSON array with these exact keys:
name, title, company, location, profile_url, relevance_score (0-100).
Do not include any explanation, markdown, or extra text outside the JSON.`;
}

function generateVariations(prompt: string, job: string): string[] {
  const terms = [
    "hiring manager",
    "director",
    "head of",
    "vp",
    "lead",
    "manager",
  ];
  const actions = [
    "hiring",
    "recruiting",
    "building team",
    "open roles",
  ];
  const scopes = [
    "EU",
    "Europe",
    "European Union",
    "UK",
  ];

  const base = prompt.trim();
  const variants = new Set<string>();

  variants.add(base);
  for (const t of terms) {
    variants.add(`${base} ${t}`);
  }
  for (const a of actions) {
    variants.add(`${base} ${a}`);
  }
  for (const s of scopes) {
    variants.add(`${base} ${s}`);
  }
  // Job-based expansions
  variants.add(`${base} — profile: ${job.slice(0, 120)}`);
  variants.add(`Leaders matching JD: ${job.slice(0, 160)} — ${base}`);

  return Array.from(variants).slice(0, 12); // cap to 12
}

function safeParseLeads(text: string): Lead[] {
  // Strip code fences if any
  const stripped = text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  // Try direct parse
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) return parsed as Lead[];
  } catch (_) {}

  // Fallback: extract first JSON array
  const match = stripped.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed as Lead[];
    } catch (_) {}
  }

  return [];
}

function normalizeLead(raw: any): Lead | null {
  if (!raw) return null;
  const name = String(raw.name || "").trim();
  const title = String(raw.title || "").trim();
  const company = String(raw.company || "").trim();
  const location = String(raw.location || "").trim();
  const profile_url = String(raw.profile_url || raw.profileUrl || "").trim();
  const relevance_score = Number(raw.relevance_score ?? raw.relevanceScore ?? 0);
  if (!name || !company) return null;
  return { name, title, company, location, profile_url, relevance_score };
}

async function callPerplexity(job: string, query: string): Promise<Lead[]> {
  if (!PERPLEXITY_API_KEY) {
    console.error("Missing PERPLEXITY_API_KEY secret");
    throw new Error("Missing PERPLEXITY_API_KEY secret");
  }

  const body = {
    model: "sonar-medium-online",
    messages: [
      { role: "system", content: "Be precise and concise. Return only JSON." },
      { role: "user", content: buildInstruction(job, query) },
    ],
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 1000,
    return_images: false,
    return_related_questions: false,
  };

  console.log(`Calling Perplexity API for query: "${query}"`);

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  console.log(`Perplexity API response status: ${res.status}`);

  if (!res.ok) {
    const txt = await res.text();
    console.error(`Perplexity error ${res.status}: ${txt}`);
    throw new Error(`Perplexity error ${res.status}: ${txt}`);
  }

  const data = await res.json();
  console.log(`Perplexity API response:`, JSON.stringify(data, null, 2));
  
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  console.log(`Content received: ${content.substring(0, 200)}...`);
  
  const leads = safeParseLeads(content)
    .map(normalizeLead)
    .filter((l): l is Lead => !!l)
    .map((l) => ({
      ...l,
      relevance_score: Math.max(0, Math.min(100, Math.round(l.relevance_score || 0))),
    }));

  console.log(`Parsed ${leads.length} leads from this query`);
  return leads;
}

async function withConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function run() {
    while (index < items.length) {
      const i = index++;
      try {
        const r = await worker(items[i]);
        // @ts-ignore collect arrays by spreading if present
        if (Array.isArray(r)) results.push(...(r as any));
        else results.push(r as any);
      } catch (_e) {
        // swallow individual call errors to continue coverage
      }
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, run);
  await Promise.all(runners);
  return results;
}

function dedupeAndSort(leads: Lead[], limit: number): Lead[] {
  const map = new Map<string, Lead>();
  for (const l of leads) {
    const key = `${l.name.toLowerCase()}|${l.company.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing || (l.relevance_score ?? 0) > (existing.relevance_score ?? 0)) {
      map.set(key, l);
    }
  }
  return Array.from(map.values())
    .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
    .slice(0, limit);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  try {
    const { prompt, jobDescription, limit }: GenerateRequestBody = await req.json();

    if (!prompt || !jobDescription) {
      return new Response(JSON.stringify({ error: "prompt and jobDescription are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    const target = Math.max(10, Math.min(Number(limit || 200), 500));

    const variations = generateVariations(prompt, jobDescription);

    const concurrentCalls = 4; // Respect rate limits: 3–5 concurrent
    const allLeads = (await withConcurrency(variations, concurrentCalls, (q) =>
      callPerplexity(jobDescription, q)
    )) as Lead[];

    const finalLeads = dedupeAndSort(allLeads, target);

    return new Response(JSON.stringify({ leads: finalLeads }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      status: 200,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
});
