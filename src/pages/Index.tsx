import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import { Copy, ExternalLink } from "lucide-react";

interface Lead {
  name: string;
  title: string;
  email: string;
  confidence: number;
  company: string;
  source: string;
}

const Index = () => {
  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [location, setLocation] = useState("");
  const [industry, setIndustry] = useState("");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [leadCount, setLeadCount] = useState(200);

  useEffect(() => {
    document.title = "Cresyx Lead Generator";
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", "SerpAPI + Hunter.io powered lead generation with real-time streaming.");
  }, []);

  const canSubmit = jobTitle.trim().length > 0 && jobDescription.trim().length > 0 && !loading;

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard!");
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    
    setLoading(true);
    setLeads([]);
    setDomains([]);
    setProgress(0);
    
    try {
      const response = await fetch('https://ramicmfsdywohgftyzxr.supabase.co/functions/v1/generate-leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJhbWljbWZzZHl3b2hnZnR5enhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUwMzY0MjUsImV4cCI6MjA3MDYxMjQyNX0.0TQJKEZQNk4Btvkv0TI3tTV3jo4jILfZEHeWvs-fA7M`,
        },
        body: JSON.stringify({
          jobTitle,
          jobDescription,
          location: location === "global" ? undefined : location,
          industry: industry === "all" ? undefined : industry,
          leadCount: leadCount,
        }),
      });

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          // Skip blank lines and [DONE] messages
          if (!line.trim() || line.trim() === 'data: [DONE]') {
            continue;
          }

          if (line.startsWith('data: ')) {
            try {
              const jsonData = line.slice(6);
              const data = JSON.parse(jsonData);
              
              if (data.type === 'progress') {
                setProgress(data.value);
              } else if (data.type === 'lead') {
                setLeads(prev => [...prev, data.lead]);
              } else if (data.type === 'domain') {
                setDomains(prev => [...prev, data.domain]);
              } else if (data.type === 'complete') {
                setProgress(100);
                toast.success(`Lead generation completed! Found ${leads.length} leads.`);
                return; // End the entire stream processing
              } else if (data.type === 'error') {
                throw new Error(data.message);
              }
            } catch (e) {
              console.error('Failed to parse SSE data:', line, e);
              // Continue processing other lines even if one fails
            }
          }
        }
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to generate leads");
    } finally {
      setLoading(false);
    }
  };

  const csvHref = useMemo(() => {
    if (!leads.length) return undefined;
    const headers = ["Name", "Job Title", "Email", "Confidence Score", "Company Domain", "Source"];
    const rows = leads.map(l => [l.name, l.title, l.email, String(l.confidence), l.company, l.source]);
    const csv = [headers, ...rows]
      .map(r => r.map(v => `"${(v ?? "").split('"').join('""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    return URL.createObjectURL(blob);
  }, [leads]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container py-6">
          <h1 className="text-3xl font-bold tracking-tight">Cresyx Lead Generator</h1>
          <p className="text-muted-foreground mt-2">SerpAPI + Hunter.io powered lead generation with real-time streaming</p>
        </div>
      </header>

      <main className="container py-8">
        <div className="grid lg:grid-cols-2 gap-8">
          {/* Left Column - Form */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Lead Generation Form</CardTitle>
                <CardDescription>Enter your job requirements to find hiring managers and recruiters</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={onSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <label htmlFor="jobTitle" className="text-sm font-medium">Job Title</label>
                    <Input
                      id="jobTitle"
                      placeholder="e.g., Senior Machine Learning Engineer"
                      required
                      value={jobTitle}
                      onChange={(e) => setJobTitle(e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="jobDescription" className="text-sm font-medium">Job Description</label>
                    <Textarea
                      id="jobDescription"
                      placeholder="Describe the role, required skills, and ideal candidate profile..."
                      required
                      value={jobDescription}
                      onChange={(e) => setJobDescription(e.target.value)}
                      rows={4}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Location</label>
                      <Select value={location} onValueChange={setLocation}>
                        <SelectTrigger>
                          <SelectValue placeholder="Global" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="global">Global</SelectItem>
                          <SelectItem value="US">United States</SelectItem>
                          <SelectItem value="EU">Europe</SelectItem>
                          <SelectItem value="Asia">Asia</SelectItem>
                          <SelectItem value="Remote">Remote</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">Industry</label>
                      <Select value={industry} onValueChange={setIndustry}>
                        <SelectTrigger>
                          <SelectValue placeholder="All Industries" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Industries</SelectItem>
                          <SelectItem value="Technology">Technology</SelectItem>
                          <SelectItem value="Finance">Finance</SelectItem>
                          <SelectItem value="Healthcare">Healthcare</SelectItem>
                          <SelectItem value="E-commerce">E-commerce</SelectItem>
                          <SelectItem value="Manufacturing">Manufacturing</SelectItem>
                          <SelectItem value="Consulting">Consulting</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-3">
                      <label className="text-sm font-medium">Leads to Generate: {leadCount}</label>
                      <Slider
                        value={[leadCount]}
                        onValueChange={(value) => setLeadCount(value[0])}
                        max={200}
                        min={10}
                        step={10}
                        className="w-full"
                      />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>10</span>
                        <span>200</span>
                      </div>
                    </div>
                  </div>

                  <Button type="submit" disabled={!canSubmit} className="w-full">
                    {loading ? (
                      <span className="flex items-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                        Generating Leads...
                      </span>
                    ) : (
                      "Generate Leads"
                    )}
                  </Button>
                </form>
              </CardContent>
            </Card>

            {/* Progress Section */}
            {loading && (
              <Card>
                <CardContent className="pt-6">
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span>Progress</span>
                      <span>{leads.length}/{leadCount} leads found</span>
                    </div>
                    <Progress value={progress} className="w-full" />
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Export Button */}
            {leads.length > 0 && csvHref && (
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{leads.length} leads generated</span>
                    <a href={csvHref} download={`cresyx-leads-${Date.now()}.csv`}>
                      <Button variant="outline">Export CSV</Button>
                    </a>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Discovered Companies */}
            {domains.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Discovered Companies</CardTitle>
                  <CardDescription>Company domains found from search</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {domains.map((domain, idx) => (
                      <div key={idx} className="flex items-center text-sm">
                        <span className="text-muted-foreground mr-2">•</span>
                        <span>{domain}</span>
                      </div>
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground mt-2">
                    {domains.length} companies found
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right Column - Results Table */}
          <div>
            <Card className="h-fit">
              <CardHeader>
                <CardTitle>Lead Results</CardTitle>
                <CardDescription>
                  {leads.length > 0 
                    ? `Found ${leads.length} qualified leads` 
                    : "Results will appear here as they're found"
                  }
                </CardDescription>
              </CardHeader>
              <CardContent>
                {loading && leads.length === 0 && (
                  <div className="py-12 text-center text-muted-foreground">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent mx-auto mb-2" />
                    Searching for companies and contacts...
                  </div>
                )}
                
                {!loading && leads.length === 0 && (
                  <div className="py-12 text-center text-muted-foreground">
                    No leads yet. Fill out the form to start generating results.
                  </div>
                )}

                {leads.length > 0 && (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Job Title</TableHead>
                          <TableHead>Email</TableHead>
                          <TableHead>Confidence</TableHead>
                          <TableHead>Company</TableHead>
                          <TableHead>Source</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {leads.map((lead, idx) => (
                          <TableRow key={`${lead.email}-${idx}`}>
                            <TableCell className="font-medium">{lead.name}</TableCell>
                            <TableCell>{lead.title}</TableCell>
                            <TableCell>
                              <button
                                onClick={() => copyToClipboard(lead.email)}
                                className="flex items-center gap-1 text-primary hover:text-primary/80 transition-colors"
                              >
                                {lead.email}
                                <Copy className="h-3 w-3" />
                              </button>
                            </TableCell>
                            <TableCell>
                              <span className="inline-flex items-center px-2 py-1 rounded-md bg-primary/10 text-primary text-xs font-medium">
                                {lead.confidence}%
                              </span>
                            </TableCell>
                            <TableCell>{lead.company}</TableCell>
                            <TableCell>
                              <a 
                                href={`https://${lead.company}`} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-primary hover:text-primary/80 transition-colors"
                              >
                                {lead.source}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Index;