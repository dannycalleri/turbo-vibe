export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <main>
      <h1>turbo-vibe Next.js example</h1>
      <p>
        Build: <code id="build">{process.env.TURBO_VIBE_BUILD_ID}</code>
      </p>
      <p>
        Greeting set:{" "}
        <code id="greeting">{process.env.EXAMPLE_GREETING ? "yes" : "no"}</code>
      </p>
      <p>Rendered on the server at {new Date().toISOString()}</p>
    </main>
  );
}
