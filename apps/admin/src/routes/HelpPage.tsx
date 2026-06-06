import { Book, FileText } from "lucide-react";
import { PageHeader } from "../components/ui/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";

export function HelpPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Help & Resources" description="Learn more about building and managing your community." />

      <div className="grid gap-4">
        <a href="https://www.amazon.com/s?k=building+online+social+communities+books" target="_blank" rel="noopener noreferrer">
          <Card className="transition-colors hover:bg-surface-2">
            <CardHeader>
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <Book className="size-5 shrink-0 text-primary" />
                  <div className="space-y-1">
                    <CardTitle>Learn how to build a community</CardTitle>
                    <CardDescription>Explore books and resources on Amazon about building thriving online social communities. (Results are not in any particular order.)</CardDescription>
                  </div>
                </div>
              </div>
            </CardHeader>
          </Card>
        </a>

        <Card className="opacity-50">
          <CardHeader>
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <FileText className="size-5 shrink-0 text-muted" />
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <CardTitle>Online documentation</CardTitle>
                    <Badge variant="muted" className="text-xs">Coming soon</Badge>
                  </div>
                  <CardDescription>Comprehensive guides and API documentation for running your Agora instance.</CardDescription>
                </div>
              </div>
            </div>
          </CardHeader>
        </Card>
      </div>
    </div>
  );
}
