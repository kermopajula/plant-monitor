// Open Plant Book API client (https://open.plantbook.io). Needs a free API key.

import type { Ranges } from './status';

export interface PlantSearchResult {
  pid: string;
  display_pid: string;
  alias: string;
  category?: string;
}

export interface PlantDetail extends PlantSearchResult {
  min_soil_moist?: number | null;
  max_soil_moist?: number | null;
  min_soil_ec?: number | null;
  max_soil_ec?: number | null;
  min_light_lux?: number | null;
  max_light_lux?: number | null;
  min_temp?: number | null;
  max_temp?: number | null;
  image_url?: string | null;
}

export class PlantbookError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class PlantbookClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://open.plantbook.io/api/v1',
    private readonly timeoutMs = 10000,
  ) {}

  get configured(): boolean {
    return this.apiKey !== '';
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.configured) throw new PlantbookError('PLANTBOOK_API_KEY is not set');
    const res = await fetch(this.baseUrl + path, {
      headers: { Authorization: `Token ${this.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new PlantbookError(`Open Plant Book returned ${res.status}: ${body.slice(0, 200)}`, res.status);
    }
    return (await res.json()) as T;
  }

  async search(query: string, limit = 15): Promise<PlantSearchResult[]> {
    const q = new URLSearchParams({ alias: query, limit: String(limit) });
    const body = await this.get<{ results?: PlantSearchResult[] }>(`/plant/search?${q}`);
    return body.results ?? [];
  }

  detail(pid: string): Promise<PlantDetail> {
    return this.get<PlantDetail>(`/plant/detail/${encodeURIComponent(pid)}/`);
  }
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Map Open Plant Book fields to our ranges (units match Mi Flora: %, µS/cm, lux, °C). */
export function rangesFromPlantbook(d: PlantDetail): Ranges {
  return {
    moisture: { min: n(d.min_soil_moist), max: n(d.max_soil_moist) },
    conductivity: { min: n(d.min_soil_ec), max: n(d.max_soil_ec) },
    lux: { min: n(d.min_light_lux), max: n(d.max_light_lux) },
    temperature: { min: n(d.min_temp), max: n(d.max_temp) },
  };
}
