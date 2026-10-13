import { AwsClient } from "aws4fetch";
import type { Io } from "./io.js";

export type Outputs = Readonly<Record<string, string>>;

export interface BuildRecord {
  buildId: string;
  createdAt: string;
  smoke: "pending" | "passed" | "failed";
  services: Record<string, Outputs>;
}

export function choosePromotion(
  records: readonly BuildRecord[],
): BuildRecord | undefined {
  return records
    .filter((record) => record.smoke === "passed")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function buildsBucket(
  environment: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return environment === "production"
    ? env.TURBO_VIBE_BUILDS_BUCKET
    : env.TURBO_VIBE_STATE_BUCKET;
}

export class BuildStore {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(
    private readonly io: Io,
    private readonly project: string,
    bucket: string | undefined,
  ) {
    this.client = new AwsClient({
      accessKeyId: io.env.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: io.env.AWS_SECRET_ACCESS_KEY ?? "",
      service: "s3",
      region: "auto",
    });
    this.base = `https://${io.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}`;
  }

  artifactKey(buildId: string, service: string): string {
    return `${this.project}/builds/${buildId}/${service}.tar.gz`;
  }

  async putRecord(record: BuildRecord): Promise<void> {
    await this.put(
      this.recordKey(record.buildId),
      JSON.stringify(record, null, 2),
    );
  }

  async getRecord(buildId: string): Promise<BuildRecord | undefined> {
    const body = await this.get(this.recordKey(buildId));
    return body && (JSON.parse(new TextDecoder().decode(body)) as BuildRecord);
  }

  async listRecords(): Promise<BuildRecord[]> {
    const prefix = `${this.project}/builds/`;
    const records: BuildRecord[] = [];
    let token: string | undefined;
    do {
      const url = new URL(`${this.base}/`);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("delimiter", "/");
      if (token) url.searchParams.set("continuation-token", token);
      const xml = await (
        await this.send(url, { method: "GET" }, "list build records")
      ).text();
      for (const [, key] of xml.matchAll(/<Key>([^<]+\.json)<\/Key>/g)) {
        const id = key?.slice(prefix.length, -".json".length);
        const record = id && (await this.getRecord(id));
        if (record) records.push(record);
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? xml.match(
            /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/,
          )?.[1]
        : undefined;
    } while (token);
    return records;
  }

  async put(
    key: string,
    body: string | Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    await this.send(this.url(key), { method: "PUT", body }, `upload ${key}`);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const response = await this.send(
      this.url(key),
      { method: "GET" },
      `download ${key}`,
      [404],
    );
    return response.status === 404
      ? undefined
      : new Uint8Array(await response.arrayBuffer());
  }

  async putIfAbsent(key: string, body: string): Promise<number> {
    const response = await this.io.fetch(
      await this.client.sign(this.url(key).toString(), {
        method: "PUT",
        body,
        headers: { "if-none-match": "*" },
      }),
    );
    return response.status;
  }

  async remove(key: string): Promise<void> {
    await this.send(
      this.url(key),
      { method: "DELETE" },
      `delete ${key}`,
      [404],
    );
  }

  private recordKey(buildId: string): string {
    return `${this.project}/builds/${buildId}.json`;
  }

  private url(key: string): URL {
    return new URL(
      `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`,
    );
  }

  private async send(
    url: URL,
    init: RequestInit,
    action: string,
    allowed: readonly number[] = [],
  ): Promise<Response> {
    const response = await this.io.fetch(
      await this.client.sign(url.toString(), init),
    );
    if (!response.ok && !allowed.includes(response.status)) {
      throw new Error(
        `cannot ${action}: the state bucket answered HTTP ${response.status}`,
      );
    }
    return response;
  }
}
