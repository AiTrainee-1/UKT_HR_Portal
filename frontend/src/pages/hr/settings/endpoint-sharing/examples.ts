import type { SharedGuideExample } from "@/lib/api-client/custom-hooks";

export const KEY_PLACEHOLDER = "YOUR_API_KEY";

/**
 * The same call in six languages, for the general Integration guide. The key is a placeholder: a real key is never put in
 * an example (and the per-endpoint Guide the server writes does the same). Every example reads the key from the program's
 * settings rather than writing it into the code.
 */
export function buildExamples(url: string): SharedGuideExample[] {
  return [
    {
      language: "curl",
      label: "curl",
      code: `curl -H "Authorization: Bearer ${KEY_PLACEHOLDER}" \\\n  "${url}?page=1&pageSize=50"`,
    },
    {
      language: "javascript",
      label: "JavaScript",
      code: [
        "// Run this on YOUR server (or in a build step), not in a page that visitors can read.",
        `const response = await fetch("${url}?page=1&pageSize=50", {`,
        `  headers: { Authorization: \`Bearer \${process.env.SHARED_API_KEY}\` },`,
        "});",
        "if (!response.ok) throw new Error(`Call failed: ${response.status}`);",
        "const { data, meta } = await response.json();",
        "console.log(meta.total, data);",
      ].join("\n"),
    },
    {
      language: "python",
      label: "Python",
      code: [
        "import os, requests",
        "",
        "response = requests.get(",
        `    "${url}",`,
        '    headers={"Authorization": "Bearer " + os.environ["SHARED_API_KEY"]},',
        '    params={"page": 1, "pageSize": 50},',
        "    timeout=30,",
        ")",
        "response.raise_for_status()",
        "payload = response.json()",
        'print(payload["meta"]["total"], payload["data"])',
      ].join("\n"),
    },
    {
      language: "php",
      label: "PHP",
      code: [
        "<?php",
        `$ch = curl_init("${url}?page=1&pageSize=50");`,
        "curl_setopt_array($ch, [",
        "    CURLOPT_RETURNTRANSFER => true,",
        '    CURLOPT_HTTPHEADER => ["Authorization: Bearer " . getenv("SHARED_API_KEY")],',
        "    CURLOPT_TIMEOUT => 30,",
        "]);",
        "$body = curl_exec($ch);",
        "$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);",
        "curl_close($ch);",
        'if ($status !== 200) { throw new Exception("Call failed: $status"); }',
        "$payload = json_decode($body, true);",
        'echo $payload["meta"]["total"];',
      ].join("\n"),
    },
    {
      language: "csharp",
      label: "C#",
      code: [
        "using System.Net.Http;",
        "using System.Net.Http.Headers;",
        "",
        "using var client = new HttpClient();",
        "client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(",
        '    "Bearer", Environment.GetEnvironmentVariable("SHARED_API_KEY"));',
        `var response = await client.GetAsync("${url}?page=1&pageSize=50");`,
        "response.EnsureSuccessStatusCode();",
        "var json = await response.Content.ReadAsStringAsync();",
        "Console.WriteLine(json);",
      ].join("\n"),
    },
    {
      language: "node",
      label: "Node",
      code: [
        "// Node 18 or newer: fetch is built in.",
        `const res = await fetch("${url}?page=1&pageSize=50", {`,
        '  headers: { "X-API-Key": process.env.SHARED_API_KEY },',
        "});",
        "if (res.status === 429) console.log('Slow down, retry after', res.headers.get('Retry-After'), 'seconds');",
        "const body = await res.json();",
        "console.log(body);",
      ].join("\n"),
    },
  ];
}
