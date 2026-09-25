/**
 * Ambient types for the Deno Edge Function runtime.
 *
 * The functions are deployed to Deno, which provides `Deno.env` / `Deno.serve`
 * and resolves `jsr:` specifiers. The repo's own tooling (TypeScript, the Node
 * test runner) does not, so this file declares the minimal runtime surface to
 * let `npm run typecheck:functions` check the functions without Docker or a Deno
 * install. It is type-only and is never bundled or deployed.
 */
declare namespace Deno {
  const env: {
    get(name: string): string | undefined;
    set(name: string, value: string): void;
  };
  function serve(
    handler: (req: Request) => Response | Promise<Response>,
    options?: { port?: number; onListen?: (args: { port: number }) => void },
  ): void;
}

declare module "jsr:@supabase/supabase-js@2" {
  export function createClient(
    url: string,
    key: string,
    options?: unknown,
  ): any;
}
