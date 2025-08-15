// Supabase Edge Function: generate-leads - SerpAPI + Hunter.io
// Deno runtime
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

interface Lead {
  name: string;
  title: string;
  company: string;
  email?: string;
  confidence?: number;
  source: string;
}

interface SerpApiResult {
  title: string;
  link: string;
  snippet: string;
}

interface HunterContact {
  first_name: string;
  last_name: string;
  email: string;
  position: string;
  confidence: number;
}

interface HunterResponse {
  data: {
    emails: HunterContact[];
    domain: string;
  };
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
const HUNTER_KEY = Deno.env.get("HUNTER_KEY");

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

function extractDomainFromUrl(url: string): string | null {
  try {
    const domain = new URL(url).hostname.replace('www.', '');
    // Filter out job boards and social media
    const jobBoards = ['indeed.com', 'glassdoor.com', 'monster.com', 'linkedin.com', 'facebook.com', 'twitter.com'];
    if (jobBoards.some(board => domain.includes(board))) {
      return null;
    }
    return domain;
  } catch {
    return null;
  }
}

async function findCompanyDomains(jobTitle: string, location?: string, industry?: string): Promise<string[]> {
  if (!SERPAPI_KEY) {
    throw new Error("Missing SERPAPI_KEY secret");
  }

  const locationPart = location ? ` "${location}"` : "";
  const industryPart = industry ? ` "${industry}"` : "";
  
  const query = `"${jobTitle}" ("Careers" OR "Jobs" OR "We're Hiring") site:*.com -site:linkedin.com -site:facebook.com -site:twitter.com${locationPart}${industryPart}`;
  
  console.log(`🔍 SerpAPI company search query: "${query}"`);

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("num", "100");
  url.searchParams.set("engine", "google");

  try {
    const response = await fetch(url.toString());
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`SerpAPI error: ${response.status} - ${errorText}`);
      throw new Error(`SerpAPI request failed: ${response.status}`);
    }

    const data = await response.json();
    console.log(`🔍 SerpAPI found ${data.organic_results?.length || 0} results`);

    const domains = new Set<string>();
    
    if (data.organic_results) {
      for (const result of data.organic_results) {
        const domain = extractDomainFromUrl(result.link);
        if (domain) {
          domains.add(domain);
        }
      }
    }
    
    const uniqueDomains = Array.from(domains);
    console.log(`🏢 Found ${uniqueDomains.length} unique company domains`);
    
    return uniqueDomains.slice(0, 50); // Limit to 50 companies for API rate limits
  } catch (err) {
    console.error(`Error calling SerpAPI:`, err);
    throw err;
  }
}

async function findContactsAtCompany(domain: string): Promise<Lead[]> {
  if (!HUNTER_KEY) {
    console.log("⚠️ Missing HUNTER_KEY, skipping Hunter.io enrichment");
    return [];
  }

  console.log(`👥 Searching contacts at ${domain}`);

  const url = new URL("https://api.hunter.io/v2/domain-search");
  url.searchParams.set("domain", domain);
  url.searchParams.set("type", "personal");
  url.searchParams.set("api_key", HUNTER_KEY);
  url.searchParams.set("limit", "10");

  try {
    const response = await fetch(url.toString());
    
    if (!response.ok) {
      console.error(`Hunter.io error for ${domain}: ${response.status}`);
      return [];
    }

    const data: HunterResponse = await response.json();
    
    if (!data.data?.emails) {
      console.log(`No contacts found for ${domain}`);
      return [];
    }

    const relevantRoles = [
      "hiring manager", "recruiter", "hr manager", "talent acquisition", 
      "engineering manager", "technical recruiter", "head of talent", 
      "director of recruiting", "talent partner", "people operations"
    ];

    const contacts = data.data.emails
      .filter(contact => {
        const position = contact.position?.toLowerCase() || "";
        return relevantRoles.some(role => position.includes(role));
      })
      .map(contact => ({
        name: `${contact.first_name} ${contact.last_name}`,
        title: contact.position || "Professional",
        company: domain,
        email: contact.email,
        confidence: contact.confidence,
        source: "Hunter.io"
      }));

    console.log(`👥 Found ${contacts.length} relevant contacts at ${domain}`);
    return contacts;
  } catch (err) {
    console.error(`Error finding contacts for ${domain}:`, err);
    return [];
  }
}

async function generateLeads(
  prompt: string, 
  jobDescription: string, 
  limit: number = 200,
  location?: string,
  industry?: string,
  companySize?: string
): Promise<Lead[]> {
  console.log("🚀 Starting lead generation with SerpAPI + Hunter.io...");
  
  // Extract job title from description
  const jobTitle = extractJobTitle(jobDescription);
  console.log(`🎯 Extracted job title: "${jobTitle}"`);

  // Phase 1: Find companies that are hiring
  const domains = await findCompanyDomains(jobTitle, location, industry);
  
  if (domains.length === 0) {
    console.log("⚠️ No companies found");
    return [];
  }

  // Phase 2: Find contacts at each company
  const allLeads: Lead[] = [];
  let processedCompanies = 0;
  
  for (const domain of domains) {
    if (allLeads.length >= limit) {
      break;
    }
    
    try {
      const contacts = await findContactsAtCompany(domain);
      allLeads.push(...contacts);
      processedCompanies++;
      
      // Add small delay to respect API rate limits
      if (processedCompanies % 5 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (err) {
      console.error(`Error processing ${domain}:`, err);
      continue;
    }
  }

  console.log(`📊 Processed ${processedCompanies} companies, found ${allLeads.length} total leads`);
  
  // Sort by confidence and limit results
  const sortedLeads = allLeads
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, limit);
  
  console.log(`📤 Returning ${sortedLeads.length} final leads`);
  return sortedLeads;
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
      company: lead.company,
      email: lead.email,
      confidence: lead.confidence,
      source: lead.source,
      profile_url: "", // No LinkedIn URLs in this workflow
      relevance_score: lead.confidence || 0
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
