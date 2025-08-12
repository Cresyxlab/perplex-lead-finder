import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";


interface Lead {
  name: string;
  title: string;
  company: string;
  location: string;
  profile_url: string;
  relevance_score: number;
}

const Index = () => {
  const [prompt, setPrompt] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [limit, setLimit] = useState<number>(200);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.title = "Cresyx Lead Generator";
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", "Perplexity-powered tool to find and rank hiring manager leads with CSV export.");
  }, []);

  const canSubmit = prompt.trim().length > 0 && jobDescription.trim().length > 0 && !loading;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setLeads([]);
    try {
      const url = `https://ramicmfsdywohgftyzxr.supabase.co/functions/v1/generate-leads`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJhbWljbWZzZHl3b2hnZnR5enhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUwMzY0MjUsImV4cCI6MjA3MDYxMjQyNX0.0TQJKEZQNk4Btvkv0TI3tTV3jo4jILfZEHeWvs-fA7M`,
        },
        body: JSON.stringify({ prompt, jobDescription, limit }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const result = (data as any)?.leads as Lead[] | undefined;

      if (!result || result.length === 0) {
        toast.info("No leads found. Try refining your prompt or JD.");
        setLeads([]);
      } else {
        setLeads(result);
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to generate leads");
    } finally {
      setLoading(false);
    }
  };

  const csvHref = useMemo(() => {
    if (!leads.length) return undefined;
    const headers = ["Name","Title","Company","Location","Profile URL","Relevance Score"];
    const rows = leads.map(l => [l.name, l.title, l.company, l.location, l.profile_url, String(l.relevance_score)]);
    const csv = [headers, ...rows]
      .map(r => r.map(v => `"${(v ?? "").split('"').join('""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    return URL.createObjectURL(blob);
  }, [leads]);

  return (
    <div className="min-h-screen ambient-gradient">
      <header className="py-10">
        <div className="container">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">Cresyx Lead Generator</h1>
          <p className="text-muted-foreground mt-2">Perplexity-powered hiring manager discovery with smart deduplication and CSV export.</p>
        </div>
      </header>

      <main className="container pb-16">
        <section aria-labelledby="form-section">
          <Card>
            <CardHeader>
              <CardTitle id="form-section">Search Inputs</CardTitle>
              <CardDescription>Provide a search prompt and job description. We will run multiple Perplexity queries for coverage.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmit} className="grid gap-6">
                <div className="grid gap-2">
                  <label htmlFor="prompt" className="text-sm font-medium">Search Prompt</label>
                  <Textarea
                    id="prompt"
                    placeholder="Find hiring managers hiring Director of AI in EU consulting firms"
                    required
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                  />
                </div>
                <div className="grid gap-2">
                  <label htmlFor="jd" className="text-sm font-medium">Job Description / Ideal Client Profile</label>
                  <Textarea
                    id="jd"
                    required
                    value={jobDescription}
                    onChange={(e) => setJobDescription(e.target.value)}
                    rows={6}
                  />
                </div>
                <div className="grid gap-2 max-w-xs">
                  <label htmlFor="limit" className="text-sm font-medium">Number of Leads</label>
                  <Input
                    id="limit"
                    type="number"
                    min={10}
                    max={500}
                    value={limit}
                    onChange={(e) => setLimit(Math.max(10, Math.min(500, Number(e.target.value || 200))))}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Button type="submit" disabled={!canSubmit}>
                    {loading ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                        Generating...
                      </span>
                    ) : (
                      "Generate Leads"
                    )}
                  </Button>
                  {leads.length > 0 && csvHref && (
                    <a
                      href={csvHref}
                      download={`cresyx-leads-${Date.now()}.csv`}
                      className="inline-flex"
                    >
                      <Button variant="secondary">Export CSV</Button>
                    </a>
                  )}
                  {leads.length > 0 && (
                    <span className="text-sm text-muted-foreground">{leads.length} leads</span>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>
        </section>

        <section className="mt-10" aria-labelledby="results-section">
          <h2 id="results-section" className="sr-only">Results</h2>
          <Card>
            <CardHeader>
              <CardTitle>Results</CardTitle>
              <CardDescription>Up to {limit} deduplicated leads ranked by relevance.</CardDescription>
            </CardHeader>
            <CardContent>
              {loading && leads.length === 0 && (
                <div className="py-12 text-center text-muted-foreground">Generating leads with Perplexity…</div>
              )}
              {!loading && leads.length === 0 && (
                <div className="py-12 text-center text-muted-foreground">No leads yet. Submit the form to generate results.</div>
              )}
              {leads.length > 0 && (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Title</TableHead>
                        <TableHead>Company</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Profile URL</TableHead>
                        <TableHead className="text-right">Relevance Score</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {leads.map((l, idx) => (
                        <TableRow key={`${l.name}-${l.company}-${idx}`}>
                          <TableCell>{l.name}</TableCell>
                          <TableCell>{l.title}</TableCell>
                          <TableCell>{l.company}</TableCell>
                          <TableCell>{l.location}</TableCell>
                          <TableCell>
                            {l.profile_url ? (
                              <a href={l.profile_url} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-4">
                                View Profile
                              </a>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-medium">{l.relevance_score}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
};

export default Index;
