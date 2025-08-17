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
  leadCount?: number;
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
  async findCompanyDomains(jobTitle: string, location?: string, industry?: string): Promise<string[]> {
    try {
      // Enhanced query format
      let query = `"${jobTitle}" ("Careers" OR "Jobs" OR "We're Hiring") -site:linkedin.com`;
      if (location && location !== 'global') query += ` location:${location}`;
      if (industry && industry !== 'all') query += ` industry:${industry}`;

      console.log(`🔍 SearchService: Querying SerpAPI with: ${query}`);
      
      const response = await fetch(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}&num=50`);
      
      if (!response.ok) {
        throw new Error(`SerpAPI error: ${response.status}`);
      }

      const data: SerpApiResult = await response.json();
      const domains: string[] = [];

      // Extract domains from organic results
      if (data.organic_results) {
        for (const result of data.organic_results) {
          const domain = this.extractDomainFromUrl(result.link);
          if (domain && !domains.includes(domain)) {
            domains.push(domain);
          }
        }
      }

      console.log(`🔍 SearchService: Found ${domains.length} unique domains`);
      return domains.slice(0, 80); // Limit to 80 domains
    } catch (error) {
      console.error('SearchService error:', error);
      return [];
    }
  }

  private extractDomainFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();
      
      // Filter out common job boards and social media
      const excludedDomains = [
        'indeed.com', 'glassdoor.com', 'monster.com', 'ziprecruiter.com',
        'careerbuilder.com', 'simplyhired.com', 'dice.com', 'craigslist.org',
        'linkedin.com', 'facebook.com', 'twitter.com', 'youtube.com',
        'builtin.com', 'builtinsf.com', 'welcometothejungle.com', 'roberthalf.com',
        'governmentjobs.com', 'disneycareers.com', 'spacecrew.com'
      ];
      
      if (excludedDomains.some(excluded => hostname.includes(excluded))) {
        return null;
      }
      
      return hostname.replace('www.', '');
    } catch {
      return null;
    }
  }
}

// ============== SERVICE 2: ENRICHMENT SERVICE ==============
class EnrichmentService {

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

      const leads: Lead[] = [];

      for (const contact of data.data.emails) {
        if (contact.email) { // Only verified contacts
          const lead = {
            name: `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'Unknown',
            title: contact.position || 'Unknown Position',
            email: contact.email,
            confidence: contact.confidence,
            company: domain,
            source: `Hunter.io`
          };
          leads.push(lead);
        }
      }

      console.log(`👥 EnrichmentService: Found ${leads.length} total contacts at ${domain}`);
      return leads;
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
    leadCount: number = 200,
    onProgress?: (progress: number, lead?: Lead, domain?: string) => void
  ): Promise<Lead[]> {
    console.log("🚀 AggregationService: Starting lead generation...");
    
    // Phase 1: Find companies
    onProgress?.(10);
    const domains = await new SearchService().findCompanyDomains(jobTitle, location, industry);
    
    if (domains.length === 0) {
      throw new Error("No companies found. Try a broader job title or remove location filter.");
    }

    // Stream each domain found
    for (const domain of domains) {
      onProgress?.(15, undefined, domain);
    }

    onProgress?.(20);

    // Phase 2: Process companies and find contacts
    const totalDomains = domains.length;
    let processedDomains = 0;
    
    for (const domain of domains) {
      if (this.allLeads.length >= leadCount) {
        break;
      }

      try {
        const contacts = await EnrichmentService.findContactsAtCompany(domain);
        
        // Deduplicate by email
        for (const contact of contacts) {
          if (!this.leads.has(contact.email) && this.allLeads.length < leadCount) {
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
    
    return this.allLeads.slice(0, leadCount);
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
    const { jobTitle, jobDescription, location, industry, leadCount = 200 }: GenerateRequestBody = await req.json();

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
            leadCount,
            (progress: number, lead?: Lead, domain?: string) => {
              if (lead) {
                sendMessage('lead', { lead });
              }
              if (domain) {
                sendMessage('domain', { domain });
              }
              sendMessage('progress', { value: progress });
            }
          );

          sendMessage('complete', { message: 'Lead generation completed' });
          
          // Send final done message to indicate stream completion
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (error) {
          console.error('Streaming error:', error);
          sendMessage('error', { 
            message: error instanceof Error ? error.message : 'An error occurred' 
          });
          
          // Send final done message even on error
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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