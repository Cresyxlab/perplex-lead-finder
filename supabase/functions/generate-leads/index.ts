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

interface Company {
  company_name: string;
  industry: string;
  headquarters_location: string;
  careers_page_url: string;
  linkedin_company_url: string;
  example_role_titles: string[];
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

function safeExtractJson(text: string): any[] {
  try {
    // Remove markdown code blocks
    let cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    
    // Try to find JSON array
    const start = cleanText.indexOf("[");
    const end = cleanText.lastIndexOf("]") + 1;
    
    if (start === -1 || end === -1) {
      console.log("🔍 DEBUG: No JSON array brackets found in text");
      return [];
    }
    
    const jsonStr = cleanText.slice(start, end);
    const parsed = JSON.parse(jsonStr);
    console.log(`🔍 DEBUG: Successfully parsed ${parsed.length} items from JSON`);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("🔍 DEBUG: JSON parse failed:", err);
    console.log("🔍 DEBUG: Failed text was:", text.substring(0, 500));
    return [];
  }
}

function normalizeCompany(company: any): Company | null {
  if (!company.company_name || !company.example_role_titles || 
      (Array.isArray(company.example_role_titles) && company.example_role_titles.length === 0)) {
    return null;
  }
  
  return {
    company_name: company.company_name || company.name || "",
    industry: company.industry || "",
    headquarters_location: company.headquarters_location || company.location || "",
    careers_page_url: company.careers_page_url || company.careers_url || "",
    linkedin_company_url: company.linkedin_company_url || company.linkedin_url || "",
    example_role_titles: Array.isArray(company.example_role_titles) 
      ? company.example_role_titles 
      : [company.example_role_titles].filter(Boolean)
  };
}

function normalizeCompanies(companies: any[]): Company[] {
  return companies.map(normalizeCompany).filter((company): company is Company => company !== null);
}

function dedupeCompanies(companies: Company[]): Company[] {
  const seen = new Map();
  for (const company of companies) {
    const key = company.company_name.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, company);
    }
  }
  return Array.from(seen.values());
}

function companiesToLeads(companies: Company[]): Lead[] {
  return companies.map((company, index) => ({
    name: company.company_name,
    title: company.example_role_titles[0] || "Multiple Roles",
    company: company.company_name,
    location: company.headquarters_location,
    profile_url: company.linkedin_company_url || company.careers_page_url,
    relevance_score: 100 - index // Simple relevance based on position
  }));
}

async function generateLeads(prompt: string, jobDescription: string, limit: number = 200): Promise<Lead[]> {
  if (!PERPLEXITY_API_KEY) {
    throw new Error("Missing PERPLEXITY_API_KEY secret");
  }

  // PHASE 1 - COMPANY DISCOVERY: Generate 5 variations to discover companies
  const companyQueries = [
    `List 50 companies actively hiring for: ${jobDescription}`,
    `Companies in United States recruiting for: ${jobDescription}`,
    `Firms that have posted jobs for: ${jobDescription} in the last 6 months`,
    `${jobDescription} hiring companies with over 50 employees`,
    `Top employers hiring for ${jobDescription} roles right now`,
  ];

  let allCompanies: Company[] = [];

  console.log("🏢 PHASE 1 - COMPANY DISCOVERY: Finding companies with 5 variations...");
  
  for (const query of companyQueries) {
    const messages = [
      {
        role: "user",
        content: `${query}. Return ONLY a valid JSON array with these exact keys: company_name, industry, headquarters_location, careers_page_url, linkedin_company_url, example_role_titles (array of job titles).`
      }
    ];

    try {
      console.log(`Processing company query: "${query}"`);
      const perplexityData = await callPerplexityWithFallback(messages);
      const rawText = perplexityData.choices?.[0]?.message?.content || "";
      console.log(`🏢 PHASE 1 raw response for "${query}": ${rawText.substring(0, 200)}...`);
      
      let companies = safeExtractJson(rawText);
      
      if (companies.length === 0) {
        console.log(`🔍 DEBUG: Zero companies extracted from query "${query}"`);
        console.log(`🔍 DEBUG: Full raw response:`, rawText);
      }
      
      const normalizedCompanies = normalizeCompanies(companies);
      allCompanies = allCompanies.concat(normalizedCompanies);
      console.log(`Found ${normalizedCompanies.length} companies for query: "${query}"`);
      
    } catch (err) {
      console.error(`Error in PHASE 1 for query "${query}":`, err);
      continue;
    }
  }

  if (allCompanies.length === 0) {
    console.log("🏢 PHASE 1 produced no valid companies");
    return [];
  }

  // PHASE 2 - MERGE & CLEAN: Deduplicate and validate companies
  console.log("🧹 PHASE 2 - MERGE & CLEAN: Processing companies...");
  console.log(`🧹 Total companies before deduplication: ${allCompanies.length}`);
  
  let uniqueCompanies = dedupeCompanies(allCompanies);
  console.log(`🧹 Unique companies after deduplication: ${uniqueCompanies.length}`);

  // PHASE 3 - OUTPUT: Sort and convert to leads format
  console.log("📤 PHASE 3 - OUTPUT: Converting to leads format...");
  
  uniqueCompanies = uniqueCompanies.sort((a, b) => a.company_name.localeCompare(b.company_name));
  uniqueCompanies = uniqueCompanies.slice(0, limit);
  
  const finalLeads = companiesToLeads(uniqueCompanies);
  console.log(`Final leads count: ${finalLeads.length}`);
  return finalLeads;
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
