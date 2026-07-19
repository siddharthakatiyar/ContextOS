import { DocPage } from "@/components/docs/doc-page";

export default function ExamplesDocs() {
  return (
    <DocPage
      title="Framework Examples"
      description="Integration examples and best practices across popular technology stacks."
    >
      <h2>Next.js / React</h2>
      <p>
        When working with Next.js or React, LLMs often struggle with Server Components vs. Client Components, or routing structure. ContextOS natively parses TSX/JSX and resolves imports across the app router.
      </p>
      <p>
        <strong>Example Query:</strong>
        <br/>
        <code>contextos query "How is the user authentication state passed from the root layout to the dashboard page?"</code>
      </p>
      <p>
        <strong>Result:</strong> ContextOS will extract the <code>layout.tsx</code>, trace the <code>AuthProvider</code> import, pull the context definition, and extract the <code>useAuth()</code> hook usage inside <code>dashboard/page.tsx</code>.
      </p>

      <h2>Node.js / Express</h2>
      <p>
        In monolithic Express apps, routes often depend on dozens of middleware and controller files. 
      </p>
      <p>
        <strong>Example Query:</strong>
        <br/>
        <code>contextos query "What middleware is executed before the POST /api/checkout route?"</code>
      </p>
      <p>
        <strong>Result:</strong> ContextOS finds the route definition, runs graph expansion on the route handler array, and retrieves the AST chunks for the specific middleware functions (e.g. <code>verifyStripeSignature</code>, <code>rateLimiter</code>) without returning the entire 2,000-line <code>middleware.ts</code> file.
      </p>

      <h2>Python (FastAPI / Django)</h2>
      <p>
        ContextOS fully supports Python AST parsing via Tree-sitter. It perfectly understands class inheritance and decorators.
      </p>
      <p>
        <strong>Example Query:</strong>
        <br/>
        <code>contextos query "Where is the User model defined and what fields does it have?"</code>
      </p>
      <p>
        <strong>Result:</strong> ContextOS uses exact symbol matching to locate <code>class User(models.Model)</code> and returns only that chunk, stripping out the rest of the <code>models.py</code> file.
      </p>

      <h2>Go (Golang)</h2>
      <p>
        Go projects often have hundreds of small files in a single package. ContextOS handles Go's implicit package-level visibility natively.
      </p>
      <p>
        <strong>Example Query:</strong>
        <br/>
        <code>contextos query "Show me the implementation of the ProcessQueue goroutine."</code>
      </p>
      <p>
        <strong>Result:</strong> ContextOS returns the <code>ProcessQueue</code> function, and through Graph Expansion, pulls in the struct definitions for any channels or mutexes it operates on.
      </p>
    </DocPage>
  );
}
