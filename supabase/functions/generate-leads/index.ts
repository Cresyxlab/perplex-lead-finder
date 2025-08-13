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

async function callPerplexityWithFallback(messages: any[]): Promise<any> {
  const models = ["sonar-small-online", "sonar-large-online"];

  for (const model of models) {
    try {
      const res = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${PERPLEXITY_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          top_p: 0.9,
          max_tokens: 1000,
          return_images: false,
          return_related_questions: false,
        })
      });

      if (!res.ok) {
        const errorData = await res.json();
        console.warn(`Model ${model} failed:`, errorData);
        continue;
      }

      const data = await res.json();
      console.log(`✅ Used model: ${model}`);
      return data;

    } catch (err) {
      console.error(`Error calling ${model}:`, err);
      continue;
    }
  }

  throw new Error("All Perplexity model calls failed.");
}

function extractJsonArray(text: string): Lead[] {
  try {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]") + 1;
    if (start === -1 || end === -1) return [];
    return JSON.parse(text.slice(start, end));
  } catch (err) {
    console.error("JSON parse failed:", err);
    return [];
  }
}

function normalizeLeads(leads: any[]): Lead[] {
  return leads.map(lead => ({
    name: lead.name || "",
    title: lead.title || "",
    company: lead.company || "",
    location: lead.location || "",
    profile_url: lead.profile_url || "",
    relevance_score: Math.max(0, Math.min(100, Math.round(lead.relevance_score || lead.score || 0)))
  })).filter(lead => lead.name && lead.company);
}

function dedupeLeads(leads: Lead[]): Lead[] {
  const seen = new Map();
  for (const lead of leads) {
    const key = `${lead.name}-${lead.company}`.toLowerCase();
    if (!seen.has(key) || lead.relevance_score > seen.get(key).relevance_score) {
      seen.set(key, lead);
    }
  }
  return Array.from(seen.values());
}

async function generateLeads(prompt: string, jobDescription: string, limit: number = 200): Promise<Lead[]> {
  if (!PERPLEXITY_API_KEY) {
    throw new Error("Missing PERPLEXITY_API_KEY secret");
  }

  const queries = [
    `Find hiring managers relevant to: ${jobDescription}`,
    `List decision makers hiring for: ${prompt}`,
    `Hiring managers in companies needing: ${jobDescription}`,
    `${prompt} recruitment leads`,
    `Key people hiring for: ${jobDescription}`,
    `Directors or managers in charge of hiring for: ${jobDescription}`,
    `Leads for companies actively recruiting for: ${jobDescription}`,
  ];

  let allLeads: Lead[] = [];

  for (const query of queries) {
    const messages = [
      {
        role: "user",
        content: `Find up to 25 hiring managers that match this job description: "${jobDescription}". 
        Search using: "${query}". 
        Return ONLY a valid JSON array with these exact keys: name, title, company, location, profile_url, relevance_score (0-100).`
      }
    ];

    try {
      console.log(`Processing query: "${query}"`);
      const perplexityData = await callPerplexityWithFallback(messages);
      const rawText = perplexityData.choices?.[0]?.message?.content || "";
      console.log(`Raw response for query "${query}": ${rawText.substring(0, 200)}...`);
      
      let leads = extractJsonArray(rawText);
      leads = normalizeLeads(leads);
      allLeads = allLeads.concat(leads);
      console.log(`Found ${leads.length} leads for query: "${query}"`);
    } catch (err) {
      console.error(`Error fetching for query "${query}":`, err);
      continue;
    }
  }

  // Deduplicate + sort
  let finalLeads = dedupeLeads(allLeads);
  finalLeads = finalLeads.sort((a, b) => b.relevance_score - a.relevance_score);
  console.log(`Final leads count: ${finalLeads.length}`);
  return finalLeads.slice(0, limit);
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

    const finalLeads = await generateLeads(prompt, jobDescription, target);

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
