// Supabase Edge Function: generate-leads - SerpAPI Google Search
// Deno runtime
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

interface Lead {
  name: string;
  title: string;
  company_name: string;
  email?: string;
  linkedin_url: string;
  location: string;
  relevance_score: number;
}

interface SerpApiResult {
  title: string;
  link: string;
  snippet: string;
}

interface GenerateRequestBody {
  prompt: string;
  jobDescription: string;
  limit?: number;
  location?: string;
  industry?: string;
  companySize?: string;
}

const SERPAPI_KEY = Deno.env.get("SERPAPI_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function extractJobTitle(jobDescription: string): string {
  // Extract the job title from the description
  const lines = jobDescription.split('\n');
  const titleLine = lines.find(line => 
    line.toLowerCase().includes('title:') || 
    line.toLowerCase().includes('position:') || 
    line.toLowerCase().includes('role:')
  );
  
  if (titleLine) {
    return titleLine.split(':')[1]?.trim() || '';
  }
  
  // If no explicit title line, try to extract from first line or description
  const firstLine = lines[0]?.trim();
  if (firstLine && firstLine.length < 100) {
    return firstLine;
  }
  
  // Fallback: look for common job titles in the description
  const commonTitles = [
    'Senior Machine Learning Engineer', 'Machine Learning Engineer', 'Data Scientist', 
    'Software Engineer', 'Full Stack Developer', 'Backend Engineer', 'Frontend Engineer',
    'DevOps Engineer', 'Product Manager', 'Engineering Manager', 'Technical Lead'
  ];
  
  for (const title of commonTitles) {
    if (jobDescription.toLowerCase().includes(title.toLowerCase())) {
      return title;
    }
  }
  
  return 'Software Engineer'; // Default fallback
}

function getJobTitleSynonyms(jobTitle: string): string[] {
  const synonymMap: { [key: string]: string[] } = {
    'machine learning engineer': ['ML Engineer', 'AI Engineer', 'Data Engineer', 'AI/ML Engineer'],
    'software engineer': ['Software Developer', 'Developer', 'Programmer', 'Software Dev'],
    'data scientist': ['Data Analyst', 'Analytics Engineer', 'Data Engineer'],
    'product manager': ['PM', 'Product Owner', 'Product Lead'],
    'full stack developer': ['Fullstack Developer', 'Full-Stack Engineer', 'Web Developer'],
    'devops engineer': ['DevOps', 'Site Reliability Engineer', 'SRE', 'Platform Engineer']
  };
  
  const lowerTitle = jobTitle.toLowerCase();
  for (const [key, synonyms] of Object.entries(synonymMap)) {
    if (lowerTitle.includes(key)) {
      return [jobTitle, ...synonyms];
    }
  }
  
  return [jobTitle];
}

async function callSerpAPI(query: string): Promise<SerpApiResult[]> {
  if (!SERPAPI_KEY) {
    throw new Error("Missing SERPAPI_KEY secret");
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("num", "100");
  url.searchParams.set("engine", "google");

  console.log(`🔍 SerpAPI query: "${query}"`);

  try {
    const response = await fetch(url.toString());
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`SerpAPI error: ${response.status} - ${errorText}`);
      throw new Error(`SerpAPI request failed: ${response.status}`);
    }

    const data = await response.json();
    console.log(`🔍 SerpAPI response status: ${response.status}`);
    console.log(`🔍 SerpAPI raw response: ${JSON.stringify(data).substring(0, 500)}...`);

    return data.organic_results || [];
  } catch (err) {
    console.error(`Error calling SerpAPI:`, err);
    throw err;
  }
}

