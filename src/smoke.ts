export type Observation =
  | { status: number; buildId: string | undefined }
  | { error: string };

export interface SmokeResult {
  ok: boolean;
  message: string;
}

export function judge(
  url: string,
  expected: string,
  observed: Observation,
): SmokeResult {
  if ("error" in observed) {
    return { ok: false, message: `${url} unreachable: ${observed.error}` };
  }
  if (observed.status < 200 || observed.status > 299) {
    return { ok: false, message: `${url} answered HTTP ${observed.status}` };
  }
  if (observed.buildId !== expected) {
    return {
      ok: false,
      message: `${url} reports build ${observed.buildId ?? "(none)"}, expected ${expected}`,
    };
  }
  return { ok: true, message: `${url} reports build ${expected}` };
}

export interface Probe {
  url: string;
  headers?: Readonly<Record<string, string>>;
  read: (response: Response) => Promise<string | undefined>;
}

export async function checkBuildId(
  probe: Probe,
  expected: string,
  {
    fetch,
    sleep,
  }: { fetch: typeof globalThis.fetch; sleep: (ms: number) => Promise<void> },
  { attempts = 10, delayMs = 6000 } = {},
): Promise<SmokeResult> {
  let result: SmokeResult = { ok: false, message: `${probe.url} not checked` };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let observed: Observation;
    try {
      const response = await fetch(probe.url, {
        headers: { "cache-control": "no-cache", ...probe.headers },
        signal: AbortSignal.timeout(10_000),
      });
      observed = {
        status: response.status,
        buildId: response.ok ? await probe.read(response) : undefined,
      };
    } catch (error) {
      observed = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    result = judge(probe.url, expected, observed);
    if (result.ok || attempt === attempts) break;
    await sleep(delayMs);
  }
  return result;
}
