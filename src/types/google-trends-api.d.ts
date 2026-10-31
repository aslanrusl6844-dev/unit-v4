declare module 'google-trends-api' {
  interface TrendsOptions {
    keyword: string | string[];
    startTime?: Date;
    endTime?: Date;
    geo?: string;
    hl?: string;
    timezone?: number;
    category?: number;
  }
  const api: {
    interestOverTime(opts: TrendsOptions): Promise<string>;
    relatedQueries(opts: TrendsOptions): Promise<string>;
    interestByRegion(opts: TrendsOptions & { resolution?: string }): Promise<string>;
  };
  export default api;
}
