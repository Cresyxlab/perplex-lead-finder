// Supabase Edge Function: generate-leads - Modular SerpAPI + Hunter.io with Streaming
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

interface Lead {
  name: string;
  title: string;
  email: string;
  confidence: number;
  company: string;
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
  jobTitle: string;
  jobDescription: string;
  location?: string;
  industry?: string;
}

const SERPAPI_KEY = Deno.env.get("SERPAPI_KEY");
const HUNTER_KEY = Deno.env.get("HUNTER_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ============== SERVICE 1: SEARCH SERVICE ==============
class SearchService {
  static async findCompanyDomains(
    jobTitle: string,
    location?: string,
    industry?: string
  ): Promise<string[]> {
    if (!SERPAPI_KEY) {
      throw new Error("Missing SERPAPI_KEY secret");
    }

    console.log(`🔍 SearchService: Finding companies hiring for "${jobTitle}"`);

    const locationPart = location ? ` "${location}"` : "";
    const industryPart = industry ? ` "${industry}"` : "";
    
    const query = `"${jobTitle}" ("Careers" OR "Jobs" OR "We're Hiring") site:*.com -site:linkedin.com -site:facebook.com -site:twitter.com -site:indeed.com -site:glassdoor.com -site:monster.com${locationPart}${industryPart}`;
    
    console.log(`🔍 SerpAPI query: "${query}"`);

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
          const domain = this.extractDomainFromUrl(result.link);
          if (domain) {
            domains.add(domain);
          }
        }
      }
      
      const uniqueDomains = Array.from(domains);
      console.log(`🏢 SearchService: Found ${uniqueDomains.length} unique company domains`);
      
      return uniqueDomains.slice(0, 50); // Limit for API rate limits
    } catch (err) {
      console.error(`SearchService error:`, err);
      throw err;
    }
  }

  private static extractDomainFromUrl(url: string): string | null {
    try {
      const domain = new URL(url).hostname.replace('www.', '');
      // Filter out job boards and social media
      const jobBoards = [
        'indeed.com', 'glassdoor.com', 'monster.com', 'linkedin.com', 
        'facebook.com', 'twitter.com', 'ziprecruiter.com', 'dice.com',
        'builtinnyc.com', 'builtinboston.com', 'wellfound.com', 'remoterocketship.com'
      ];
      if (jobBoards.some(board => domain.includes(board))) {
        return null;
      }
      return domain;
    } catch {
      return null;
    }
  }
}

// ============== SERVICE 2: ENRICHMENT SERVICE ==============
class EnrichmentService {
  private static readonly HIRING_ROLES = [
    "hiring manager", "recruiter", "talent acquisition", "hr manager", 
    "hr director", "engineering manager", "head of people", "vp talent", 
    "technical recruiter"
  ];

  static async findContactsAtCompany(domain: string): Promise<Lead[]> {
    if (!HUNTER_KEY) {
      console.log("⚠️ Missing HUNTER_KEY, skipping Hunter.io enrichment");
      return [];
    }

    console.log(`👥 EnrichmentService: Searching contacts at ${domain}`);

    const url = new URL("https://api.hunter.io/v2/domain-search");
    url.searchParams.set("domain", domain);
    url.searchParams.set("type", "personal");
    url.searchParams.set("api_key", HUNTER_KEY);
    url.searchParams.set("limit", "15");

    try {
      const response = await fetch(url.toString());
      
      if (!response.ok) {
        console.error(`Hunter.io error for ${domain}: ${response.status}`);
        return [];
      }

      const data: HunterResponse = await response.json();
      
      if (!data.data?.emails) {
        console.log(`👥 No contacts found for ${domain}`);
        return [];
      }

      const contacts = data.data.emails
        .filter(contact => {
          const position = contact.position?.toLowerCase() || "";
          return this.HIRING_ROLES.some(role => position.includes(role));
        })
        .map(contact => ({
          name: `${contact.first_name} ${contact.last_name}`,
          title: contact.position || "Professional",
          email: contact.email,
          confidence: contact.confidence,
          company: domain,
          source: "Hunter.io"
        }));

      console.log(`👥 EnrichmentService: Found ${contacts.length} relevant contacts at ${domain}`);
      return contacts;
    } catch (err) {
      console.error(`EnrichmentService error for ${domain}:`, err);
      return [];
    }
  }
}

// ============== SERVICE 3: AGGREGATION SERVICE ==============
class AggregationService {
  private leads: Set<string> = new Set(); // Track by email to deduplicate
  private allLeads: Lead[] = [];

  async generateLeadsWithStreaming(
    jobTitle: string,
    jobDescription: string,
    location?: string,
    industry?: string,
    onProgress?: (progress: number, lead?: Lead) => void
  ): Promise<Lead[]> {
    console.log("🚀 AggregationService: Starting lead generation...");
    
    // Phase 1: Find companies
    onProgress?.(10);
    const domains = await SearchService.findCompanyDomains(jobTitle, location, industry);
    
    if (domains.length === 0) {
      throw new Error("No companies found. Try a broader job title or remove location filter.");
    }

    onProgress?.(20);

    // Phase 2: Process companies and find contacts
    const totalDomains = domains.length;
    let processedDomains = 0;
    
    for (const domain of domains) {
      if (this.allLeads.length >= 200) {
        break;
      }

      try {
        const contacts = await EnrichmentService.findContactsAtCompany(domain);
        
        // Deduplicate by email
        for (const contact of contacts) {
          if (!this.leads.has(contact.email) && this.allLeads.length < 200) {
            this.leads.add(contact.email);
            this.allLeads.push(contact);
            
            // Stream individual lead back
            onProgress?.(
              20 + Math.floor((processedDomains / totalDomains) * 70),
              contact
            );
          }
        }

        processedDomains++;
        
        // Small delay for API rate limiting
        if (processedDomains % 5 === 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

      } catch (err) {
        console.error(`Error processing ${domain}:`, err);
        continue;
      }
    }

    // Final sorting by confidence
    this.allLeads.sort((a, b) => b.confidence - a.confidence);
    
    console.log(`📊 AggregationService: Completed with ${this.allLeads.length} leads from ${processedDomains} companies`);
    onProgress?.(100);
    
    return this.allLeads.slice(0, 200);
  }
}

// ============== MAIN HANDLER ==============
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
    const { jobTitle, jobDescription, location, industry }: GenerateRequestBody = await req.json();

    if (!jobTitle || !jobDescription) {
      return new Response(JSON.stringify({ error: "jobTitle and jobDescription are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // Create streaming response
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        
        const sendMessage = (type: string, data: any) => {
          const message = `data: ${JSON.stringify({ type, ...data })}\n\n`;
          controller.enqueue(encoder.encode(message));
        };

        try {
          const aggregationService = new AggregationService();
          
          await aggregationService.generateLeadsWithStreaming(
            jobTitle,
            jobDescription,
            location,
            industry,
            (progress: number, lead?: Lead) => {
              if (lead) {
                sendMessage('lead', { lead });
              }
              sendMessage('progress', { value: progress });
            }
          );

          sendMessage('complete', { message: 'Lead generation completed' });
        } catch (error) {
          console.error('Streaming error:', error);
          sendMessage('error', { 
            message: error instanceof Error ? error.message : 'An error occurred' 
          });
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...CORS_HEADERS,
      },
    });

  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
});