function mapSerpResultToLead(result: SerpApiResult): Lead | null {
  if (!result.link || !result.link.includes('linkedin.com/in/')) {
    return null;
  }

  // Extract name from title (remove " - LinkedIn" or similar suffixes)
  let name = result.title.replace(/ - LinkedIn.*$/i, '').replace(/ \| LinkedIn.*$/i, '').trim();
  
  // Extract potential title and company from snippet or title
  let title = "Professional";
  let company = "Company";
  let location = "";

  // Try to extract from snippet
  const snippet = result.snippet || "";
  const titleMatches = snippet.match(/(?:at|@)\s+([^,.\n]+)/i);
  if (titleMatches) {
    company = titleMatches[1].trim();
  }

  const positionMatches = snippet.match(/^([^,.\n]+?)(?:\s+at\s+|\s+@\s+|,)/i);
  if (positionMatches && !positionMatches[1].includes(name)) {
    title = positionMatches[1].trim();
  }

  // Extract location if present
  const locationMatches = snippet.match(/(?:in|from)\s+([^,.\n]+?)(?:\s*[,.]|$)/i);
  if (locationMatches) {
    location = locationMatches[1].trim();
  }

  return {
    name,
    title,
    company_name: company,
    linkedin_url: result.link,
    location,
    relevance_score: 85 // Default relevance score
  };
}

function deduplicateLeadsByUrl(leads: Lead[]): Lead[] {
  const seen = new Map<string, Lead>();
  
  for (const lead of leads) {
    const existing = seen.get(lead.linkedin_url);
    if (!existing || lead.relevance_score > existing.relevance_score) {
      seen.set(lead.linkedin_url, lead);
    }
  }
  
  return Array.from(seen.values());
}

async function generateLeads(
  prompt: string, 
  jobDescription: string, 
  limit: number = 200,
  location?: string,
  industry?: string,
  companySize?: string
): Promise<Lead[]> {
  console.log("🔍 Starting SerpAPI lead generation...");
  
  // Extract job title from description
  const jobTitle = extractJobTitle(jobDescription);
  console.log(`🔍 Extracted job title: "${jobTitle}"`);

  // Build base search query
  const locationPart = location ? `"${location}"` : "";
  const industryPart = industry ? `"${industry}"` : "";
  
  const baseQuery = `site:linkedin.com/in "${jobTitle}" "hiring manager" ${locationPart} ${industryPart}`.trim();
  
  let allLeads: Lead[] = [];
  const queries = [baseQuery];

  // If we need more results, add synonym queries
  if (limit > 50) {
    const synonyms = getJobTitleSynonyms(jobTitle);
    for (const synonym of synonyms.slice(1, 4)) { // Add up to 3 synonyms
      queries.push(`site:linkedin.com/in "${synonym}" "hiring manager" ${locationPart} ${industryPart}`.trim());
    }
  }

  // Execute searches
  for (const query of queries) {
    try {
      const results = await callSerpAPI(query);
      console.log(`🔍 Got ${results.length} results for query: "${query}"`);
      
      const leads = results
        .map(mapSerpResultToLead)
        .filter((lead): lead is Lead => lead !== null);
      
      allLeads.push(...leads);
      console.log(`🔍 Mapped to ${leads.length} valid leads`);
      
      // Stop if we have enough leads
      if (allLeads.length >= limit * 2) { // Get extra for deduplication
        break;
      }
    } catch (err) {
      console.error(`Error processing query "${query}":`, err);
      continue;
    }
  }

  if (allLeads.length === 0) {
    console.log("🔍 No leads found from SerpAPI");
    return [];
  }

  // Deduplicate by LinkedIn URL
  const uniqueLeads = deduplicateLeadsByUrl(allLeads);
  console.log(`🔍 Unique leads after deduplication: ${uniqueLeads.length}`);

  // Sort by relevance and limit
  const sortedLeads = uniqueLeads.sort((a, b) => b.relevance_score - a.relevance_score);
  const finalLeads = sortedLeads.slice(0, limit);
  
  console.log(`📤 Final leads count: ${finalLeads.length}`);
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
    const { prompt, jobDescription, limit, location, industry, companySize }: GenerateRequestBody = await req.json();

    if (!prompt || !jobDescription) {
      return new Response(JSON.stringify({ error: "prompt and jobDescription are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    const target = Math.max(10, Math.min(Number(limit || 200), 500));

    const finalLeads = await generateLeads(prompt, jobDescription, target, location, industry, companySize);

    // Convert to frontend format
    const formattedLeads = finalLeads.map(lead => ({
      name: lead.name,
      title: lead.title,
      company: lead.company_name,
      location: lead.location,
      profile_url: lead.linkedin_url,
      relevance_score: lead.relevance_score
    }));

    return new Response(JSON.stringify({ leads: formattedLeads }), {
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
