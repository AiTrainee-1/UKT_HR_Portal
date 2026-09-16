import { useState, type FormEvent } from "react";
import { useLocation, useRoute } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useReceptionLoginInfo, useReceptionLogin } from "@/lib/api-client/custom-hooks";
import { UserRound } from "lucide-react";
import { CircleLoader } from "@/components/ui/CircleLoader";

/**
 * Login page for one Reception desk. Deliberately outside the HR shell (no
 * sidebar, no ProtectedRoute) -mirrors GateScannerLogin.tsx exactly: the
 * :loginToken in the URL only identifies which desk's name/branch to show
 * before any credentials are entered, the actual login is always
 * username+password against ReceptionDevice, verified server-side (see
 * reception_views.py).
 */
export default function ReceptionLogin() {
  const [, params] = useRoute("/reception-login/:loginToken");
  const loginToken = params?.loginToken ?? "";
  const [, navigate] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: info, isLoading, error: infoError } = useReceptionLoginInfo(loginToken);
  const loginMutation = useReceptionLogin();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await loginMutation.mutateAsync({ username, password });
      localStorage.setItem("reception_device_token", res.token);
      localStorage.setItem("reception_device_id", String(res.deviceId));
      localStorage.setItem("reception_device_name", res.deskName);
      navigate("/reception/console");
    } catch (err: any) {
      setError(err?.message ?? "Invalid username or password");
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-sm mx-auto px-4 py-16">
        <div className="mb-8 text-center">
          <UserRound className="mx-auto text-accent mb-2" size={28} />
          <p className="text-accent text-xs font-bold tracking-[0.25em] uppercase mb-2">UK Textile</p>
          <h1 className="text-3xl font-black text-foreground">Reception</h1>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <CircleLoader texts={["UK Textiles", "Reception", "Loading"]} />
          </div>
        ) : infoError || !info ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              This reception login link is not recognized. Please check with HR.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{info.deskName}</CardTitle>
              <CardDescription>{info.branchName} · Sign in to view today's visitors.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reception-login-username">Username</Label>
                  <Input id="reception-login-username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reception-login-password">Password</Label>
                  <Input id="reception-login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button type="submit" className="w-full" size="lg" disabled={loginMutation.isPending || !info.isActive}>
                  {!info.isActive ? "This desk has been deactivated" : loginMutation.isPending ? "Signing in…" : "Sign In"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
