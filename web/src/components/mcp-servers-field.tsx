import { Label } from '@/components/ui/label'

const EXAMPLE = `{
  "playwright": {
    "command": "npx",
    "args": ["@playwright/mcp@latest"]
  }
}`

/** JSON editor for the instance's external stdio MCP servers. */
export function McpServersField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor="inst-mcp">External MCP servers</Label>
      <textarea
        id="inst-mcp"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={EXAMPLE}
        rows={6}
        spellCheck={false}
        autoComplete="off"
        aria-describedby="inst-mcp-help"
        className="min-h-24 w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <p id="inst-mcp-help" className="text-xs text-muted-foreground">
        Optional. Paste an <code>mcpServers</code> JSON (stdio <code>command</code>, <code>args</code>, <code>env</code>). Their tools reach ChatGPT as{' '}
        <code>server__tool</code> through this instance's tunnel and ask for approval unless <code>"trustAnnotations": true</code>. Also supported:{' '}
        <code>tools</code> (allowlist), <code>enabled</code>, <code>cwd</code>, <code>timeoutSecs</code> (5-110). Saved env values show as{' '}
        <code>&lt;hidden&gt;</code>; leave them as is to keep them. Put secrets in <code>env</code> only: args are shown as entered. Restart the instance and refresh the connector in ChatGPT after changes.
      </p>
    </div>
  )
}
